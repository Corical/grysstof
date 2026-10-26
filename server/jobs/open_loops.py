#!/usr/bin/env python3
"""Open loops: the morning list of what is still owed in the Xactco Discord, kept as a record.

Reads the last 7 days of Discord messages and every recorded loop through Grysstof's read API, asks the
model which recorded loops closed or moved and which new ones exist (contract C5 of plan 5), checks every
claim in code, writes one ledger line per change through /mcp (C1, C2), and posts the list.

Usage:
  open_loops.py --env FILE --check     reads, settings present, Pi clock vs Discord; no model, no writes, no post
  open_loops.py --env FILE             dry run: model pass, prints "would open N, close M, update K" and the post
  open_loops.py --env FILE --post      writes the ledger lines, then posts to the webhook
  --lock FILE                          take this lock for the run; if another run holds it, exit at once
                                       (and, with --post, say so in the channel when it is over an hour old)

Env file (KEY=value lines): ANTHROPIC_API_KEY, OPEN_LOOPS_WEBHOOK, GRYSSTOF_URL (the server's /mcp URL),
MCP_ACCESS_KEY, XACTCO_MEMBERS (comma-separated Discord user ids, each optionally "id:Name").

Standard library only. Every Grysstof, Discord and webhook call has a 30-second timeout; the streamed model call
allows 120 seconds of silence. Every failure prints one line and exits non-zero.
"""
import argparse
import email.utils
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows, where the tests run
    fcntl = None
    import msvcrt

SAST = timezone(timedelta(hours=2))
UTC = timezone.utc
DEFAULT_ENV = Path("/home/corical/open-loops/.env")
MODEL = "claude-sonnet-5-5"
MAX_TOKENS = 16000
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
DISCORD_CLOCK_URL = "https://discord.com/api/v10/gateway"
ACTOR = "open-loops"
DAYS = 7
HTTP_TIMEOUT = 30          # seconds, every Grysstof, Discord and webhook call
MODEL_IDLE_TIMEOUT = 120   # the model call streams; this is the longest silence allowed while it thinks with its
                           # thinking hidden (the default), which can be a long pause before the first text
                           # (the whole run is bounded by `timeout 900` in cron)
PAGE = 500                 # /thoughts page size
WINDOW_CAP = 2000          # a window this big is a flood or a backfill: fail rather than cut it
LOOPS_LIMIT = 2000
MAX_OFFERED = 60           # open loops handed to the model, newest first
POST_CAP = 15
MAX_SKEW_SECONDS = 60
LOCK_STALE_SECONDS = 3600
DISCORD_LIMIT = 1900
MAX_EVIDENCE = 8
SKIP_CHANNELS = {"standup", "general_announcements", "general"}
TYPES = ("unanswered_question", "unkept_promise", "stale_followup", "unticketed_ask")
MIN_AGE_HOURS = {"unanswered_question": 4, "unticketed_ask": 4, "unkept_promise": 24, "stale_followup": 48}
REQUIRED = ("GRYSSTOF_URL", "MCP_ACCESS_KEY", "XACTCO_MEMBERS", "ANTHROPIC_API_KEY")
CHECKED = ("ANTHROPIC_API_KEY", "OPEN_LOOPS_WEBHOOK", "GRYSSTOF_URL", "MCP_ACCESS_KEY", "XACTCO_MEMBERS")
SOURCE_RE = re.compile(r"^discord:([^/]+)/(\d+)/(\d+)$")
PROOF_RE = re.compile(r"^https://discord\.com/channels/([^/]+)/(\d+)/(\d+)$")
AUTHOR_RE = re.compile(r", \d{4}-\d{2}-\d{2}, ([^:\n]+?): ")
KEY_RE = re.compile(r"^(\d+)(?::([a-z]))?(?::(\d+))?$")
DISCORD_EPOCH_MS = 1420070400000


class JobError(Exception):
    """A failure that ends the run with one line."""


class ConfigError(JobError):
    pass


class ModelError(JobError):
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


# --- C1: the line ---------------------------------------------------------------------------------------------


