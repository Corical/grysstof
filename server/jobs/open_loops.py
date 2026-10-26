#!/usr/bin/env python3
"""Open loops: the morning list of what is still owed in the Xactco Discord, kept as a record.

Reads the last 7 days of Discord messages and every recorded loop through Grysstof's read API, asks the
model which recorded loops closed or moved and which new ones exist (contract C5 of plan 5), checks every
claim in code, writes one ledger line per change through /mcp (C1, C2), reads /loops again, and posts it.
The job owns the C2 and C5 rules (plan v3.1); C1 lines are sanitised exactly as core/loops.ts does.

Usage:
  open_loops.py --env FILE --check     reads, settings present, Pi clock vs Discord; no model, no writes, no post
  open_loops.py --env FILE             dry run: model pass, prints "would unpark N", "would open N, close M,
                                       update K" and the post; writes nothing
  open_loops.py --env FILE --post      writes the ledger lines, then posts to the webhook
  --lock FILE                          take this lock for the run; if another run holds it, exit at once
                                       (and, with --post, say so in the channel when it is over an hour old)

A parked loop whose `until` has passed is put back to OPEN at the start of the run (one OPEN line superseding
the PARKED line, every field carried from the OPEN line before it) and then takes part like any open loop.

Env file (KEY=value lines): OPEN_LOOPS_WEBHOOK, GRYSSTOF_URL (the server's /mcp URL), MCP_ACCESS_KEY,
XACTCO_MEMBERS (comma-separated Discord user ids, each optionally "id:Name"), OPEN_LOOPS_MODEL_PROVIDER
(default anthropic), OPEN_LOOPS_MODEL (default claude-sonnet-5-5), and the provider's key (ANTHROPIC_API_KEY).

Standard library only. Every Grysstof, Discord and webhook call has a 30-second timeout; the streamed model call
allows 120 seconds of silence; the reads, the model call and the writes share a 780-second deadline (cron kills
at 900). SIGTERM runs the failure path. Every failure prints one line and exits non-zero.
"""
import argparse
import email.utils
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows, where the tests run
    fcntl = None
    import msvcrt

SAST = timezone(timedelta(hours=2))
UTC = timezone.utc
DEFAULT_ENV = Path("/home/corical/open-loops/.env")
DEFAULT_PROVIDER = "anthropic"
DEFAULT_MODEL = "claude-sonnet-5-5"
MAX_TOKENS = 16000
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
DISCORD_CLOCK_URL = "https://discord.com/api/v10/gateway"
ACTOR = "open-loops"
DAYS = 7
HTTP_TIMEOUT = 30          # seconds, every Grysstof, Discord and webhook call
MODEL_IDLE_TIMEOUT = 120   # the model call streams; this is the longest silence allowed while it thinks with its
                           # thinking hidden (the default), which can be a long pause before the first text
DEADLINE_SECONDS = 780     # reads, model call and writes together; the cron line kills at 900, leaving time to post
REREAD_PAUSE = 10          # after a write times out, wait this long before the one re-read
PAGE = 500                 # /thoughts page size
WINDOW_CAP = 2000          # the whole 7-day window, every page together: more is a flood or a backfill
LOOPS_PAGE = 2000          # /loops page size (the route's maximum)
MAX_OFFERED = 60           # open loops handed to the model, newest first
POST_CAP = 15
MAX_SKEW_SECONDS = 60
LOCK_STALE_SECONDS = 3600
DISCORD_LIMIT = 1900
WEBHOOK_TRIES = 4
MAX_RETRY_AFTER = 30.0
MAX_EVIDENCE = 8
NAME_CAP = 100             # C1 (core/loops.ts LIMITS.name): owner, channel, by_name
ID_CAP = 100               # C1 (LIMITS.id): keys, codes, ids and times
SKIP_CHANNELS = {"standup", "general_announcements", "general"}
TYPES = ("unanswered_question", "unkept_promise", "stale_followup", "unticketed_ask")
MIN_AGE_HOURS = {"unanswered_question": 4, "unticketed_ask": 4, "unkept_promise": 24, "stale_followup": 48}
BASE_SETTINGS = ("GRYSSTOF_URL", "MCP_ACCESS_KEY", "XACTCO_MEMBERS")
SOURCE_RE = re.compile(r"^discord:([^/]+)/(\d+)/(\d+)$")
PROOF_RE = re.compile(r"^https://discord\.com/channels/([^/]+)/(\d+)/(\d+)$")
AUTHOR_RE = re.compile(r", \d{4}-\d{2}-\d{2}, ([^:\n]+?): ")
# The key grammar of plan v3.1 (core/loops.ts KEY_RE), always used with fullmatch: ASCII digits only (Python's \d
# matches other scripts' digits, JavaScript's does not) and nothing after the last part (Python's $ allows a newline).
KEY_RE = re.compile(r"([0-9]{17,20})(?::([a-z]))?(?::([0-9]{1,3}))?")
LETTERS = [""] + [chr(c) for c in range(ord("b"), ord("z") + 1)]
DISCORD_EPOCH_MS = 1420070400000

monotonic = time.monotonic  # module names, so the tests can drive the clock and skip the waits
sleep = time.sleep


class JobError(Exception):
    """A failure that ends the run with one line."""


class ConfigError(JobError):
    pass


class ModelError(JobError):
    pass


class RequestTimeout(JobError):
    """The request may still be running on the server: never assume it did not land."""


class HttpFailure(JobError):
    def __init__(self, message, code, body, headers):
        super().__init__(message)
        self.code, self.body, self.headers = code, body, headers


class Terminated(JobError):
    """SIGTERM (the cron timeout). Raised from the signal handler so the failure path runs."""


class DeadlineExceeded(JobError):
    pass


class LockHeld(Exception):
    def __init__(self, age_seconds: float):
        super().__init__(f"lock held for {age_seconds:.0f} s")
        self.age = age_seconds


def now_sast() -> datetime:
    return datetime.now(SAST)


def one_line(s) -> str:
    return re.sub(r"\s+", " ", str(s)).strip()


def log(event: str, *, err: bool = False, **fields) -> None:
    parts = [event]
    for k, v in fields.items():
        v = "" if v is None else str(v)
        parts.append(f"{k}={json.dumps(v, ensure_ascii=False) if re.search(r'[\s=]', v) or not v else v}")
    print(" ".join(parts), file=sys.stderr if err else sys.stdout)


def iso(at: datetime) -> str:
    return at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(s):
    if not isinstance(s, str) or not s or s == "-":
        return None
    try:
        at = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=UTC)


def snowflake_time(i):
    s = str(i).split(":")[0]
    return datetime.fromtimestamp(((int(s) >> 22) + DISCORD_EPOCH_MS) / 1000, UTC) if s.isdigit() else None


def read_env(path) -> dict:
    out = {}
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()  # also drops a stray \r
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


# --- the deadline -------------------------------------------------------------------------------------------

_deadline = None


def set_deadline(seconds) -> None:
    global _deadline
    _deadline = None if seconds is None else monotonic() + seconds


def remaining():
    return None if _deadline is None else _deadline - monotonic()


def budget(cap: float) -> float:
    """A call's timeout: its own cap, never past the run's deadline."""
    r = remaining()
    if r is None:
        return cap
    if r <= 0:
        raise DeadlineExceeded(f"the run passed its {DEADLINE_SECONDS} s deadline")
    return min(cap, r)


# --- C1: the line, as core/loops.ts writes it -----------------------------------------------------------------

# core/loops.ts UNSAFE: control characters, lone surrogate halves, line and paragraph separators, bidi controls.
UNSAFE_RE = re.compile("[\x00-\x1f\x7f-\x9f\ud800-\udfff\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]")
# JavaScript's \s, which the TypeScript side collapses and trims.
JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
SPACE_RE = re.compile(f"[{JS_SPACE}]+")
ID_DROP_RE = re.compile(f"[|,{JS_SPACE}]")
# JavaScript's String.prototype.trim() set, as code points (the same characters as JS_SPACE).
JS_TRIM = "".join(chr(c) for c in (*range(0x09, 0x0E), 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F,
                                   0x205F, 0x3000, 0xFEFF))
C1_FIELDS = {
    "OPEN": ("key", "client", "type", "owner", "channel", "channel_id", "opened", "reopened", "title", "summary", "evidence"),
    "CLOSED": ("key", "by_message", "closed", "reason"),
    "RESOLVED": ("key", "by_user", "by_name", "resolved", "note"),
    "PARKED": ("key", "by_user", "by_name", "until", "note"),
}
TAG_RE = re.compile(r"(OPEN|CLOSED|RESOLVED|PARKED)/([0-9]+)")
DAY_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")


class C1Refused(JobError):
    """compose() refusing a line that parse() could not read back; the message names the field."""


def sanitise(text, limit=None) -> str:
    """core/loops.ts sanitise(): every `|` removed; control, separator and bidi characters to spaces; whitespace
    collapsed and trimmed; cut to `limit` code points and trimmed again. No limit: not cut (for the post only)."""
    s = "" if text is None else str(text)
    s = SPACE_RE.sub(" ", UNSAFE_RE.sub(" ", s.replace("|", ""))).strip(" ")
    return s if limit is None else s[: max(0, limit)].strip(" ")


def clean_id(v) -> str:
    """core/loops.ts cleanId(): an id, key, code or time; nothing unsafe, no `|`, comma or whitespace; 100 code points."""
    s = "" if v is None else str(v)
    return ID_DROP_RE.sub("", UNSAFE_RE.sub("", s))[:ID_CAP]


def clean_evidence(ids) -> list:
    """core/loops.ts cleanEvidence(): cleaned, blanks and repeats dropped (first sighting keeps its place), last 8."""
    out = []
    for i in ids if isinstance(ids, list) else []:
        c = clean_id(i)
        if c and c not in out:
            out.append(c)
    return out[-MAX_EVIDENCE:]