def sanitise(text, limit=None) -> str:
    """No `|`, no line breaks or control characters, whitespace collapsed, cut to `limit` characters."""
    s = "" if text is None else str(text)
    s = "".join(" " if unicodedata.category(c) in ("Cc", "Zl", "Zp") else c for c in s).replace("|", "")
    s = re.sub(r"\s+", " ", s).strip()
    if limit and len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    return s


def evidence_list(ids) -> list:
    """Message ids, unique, oldest to newest, the newest MAX_EVIDENCE kept."""
    uniq = {str(i).strip() for i in (ids or []) if str(i).strip().isdigit()}
    return sorted(uniq, key=int)[-MAX_EVIDENCE:]


def compose(tag: str, pairs) -> str:
    return " | ".join([tag] + [f"{k}={v}" for k, v in pairs])


def open_line(f: dict) -> str:
    return compose("OPEN/1", [
        ("key", sanitise(f["key"])),
        ("client", sanitise(f.get("client")) or "internal"),
        ("type", sanitise(f.get("type"))),
        ("owner", sanitise(f.get("owner")) or "unclear"),
        ("channel", sanitise(f.get("channel"))),
        ("channel_id", sanitise(f.get("channel_id"))),
        ("opened", sanitise(f.get("opened"))),
        ("reopened", sanitise(f.get("reopened")) or "-"),
        ("title", sanitise(f.get("title"), 120)),
        ("summary", sanitise(f.get("summary"), 300)),
        ("evidence", ",".join(evidence_list(f.get("evidence")))),
    ])


def closed_line(key, by_message, closed, reason) -> str:
    return compose("CLOSED/1", [("key", sanitise(key)), ("by_message", sanitise(by_message)),
                                ("closed", sanitise(closed)), ("reason", sanitise(reason, 200))])


# --- HTTP -----------------------------------------------------------------------------------------------------


def _request(method: str, url: str, *, headers=None, body=None) -> urllib.request.Request:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict(headers or {}))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    return req


def http_text(req: urllib.request.Request, label: str):
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return r.read().decode("utf-8"), r.headers
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace") if e.fp else ""
        finally:
            e.close()
        raise JobError(f"{label} answered {e.code}: {one_line(detail)[:200]}") from None
    except (urllib.error.URLError, OSError) as e:
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
        d = self.get("/loops", state="all", limit=LOOPS_LIMIT)
        if not isinstance(d.get("loops"), list):
            raise JobError("/browse/api/loops answered without a loops list")
        total = d.get("total")
        if isinstance(total, int) and total > len(d["loops"]):
            raise JobError(f"/browse/api/loops returned {len(d['loops'])} of {total} loops; refusing a cut-off list")
        return d

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
    """Every Discord thought since `since`, oldest first, paged by offset until a short page."""
    out, seen, offset = [], set(), 0
    while True:
        page = g.thoughts(since, offset, PAGE)
        if len(page) > PAGE:
            raise JobError(f"/browse/api/thoughts returned {len(page)} rows for a page of {PAGE}")
        if page and str(page[0].get("id")) in seen:
            raise JobError(f"/browse/api/thoughts repeated a page at offset {offset}; refusing to loop")
        seen.update(str(t.get("id")) for t in page)
        out.extend(page)
        if len(out) >= WINDOW_CAP:
            raise JobError(f"the {DAYS}-day window holds {WINDOW_CAP} or more messages; refusing to build a cut-off transcript")
        if len(page) < PAGE:
            return out
        offset += len(page)


def send(webhook: str, text: str) -> int:
    parts = chunks(text)
    for part in parts:
        req = _request("POST", webhook + "?wait=true", headers={"User-Agent": "open-loops/2.0"},
                       body={"content": part, "allowed_mentions": {"parse": []}})
        http_text(req, "webhook")
    return len(parts)


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


def client_map(pulse: dict) -> dict:
    """Channel name (case-folded) to client slug, or None for a channel that is not a client's."""
    out = {}
    for row in pulse.get("mapping") or []:
        if not isinstance(row, dict):
            continue
        ch = str(row.get("channel") or "").strip().lstrip("#").casefold()
        c = row.get("client")
        out[ch] = c[len("client:"):] if isinstance(c, str) and c.startswith("client:") else None
    return out


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