def evidence_list(ids) -> list:
    """What the job writes: message ids in snowflake (time) order, the newest eight."""
    digits = {clean_id(i) for i in (ids or [])}
    return clean_evidence(sorted((d for d in digits if d.isdigit()), key=int))


def reopened_of(v):
    """core/loops.ts reopenedOf(): None when blank or '-' after cleaning."""
    c = "" if v is None else clean_id(v)
    return None if c in ("", "-") else c


def c1_sanitise(tag: str, w: dict) -> dict:
    """core/loops.ts sanitiseLine(), on the line's own (snake_case) field names: what parse(compose(w)) gives back."""
    if tag == "OPEN":
        return {"key": clean_id(w.get("key")), "client": clean_id(w.get("client")), "type": clean_id(w.get("type")),
                "owner": sanitise(w.get("owner"), NAME_CAP), "channel": sanitise(w.get("channel"), NAME_CAP),
                "channel_id": clean_id(w.get("channel_id")), "opened": clean_id(w.get("opened")),
                "reopened": reopened_of(w.get("reopened")), "title": sanitise(w.get("title"), 120),
                "summary": sanitise(w.get("summary"), 300), "evidence": clean_evidence(w.get("evidence"))}
    if tag == "CLOSED":
        return {"key": clean_id(w.get("key")), "by_message": clean_id(w.get("by_message")), "closed": clean_id(w.get("closed")),
                "reason": sanitise(w.get("reason"), 200)}
    if tag in ("RESOLVED", "PARKED"):
        when = "resolved" if tag == "RESOLVED" else "until"
        return {"key": clean_id(w.get("key")), "by_user": clean_id(w.get("by_user")), "by_name": sanitise(w.get("by_name"), NAME_CAP),
                when: clean_id(w.get(when)), "note": sanitise(w.get("note"), 300)}
    raise C1Refused(f"unknown loop line tag {tag!r}")


def is_instant(v) -> bool:
    """core/loops.ts isInstant(): ISO 8601 beginning YYYY-MM-DD, a calendar date that exists, a time that parses."""
    if not isinstance(v, str):
        return False
    m = DAY_RE.match(v)
    if not m or (len(v) > 10 and v[10] not in "T "):  # Python takes any character between date and time; Date.parse does not
        return False
    try:
        date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        datetime.fromisoformat(v[:-1] + "+00:00" if v.endswith("Z") else v)
    except ValueError:
        return False
    return True


def c1_invalid(tag: str, f: dict):
    """core/loops.ts invalid(): why these written fields make no readable line of this tag, or None."""
    if not f["key"]:
        return "key is blank"
    if not KEY_RE.fullmatch(f["key"]):
        return f'key "{f["key"][:40]}" does not match the key grammar'

    def when(name):
        return None if is_instant(f[name]) else f'{name} is not an ISO 8601 time: "{f[name][:40]}"'

    if tag == "OPEN":
        if f["type"] not in TYPES:
            return f'type "{f["type"][:40]}" is not one of {", ".join(TYPES)}'
        if f["reopened"] not in ("", "-") and not is_instant(f["reopened"]):
            return when("reopened")
        return when("opened")
    if tag == "CLOSED":
        return when("closed") if f["by_message"] else "by_message is blank"
    if tag == "RESOLVED":
        return when("resolved") if f["by_user"] else "by_user is blank"
    return when("until") if f["by_user"] else "by_user is blank"


def c1_compose(tag: str, w: dict) -> str:
    """core/loops.ts compose(): sanitise every field, refuse a line parse() could not read back, write it."""
    f = c1_sanitise(tag, w)
    if tag == "OPEN":
        f = {**f, "reopened": f["reopened"] or "-", "evidence": ",".join(f["evidence"])}
    problem = c1_invalid(tag, f)
    if problem:
        raise C1Refused(f"cannot compose a {tag} line: {problem}")
    return " | ".join([f"{tag}/1"] + [f"{name}={f[name]}" for name in C1_FIELDS[tag]])


def c1_parse(claim):
    """core/loops.ts parse(): (tag, fields as the fixture writes them), or None for a claim nobody can read.
    Strict about tag, version, which fields, the key grammar, types and times; tolerant of spacing and field order."""
    if not isinstance(claim, str) or "\r" in claim or "\n" in claim:
        return None
    parts = [p.strip(JS_TRIM) for p in claim.split("|")]
    m = TAG_RE.fullmatch(parts[0])
    if not m or m.group(2) != "1":
        return None
    tag, f = m.group(1), {}
    for p in parts[1:]:
        eq = p.find("=")
        if eq <= 0:
            return None
        name = p[:eq].strip(JS_TRIM)
        if name not in C1_FIELDS[tag] or name in f:
            return None
        f[name] = p[eq + 1:].strip(JS_TRIM)
    if any(name not in f for name in C1_FIELDS[tag]) or c1_invalid(tag, f):
        return None
    if tag == "OPEN":
        f["reopened"] = reopened_of(f["reopened"])
        f["evidence"] = [e for e in (x.strip(JS_TRIM) for x in f["evidence"].split(",")) if e]
    return tag, f


def open_line(f: dict) -> str:
    return c1_compose("OPEN", f)


def closed_line(key, by_message, closed, reason) -> str:
    return c1_compose("CLOSED", {"key": key, "by_message": by_message, "closed": closed, "reason": reason})


def esc(s) -> str:
    """Model text made inert in a Discord post, as the PA's esc() does."""
    return re.sub(r"([\\*_~`|>#\[\]()<@])", r"\\\1", str(s or ""))


# --- HTTP -----------------------------------------------------------------------------------------------------


def _request(method: str, url: str, *, headers=None, body=None) -> urllib.request.Request:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict(headers or {}))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    return req


def http_text(req: urllib.request.Request, label: str, cap: float = HTTP_TIMEOUT):
    timeout = budget(cap)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8"), r.headers
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace") if e.fp else ""
        finally:
            e.close()
        raise HttpFailure(f"{label} answered {e.code}: {one_line(detail)[:200]}", e.code, detail, e.headers) from None
    except urllib.error.URLError as e:
        if isinstance(e.reason, TimeoutError):
            raise RequestTimeout(f"{label} timed out after {timeout:.0f} s") from None
        raise JobError(f"{label} unreachable: {type(e).__name__}: {e}") from None
    except TimeoutError:
        raise RequestTimeout(f"{label} timed out after {timeout:.0f} s") from None
    except OSError as e:
        raise JobError(f"{label} unreachable: {type(e).__name__}: {e}") from None


def decode_mcp(raw: str) -> str:
    """The text of a tools/call reply, plain JSON or SSE (the last `data:` line). Errors raise."""
    text = raw.strip()
    if text.startswith(("event:", "data:")) or "\ndata:" in text:
        datas = [ln[5:].strip() for ln in text.splitlines() if ln.startswith("data:")]
        text = datas[-1] if datas else "{}"
    try:
        msg = json.loads(text)
    except ValueError:
        raise JobError(f"/mcp did not answer JSON-RPC: {one_line(raw)[:120]}") from None
    if not isinstance(msg, dict):
        raise JobError(f"/mcp answered {type(msg).__name__}, not a JSON-RPC object")
    if msg.get("error"):
        e = msg["error"] if isinstance(msg["error"], dict) else {"message": msg["error"]}
        raise JobError(f"/mcp error {e.get('code')}: {e.get('message')}")
    result = msg.get("result") or {}
    content = result.get("content") or [{}]
    first = content[0].get("text", "") if isinstance(content[0], dict) else ""
    if result.get("isError"):
        raise JobError(f"/mcp tool error: {one_line(first)[:200] or 'isError'}")
    return first


class Grysstof:
    """The two doors the job uses: GET /browse/api/... and POST /mcp (capture_thought)."""

    def __init__(self, url: str, key: str):
        u = url.strip().rstrip("/")
        self.base = u[:-4] if u.endswith("/mcp") else u
        self.mcp_url = self.base + "/mcp"
        self.headers = {"x-brain-key": key, "x-brain-actor": ACTOR}

    def get(self, route: str, **params) -> dict:
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        url = f"{self.base}/browse/api{route}" + (f"?{query}" if query else "")
        text, _ = http_text(_request("GET", url, headers=self.headers), f"/browse/api{route}")
        try:
            d = json.loads(text)
        except ValueError:
            raise JobError(f"/browse/api{route} did not answer JSON: {one_line(text)[:120]}") from None
        if not isinstance(d, dict):
            raise JobError(f"/browse/api{route} answered {type(d).__name__}, not an object")
        if d.get("error") is not None:  # the gate answers 200 with a JSON-RPC error; a route answers {"error": ...}
            e = d["error"]
            raise JobError(f"/browse/api{route} refused: " + (f"{e.get('code')}: {e.get('message')}" if isinstance(e, dict) else str(e)))
        return d

    def thoughts(self, since: str, offset: int, limit: int) -> list:
        rows = self.get("/thoughts", source_prefix="discord:", order="oldest", since=since, offset=offset, limit=limit).get("thoughts")
        if not isinstance(rows, list):
            raise JobError("/browse/api/thoughts answered without a thoughts list")
        return rows

    def pulse(self) -> dict:
        return self.get("/pulse/overview")

    def loops(self) -> dict:
        """Every loop in every state, paged by offset. A repeated page restarts the read once, then fails."""
        for attempt in (1, 2):
            out, keys, offset, first, repeated = [], set(), 0, None, False
            while True:
                d = self.get("/loops", state="all", limit=LOOPS_PAGE, offset=offset)
                page = d.get("loops")
                if not isinstance(page, list):
                    raise JobError("/browse/api/loops answered without a loops list")
                first = first or d
                page_keys = [str(lp.get("key")) for lp in page if isinstance(lp, dict)]
                if any(k in keys for k in page_keys):
                    repeated = True
                    break
                keys.update(page_keys)
                out.extend(page)
                total = d.get("total")
                if len(page) < LOOPS_PAGE or (isinstance(total, int) and len(out) >= total):
                    break
                offset += len(page)
            if not repeated:
                total = first.get("total")
                if isinstance(total, int) and len(out) < total:
                    raise JobError(f"/browse/api/loops gave {len(out)} of {total} loops; refusing a cut-off list")
                return {"loops": out, "unreadable": first.get("unreadable") or [], "warnings": first.get("warnings") or {}, "total": total}
            log("loops.repeated_page", err=True, offset=offset, attempt=attempt)
        raise JobError("/browse/api/loops repeated a page twice (does the route take offset?); refusing a list with loops counted twice")

    def history(self, subject: str) -> list:
        facts = self.get("/history", subject=subject).get("facts")
        if not isinstance(facts, list):
            raise JobError("/browse/api/history answered without a facts list")
        return facts

    def capture(self, w) -> str:
        args = {"content": w.claim, "subject": f"loop:{w.key}", "source": w.source, "proof": w.proof, "occurred_at": w.occurred_at}
        if w.supersedes:
            args["supersedes"] = w.supersedes
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "capture_thought", "arguments": args}}
        headers = {**self.headers, "Accept": "application/json, text/event-stream"}
        text, _ = http_text(_request("POST", self.mcp_url, headers=headers, body=body), "/mcp")
        reply = decode_mcp(text)
        m = re.match(r"Recorded fact (\S+) about " + re.escape(f"loop:{w.key}") + r"(?![\w:])", reply)
        if not m:
            raise JobError(f"capture_thought did not record the line: {one_line(reply)[:160]}")
        return m.group(1)


def read_window(g: Grysstof, since: str) -> list:
    """Every Discord thought since `since`, oldest first, paged by offset until a short page. WINDOW_CAP is the
    total over all pages. Messages moving under the read (a backfill) repeat a page: read again from the start, once."""
    for attempt in (1, 2):
        out, seen, offset, repeated = [], set(), 0, False
        while True:
            page = g.thoughts(since, offset, PAGE)
            if len(page) > PAGE:
                raise JobError(f"/browse/api/thoughts returned {len(page)} rows for a page of {PAGE}")
            ids = [str(t.get("id")) for t in page]
            if any(i in seen for i in ids):
                repeated = True
                break
            seen.update(ids)
            out.extend(page)
            if len(out) >= WINDOW_CAP:
                raise JobError(f"the {DAYS}-day window holds {WINDOW_CAP} or more messages in total; refusing to build a cut-off transcript")
            if len(page) < PAGE:
                return out
            offset += len(page)
        log("window.repeated_page", err=True, offset=offset, attempt=attempt, detail="messages moved while reading; reading again from the start")
    raise JobError("/browse/api/thoughts repeated a page twice; refusing a transcript with messages counted twice")


def send(webhook: str, text: str) -> int:
    """The post, in chunks. A 429 waits for Discord's retry_after and tries again (WEBHOOK_TRIES in all)."""
    parts = chunks(text)
    for part in parts:
        for attempt in range(1, WEBHOOK_TRIES + 1):
            req = _request("POST", webhook + "?wait=true", headers={"User-Agent": "open-loops/2.0"},
                           body={"content": part, "allowed_mentions": {"parse": []}})
            try:
                http_text(req, "webhook")
                break
            except HttpFailure as e:
                if e.code != 429 or attempt == WEBHOOK_TRIES:
                    raise
                wait = retry_after(e)
                log("webhook.rate_limited", err=True, wait=wait, attempt=attempt)
                sleep(wait)
    return len(parts)


def retry_after(e: HttpFailure) -> float:
    try:
        wait = float(json.loads(e.body or "{}").get("retry_after"))
    except (ValueError, TypeError, AttributeError):
        try:
            wait = float((e.headers or {}).get("Retry-After"))
        except (ValueError, TypeError):
            wait = 1.0
    return min(MAX_RETRY_AFTER, max(0.0, wait))


def chunks(text: str) -> list:
    out, cur = [], ""
    for line in text.split("\n"):
        while len(line) > DISCORD_LIMIT:
            if cur:
                out.append(cur)
                cur = ""
            out.append(line[:DISCORD_LIMIT])
            line = line[DISCORD_LIMIT:]
        if len(cur) + len(line) + 1 > DISCORD_LIMIT:
            out.append(cur)
            cur = line
        else:
            cur = f"{cur}\n{line}" if cur else line
    if cur:
        out.append(cur)
    return out


# --- messages ------------------------------------------------------------------------------------------------


def author_of(content: str):
    if not content.startswith("Discord #"):
        return None
    m = AUTHOR_RE.search(content)
    return m.group(1).strip() if m else None


def body_of(content: str) -> str:
    m = AUTHOR_RE.search(content)
    return (content[m.end():] if m and content.startswith("Discord #") else content).strip()


def reactions_of(v) -> list:
    out = []
    for r in v if isinstance(v, list) else []:
        if isinstance(r, dict) and r.get("emoji"):
            out.append({"emoji": str(r["emoji"]), "by": [str(b) for b in r.get("by") or [] if b]})
    return out


def load(thoughts: list, portal_sources: set) -> list:
    """Window thoughts as messages m1..mN in time order. Ids come from metadata (after C4) or from the source."""
    msgs = []
    for t in thoughts:
        meta = t.get("metadata") or {}
        source = str(meta.get("source") or "")
        sm = SOURCE_RE.match(source)
        channel = meta.get("channel")
        ts = parse_time(t.get("createdAt"))
        if not sm or not isinstance(channel, str) or not channel.strip() or ts is None:
            continue
        channel = channel.strip().lstrip("#")
        if channel.casefold() in SKIP_CHANNELS:
            continue
        guild, src_channel, mid = sm.groups()
        content = str(t.get("content") or "")
        cid = meta.get("channel_id")
        msgs.append({
            "ts": ts.astimezone(SAST), "channel": channel, "author": author_of(content) or "?", "text": body_of(content),
            "source": source, "msg_id": mid, "guild": guild,
            "channel_id": str(cid) if cid else src_channel, "parent_id": str(meta.get("parent_id") or ""),
            "ids_known": bool(cid), "author_id": str(meta.get("author_id") or ""),
            "reply_to_source": str(meta.get("in_reply_to") or ""), "reactions": reactions_of(meta.get("reactions")),
            "link": str(meta.get("proof") or f"https://discord.com/channels/{guild}/{src_channel}/{mid}"),
            "portal": source in portal_sources,
        })
    msgs.sort(key=lambda m: (m["ts"], int(m["msg_id"])))
    for i, m in enumerate(msgs, 1):
        m["id"] = f"m{i}"
    by_source = {m["source"]: m["id"] for m in msgs}
    for m in msgs:
        m["reply_to"] = by_source.get(m["reply_to_source"], "")
    return msgs


def slug(c) -> str:
    s = str(c or "").strip().casefold()
    return s[len("client:"):] if s.startswith("client:") else s


def client_map(pulse: dict) -> dict:
    """Channel name (case-folded) to client slug, or None for a channel that is not a client's."""
    out = {}
    for row in pulse.get("mapping") or []:
        if not isinstance(row, dict):
            continue
        ch = str(row.get("channel") or "").strip().lstrip("#").casefold()
        c = row.get("client")
        out[ch] = slug(c) if isinstance(c, str) and c.startswith("client:") else None
    return out


def known_clients(pulse: dict) -> set:
    """Every client the server knows: a card per client subject, and every mapped channel's client."""
    cards = {slug(c.get("client")) for c in pulse.get("cards") or [] if isinstance(c, dict) and c.get("client")}
    return {c for c in cards | set(client_map(pulse).values()) if c}


def transcript(msgs: list, mapping: dict) -> str:
    out = []
    for ch in sorted({m["channel"] for m in msgs}):
        client = mapping.get(ch.casefold())
        out.append(f"\n=== #{ch}" + (f" · client {client}" if client else "") + " ===")
        for m in (x for x in msgs if x["channel"] == ch):
            extra = f" (reply to {m['reply_to']})" if m["reply_to"] else ""
            if m["reactions"]:
                extra += " [reactions: " + ", ".join(f"{r['emoji']} by {'/'.join(r['by'])}" for r in m["reactions"]) + "]"
            flag = " ⚑portal" if m["portal"] else ""
            out.append(f"[{m['id']}]{flag} {m['ts']:%a %d %b %H:%M} {m['author']}{extra}: {m['text'].replace(chr(10), ' ')[:600]}")
    return "\n".join(out)


@dataclass
class Members:
    """XACTCO_MEMBERS: Discord user ids. Names only for messages captured before author ids were stored."""
    ids: set
    names: set

    def learn(self, msgs: list) -> None:
        for m in msgs:
            if m["author_id"] and m["author_id"] in self.ids and m["author"] != "?":
                self.names.add(m["author"].casefold())


def parse_members(raw) -> Members:
    ids, names = set(), set()
    for part in str(raw or "").split(","):
        uid, _, name = part.strip().partition(":")
        if uid.strip():
            ids.add(uid.strip())
        if name.strip():
            names.add(name.strip().casefold())
    return Members(ids, names)


# --- C5: the model exchange -----------------------------------------------------------------------------------