You get the loops already recorded as open, each with a key, and the messages of the last seven days, each with an id like m12.

Another tool already reports unanswered asks. Messages it reports are marked "⚑portal". NEVER report a new loop that uses a ⚑portal message as evidence. Report as new only what that tool cannot see:
(a) someone responded (a reply, a reaction, a partial answer) but a concrete deliverable, decision or answer is still owed;
(b) a promise or a "waiting on" item (not an ask) with no later follow-up.

Loop types:
- unanswered_question: a question or request for action directed at someone, with no later message that answers it or does it.
- unkept_promise: someone said they would do / check / follow up / send something, with no later message showing it happened.
- stale_followup: an item said to be waiting ("lets see if we get a reply", "hopefully next week", "will update") where time has passed with no further message.
- unticketed_ask: a client or colleague asks for a change or fix and nothing shows it was logged or scheduled.

For each recorded loop, say what the messages show, under "existing":
- still_open: nothing in the messages closes it. You may leave a still-open loop out.
- closed_by: a later message in the same channel answers it, does it, or clearly takes ownership. Give that message's id in "message".
- owner_now: the person or role it waits on has clearly changed. Give the new owner in "owner" and the message that shows it in "message".
- evidence_add: newer messages are about the same loop and it is still open. List their ids in "evidence".
Use only the keys given. Never report a recorded loop under "new".

Rules:
1. Use ONLY the messages given. Every claim must cite the message ids that show it. Never invent an id or a fact.
2. A loop is CLOSED if a later message in the same channel answers it, does it, or clearly acknowledges and takes ownership. A reaction from the addressed person (thumbs up, prayer hands) means acknowledged, not done: keep it open only if a deliverable is still owed.
3. Skip chit-chat, gifs, thanks, greetings, and anything a person says about their own day in passing.
4. Describe the state, never the person. Never use a person as the subject of "has not", "did not", "failed" or "ignored". Write "No reply in the channel since Tue 14:10" (good), never "Kelli has not replied" (bad). No judgement of anyone's work, speed or competence.
4b. Never mention message ids (m12 etc.) inside title, summary or why_open. Ids go only in "evidence" and "message".
5. 'owner' is the person or role the loop is waiting on, only if the messages make that clear; otherwise "unclear".
6. One loop per distinct thing owed. A message holding two asks gives two loops, each citing that message.
7. For a new loop, cite the message that raised it and the messages that show it is still open. Do not cite earlier messages as background: the oldest message you cite is taken as the one that raised the loop.
8. "client" is the client named in the channel's header, or null.
9. Order new loops by how much it matters to a client relationship: client-facing channels and client-visible deliverables first.
10. Return at most 15 new loops. Fewer is fine. If nothing is open, return empty lists. Do not pad.
11. Answer once. Return exactly one JSON object and nothing before or after it.