SYSTEM = """You keep the list of OPEN LOOPS for a software company's Discord channels (client-support and internal channels).
An open loop is something raised in the messages that nothing afterwards in the messages closes.

You get the loops already recorded as open (each with a key), the loops already finished whose first message is in this window (each with a key), the list of known clients, and the messages of the last seven days, each with an id like m12.

Another tool already reports unanswered asks. Messages it reports are marked "⚑portal". NEVER report a new loop that uses a ⚑portal message as evidence. Report as new only what that tool cannot see:
(a) someone responded (a reply, a reaction, a partial answer) but a concrete deliverable, decision or answer is still owed;
(b) a promise or a "waiting on" item (not an ask) with no later follow-up.

Loop types:
- unanswered_question: a question or request for action directed at someone, with no later message that answers it or does it.
- unkept_promise: someone said they would do / check / follow up / send something, with no later message showing it happened.
- stale_followup: an item said to be waiting ("lets see if we get a reply", "hopefully next week", "will update") where time has passed with no further message.
- unticketed_ask: a client or colleague asks for a change or fix and nothing shows it was logged or scheduled.

For each recorded open loop, say what the messages show, under "existing":
- still_open: nothing in the messages closes it. You may leave a still-open loop out.
- closed_by: a later message in the same channel answers it, does it, or clearly takes ownership. Give that message's id in "message".
- owner_now: the person or role it waits on has clearly changed. Give the new owner in "owner" and the message that shows it in "message".
- evidence_add: newer messages are about the same loop and it is still open. List their ids in "evidence".
Use only the keys given. Never report a recorded open loop under "new".

For a finished loop: if a message raises that same thing again, report it under "new" with that loop's "key". A different thing owed in the same message is a new loop without "key".

Rules:
1. Use ONLY the messages given. Every claim must cite the message ids that show it. Never invent an id or a fact.
2. A loop is CLOSED if a later message in the same channel answers it, does it, or clearly acknowledges and takes ownership. A reaction from the addressed person (thumbs up, prayer hands) means acknowledged, not done: keep it open only if a deliverable is still owed.
3. Skip chit-chat, gifs, thanks, greetings, and anything a person says about their own day in passing.
4. Describe the state, never the person. Never use a person as the subject of "has not", "did not", "failed" or "ignored". Write "No reply in the channel since Tue 14:10" (good), never "Kelli has not replied" (bad). No judgement of anyone's work, speed or competence.
4b. Never mention message ids (m12 etc.) inside title, summary or why_open. Ids go only in "evidence" and "message".
5. 'owner' is the person or role the loop is waiting on, only if the messages make that clear; otherwise "unclear".
6. One loop per distinct thing owed. A message holding two asks gives two loops, each citing that message.
7. A loop lives in one channel: "channel" names it, and every message in "evidence" comes from that channel (a thread counts as its channel). Cite the message that raised it and the messages that show it is still open; do not cite earlier messages as background: the oldest message you cite is taken as the one that raised the loop.
8. "client" is the client the messages are about, from the list of known clients given with the messages, or null.
9. Order new loops by how much it matters to a client relationship: client-facing channels and client-visible deliverables first.
10. Return at most 15 new loops. Fewer is fine. If nothing is open, return empty lists. Do not pad.
11. Answer once. Return exactly one JSON object and nothing before or after it.

Return ONLY JSON in this shape:
{"existing":[{"key":"as given","status":"still_open|closed_by|owner_now|evidence_add","message":"m12","owner":"name","evidence":["m3"]}],
 "new":[{"key":"only when it re-reports a recorded loop","channel":"name","client":"slug or null","type":"unanswered_question|unkept_promise|stale_followup|unticketed_ask","title":"at most 8 words, names the thing owed, e.g. Azure 6498 update for Swanzo","summary":"one plain sentence","owner":"name or unclear","evidence":["m4","m9"],"why_open":"one sentence on what is missing"}]}"""


def state_of(lp: dict) -> str:
    return str(lp.get("state") or "").casefold()


def activity(lp: dict) -> float:
    at = parse_time(lp.get("reopened")) or parse_time(lp.get("opened"))
    return at.timestamp() if at else 0.0


def newest_first(loops: list) -> list:
    return sorted(loops, key=lambda lp: (activity(lp), str(lp.get("key"))), reverse=True)


def split_key(key):
    m = KEY_RE.fullmatch(str(key or ""))
    return (m.group(1), m.group(2) or "", int(m.group(3) or 1)) if m else None


def finish_time(lp: dict):
    """When a finished loop finished. A RESOLVED line's claimed time is trusted no later than when the ledger learned
    it (a wrong clock or a hand-written future time must not decide suppression); CLOSED keeps the message's time."""
    claimed, learned = parse_time(lp.get("closed")), parse_time(lp.get("learnedAt"))
    if state_of(lp) == "resolved":
        known = [t for t in (claimed, learned) if t]
        return min(known) if known else None
    return claimed or learned


def finished_in_window(loops: list, msgs: list) -> list:
    ids = {m["msg_id"] for m in msgs}
    return sorted((lp for lp in loops if isinstance(lp, dict) and state_of(lp) in ("closed", "resolved")
                   and (split_key(lp.get("key")) or ("",))[0] in ids), key=lambda lp: str(lp.get("key")))


def model_input(now: datetime, msgs: list, offered: list, not_offered: int, mapping: dict, finished=(), clients=()) -> str:
    by_msg = {m["msg_id"]: m["id"] for m in msgs}
    lines = [f"Now is {now:%A %d %B %Y %H:%M} SAST.", "",
             'Loops already recorded as open (attach to these by key under "existing"; never report one of them under "new"):']
    for lp in offered:
        ev = evidence_list(lp.get("evidence"))
        known = [by_msg[e] for e in ev if e in by_msg]
        older = len(ev) - len(known)
        evs = ", ".join(known) + (f" and {older} older" if known and older else (f"{older} older" if older else ""))
        parts = [f"- key {lp.get('key')}", sanitise(lp.get("title"), 120), f"#{sanitise(lp.get('channel'))}",
                 f"waiting on {sanitise(lp.get('owner')) or 'unclear'}", f"evidence {evs or 'none in this window'}"]
        reopened = parse_time(lp.get("reopened"))
        if reopened:
            parts.append(f"reopened {reopened.astimezone(SAST):%a %d %b %H:%M}")
        lines.append(" · ".join(parts))
    if not offered:
        lines.append("(none)")
    if not_offered:
        lines.append(f"({not_offered} older open loops are not listed; do not report them.)")
    lines += ["", 'Loops already finished whose first message is in this window (if a message raises one of these again, '
                  'report it under "new" with its "key"):']
    for lp in finished:
        done = finish_time(lp)
        lines.append(" · ".join([f"- key {lp.get('key')}", sanitise(lp.get("title"), 120), f"#{sanitise(lp.get('channel'))}",
                                 f"{state_of(lp)}" + (f" {done.astimezone(SAST):%a %d %b %H:%M}" if done else "")]))
    if not finished:
        lines.append("(none)")
    lines += ["", f"Clients: {', '.join(sorted(clients)) or '(none known)'}", "",
              "Messages (oldest first within each channel):", transcript(msgs, mapping)]
    return "\n".join(lines)