Return ONLY JSON in this shape:
{"existing":[{"key":"as given","status":"still_open|closed_by|owner_now|evidence_add","message":"m12","owner":"name","evidence":["m3"]}],
 "new":[{"channel":"name","client":"slug or null","type":"unanswered_question|unkept_promise|stale_followup|unticketed_ask","title":"at most 8 words, names the thing owed, e.g. Azure 6498 update for Swanzo","summary":"one plain sentence","owner":"name or unclear","evidence":["m4","m9"],"why_open":"one sentence on what is missing"}]}"""


def state_of(lp: dict) -> str:
    return str(lp.get("state") or "").casefold()


def activity(lp: dict) -> float:
    at = parse_time(lp.get("reopened")) or parse_time(lp.get("opened"))
    return at.timestamp() if at else 0.0


def newest_first(loops: list) -> list:
    return sorted(loops, key=lambda lp: (activity(lp), str(lp.get("key"))), reverse=True)


def model_input(now: datetime, msgs: list, offered: list, not_offered: int, mapping: dict) -> str:
    by_msg = {m["msg_id"]: m["id"] for m in msgs}
    lines = [f"Now is {now:%A %d %B %Y %H:%M} SAST.", "",
             'Loops already recorded as open (attach to these by key; never report one of them under "new"):']
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
    lines += ["", "Messages (oldest first within each channel):", transcript(msgs, mapping)]
    return "\n".join(lines)


def ask_model(api_key: str, user: str) -> tuple:
    """One streamed Messages call; the text of the answer and the token usage. Anything off raises ModelError."""
    body = {"model": MODEL, "max_tokens": MAX_TOKENS, "system": SYSTEM, "stream": True,
            "messages": [{"role": "user", "content": user}]}
    req = _request("POST", ANTHROPIC_URL, headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"}, body=body)
    parts, usage, stop, done = [], {}, None, False
    try:
        with urllib.request.urlopen(req, timeout=MODEL_IDLE_TIMEOUT) as r:
            for raw in r:
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
        detail = e.read().decode("utf-8", "replace") if e.fp else ""
        raise ModelError(f"model answered {e.code}: {one_line(detail)[:200]}") from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise ModelError(f"model call failed: {type(e).__name__}: {e}") from None
    if not done:
        raise ModelError("model stream ended before message_stop")
    if stop not in ("end_turn", "stop_sequence"):
        raise ModelError(f"model stopped with {stop}")
    return "".join(parts), usage


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


# --- C2 and C5 in code ----------------------------------------------------------------------------------------


@dataclass
class Write:
    kind: str                 # open | update | close
    key: str
    claim: str
    supersedes: str | None
    source: str
    proof: str
    occurred_at: str
    record: dict              # the loop as it reads after this line, for the post
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


def split_key(key):
    m = KEY_RE.match(str(key))
    return (m.group(1), m.group(2) or "", int(m.group(3) or 1)) if m else None


def opener_source(lp: dict) -> str:
    m = PROOF_RE.match(str(lp.get("proof") or ""))
    return f"discord:{m.group(1)}/{m.group(2)}/{m.group(3)}" if m else ACTOR


def accept_close(lp: dict, msg: dict, members: Members):
    """C5: same channel, later than opened and reopened, written by a member. (ok, refusal reason, weak notes)."""
    notes = []
    lid = str(lp.get("channelId") or "")
    if lid and lid in (msg["channel_id"], msg["parent_id"]):
        pass
    elif not msg["ids_known"] and msg["channel"].casefold() == str(lp.get("channel") or "").casefold():
        notes.append(f"close.weak key={lp['key']} reason=channel_by_name message={msg['id']}")
    else:
        return False, "wrong_channel", []
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


def finish_time(lp: dict):
    return parse_time(lp.get("closed")) or parse_time(lp.get("learnedAt"))


def check_new(n, by_mid: dict, now: datetime, plan: Plan):
    """The Pi script's checks, unchanged in spirit: real ids, no portal message, a known type, old enough."""
    if not isinstance(n, dict):
        plan.counts["bad_entry"] += 1
        return None
    ids = n.get("evidence")
    if not isinstance(ids, list) or not ids or any(str(e) not in by_mid for e in ids):
        plan.counts["bad_id"] += 1
        return None
    ev = list({by_mid[str(e)]["id"]: by_mid[str(e)] for e in ids}.values())
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
            "client": n.get("client"), "ev": ev, "opener": min(ev, key=lambda m: (m["ts"], int(m["msg_id"])))}


def classify(out, msgs: list, loops_reply: dict, members: Members, mapping: dict, now: datetime, offered=None) -> Plan:
    """The model's answer, checked against the record and the messages, as the lines to write. Pure."""
    out = out or {}
    plan = Plan()
    loops = [lp for lp in (loops_reply or {}).get("loops") or [] if isinstance(lp, dict) and lp.get("key")]
    by_key = {str(lp["key"]): lp for lp in loops}
    unreadable = [split_key(str(u.get("subject", ""))[len("loop:"):]) for u in (loops_reply or {}).get("unreadable") or []
                  if isinstance(u, dict) and str(u.get("subject", "")).startswith("loop:")]
    by_mid = {m["id"]: m for m in msgs}
    offered = set(offered) if offered is not None else {k for k, lp in by_key.items() if state_of(lp) == "open"}
    known_clients = {c for c in mapping.values() if c}
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

    groups = defaultdict(list)
    for n in out.get("new") or []:
        item = check_new(n, by_mid, now, plan)
        if item:
            groups[item["opener"]["msg_id"]].append(item)

    def heads(opener_id: str) -> dict:
        """Letter (or "") -> the newest generation of that loop for this opener."""
        best = {}
        for lp in loops:
            k = split_key(lp["key"])
            if k and k[0] == opener_id and (k[1] not in best or k[2] > best[k[1]][1]):
                best[k[1]] = (lp, k[2])
        return best

    def closed_at(lp: dict):
        if lp["key"] in closes:
            return closes[lp["key"]]["ts"]
        return finish_time(lp) if state_of(lp) in ("closed", "resolved") else None

    opens = []
    for opener_id in sorted(groups, key=int):
        fam = heads(opener_id)
        kept = []
        for it in groups[opener_id]:  # C2 rule 2, first branch: a re-sighting of a finished loop is suppressed
            finished = [closed_at(lp) for lp, _ in fam.values()]
            if any(ct is not None and all(m["ts"] <= ct for m in it["ev"]) for ct in finished):
                plan.counts["resighted_closed"] += 1
                plan.notes.append(f"new.resighted_closed opener={opener_id} title={json.dumps(it['title'], ensure_ascii=False)}")
            else:
                kept.append(it)
        kept.sort(key=lambda it: (it["title"].casefold(), it["title"]))  # C2 rule 3: title order
        for i, it in enumerate(kept):
            letter = "" if i == 0 else chr(ord("a") + i)
            base = opener_id + (f":{letter}" if letter else "")
            if any(u and u[0] == opener_id and u[1] == letter for u in unreadable):
                plan.counts["unreadable_conflict"] += 1
                plan.notes.append(f"new.unreadable_conflict key={base}")
                continue
            if letter not in fam:
                opens.append(new_open(base, it, it["opener"]["ts"], mapping, known_clients))
                continue
            head, gen = fam[letter]
            ct = closed_at(head)
            if ct is None and state_of(head) == "open":      # rule 1: a re-sighting adds evidence
                changes[head["key"]]["evidence"].extend(it["ev"])
                plan.counts["resighted_open"] += 1
            elif ct is None and state_of(head) == "parked":  # rule 1: parked stays parked, nothing written
                plan.counts["resighted_parked"] += 1
            elif ct is not None:                              # rule 2, second branch: a new ask on the same opener
                later = [m for m in it["ev"] if m["ts"] > ct]
                opens.append(new_open(f"{base}:{gen + 1}", it, min(m["ts"] for m in later), mapping, known_clients))
            else:
                plan.counts["unknown_state"] += 1
                plan.notes.append(f"new.unknown_state key={head['key']} state={head.get('state')}")

    for key in sorted(closes):
        lp, msg = by_key[key], closes[key]
        record = {**lp, "state": "closed", "closed": iso(msg["ts"]), "byMessage": msg["msg_id"]}
        plan.writes.append(Write("close", key, closed_line(key, msg["msg_id"], iso(msg["ts"]), f"member reply in #{msg['channel']}"),
                                 lp.get("lineId"), msg["source"], msg["link"], iso(msg["ts"]), record, closer=msg))
    for key in sorted(changes):
        if key in closes:
            continue
        lp, ch = by_key[key], changes[key]
        stored = evidence_list(lp.get("evidence"))
        merged = evidence_list(list(lp.get("evidence") or []) + [m["msg_id"] for m in ch["evidence"]])
        if merged == stored and not ch["owner"]:
            plan.counts["evidence_unchanged"] += 1
            continue
        fields = {"key": key, "client": lp.get("client"), "type": lp.get("type"), "owner": ch["owner"] or lp.get("owner"),
                  "channel": lp.get("channel"), "channel_id": lp.get("channelId"), "opened": lp.get("opened"),
                  "reopened": lp.get("reopened"), "title": lp.get("title"), "summary": lp.get("summary"), "evidence": merged}
        touched = ch["evidence"] + ch["touched"]
        at = max((m["ts"] for m in touched), default=now)
        record = {**lp, "owner": fields["owner"], "evidence": merged}
        plan.writes.append(Write("update", key, open_line(fields), lp.get("lineId"), opener_source(lp), str(lp.get("proof") or ""),
                                 iso(at), record))
    plan.writes.extend(opens)
    return plan