def stream_messages(api_key: str, model: str, system: str, user: str) -> tuple:
    """One streamed Messages call: the answer's text and the token usage. Anything off raises ModelError."""
    body = {"model": model, "max_tokens": MAX_TOKENS, "system": system, "stream": True,
            "messages": [{"role": "user", "content": user}]}
    req = _request("POST", ANTHROPIC_URL, headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"}, body=body)
    parts, usage, stop, done = [], {}, None, False
    try:
        with urllib.request.urlopen(req, timeout=budget(MODEL_IDLE_TIMEOUT)) as r:
            for raw in r:
                left = remaining()
                if left is not None and left <= 0:
                    raise ModelError(f"the model pass ran past the run's {DEADLINE_SECONDS} s deadline")
                line = raw.decode("utf-8").strip()
                if not line.startswith("data:"):
                    continue
                ev = json.loads(line[5:].strip())
                kind = ev.get("type")
                if kind == "message_start":
                    usage["input_tokens"] = ((ev.get("message") or {}).get("usage") or {}).get("input_tokens")
                elif kind == "content_block_delta":
                    delta = ev.get("delta") or {}
                    if delta.get("type") == "text_delta":  # thinking blocks are not the answer
                        parts.append(delta.get("text", ""))
                elif kind == "message_delta":
                    stop = (ev.get("delta") or {}).get("stop_reason") or stop
                    usage["output_tokens"] = (ev.get("usage") or {}).get("output_tokens")
                elif kind == "message_stop":
                    done = True
                elif kind == "error":
                    e = ev.get("error") or {}
                    raise ModelError(f"model stream error {e.get('type')}: {e.get('message')}")
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace") if e.fp else ""
        finally:
            e.close()
        raise ModelError(f"model answered {e.code}: {one_line(detail)[:200]}") from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise ModelError(f"model call failed: {type(e).__name__}: {e}") from None
    if not done:
        raise ModelError("model stream ended before message_stop")
    if stop not in ("end_turn", "stop_sequence"):
        raise ModelError(f"model stopped with {stop}")
    return "".join(parts), usage


def anthropic_provider(env: dict):
    """The one model provider today. Returns ask(system, user) -> text."""
    key, model = env.get("ANTHROPIC_API_KEY", ""), env.get("OPEN_LOOPS_MODEL") or DEFAULT_MODEL

    def ask(system: str, user: str) -> str:
        text, usage = stream_messages(key, model, system, user)
        log("model.ok", provider="anthropic", model=model, tokens_in=usage.get("input_tokens"), tokens_out=usage.get("output_tokens"))
        return text

    return ask


# The model port: provider name -> factory(env) -> ask(system, user) -> text (raises ModelError).
PROVIDERS = {"anthropic": anthropic_provider}
PROVIDER_SETTINGS = {"anthropic": ("ANTHROPIC_API_KEY",)}


def parse_model(raw: str) -> dict:
    dec, i, found = json.JSONDecoder(), 0, None
    while (i := raw.find("{", i)) != -1:
        try:
            obj, end = dec.raw_decode(raw, i)
        except json.JSONDecodeError:
            i += 1
            continue
        if isinstance(obj, dict) and ("existing" in obj or "new" in obj):
            found = obj
        i = end
    if found is None:
        raise ModelError("no JSON object with 'existing' or 'new' in the model's answer")
    for k in ("existing", "new"):
        v = found.get(k) or []
        if not isinstance(v, list):
            raise ModelError(f"model answer: '{k}' is not a list")
        found[k] = v
    return found


# --- C2 and C5 in code (the job owns these rules, plan v3.1) --------------------------------------------------


@dataclass
class Write:
    kind: str                 # open | update | close | unpark
    key: str
    claim: str
    supersedes: str | None
    source: str
    proof: str
    occurred_at: str
    record: dict              # the loop as it reads after this line, for the dry run's post
    closer: dict | None = None


@dataclass
class Plan:
    writes: list = field(default_factory=list)
    counts: Counter = field(default_factory=Counter)
    notes: list = field(default_factory=list)


def is_unclear(v) -> bool:
    return not v or str(v).strip().casefold() in {"unclear", "unknown", "?", "none", "null", "-", "n/a"}


def strip_ids(s) -> str:
    return re.sub(r"\s*\(?\bm\d+\b(?:\s*,\s*m\d+)*\)?", "", str(s or "")).strip()


def norm_title(s) -> str:
    """A title for matching: case, punctuation and spacing ignored."""
    return " ".join(re.findall(r"\w+", str(s or "").casefold()))


def opener_source(lp: dict) -> str:
    m = PROOF_RE.match(str(lp.get("proof") or ""))
    return f"discord:{m.group(1)}/{m.group(2)}/{m.group(3)}" if m else ACTOR


def same_channel(lp: dict, msg: dict):
    """(in the loop's channel, only by name). Ids decide; a name only for a message captured before C4."""
    lid = str(lp.get("channelId") or "")
    if lid and lid in (msg["channel_id"], msg["parent_id"]):
        return True, False
    if (not msg["ids_known"] or not lid) and msg["channel"].casefold() == str(lp.get("channel") or "").casefold():
        return True, True
    return False, False


def accept_close(lp: dict, msg: dict, members: Members):
    """C5: same channel, later than opened and reopened, written by a member. (ok, refusal reason, weak notes)."""
    notes = []
    inside, by_name = same_channel(lp, msg)
    if not inside:
        return False, "wrong_channel", []
    if by_name:
        notes.append(f"close.weak key={lp['key']} reason=channel_by_name message={msg['id']}")
    opened, reopened = parse_time(lp.get("opened")), parse_time(lp.get("reopened"))
    if opened is None or msg["ts"] <= opened or (reopened is not None and msg["ts"] <= reopened):
        return False, "before_open", []
    if msg["author_id"]:
        if msg["author_id"] not in members.ids:
            return False, "non_member", []
    elif msg["author"].casefold() in members.names:
        notes.append(f"close.weak key={lp['key']} reason=author_by_name message={msg['id']}")
    else:
        return False, "non_member", []
    return True, "", notes


def check_new(n, by_mid: dict, now: datetime, plan: Plan):
    """Real ids; evidence only from the channel the model names (row 3); no portal message; a known type; old enough."""
    if not isinstance(n, dict):
        plan.counts["bad_entry"] += 1
        return None
    ids = n.get("evidence")
    if not isinstance(ids, list) or not ids or any(str(e) not in by_mid for e in ids):
        plan.counts["bad_id"] += 1
        return None
    cited = list({by_mid[str(e)]["id"]: by_mid[str(e)] for e in ids}.values())
    channel = str(n.get("channel") or "").strip().lstrip("#").casefold()
    ev = [m for m in cited if m["channel"].casefold() == channel]
    if len(ev) < len(cited):
        plan.counts["cross_channel"] += len(cited) - len(ev)
        plan.notes.append(f"new.cross_channel channel={channel or '-'} dropped={','.join(m['id'] for m in cited if m not in ev)}")
    if not ev:
        plan.counts["bad_channel"] += 1
        return None
    if any(m["portal"] for m in ev):
        plan.counts["on_portal"] += 1
        return None
    kind = n.get("type")
    if kind not in TYPES:
        plan.counts["bad_type"] += 1
        return None
    if (now - max(m["ts"] for m in ev)).total_seconds() / 3600 < MIN_AGE_HOURS[kind]:
        plan.counts["too_young"] += 1
        return None
    summary = strip_ids(n.get("summary"))
    title = strip_ids(n.get("title")) or summary[:70]
    if not title:
        plan.counts["bad_entry"] += 1
        return None
    owner = str(n.get("owner") or "").strip()
    return {"title": title, "summary": summary, "type": kind, "owner": "unclear" if is_unclear(owner) else owner,
            "client": n.get("client"), "ev": ev, "opener": min(ev, key=lambda m: (m["ts"], int(m["msg_id"]))),
            "key": str(n.get("key") or "").strip() or None}


def classify(out, msgs: list, loops_reply: dict, members: Members, mapping: dict, now: datetime, offered=None, clients=None) -> Plan:
    """The model's answer, checked against the record and the messages, as the lines to write. Pure."""
    out = out or {}
    plan = Plan()
    loops = [lp for lp in (loops_reply or {}).get("loops") or [] if isinstance(lp, dict) and lp.get("key")]
    by_key = {str(lp["key"]): lp for lp in loops}
    unreadable = {k[0] for k in (split_key(str(u.get("subject", ""))[len("loop:"):])
                                 for u in (loops_reply or {}).get("unreadable") or [] if isinstance(u, dict)) if k}
    by_mid = {m["id"]: m for m in msgs}
    offered = set(offered) if offered is not None else {k for k, lp in by_key.items() if state_of(lp) == "open"}
    known = {slug(c) for c in (clients or ())} | {c for c in mapping.values() if c}
    closes = {}                                                   # key -> closing message
    changes = defaultdict(lambda: {"owner": None, "evidence": [], "touched": []})

    for e in out.get("existing") or []:
        if not isinstance(e, dict):
            plan.counts["bad_entry"] += 1
            continue
        key = str(e.get("key") or "")
        if key not in offered or key not in by_key:
            plan.counts["unknown_key"] += 1
            plan.notes.append(f"existing.unknown_key key={key or '-'}")
            continue
        lp, status = by_key[key], e.get("status")
        if status in (None, "still_open"):
            continue
        if status == "closed_by":
            if key in closes:
                continue
            msg = by_mid.get(str(e.get("message") or ""))
            if msg is None:
                plan.counts["close_bad_id"] += 1
                plan.notes.append(f"close.refused key={key} reason=bad_id message={e.get('message')}")
                continue
            ok, why, weak = accept_close(lp, msg, members)
            if not ok:
                plan.counts[f"close_{why}"] += 1
                plan.notes.append(f"close.refused key={key} reason={why} message={msg['id']}")
                continue
            plan.notes.extend(weak)
            closes[key] = msg
        elif status == "owner_now":
            new, old = str(e.get("owner") or "").strip(), str(lp.get("owner") or "").strip()
            if is_unclear(new) or is_unclear(old) or new.casefold() == old.casefold():
                plan.counts["owner_ignored"] += 1
                continue
            changes[key]["owner"] = new
            m = by_mid.get(str(e.get("message") or ""))
            if m:
                changes[key]["touched"].append(m)
        elif status == "evidence_add":
            for mid in e.get("evidence") if isinstance(e.get("evidence"), list) else []:
                m = by_mid.get(str(mid))
                if m is None:
                    plan.counts["evidence_bad_id"] += 1
                else:
                    changes[key]["evidence"].append(m)
        else:
            plan.counts["bad_status"] += 1

    def family(opener_id: str) -> dict:
        """Letter (or "") -> (newest generation, its number, every title in that letter's line) for this opener."""
        out_ = {}
        for lp in loops:
            k = split_key(lp["key"])
            if not k or k[0] != opener_id:
                continue
            head, gen, titles = out_.get(k[1], (None, 0, set()))
            titles.add(norm_title(lp.get("title")))
            out_[k[1]] = (lp, k[2], titles) if k[2] > gen else (head, gen, titles)
        return out_

    def finished_at(lp: dict):
        if lp["key"] in closes:
            return closes[lp["key"]]["ts"]
        return finish_time(lp) if state_of(lp) in ("closed", "resolved") else None

    opens = {}  # key -> {"it": item, "opened": time}

    def add_open(key: str, it: dict, opened: datetime) -> None:
        if key in opens:
            have = opens[key]
            have["it"]["ev"] += [m for m in it["ev"] if m not in have["it"]["ev"]]
            have["opened"] = min(have["opened"], opened)
        else:
            opens[key] = {"it": {**it, "ev": list(it["ev"])}, "opened": opened}

    attached, free = [], defaultdict(list)
    for n in out.get("new") or []:
        it = check_new(n, by_mid, now, plan)
        if not it:
            continue
        target = None
        if it["key"]:  # the model says which recorded loop this is (row 2)
            k = split_key(it["key"])
            if it["key"] in by_key and k:
                target = (k[0], k[1])
            else:
                plan.counts["unknown_key_new"] += 1
                plan.notes.append(f"new.unknown_key key={it['key']}")
        if not target:  # else by title, within the family of the item's own opener (row 1)
            nt, opener_id = norm_title(it["title"]), it["opener"]["msg_id"]
            target = next(((opener_id, letter) for letter, (_, _, titles) in sorted(family(opener_id).items()) if nt and nt in titles), None)
        if target:
            attached.append((it, target))
        else:
            free[it["opener"]["msg_id"]].append(it)

    for it, (opener_id, letter) in attached:
        head, gen, _ = family(opener_id)[letter]
        base = opener_id + (f":{letter}" if letter else "")
        done = finished_at(head)
        if done is None and state_of(head) == "open":      # C2 rule 1: a re-sighting adds evidence
            changes[head["key"]]["evidence"].extend(it["ev"])
            plan.counts["resighted_open"] += 1
        elif done is None and state_of(head) == "parked":  # C2 rule 1: parked stays parked, nothing written
            plan.counts["resighted_parked"] += 1
        elif done is not None:                              # C2 rule 2, for the loop it attached to only
            later = [m for m in it["ev"] if m["ts"] > done]
            if later:
                add_open(f"{base}:{gen + 1}", it, min(m["ts"] for m in later))
            else:
                plan.counts["resighted_closed"] += 1
                plan.notes.append(f"new.resighted_closed key={head['key']} title={json.dumps(it['title'], ensure_ascii=False)}")
        else:
            plan.counts["unknown_state"] += 1
            plan.notes.append(f"new.unknown_state key={head['key']} state={head.get('state')}")

    for opener_id in sorted(free, key=int):
        items = sorted(free[opener_id], key=lambda it: (it["title"].casefold(), it["title"]))
        if opener_id in unreadable:
            plan.counts["unreadable_conflict"] += len(items)
            plan.notes.append(f"new.unreadable_conflict opener={opener_id} items={len(items)}")
            continue
        merged = {}
        for it in items:  # two items with one title are one loop
            nt = norm_title(it["title"])
            if nt in merged:
                merged[nt]["ev"] += [m for m in it["ev"] if m not in merged[nt]["ev"]]
            else:
                merged[nt] = {**it, "ev": list(it["ev"])}
        taken = set(family(opener_id)) | {split_key(k)[1] for k in opens if split_key(k) and split_key(k)[0] == opener_id}
        for it in merged.values():  # C2 rule 3: fresh letters, in title order, only the ones not in use (row 1)
            letter = next((x for x in LETTERS if x not in taken), None)
            if letter is None:
                plan.counts["no_letter"] += 1
                continue
            taken.add(letter)
            add_open(opener_id + (f":{letter}" if letter else ""), it, it["opener"]["ts"])

    def add(build) -> None:
        """One write, composed by C1; a line C1 refuses is counted and named, never written and never fatal."""
        try:
            plan.writes.append(build())
        except C1Refused as e:
            plan.counts["unwritable"] += 1
            plan.notes.append(f"write.refused {one_line(e)[:200]}")

    for key in sorted(closes):
        lp, msg = by_key[key], closes[key]
        record = {**lp, "state": "closed", "closed": iso(msg["ts"]), "byMessage": msg["msg_id"]}
        add(lambda: Write("close", key, closed_line(key, msg["msg_id"], iso(msg["ts"]), f"member reply in #{msg['channel']}"),
                          lp.get("lineId"), msg["source"], msg["link"], iso(msg["ts"]), record, closer=msg))
    for key in sorted(changes):
        if key in closes:
            continue
        lp, ch = by_key[key], changes[key]
        good = []
        for m in ch["evidence"]:
            if same_channel(lp, m)[0]:
                good.append(m)
            else:
                plan.counts["cross_channel"] += 1
                plan.notes.append(f"evidence.cross_channel key={key} message={m['id']}")
        stored = evidence_list(lp.get("evidence"))
        merged = evidence_list(list(lp.get("evidence") or []) + [m["msg_id"] for m in good])
        if merged == stored and not ch["owner"]:
            plan.counts["evidence_unchanged"] += 1
            continue
        fields = {"key": key, "client": lp.get("client"), "type": lp.get("type"), "owner": ch["owner"] or lp.get("owner"),
                  "channel": lp.get("channel"), "channel_id": lp.get("channelId"), "opened": lp.get("opened"),
                  "reopened": lp.get("reopened"), "title": lp.get("title"), "summary": lp.get("summary"), "evidence": merged}
        at = max((m["ts"] for m in good + ch["touched"]), default=now)
        record = {**lp, "owner": fields["owner"], "evidence": merged}
        add(lambda: Write("update", key, open_line(fields), lp.get("lineId"), opener_source(lp), str(lp.get("proof") or ""),
                          iso(at), record))
    for key in sorted(opens):
        add(lambda: new_open(key, opens[key]["it"], opens[key]["opened"], mapping, known))
    return plan


def new_open(key: str, it: dict, opened: datetime, mapping: dict, known: set) -> Write:
    op = it["opener"]
    model_client = slug(it["client"]) if isinstance(it["client"], str) and slug(it["client"]) in known else None
    evidence = evidence_list([m["msg_id"] for m in it["ev"]])
    fields = {"key": key, "client": mapping.get(op["channel"].casefold()) or model_client or "internal", "type": it["type"],
              "owner": it["owner"], "channel": op["channel"], "channel_id": op["parent_id"] or op["channel_id"],
              "opened": iso(opened), "reopened": None, "title": it["title"], "summary": it["summary"], "evidence": evidence}
    record = {"key": key, "state": "open", "client": fields["client"], "type": it["type"], "owner": it["owner"],
              "channel": op["channel"], "channelId": fields["channel_id"], "opened": fields["opened"], "reopened": None,
              "title": sanitise(it["title"], 120), "summary": sanitise(it["summary"], 300), "evidence": evidence, "proof": op["link"]}
    return Write("open", key, open_line(fields), None, op["source"], op["link"], iso(opened), record)


# --- parked loops whose time is up ----------------------------------------------------------------------------


def until_of(lp: dict):
    """When a parked loop comes back. A bare date (what the Park button writes) is the start of that day in SAST."""
    u = str(lp.get("until") or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", u):
        try:
            return datetime.fromisoformat(u).replace(tzinfo=SAST)
        except ValueError:
            return None
    return parse_time(u)


def due_parked(loops: list, now: datetime) -> list:
    due = []
    for lp in loops:
        if not isinstance(lp, dict) or state_of(lp) != "parked":
            continue
        until = until_of(lp)
        if until is None:
            log("unpark.bad_until", err=True, key=lp.get("key"), until=lp.get("until") or "-",
                detail="not a date anyone can read; the loop stays parked until it is fixed")
        elif until <= now:
            due.append(lp)
    return due


def previous_open(facts: list, parked_id, key: str):
    """The OPEN line a PARKED line covers: back along `supersedes` first, else the newest readable OPEN line."""
    by_id = {f.get("id"): f for f in facts if isinstance(f, dict)}

    def open_fields(f):
        r = c1_parse(f.get("claim"))  # the strict C1 reader: an unreadable line is never carried forward
        return r[1] if r and r[0] == "OPEN" and r[1]["key"] == key else None

    seen = {parked_id}
    cur = by_id.get((by_id.get(parked_id) or {}).get("supersedes"))
    while cur is not None and cur.get("id") not in seen:
        seen.add(cur.get("id"))
        found = open_fields(cur)
        if found:
            return cur, found
        cur = by_id.get(cur.get("supersedes"))
    for f in facts:  # /history is newest first
        found = open_fields(f) if isinstance(f, dict) else None
        if found:
            return f, found
    return None


def unpark_write(g: Grysstof, lp: dict, now: datetime) -> Write:
    """One OPEN line superseding the PARKED line, every OPEN field carried from the OPEN line before it."""
    subject = f"loop:{lp['key']}"
    hit = previous_open(g.history(subject), lp.get("lineId"), str(lp["key"]))
    if not hit:
        raise JobError(f"no readable OPEN line in the history of {subject}")
    fact, f = hit  # f as c1_parse reads it: reopened is None or a time, evidence a list
    reopened = f["reopened"]
    evidence = list(f["evidence"])
    fields = {"key": lp["key"], "client": f["client"], "type": f["type"], "owner": f["owner"], "channel": f["channel"],
              "channel_id": f["channel_id"], "opened": f["opened"], "reopened": reopened, "title": f["title"],
              "summary": f["summary"], "evidence": evidence}
    proof = str(fact.get("proof") or lp.get("proof") or "")
    record = {**lp, "state": "open", "client": f["client"], "type": f["type"], "owner": f["owner"], "channel": f["channel"],
              "channelId": f["channel_id"], "opened": f["opened"], "reopened": reopened, "title": f["title"],
              "summary": f["summary"], "evidence": clean_evidence(evidence), "proof": proof,
              "until": None, "byUser": None, "byName": None, "note": None}
    return Write("unpark", str(lp["key"]), open_line(fields), lp.get("lineId"), opener_source({"proof": proof}), proof, iso(now), record)


def unpark_due(g: Grysstof, loops: list, now: datetime, post: bool) -> tuple:
    """Parked loops whose `until` has passed, back to OPEN. Returns the unparks that hold and a Counter of the rest."""
    done, stats = [], Counter()
    for lp in due_parked(loops, now):
        try:
            w = unpark_write(g, lp, now)
        except (Terminated, DeadlineExceeded):
            raise
        except JobError as e:
            log("unpark.failed", err=True, key=lp.get("key"), error=one_line(e)[:200])
            stats["failed"] += 1
            continue
        if post:
            status, fid = write_line(g, w)
            if status != "ok":
                stats[status] += 1
                continue
            w.record["lineId"] = fid  # a close or update later in this run supersedes this line, not the PARKED one
        else:
            w.record["lineId"] = f"(after unpark of {lp.get('lineId')})"
        done.append(w)
    return done, stats


# --- writing --------------------------------------------------------------------------------------------------


def landed(facts: list, w: Write):
    return next((f for f in facts if isinstance(f, dict) and f.get("claim") == w.claim
                 and (f.get("supersedes") or None) == (w.supersedes or None)), None)


def write_line(g: Grysstof, w: Write) -> tuple:
    """One capture_thought. Returns (status, the new line's id or None); status is ok, failed, conflict or unknown.

    A timeout may still land on the server, so it is never retried: pause, re-read once, and say "unknown" if the
    line is not there yet. Any other failure re-reads too: written already (ok), changed by someone (conflict), or,
    for a line that supersedes another, retried once. A line without `supersedes` is never retried (row 5)."""
    subject = f"loop:{w.key}"
    for attempt in (1, 2):
        try:
            fid = g.capture(w)
            log("write.ok", kind=w.kind, key=w.key, id=fid, attempt=attempt)
            return "ok", fid
        except (Terminated, DeadlineExceeded):
            raise
        except RequestTimeout as e:
            log("write.timeout", err=True, kind=w.kind, key=w.key, attempt=attempt, error=one_line(e)[:200])
            sleep(REREAD_PAUSE)
            try:
                hit = landed(g.history(subject), w)
            except Terminated:
                raise
            except JobError as e2:
                log("write.reread_failed", err=True, key=w.key, error=one_line(e2)[:200])
                hit = None
            if hit:
                log("write.landed_late", key=w.key, id=hit.get("id"))
                return "ok", hit.get("id")
            log("write.unknown", err=True, key=w.key, detail="timed out and not there on the re-read; not retried; check /loops")
            return "unknown", None
        except JobError as e:
            log("write.failed", err=True, kind=w.kind, key=w.key, attempt=attempt, error=one_line(e)[:200])
        try:
            facts = g.history(subject)
        except (Terminated, DeadlineExceeded):
            raise
        except JobError as e:
            log("write.reread_failed", err=True, key=w.key, error=one_line(e)[:200])
            return "failed", None
        hit = landed(facts, w)
        if hit:
            log("write.landed_despite_error", key=w.key, id=hit.get("id"))
            return "ok", hit.get("id")
        if not w.supersedes:
            log("write.not_retried", err=True, key=w.key, detail="a line that supersedes nothing is never sent twice")
            return "failed", None
        head = next((f for f in facts if isinstance(f, dict) and not f.get("supersededBy")), None)
        if head is None or head.get("id") != w.supersedes:
            log("write.conflict", key=w.key, detail="the loop changed since it was read; left as it is",
                expected=w.supersedes, head=(head or {}).get("id", "-"))
            return "conflict", None
        if attempt == 2:
            return "failed", None
    return "failed", None


def apply_plan(g: Grysstof, writes: list) -> tuple:
    done, stats = [], Counter()
    for i, w in enumerate(writes):
        try:
            status, _ = write_line(g, w)  # every request's budget() raises DeadlineExceeded once the deadline has passed
        except DeadlineExceeded:
            stats["not_made"] += len(writes) - i
            log("write.deadline", err=True, not_made=len(writes) - i, detail=f"the run reached its {DEADLINE_SECONDS} s deadline")
            break
        if status == "ok":
            done.append(w)
        else:
            stats[status] += 1
    return done, stats


def project(loops: list, applied: list) -> list:
    cur = {str(lp.get("key")): lp for lp in loops if isinstance(lp, dict)}
    for w in applied:
        cur[w.key] = w.record
    return list(cur.values())


# --- the post -------------------------------------------------------------------------------------------------


def age_str(delta: timedelta) -> str:
    delta = max(delta, timedelta(0))
    return f"{delta.days}d {delta.seconds // 3600}h" if delta.days else f"{delta.seconds // 3600}h"


def md_title(lp: dict) -> str:
    return esc(sanitise(lp.get("title"), 120) or sanitise(lp.get("summary"), 70) or str(lp.get("key")))


def last_activity(lp: dict) -> datetime:
    times = [snowflake_time(e) for e in evidence_list(lp.get("evidence"))]
    times += [parse_time(lp.get("opened")), parse_time(lp.get("reopened"))]
    return max((t for t in times if t), default=datetime.fromtimestamp(0, UTC))


def link_of(lp: dict, links: dict) -> str:
    for e in reversed(evidence_list(lp.get("evidence"))):
        if e in links:
            return links[e]
    return str(lp.get("proof") or "")


def plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def build_post(now: datetime, loops: list, *, closes=(), counts=None, model_failed=False, not_evaluated=0,
               unreadable=0, stats=None, portal_ids=frozenset(), links=None) -> str:
    counts, stats, links = counts or {}, stats or {}, links or {}
    open_ = newest_first([lp for lp in loops if isinstance(lp, dict) and state_of(lp) == "open"])
    lines = [f"**Open loops** · {now:%a %d %b %Y} · {len(open_)} waiting"]
    if model_failed:
        lines.append("⚠ **model pass failed; list may be stale.** This is the record as the job found it.")
    for i, lp in enumerate(open_[:POST_CAP], 1):
        head = f"\n**{i}.** [{md_title(lp)}](<{link_of(lp, links)}>)"
        if str(lp.get("key")).split(":")[0] in portal_ids:
            lines.append(head + " · ⚑ also on the portal")
            continue
        lines.append(head)
        lines.append(f"#{esc(sanitise(lp.get('channel')))} · waiting on {esc(sanitise(lp.get('owner'))) or 'unclear'} · {age_str(now - last_activity(lp))}")
        if lp.get("summary"):
            lines.append(esc(sanitise(lp.get("summary"), 300)))
    if not open_:
        lines.append("\nNothing open. (If this reads empty for days, check the job rather than trust the calm.)")
    if len(open_) > POST_CAP:
        lines.append(f"\n_{len(open_) - POST_CAP} older, see /loops in the Xactco server._")
    if not_evaluated:
        lines.append(f"_{not_evaluated} loops not evaluated this run (only the newest {MAX_OFFERED} go to the model)._")
    if closes:
        lines.append("\n**Closed in channel this run**")
        for w in closes:
            lines.append(f"- [{md_title(w.record)}](<{w.closer['link']}>) · #{esc(sanitise(w.closer['channel']))}")
    if counts.get("resighted_closed"):
        lines.append(f"\n_{counts['resighted_closed']} re-sightings of closed loops suppressed._")
    if unreadable:
        lines.append(f"_{unreadable} loop lines unreadable; see /loops._")
    if stats.get("conflict"):
        lines.append(f"_{plural(stats['conflict'], 'loop', 'loops')} changed by someone else during the run; left as they are._")
    if stats.get("failed"):
        lines.append(f"_{plural(stats['failed'], 'ledger write', 'ledger writes')} failed; this list may be out of date._")
    if stats.get("unknown"):
        lines.append(f"_{plural(stats['unknown'], 'ledger write', 'ledger writes')} timed out; whether they landed is unknown (check /loops)._")
    if stats.get("not_made"):
        lines.append(f"_{plural(stats['not_made'], 'ledger write', 'ledger writes')} not made: the run reached its {DEADLINE_SECONDS} s deadline._")
    if stats.get("reread_failed"):
        lines.append("_/loops could not be read again after the writes; this list is the job's own view._")
    lines.append("\n_Reads Discord only. A loop closed in Azure DevOps, email, a call or in person still shows here._")
    lines.append("To resolve, press /loops in the Xactco server.")
    return "\n".join(lines)


# --- runs -----------------------------------------------------------------------------------------------------


def read_state(g: Grysstof, now: datetime) -> dict:
    pulse = g.pulse()
    portal = {str(le.get("source")) for le in pulse.get("looseEnds") or [] if isinstance(le, dict) and le.get("source")}
    thoughts = read_window(g, iso(now - timedelta(days=DAYS)))
    msgs = load(thoughts, portal)
    lr = g.loops()
    return {"portal": portal, "mapping": client_map(pulse), "clients": known_clients(pulse), "thoughts": len(thoughts),
            "msgs": msgs, "loops": lr}


def provider_of(env: dict) -> str:
    provider = (env.get("OPEN_LOOPS_MODEL_PROVIDER") or DEFAULT_PROVIDER).strip()
    if provider not in PROVIDERS:
        raise ConfigError(f"OPEN_LOOPS_MODEL_PROVIDER={provider} is not one of: {', '.join(sorted(PROVIDERS))}")
    return provider


def config(env: dict, post: bool) -> tuple:
    provider = provider_of(env)
    needed = list(BASE_SETTINGS) + list(PROVIDER_SETTINGS.get(provider, ())) + (["OPEN_LOOPS_WEBHOOK"] if post else [])
    missing = [k for k in needed if not env.get(k)]
    if missing:
        raise ConfigError(f"missing from the env file: {', '.join(missing)}")
    members = parse_members(env["XACTCO_MEMBERS"])
    if not members.ids or not all(i.isdigit() for i in members.ids):
        raise ConfigError("XACTCO_MEMBERS must be comma-separated Discord user ids, each optionally id:Name")
    return members, PROVIDERS[provider](env)


def fresh_loops(g: Grysstof, fallback: list, stats: Counter) -> tuple:
    """The list the post is built from: /loops read now (row 7), or the job's own view if that read fails."""
    try:
        lr = g.loops()
        return lr["loops"], len(lr.get("unreadable") or [])
    except (Terminated,):
        raise
    except JobError as e:
        log("post.reread_failed", err=True, error=one_line(e)[:200])
        stats["reread_failed"] += 1
        return fallback, None


def run(env: dict, post: bool) -> int:
    members, ask = config(env, post)
    now = now_sast()
    set_deadline(DEADLINE_SECONDS)
    try:
        return _run(env, post, members, ask, now)
    finally:
        set_deadline(None)


def _run(env: dict, post: bool, members: Members, ask, now: datetime) -> int:
    g = Grysstof(env["GRYSSTOF_URL"], env["MCP_ACCESS_KEY"])
    s = read_state(g, now)
    msgs, lr, mapping, clients = s["msgs"], s["loops"], s["mapping"], s["clients"]
    unparked, stats = unpark_due(g, lr["loops"], now, post)
    if post:
        log("unparked", count=len(unparked), **{k: v for k, v in sorted(stats.items())})
    else:
        print(f"would unpark {len(unparked)}")
        for w in unparked:
            print(f"  unpark loop:{w.key} supersedes {w.supersedes} :: {w.claim}")
    lr = {**lr, "loops": project(lr["loops"], unparked)}  # an unparked loop takes part in this run as open
    members.learn(msgs)
    portal_ids = {src.rsplit("/", 1)[-1] for src in s["portal"]}
    links = {m["msg_id"]: m["link"] for m in msgs}
    open_now = newest_first([lp for lp in lr["loops"] if isinstance(lp, dict) and state_of(lp) == "open"])
    offered = open_now[:MAX_OFFERED]
    not_evaluated = len(open_now) - len(offered)
    unreadable = len(lr.get("unreadable") or [])
    finished = finished_in_window(lr["loops"], msgs)
    log("window", now=f"{now:%a %d %b %H:%M} SAST", thoughts=s["thoughts"], messages=len(msgs),
        channels=len({m["channel"] for m in msgs}), open_loops=len(open_now), offered=len(offered),
        finished_in_window=len(finished), unreadable=unreadable, portal_loose_ends=len(s["portal"]))

    try:
        raw = ask(SYSTEM, model_input(now, msgs, offered, not_evaluated, mapping, finished, clients))
        left = remaining()
        if left is not None and left <= 0:
            raise ModelError(f"the model pass ran past the run's {DEADLINE_SECONDS} s deadline")
        answer = parse_model(raw)
    except (ModelError, DeadlineExceeded) as e:
        log("model.failed", err=True, error=one_line(e)[:300])
        set_deadline(None)
        loops_now, fresh_unreadable = fresh_loops(g, lr["loops"], stats) if post else (lr["loops"], None)
        text = build_post(now, loops_now, model_failed=True, not_evaluated=not_evaluated,
                          unreadable=unreadable if fresh_unreadable is None else fresh_unreadable,
                          stats=stats, portal_ids=portal_ids, links=links)
        if post:
            log("posted", messages=send(env["OPEN_LOOPS_WEBHOOK"], text))
        else:
            print("--- DRY RUN: nothing written, nothing posted ---\n" + text)
        return 1
    log("model.answer", existing=len(answer["existing"]), new=len(answer["new"]))

    plan = classify(answer, msgs, lr, members, mapping, now, {str(lp["key"]) for lp in offered}, clients=clients)
    for note in plan.notes:
        print(note)
    if plan.counts:
        log("checks", **{k: v for k, v in sorted(plan.counts.items())})
    by_kind = Counter(w.kind for w in plan.writes)
    if post:
        applied, write_stats = apply_plan(g, plan.writes)
        stats.update(write_stats)
        done = Counter(w.kind for w in applied)
        log("written", opened=done["open"], closed=done["close"], updated=done["update"], **{k: v for k, v in sorted(write_stats.items())})
        set_deadline(None)
        loops_now, fresh_unreadable = fresh_loops(g, project(lr["loops"], applied), stats)
        if fresh_unreadable is not None:
            unreadable = fresh_unreadable
    else:
        applied = plan.writes
        print(f"would open {by_kind['open']}, close {by_kind['close']}, update {by_kind['update']}")
        for w in plan.writes:
            print(f"  {w.kind} loop:{w.key}" + (f" supersedes {w.supersedes}" if w.supersedes else "") + f" :: {w.claim}")
        loops_now = project(lr["loops"], applied)
    text = build_post(now, loops_now, closes=[w for w in applied if w.kind == "close"], counts=plan.counts,
                      not_evaluated=not_evaluated, unreadable=unreadable, stats=stats, portal_ids=portal_ids, links=links)
    if post:
        log("posted", messages=send(env["OPEN_LOOPS_WEBHOOK"], text))
    else:
        print("--- DRY RUN: nothing written, nothing posted ---\n" + text)
    failing = sum(stats[k] for k in ("failed", "unknown", "not_made", "reread_failed"))
    return 1 if failing else 0  # a conflict alone is not a failure (row 7)


def clock_skew() -> tuple:
    """Seconds the Pi's clock is ahead of Discord's (negative: behind), and Discord's time."""
    text, headers = http_text(_request("GET", DISCORD_CLOCK_URL, headers={"User-Agent": "open-loops/2.0"}), "discord clock")
    date = headers.get("Date") if headers else None
    if not date:
        raise JobError("Discord answered without a Date header")
    theirs = email.utils.parsedate_to_datetime(date)
    return (now_sast() - theirs).total_seconds(), theirs


def run_check(env: dict) -> int:
    ok = True
    try:
        provider = provider_of(env)
    except ConfigError as e:
        print(f"settings: {one_line(e)}")
        provider, ok = DEFAULT_PROVIDER, False
    checked = list(PROVIDER_SETTINGS.get(provider, ())) + ["OPEN_LOOPS_WEBHOOK"] + list(BASE_SETTINGS)
    print(f"settings (provider {provider}): " + " | ".join(f"{k} {'set' if env.get(k) else 'MISSING'}" for k in checked))
    if any(not env.get(k) for k in checked):
        ok = False
    members = parse_members(env.get("XACTCO_MEMBERS"))
    print(f"members: {len(members.ids)} user ids, {len(members.names)} names")
    if env.get("GRYSSTOF_URL") and env.get("MCP_ACCESS_KEY"):
        try:
            s = read_state(Grysstof(env["GRYSSTOF_URL"], env["MCP_ACCESS_KEY"]), now_sast())
            states = Counter(state_of(lp) for lp in s["loops"]["loops"] if isinstance(lp, dict))
            print(f"grysstof: {len(s['msgs'])} messages in the window, loops {dict(sorted(states.items()))}, "
                  f"{len(due_parked(s['loops']['loops'], now_sast()))} parked due back, "
                  f"{len(s['loops'].get('unreadable') or [])} unreadable, portal lists {len(s['portal'])} loose ends")
        except Terminated:
            raise
        except JobError as e:
            print(f"grysstof: FAILED {one_line(e)[:300]}")
            ok = False
    try:
        skew, theirs = clock_skew()
        good = abs(skew) <= MAX_SKEW_SECONDS
        print(f"clock: {'ok' if good else 'FAILED'}, Pi is {skew:+.0f} s against Discord ({theirs:%H:%M:%S} UTC); limit {MAX_SKEW_SECONDS} s")
        ok = ok and good
    except Terminated:
        raise
    except JobError as e:
        print(f"clock: FAILED {one_line(e)[:300]}")
        ok = False
    return 0 if ok else 1


def acquire_lock(path):
    """A non-blocking exclusive lock held for the life of the returned file. LockHeld(age) if another run has it."""
    fh = open(path, "a+")
    try:
        fh.seek(0)
        if fcntl:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        fh.close()
        try:
            age = time.time() - os.path.getmtime(path)
        except OSError:
            age = 0.0
        raise LockHeld(age) from None
    os.utime(path, None)  # the lock's age is the time this run started
    return fh


def release_lock(fh) -> None:
    try:
        if not fcntl:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    fh.close()


def readable_console() -> None:
    """A console that cannot show a character (a Pi in the C locale, a Windows code page) gets a `?`,
    never an exception: the failure path prints marks like ⚠ and must not die printing them. The post
    itself goes to Discord as UTF-8 JSON and keeps every mark."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):
            pass  # not a text stream that can be reconfigured (a test's StringIO); nothing to protect


def _on_sigterm(signum, frame):
    raise Terminated("terminated by SIGTERM (the cron line's `timeout 900`?)")


def main(argv=None) -> int:
    readable_console()
    p = argparse.ArgumentParser(description="Open loops: the morning list, kept as a ledger record.")
    p.add_argument("--env", default=str(DEFAULT_ENV), help="env file with the settings (default %(default)s)")
    p.add_argument("--post", action="store_true", help="write the ledger lines and post; without it nothing is written")
    p.add_argument("--check", action="store_true", help="reads, settings and the clock only")
    p.add_argument("--lock", help="lock file held for the run")
    args = p.parse_args(argv)
    try:
        env = read_env(args.env)
    except OSError as e:
        print(f"FAILED: cannot read the env file {args.env}: {e.strerror or e}", file=sys.stderr)
        return 2
    lock = None
    if args.lock:
        try:
            lock = acquire_lock(args.lock)
        except LockHeld as held:
            if held.age > LOCK_STALE_SECONDS:
                msg = f"previous run still holding the lock ({args.lock}, taken {held.age / 3600:.1f} h ago)"
                print(f"FAILED: {msg}", file=sys.stderr)
                if args.post and env.get("OPEN_LOOPS_WEBHOOK"):
                    try:
                        send(env["OPEN_LOOPS_WEBHOOK"], f"**Open loops job**: {msg}; this run did nothing.")
                    except JobError as e:
                        print(f"FAILED: and the post saying so failed: {one_line(e)[:200]}", file=sys.stderr)
            else:
                print(f"FAILED: another run holds the lock {args.lock}; exiting", file=sys.stderr)
            return 3
    installed, previous = False, None
    try:
        previous = signal.signal(signal.SIGTERM, _on_sigterm)
        installed = True
    except (ValueError, OSError, AttributeError):
        pass  # not the main thread, or no SIGTERM here: cron's timeout then ends the run without a post
    try:
        return run_check(env) if args.check else run(env, args.post)
    except Exception as e:  # never fail silently: one line here, and in the channel when posting
        set_deadline(None)
        print(f"FAILED: {type(e).__name__}: {one_line(e)[:400]}", file=sys.stderr)
        if args.post and not args.check and env.get("OPEN_LOOPS_WEBHOOK"):
            try:
                send(env["OPEN_LOOPS_WEBHOOK"], f"**Open loops job failed** ({now_sast():%a %d %b %H:%M}): {type(e).__name__}: {one_line(e)[:300]}")
            except Exception as e2:
                print(f"FAILED: and the post saying so failed: {one_line(e2)[:200]}", file=sys.stderr)
        return 2 if isinstance(e, ConfigError) else 1
    finally:
        if installed:
            signal.signal(signal.SIGTERM, previous if previous is not None else signal.SIG_DFL)
        if lock:
            release_lock(lock)


if __name__ == "__main__":
    sys.exit(main())