def new_open(key: str, it: dict, opened: datetime, mapping: dict, known_clients: set) -> Write:
    op = it["opener"]
    model_client = it["client"] if isinstance(it["client"], str) and it["client"] in known_clients else None
    fields = {"key": key, "client": mapping.get(op["channel"].casefold()) or model_client or "internal", "type": it["type"],
              "owner": it["owner"], "channel": op["channel"], "channel_id": op["parent_id"] or op["channel_id"],
              "opened": iso(opened), "reopened": None, "title": it["title"], "summary": it["summary"],
              "evidence": [m["msg_id"] for m in it["ev"]]}
    record = {"key": key, "state": "open", "client": fields["client"], "type": it["type"], "owner": it["owner"],
              "channel": op["channel"], "channelId": fields["channel_id"], "opened": fields["opened"], "reopened": None,
              "title": sanitise(it["title"], 120), "summary": sanitise(it["summary"], 300),
              "evidence": evidence_list(fields["evidence"]), "proof": op["link"]}
    return Write("open", key, open_line(fields), None, op["source"], op["link"], iso(opened), record)


# --- writing --------------------------------------------------------------------------------------------------


def landed(facts: list, w: Write):
    return next((f for f in facts if isinstance(f, dict) and f.get("claim") == w.claim
                 and (f.get("supersedes") or None) == (w.supersedes or None)), None)


def write_line(g: Grysstof, w: Write) -> str:
    """One capture_thought. On any failure, re-read the loop first: written already, changed by someone, or retry once."""
    subject = f"loop:{w.key}"
    for attempt in (1, 2):
        try:
            fid = g.capture(w)
            log("write.ok", kind=w.kind, key=w.key, id=fid, attempt=attempt)
            return "ok"
        except JobError as e:
            log("write.failed", err=True, kind=w.kind, key=w.key, attempt=attempt, error=one_line(e)[:200])
        try:
            facts = g.history(subject)
        except JobError as e:
            log("write.reread_failed", err=True, key=w.key, error=one_line(e)[:200])
            return "failed"
        hit = landed(facts, w)
        if hit:
            log("write.landed_despite_error", key=w.key, id=hit.get("id"))
            return "ok"
        if attempt == 2:
            return "failed"
        head = next((f for f in facts if isinstance(f, dict) and not f.get("supersededBy")), None)
        if (w.supersedes and (head is None or head.get("id") != w.supersedes)) or (not w.supersedes and facts):
            log("write.conflict", err=True, key=w.key, detail="the loop changed since it was read; not retried",
                expected=w.supersedes or "-", head=(head or {}).get("id", "-"))
            return "conflict"
    return "failed"


def apply_plan(g: Grysstof, writes: list) -> tuple:
    done, failed = [], 0
    for w in writes:
        if write_line(g, w) == "ok":
            done.append(w)
        else:
            failed += 1
    return done, failed


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
    t = sanitise(lp.get("title"), 120) or sanitise(lp.get("summary"), 70) or str(lp.get("key"))
    return t.replace("[", "(").replace("]", ")")


def last_activity(lp: dict) -> datetime:
    times = [snowflake_time(e) for e in evidence_list(lp.get("evidence"))]
    times += [parse_time(lp.get("opened")), parse_time(lp.get("reopened"))]
    return max((t for t in times if t), default=datetime.fromtimestamp(0, UTC))


def link_of(lp: dict, links: dict) -> str:
    for e in reversed(evidence_list(lp.get("evidence"))):
        if e in links:
            return links[e]
    return str(lp.get("proof") or "")


def build_post(now: datetime, loops: list, *, closes=(), counts=None, model_failed=False, not_evaluated=0,
               unreadable=0, write_failures=0, portal_ids=frozenset(), links=None) -> str:
    counts, links = counts or {}, links or {}
    open_ = newest_first([lp for lp in loops if state_of(lp) == "open"])
    lines = [f"**Open loops** · {now:%a %d %b %Y} · {len(open_)} waiting"]
    if model_failed:
        lines.append("⚠ **model pass failed; list may be stale.** This is the record as it stood before this run.")
    for i, lp in enumerate(open_[:POST_CAP], 1):
        head = f"\n**{i}.** [{md_title(lp)}](<{link_of(lp, links)}>)"
        if str(lp.get("key")).split(":")[0] in portal_ids:
            lines.append(head + " · ⚑ also on the portal")
            continue
        lines.append(head)
        lines.append(f"#{sanitise(lp.get('channel'))} · waiting on {sanitise(lp.get('owner')) or 'unclear'} · {age_str(now - last_activity(lp))}")
        if lp.get("summary"):
            lines.append(sanitise(lp.get("summary"), 300))
    if not open_:
        lines.append("\nNothing open. (If this reads empty for days, check the job rather than trust the calm.)")
    if len(open_) > POST_CAP:
        lines.append(f"\n_{len(open_) - POST_CAP} older, see /loops in the Xactco server._")
    if not_evaluated:
        lines.append(f"_{not_evaluated} loops not evaluated this run (only the newest {MAX_OFFERED} go to the model)._")
    if closes:
        lines.append("\n**Closed in channel this run**")
        for w in closes:
            lines.append(f"- [{md_title(w.record)}](<{w.closer['link']}>) · #{sanitise(w.closer['channel'])}")
    if counts.get("resighted_closed"):
        lines.append(f"\n_{counts['resighted_closed']} re-sightings of closed loops suppressed._")
    if unreadable:
        lines.append(f"_{unreadable} loop lines unreadable; see /loops._")
    if write_failures:
        lines.append(f"_{write_failures} ledger write{'' if write_failures == 1 else 's'} failed; this list may be out of date._")
    lines.append("\n_Reads Discord only. A loop closed in Azure DevOps, email, a call or in person still shows here._")
    lines.append("To resolve, press /loops in the Xactco server.")
    return "\n".join(lines)


# --- runs -----------------------------------------------------------------------------------------------------


def read_state(g: Grysstof, now: datetime) -> dict:
    pulse = g.pulse()
    portal = {str(le.get("source")) for le in pulse.get("looseEnds") or [] if isinstance(le, dict) and le.get("source")}
    mapping = client_map(pulse)
    thoughts = read_window(g, iso(now - timedelta(days=DAYS)))
    msgs = load(thoughts, portal)
    lr = g.loops()
    return {"portal": portal, "mapping": mapping, "thoughts": len(thoughts), "msgs": msgs, "loops": lr}


def config(env: dict, post: bool) -> Members:
    missing = [k for k in REQUIRED if not env.get(k)] + (["OPEN_LOOPS_WEBHOOK"] if post and not env.get("OPEN_LOOPS_WEBHOOK") else [])
    if missing:
        raise ConfigError(f"missing from the env file: {', '.join(missing)}")
    members = parse_members(env["XACTCO_MEMBERS"])
    if not members.ids or not all(i.isdigit() for i in members.ids):
        raise ConfigError("XACTCO_MEMBERS must be comma-separated Discord user ids, each optionally id:Name")
    return members


def run(env: dict, post: bool) -> int:
    members = config(env, post)
    now = now_sast()
    g = Grysstof(env["GRYSSTOF_URL"], env["MCP_ACCESS_KEY"])
    s = read_state(g, now)
    msgs, lr, mapping = s["msgs"], s["loops"], s["mapping"]
    members.learn(msgs)
    portal_ids = {src.rsplit("/", 1)[-1] for src in s["portal"]}
    links = {m["msg_id"]: m["link"] for m in msgs}
    open_now = newest_first([lp for lp in lr["loops"] if isinstance(lp, dict) and state_of(lp) == "open"])
    offered = open_now[:MAX_OFFERED]
    not_evaluated = len(open_now) - len(offered)
    unreadable = len(lr.get("unreadable") or [])
    log("window", now=f"{now:%a %d %b %H:%M} SAST", thoughts=s["thoughts"], messages=len(msgs),
        channels=len({m["channel"] for m in msgs}), open_loops=len(open_now), offered=len(offered),
        unreadable=unreadable, portal_loose_ends=len(s["portal"]))

    try:
        raw, usage = ask_model(env["ANTHROPIC_API_KEY"], model_input(now, msgs, offered, not_evaluated, mapping))
        answer = parse_model(raw)
    except ModelError as e:
        log("model.failed", err=True, error=one_line(e)[:300])
        text = build_post(now, lr["loops"], model_failed=True, not_evaluated=not_evaluated, unreadable=unreadable,
                          portal_ids=portal_ids, links=links)
        if post:
            log("posted", messages=send(env["OPEN_LOOPS_WEBHOOK"], text))
        else:
            print("--- DRY RUN: nothing written, nothing posted ---\n" + text)
        return 1
    log("model.ok", tokens_in=usage.get("input_tokens"), tokens_out=usage.get("output_tokens"),
        existing=len(answer["existing"]), new=len(answer["new"]))

    plan = classify(answer, msgs, lr, members, mapping, now, {str(lp["key"]) for lp in offered})
    for note in plan.notes:
        print(note)
    if plan.counts:
        log("checks", **{k: v for k, v in sorted(plan.counts.items())})
    by_kind = Counter(w.kind for w in plan.writes)
    failures = 0
    if post:
        applied, failures = apply_plan(g, plan.writes)
        done = Counter(w.kind for w in applied)
        log("written", opened=done["open"], closed=done["close"], updated=done["update"], failed=failures)
    else:
        applied = plan.writes
        print(f"would open {by_kind['open']}, close {by_kind['close']}, update {by_kind['update']}")
        for w in plan.writes:
            print(f"  {w.kind} loop:{w.key}" + (f" supersedes {w.supersedes}" if w.supersedes else "") + f" :: {w.claim}")
    text = build_post(now, project(lr["loops"], applied), closes=[w for w in applied if w.kind == "close"], counts=plan.counts,
                      not_evaluated=not_evaluated, unreadable=unreadable, write_failures=failures, portal_ids=portal_ids, links=links)
    if post:
        log("posted", messages=send(env["OPEN_LOOPS_WEBHOOK"], text))
    else:
        print("--- DRY RUN: nothing written, nothing posted ---\n" + text)
    return 1 if failures else 0


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
    print("settings: " + " | ".join(f"{k} {'set' if env.get(k) else 'MISSING'}" for k in CHECKED))
    if any(not env.get(k) for k in CHECKED):
        ok = False
    members = parse_members(env.get("XACTCO_MEMBERS"))
    print(f"members: {len(members.ids)} user ids, {len(members.names)} names")
    if env.get("GRYSSTOF_URL") and env.get("MCP_ACCESS_KEY"):
        try:
            s = read_state(Grysstof(env["GRYSSTOF_URL"], env["MCP_ACCESS_KEY"]), now_sast())
            states = Counter(state_of(lp) for lp in s["loops"]["loops"] if isinstance(lp, dict))
            print(f"grysstof: {len(s['msgs'])} messages in the window, loops {dict(sorted(states.items()))}, "
                  f"{len(s['loops'].get('unreadable') or [])} unreadable, portal lists {len(s['portal'])} loose ends")
        except JobError as e:
            print(f"grysstof: FAILED {one_line(e)[:300]}")
            ok = False
    try:
        skew, theirs = clock_skew()
        good = abs(skew) <= MAX_SKEW_SECONDS
        print(f"clock: {'ok' if good else 'FAILED'}, Pi is {skew:+.0f} s against Discord ({theirs:%H:%M:%S} UTC); limit {MAX_SKEW_SECONDS} s")
        ok = ok and good
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
    try:
        return run_check(env) if args.check else run(env, args.post)
    except Exception as e:  # never fail silently: one line here, and in the channel when posting
        print(f"FAILED: {type(e).__name__}: {one_line(e)[:400]}", file=sys.stderr)
        if args.post and not args.check and env.get("OPEN_LOOPS_WEBHOOK"):
            try:
                send(env["OPEN_LOOPS_WEBHOOK"], f"**Open loops job failed** ({now_sast():%a %d %b %H:%M}): {type(e).__name__}: {one_line(e)[:300]}")
            except Exception as e2:
                print(f"FAILED: and the post saying so failed: {one_line(e2)[:200]}", file=sys.stderr)
        return 2 if isinstance(e, ConfigError) else 1
    finally:
        if lock:
            release_lock(lock)


if __name__ == "__main__":
    sys.exit(main())
