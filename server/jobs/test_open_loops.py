"""Tests for open_loops.py. Standard library only; no network: every HTTP call goes to FakeNet.

Run from the repo root:  python3 -m unittest discover -s server/jobs -p "test_*.py"

These tests try to break the job: wrong channel, a client's reply, a reopened loop and the same reply, a
re-reported loop beside a new ask (S1), a second ask on a resolved opener (S2), evidence from two channels
(S3), an SSE reply, a write that lands after its timeout, SIGTERM, a deadline, a loop changed mid-run, a model
that fails, a lock still held. They do not re-state the implementation.
"""
import contextlib
import email.message
import email.utils
import io
import json
import os
import signal
import socket
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import open_loops as ol

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures"
C1_FIXTURE = HERE.parent / "tests" / "fixtures" / "c1-sanitise.json"
UTC = timezone.utc
SAST = timezone(timedelta(hours=2))
NOW = datetime(2026, 10, 27, 7, 30, tzinfo=SAST)  # Tuesday
GUILD = "268128051500417024"
SERVEST, SWANZO, INTERNAL, BILLING, URGENT = ("1300000000000000101", "1300000000000000102", "1300000000000000103",
                                              "1300000000000000104", "1300000000000000105")
THREAD = "1300000000000000201"  # a thread under #servest
KELLI, DEVON = "900000000000000001", "900000000000000002"
THABO, LERATO = "700000000000000001", "700000000000000002"
BASE = "http://grysstof.test"
WEBHOOK = "https://discord.com/api/webhooks/1/test"
ANTHROPIC = "https://api.anthropic.com/v1/messages"
MEMBERS_RAW = f"{KELLI}:Kelli,{DEVON}:Devon"
ENV_TEXT = (
    "ANTHROPIC_API_KEY=test-anthropic\n"
    f"OPEN_LOOPS_WEBHOOK={WEBHOOK}\n"
    f"GRYSSTOF_URL={BASE}/mcp\n"
    "MCP_ACCESS_KEY=test-key\n"
    f"XACTCO_MEMBERS={MEMBERS_RAW}\n"
)
C1_OPEN_ORDER = ["key", "client", "type", "owner", "channel", "channel_id", "opened", "reopened", "title", "summary", "evidence"]
EMPTY_ANSWER = '{"existing": [], "new": []}'

_seq = [0]


def snow(at: datetime) -> str:
    _seq[0] += 1
    return str(((int(at.timestamp() * 1000) - 1420070400000) << 22) + _seq[0])


def iso(at: datetime) -> str:
    return at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ago(hours: float) -> datetime:
    return NOW - timedelta(hours=hours)


def parse_line(line: str):
    """A C1 reader written from the contract text, not from the code under test."""
    parts = line.split(" | ")
    fields = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        fields[k] = v
    return parts[0], fields


def when(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def thought(at, author, text, *, channel="servest", chan_id=SERVEST, msg=None, author_id=None, c4=True,
            parent_id=None, in_reply_to=None, reactions=None):
    msg = msg or snow(at)
    meta = {
        "source": f"discord:{GUILD}/{chan_id}/{msg}",
        "proof": f"https://discord.com/channels/{GUILD}/{chan_id}/{msg}",
        "channel": channel,
        "occurred_at": iso(at),
    }
    if c4:  # captured after C4 deployed: ids ride in the metadata
        meta["channel_id"] = chan_id
        if author_id:
            meta["author_id"] = author_id
        if parent_id:
            meta["parent_id"] = parent_id
    if in_reply_to:
        meta["in_reply_to"] = in_reply_to
    if reactions:
        meta["reactions"] = reactions
    content = f"Discord #{channel} (Xactco), {at.astimezone(UTC):%Y-%m-%d}, {author}: {text}"
    return {"id": "t" + msg, "content": content, "metadata": meta, "createdAt": iso(at)}


def msg_id(t) -> str:
    return t["metadata"]["source"].rsplit("/", 1)[1]


def loop_rec(key, *, opened, state="open", channel="servest", channel_id=SERVEST, reopened=None, evidence=None,
             owner="Kelli", title="A loop", summary=None, line=None, closed=None, learned=None, type_="unanswered_question",
             client="servest", fork=False):
    return {
        "key": key, "subject": f"loop:{key}", "lineId": line or f"fact_{key.replace(':', '_')}", "state": state, "client": client,
        "type": type_, "owner": owner, "channel": channel, "channelId": channel_id, "opened": iso(opened),
        "reopened": iso(reopened) if reopened else None, "title": title, "summary": summary or f"{title}.",
        "evidence": evidence if evidence is not None else [key.split(":")[0]],
        "proof": f"https://discord.com/channels/{GUILD}/{channel_id}/{key.split(':')[0]}",
        "closed": iso(closed) if closed else None, "byMessage": None, "byUser": None, "byName": None, "until": None,
        "note": None, "fork": fork, "learnedAt": iso(learned or opened),
    }


def loops_reply(*loops, unreadable=(), total=None):
    return {"loops": list(loops), "unreadable": list(unreadable), "warnings": {"understandFailed": 0},
            "total": len(loops) if total is None else total}


MAPPING = {"servest": "servest", "swanzo": "swanzo", "dev-internal": None, "billing": "billing", "urgent_support": None}


def members():
    return ol.parse_members(MEMBERS_RAW)


def classify(out, thoughts, loops, *, portal=(), offered=None, mem=None, clients=None):
    msgs = ol.load(thoughts, set(portal))
    m = mem or members()
    m.learn(msgs)
    return ol.classify(out, msgs, loops, m, MAPPING, NOW, offered, clients=clients), msgs


def mid_of(msgs, t) -> str:
    """The m-id the job gave this thought."""
    return next(m["id"] for m in msgs if m["source"] == t["metadata"]["source"])


def new_item(title, evidence, *, type_="unanswered_question", owner="unclear", channel="servest", client="servest", summary=None, key=None):
    item = {"channel": channel, "client": client, "type": type_, "title": title, "summary": summary or f"{title}.",
            "owner": owner, "evidence": evidence, "why_open": "No reply in the channel."}
    if key:
        item["key"] = key
    return item


def writes_of(plan):
    return {(w.kind, w.key): parse_line(w.claim)[1] for w in plan.writes}


# --- the fake network -------------------------------------------------------------------------------------------


class FakeResp:
    def __init__(self, body: bytes, status=200, headers=None, on_line=None):
        self._buf = io.BytesIO(body)
        self.status = status
        self.on_line = on_line  # called for every line read: a slow stream
        self.headers = email.message.Message()
        for k, v in (headers or {}).items():
            self.headers[k] = v

    def read(self, *a):
        return self._buf.read(*a)

    def __iter__(self):
        for line in iter(self._buf.readline, b""):
            if self.on_line:
                self.on_line()
            yield line

    def getcode(self):
        return self.status

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(url, code, body=b'{"error":"boom"}', headers=None):
    h = email.message.Message()
    for k, v in (headers or {}).items():
        h[k] = v
    return urllib.error.HTTPError(url, code, "error", h, io.BytesIO(body))


def sse(events) -> bytes:
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode("utf-8")


def model_stream(text: str, stop="end_turn") -> bytes:
    events = [
        {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [],
                                              "usage": {"input_tokens": 1234, "output_tokens": 1}}},
        # A thinking block carrying JSON-looking text: only text blocks may be read as the answer.
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": '{"existing": [], "new": [{"evidence": ["m999"]}]}'}},
        {"type": "content_block_stop", "index": 0},
        {"type": "ping"},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
    ]
    for i in range(0, len(text), 37):
        events.append({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": text[i:i + 37]}})
    events += [
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 567}},
        {"type": "message_stop"},
    ]
    return sse(events)


def rpc(result=None, error=None) -> bytes:
    body = {"jsonrpc": "2.0", "id": 1}
    if error:
        body["error"] = error
    else:
        body["result"] = result
    return json.dumps(body).encode()


class FakeClock:
    def __init__(self):
        self.t = 10_000.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


class FakeNet:
    """Stands in for urllib.request.urlopen: Grysstof (browse, /mcp, a small ledger whose /loops follows what was
    written), Anthropic, Discord. Faults are consumed in order."""

    def __init__(self, *, thoughts=(), pulse=None, loops=None, model=None, mcp="json", skew_seconds=0):
        self.thoughts = sorted(thoughts, key=lambda t: (t["createdAt"], t["id"]))
        self.pulse = pulse if pulse is not None else {"looseEnds": [], "cards": [{"client": "client:servest"}, {"client": "client:swanzo"}, {"client": "client:billing"}], "mapping": [
            {"channel": "servest", "client": "client:servest", "how": "auto", "messages": 1},
            {"channel": "swanzo", "client": "client:swanzo", "how": "auto", "messages": 1},
            {"channel": "billing", "client": "client:billing", "how": "auto", "messages": 1},
            {"channel": "dev-internal", "client": None, "how": "auto", "messages": 1},
            {"channel": "urgent_support", "client": None, "how": "auto", "messages": 1}]}
        start = loops if loops is not None else loops_reply()
        self.records = {lp["key"]: dict(lp) for lp in start.get("loops", [])}
        self.unreadable = list(start.get("unreadable") or [])
        self.model = model
        self.mcp_mode = mcp
        self.mcp_faults = []   # "error_after_write", "error_before_write", "timeout", "timeout_late:<reads>", "sigterm", "advance:<s>"
        self.model_hooks = []  # callables run when the model is called
        self.ledger = {}       # subject -> facts, newest first
        self.pending = []      # [subject, fact, args, history reads left] for writes that land late
        self.route_override = {}
        self.ignore_offset = False
        self.ignore_loops_offset = False
        self.repeat_once = False  # /thoughts: the second page repeats the first, once (a backfill shifted offsets)
        self.webhook_429 = 0
        self.stream_tick = 0       # seconds the model stream takes per line read
        self.stream_lines_read = 0
        self.skew_seconds = skew_seconds
        self.clock = None
        self.calls, self.unexpected, self.posts, self.captures, self.model_requests = [], [], [], [], []
        self._fact = 0
        for lp in self.records.values():
            self.ledger[lp["subject"]] = [{"id": lp["lineId"], "subject": lp["subject"], "claim": "OPEN/1 | key=" + lp["key"]}]

    def __call__(self, req, data=None, timeout=None, **kw):
        if isinstance(req, urllib.request.Request):
            url, method, body = req.full_url, req.get_method(), req.data
            headers = {k.lower(): v for k, v in req.header_items()}
        else:
            url, method, body, headers = req, "GET", data, {}
        self.calls.append({"method": method, "url": url, "timeout": timeout, "headers": headers})
        parts = urllib.parse.urlsplit(url)
        query = dict(urllib.parse.parse_qsl(parts.query))
        if url.startswith(BASE + "/browse/api/") and method == "GET":
            return self.browse(parts.path[len("/browse/api"):], query)
        if url == BASE + "/mcp" and method == "POST":
            return self.mcp(json.loads(body))
        if url == ANTHROPIC and method == "POST":
            return self.anthropic(json.loads(body), url)
        if url.startswith(WEBHOOK) and method == "POST":
            if self.webhook_429:
                self.webhook_429 -= 1
                raise http_error(url, 429, b'{"message": "You are being rate limited.", "retry_after": 0.25, "global": false}')
            self.posts.append(json.loads(body))
            return FakeResp(b'{"id": "1"}')
        if url == "https://discord.com/api/v10/gateway" and method == "GET":
            date = email.utils.format_datetime(NOW.astimezone(UTC) + timedelta(seconds=self.skew_seconds), usegmt=True)
            return FakeResp(b'{"url": "wss://gateway.discord.gg"}', headers={"Date": date})
        self.unexpected.append((method, url))
        raise urllib.error.URLError(f"unexpected url in test: {method} {url}")

    def browse(self, route, q):
        over = self.route_override.get(route)
        if isinstance(over, Exception):
            raise over
        if over is not None:
            return over
        if route == "/thoughts":
            rows = [t for t in self.thoughts if t["createdAt"] >= q.get("since", "")
                    and t["metadata"]["source"].startswith(q.get("source_prefix", ""))]
            assert q.get("order") == "oldest", q
            limit, offset = int(q["limit"]), 0 if self.ignore_offset else int(q.get("offset", "0"))
            if self.repeat_once and offset > 0:
                self.repeat_once, offset = False, 0
            return FakeResp(json.dumps({"thoughts": rows[offset:offset + limit]}).encode())
        if route == "/pulse/overview":
            return FakeResp(json.dumps(self.pulse).encode())
        if route == "/loops":
            recs = sorted(self.records.values(), key=lambda r: (r["opened"], r["key"]))
            if q.get("state", "open") != "all":
                recs = [r for r in recs if r["state"] == q.get("state", "open")]
            if q.get("key"):
                recs = [r for r in recs if r["key"] == q["key"]]
            limit = int(q.get("limit", "200"))
            offset = 0 if self.ignore_loops_offset else int(q.get("offset", "0"))
            body = {"loops": recs[offset:offset + limit], "unreadable": self.unreadable, "warnings": {"understandFailed": 0}, "total": len(recs)}
            return FakeResp(json.dumps(body).encode())
        if route == "/history":
            subject = q.get("subject", "")
            for p in list(self.pending):
                if p[0] == subject:
                    if p[3] <= 0:
                        self.land(*p[:3])
                        self.pending.remove(p)
                    else:
                        p[3] -= 1
            return FakeResp(json.dumps({"facts": self.ledger.get(subject, [])}).encode())
        return FakeResp(json.dumps({"error": f"No browse route {route}"}).encode(), status=404)

    def land(self, subject, fact, args):
        facts = self.ledger.setdefault(subject, [])
        head = next((f for f in facts if not f.get("supersededBy")), None)
        if head and fact.get("supersedes"):
            head["supersededBy"] = fact["id"]
        facts.insert(0, fact)
        self.apply_claim(subject, fact["id"], args)

    def flush_pending(self):
        for p in self.pending:
            self.land(*p[:3])
        self.pending = []

    def apply_claim(self, subject, fid, args):
        tag, f = parse_line(args["content"])
        key = subject[len("loop:"):]
        rec = dict(self.records.get(key) or {})
        if tag == "OPEN/1":
            rec.update({"key": key, "subject": subject, "lineId": fid, "state": "open", "client": f["client"], "type": f["type"],
                        "owner": f["owner"], "channel": f["channel"], "channelId": f["channel_id"], "opened": f["opened"],
                        "reopened": None if f["reopened"] == "-" else f["reopened"], "title": f["title"], "summary": f["summary"],
                        "evidence": [e for e in f["evidence"].split(",") if e], "proof": args.get("proof"), "closed": None,
                        "byMessage": None, "byUser": None, "byName": None, "until": None, "note": None, "fork": False, "learnedAt": iso(NOW)})
        elif tag == "CLOSED/1":
            rec.update({"lineId": fid, "state": "closed", "closed": f["closed"], "byMessage": f["by_message"], "note": f["reason"], "learnedAt": iso(NOW)})
        self.records[key] = rec

    def mcp(self, body):
        assert body["method"] == "tools/call" and body["params"]["name"] == "capture_thought", body
        args = body["params"]["arguments"]
        self.captures.append(args)
        fault = self.mcp_faults.pop(0) if self.mcp_faults else None
        if fault == "sigterm":
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        if fault and fault.startswith("advance:"):
            self.clock.advance(float(fault.split(":")[1]))
        if fault == "timeout":  # the request dies before the server sees it
            raise socket.timeout("timed out")
        if fault == "error_before_write":
            return FakeResp(rpc({"content": [{"type": "text", "text": "Failed to capture: database is locked"}], "isError": True}))
        subject, sup = args["subject"], args.get("supersedes")
        facts = self.ledger.setdefault(subject, [])
        head = next((f for f in facts if not f.get("supersededBy")), None)
        if sup and (head is None or head["id"] != sup):  # lane A refuses a stale supersedes before writing
            return FakeResp(rpc({"content": [{"type": "text", "text": f"Failed to capture: {sup} is not the current line of {subject}"}], "isError": True}))
        self._fact += 1
        fid = f"fact_new{self._fact}"
        fact = {"id": fid, "subject": subject, "claim": args["content"], "source": args.get("source"),
                "proof": args.get("proof"), "supersedes": sup, "learnedAt": iso(NOW), "tags": []}
        if fault and fault.startswith("timeout_late:"):  # the server keeps going and lands the line after the client gave up
            self.pending.append([subject, fact, args, int(fault.split(":")[1])])
            raise socket.timeout("timed out")
        self.land(subject, fact, args)
        if fault == "error_after_write":  # the SQLite limb: the line is written, then the embedder fails
            return FakeResp(rpc({"content": [{"type": "text", "text": "Failed to capture: embedding request failed"}], "isError": True}))
        result = {"content": [{"type": "text", "text": f"Recorded fact {fid} about {subject} (from {args.get('source')}, by open-loops, unconfirmed)"}]}
        if self.mcp_mode == "sse":
            return FakeResp(sse([{"type": "message", "jsonrpc": "2.0", "id": 1, "result": result}]), headers={"Content-Type": "text/event-stream"})
        return FakeResp(rpc(result), headers={"Content-Type": "application/json"})

    def anthropic(self, body, url):
        self.model_requests.append(body)
        for hook in self.model_hooks:
            hook()
        m = self.model
        if isinstance(m, BaseException):
            raise m
        if isinstance(m, tuple) and m[0] == "http":
            raise http_error(url, m[1], b'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
        tick = None
        if self.stream_tick:
            def tick():
                self.stream_lines_read += 1
                self.clock.advance(self.stream_tick)
        if isinstance(m, bytes):
            return FakeResp(m, headers={"Content-Type": "text/event-stream"}, on_line=tick)
        return FakeResp(model_stream(m), headers={"Content-Type": "text/event-stream"}, on_line=tick)

    def captures_for(self, key):
        return [c for c in self.captures if c["subject"] == f"loop:{key}"]

    def user_message(self) -> str:
        return self.model_requests[0]["messages"][0]["content"]


class JobCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env_path = Path(self.tmp.name) / "job.env"
        self.env_path.write_text(ENV_TEXT, encoding="utf-8")
        self.clock = FakeClock()
        self.sleeps = []
        for target, value in ((ol, "now_sast"), ):
            p = mock.patch.object(target, value, return_value=NOW)
            p.start()
            self.addCleanup(p.stop)
        for name, value in (("monotonic", self.clock), ("sleep", self.sleeps.append)):
            p = mock.patch.object(ol, name, value)
            p.start()
            self.addCleanup(p.stop)

    def run_main(self, net, *args, env=True):
        net.clock = self.clock
        out, err = io.StringIO(), io.StringIO()
        argv = (["--env", str(self.env_path)] if env else []) + list(args)
        before = signal.getsignal(signal.SIGTERM)
        with mock.patch("urllib.request.urlopen", net), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ol.main(argv)
        self.assertIs(signal.getsignal(signal.SIGTERM), before, "main puts the SIGTERM handler back")
        self.assertEqual(net.unexpected, [], "the job called something outside the fakes")
        return code, out.getvalue(), err.getvalue()

    @staticmethod
    def posted(net) -> str:
        return "\n".join(p["content"] for p in net.posts)


def fixture_net(**kw) -> FakeNet:
    return FakeNet(
        thoughts=json.loads((FIX / "window.json").read_text(encoding="utf-8")),
        pulse=json.loads((FIX / "pulse.json").read_text(encoding="utf-8")),
        loops=json.loads((FIX / "loops.json").read_text(encoding="utf-8")),
        model=(FIX / "model_answer.json").read_text(encoding="utf-8"),
        **kw,
    )


# Fixture ids (fixtures/window.json, generated from their timestamps)
W0, W0B, D1, S1 = "1562344685568004096", "1562359785062404096", "1562389984051204096", "1562722172928004096"
W1, W2, W4, P1 = "1563099660288004096", "1563160058265604096", "1564201923379204096", "1564262321356804096"
X1, PK = "1559838169497604096", "1560200557363204096"


# --- C1: the line, one truth with core/loops.ts ---------------------------------------------------------------


class LineFormat(unittest.TestCase):
    HOSTILE = [
        "a | b | key=evil",
        "line one\nline two\r\nline three",
        "ctl\x00\x07\x1b[31mred",
        "🚀 **bold** _it_ [link](https://x.test) <@123> @everyone",
        "#servest > thread",
        "x" * 500,
        "  spaced\t\tout  ",
        "uni\u2028line\u2029sep",
        "Pay \u202eNOW\u202c later \u2066x\u2069",
        "lone \ud800 half",
    ]

    def fields(self, title, owner="Kelli", summary="s", client="servest"):
        return {"key": "123", "client": client, "type": "unanswered_question", "owner": owner, "channel": "servest",
                "channel_id": SERVEST, "opened": "2026-10-26T08:00:00.000Z", "reopened": None, "title": title,
                "summary": summary, "evidence": ["3", "5"]}

    def test_open_line_is_one_physical_line_and_reads_back_as_sanitised(self):
        for bad in self.HOSTILE:
            with self.subTest(bad=bad[:30]):
                line = ol.open_line(self.fields(bad, owner=bad, summary=bad))
                self.assertNotIn("\n", line)
                self.assertNotIn("\r", line)
                tag, f = parse_line(line)
                self.assertEqual(tag, "OPEN/1")
                self.assertEqual(list(f), C1_OPEN_ORDER)
                self.assertEqual(f["title"], ol.sanitise(bad, 120))
                self.assertEqual(f["owner"], ol.sanitise(bad, 100))
                self.assertEqual(f["summary"], ol.sanitise(bad, 300))
                for name, cap in (("title", 120), ("owner", 100), ("summary", 300)):
                    self.assertLessEqual(len(f[name]), cap)
                    self.assertNotIn("|", f[name])

    def test_sanitise_follows_core_loops(self):
        # Expectations derived by hand from core/loops.ts sanitise(): `|` removed; Cc, Cs, U+2028/9 and the bidi
        # controls turned to spaces; JS whitespace collapsed and trimmed; cut to max code points; no ellipsis.
        cases = [
            ("a|b\nc\x07d  e", 300, "ab c d e"),
            ("Pay \u202eNOW\u202c later", 300, "Pay NOW later"),
            ("a\u200eb\u200fc\u2066d\u2069e", 300, "a b c d e"),
            ("lone \ud800 half", 300, "lone half"),
            ("\ufeffx\u00a0y\u3000z ", 300, "x y z"),
            ("🚀 ok", 300, "🚀 ok"),
            ("x" * 130, 120, "x" * 120),
            ("abc defg", 4, "abc"),  # cut to 4 is "abc ", trimmed again
        ]
        for text, cap, want in cases:
            with self.subTest(text=text[:20]):
                self.assertEqual(ol.sanitise(text, cap), want)

    def test_ids_and_codes_lose_spaces_commas_pipes_and_controls(self):
        self.assertEqual(ol.clean_id("servest billing,x"), "servestbillingx")
        self.assertEqual(ol.clean_id("a\u202eb|c\td"), "abcd")
        self.assertEqual(len(ol.clean_id("9" * 150)), 100)
        _, f = parse_line(ol.open_line(self.fields("t", client="servest billing,x")))
        self.assertEqual(f["client"], "servestbillingx")

    def test_a_5000_character_owner_is_capped_at_100(self):
        line = ol.open_line(self.fields("t", owner="o" * 5000))
        self.assertEqual(parse_line(line)[1]["owner"], "o" * 100)
        self.assertLess(len(line), 700)

    def test_reopened_absent_is_a_dash(self):
        for value in (None, "", "-"):
            f = self.fields("t")
            f["reopened"] = value
            self.assertEqual(parse_line(ol.open_line(f))[1]["reopened"], "-")

    def test_evidence_in_the_line_keeps_the_order_given_and_the_last_eight(self):
        f = self.fields("t")
        f["evidence"] = ["11", "2", "9", "4", "2", " 10 ", "1", "7", "3", "8"]  # a repeat of 2, one id with spaces
        self.assertEqual(parse_line(ol.open_line(f))[1]["evidence"].split(","), ["2", "9", "4", "10", "1", "7", "3", "8"])

    def test_the_job_writes_evidence_in_snowflake_order_newest_eight(self):
        self.assertEqual(ol.evidence_list(["11", "2", "9", "4", "10", "1", "7", "3", "8", "5", "6", "x"]), ["4", "5", "6", "7", "8", "9", "10", "11"])

    def test_closed_line_caps_the_reason(self):
        tag, f = parse_line(ol.closed_line("123", "456", "2026-10-26T08:00:00.000Z", "r|" * 300))
        self.assertEqual(tag, "CLOSED/1")
        self.assertEqual(list(f), ["key", "by_message", "closed", "reason"])
        self.assertLessEqual(len(f["reason"]), 200)
        self.assertNotIn("|", f["reason"])


class C1Fixture(unittest.TestCase):
    """Plan v3.1 row 18: one sanitiser truth in two languages. Lane A writes the fixture; this reads the same file.
    Expected shape: {"cases": [{"field": <C1 field name>, "input": <value>, "expected": <string, or list for evidence>}]}
    (a bare list of cases is accepted too)."""

    def test_the_job_sanitises_every_field_as_core_loops_does(self):
        if not C1_FIXTURE.exists():
            self.skipTest(f"{C1_FIXTURE} is not on this branch yet (lane A writes it, plan v3.1 row 18); re-run when it lands")
        data = json.loads(C1_FIXTURE.read_text(encoding="utf-8"))
        cases = data.get("cases") if isinstance(data, dict) else data
        self.assertTrue(cases, "the fixture holds no cases")
        for i, case in enumerate(cases):
            with self.subTest(case=i, field=case.get("field")):
                got = ol.c1_field(case["field"], case["input"])
                want = case["expected"]
                if isinstance(want, str) and isinstance(got, list):
                    got = ",".join(got)
                self.assertEqual(got, want)


class McpDecode(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(ol.decode_mcp(rpc({"content": [{"type": "text", "text": "ok"}]}).decode()), "ok")

    def test_sse_takes_the_last_data_line(self):
        raw = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Recorded fact f1 about loop:1 (x)"}]}}\n\n'
        self.assertEqual(ol.decode_mcp(raw), "Recorded fact f1 about loop:1 (x)")

    def test_rpc_error_and_tool_error_raise(self):
        with self.assertRaisesRegex(Exception, "-32001"):
            ol.decode_mcp(rpc(error={"code": -32001, "message": "Unauthorized"}).decode())
        with self.assertRaisesRegex(Exception, "stale"):
            ol.decode_mcp(rpc({"content": [{"type": "text", "text": "Failed: stale"}], "isError": True}).decode())

    def test_garbage_raises(self):
        with self.assertRaises(Exception):
            ol.decode_mcp("<html>502 Bad Gateway</html>")


class Members(unittest.TestCase):
    def test_ids_with_optional_names(self):
        m = ol.parse_members(f" {KELLI}:Kelli , {DEVON} ,, ")
        self.assertEqual(m.ids, {KELLI, DEVON})
        self.assertIn("kelli", m.names)

    def test_names_are_learned_only_from_listed_ids(self):
        m = ol.parse_members(DEVON)
        msgs = ol.load([thought(ago(30), "Devon", "hi", author_id=DEVON), thought(ago(29), "Thabo", "hi", author_id=THABO)], set())
        m.learn(msgs)
        self.assertIn("devon", m.names)
        self.assertNotIn("thabo", m.names)


# --- C5 closing acceptance ------------------------------------------------------------------------------------


class Closing(unittest.TestCase):
    def setUp(self):
        self.opener = thought(ago(50), "Thabo", "Can you send the report?", author_id=THABO)
        self.key = msg_id(self.opener)
        self.loop = loop_rec(self.key, opened=ago(50))

    def close_with(self, reply, *, loop=None, mem=None):
        _, msgs = classify(None, [self.opener, reply], loops_reply(loop or self.loop), mem=mem)
        out = {"existing": [{"key": self.key, "status": "closed_by", "message": mid_of(msgs, reply)}], "new": []}
        plan, _ = classify(out, [self.opener, reply], loops_reply(loop or self.loop), mem=mem)
        return plan

    def closes(self, plan):
        return [w for w in plan.writes if w.kind == "close"]

    def test_member_reply_in_the_same_channel_closes(self):
        reply = thought(ago(10), "Kelli", "Sent it.", author_id=KELLI, in_reply_to=self.opener["metadata"]["source"])
        [w] = self.closes(self.close_with(reply))
        tag, f = parse_line(w.claim)
        self.assertEqual((tag, f["key"], f["by_message"]), ("CLOSED/1", self.key, msg_id(reply)))
        self.assertEqual(when(f["closed"]), ago(10))
        self.assertEqual(w.supersedes, self.loop["lineId"])
        self.assertEqual(w.source, reply["metadata"]["source"])
        self.assertEqual(w.proof, reply["metadata"]["proof"])

    def test_wrong_channel_id_is_dropped_and_counted(self):
        reply = thought(ago(10), "Kelli", "Sent it.", channel="swanzo", chan_id=SWANZO, author_id=KELLI)
        plan = self.close_with(reply)
        self.assertEqual(self.closes(plan), [])
        self.assertEqual(plan.counts["close_wrong_channel"], 1)

    def test_same_name_but_different_channel_id_is_not_rescued_by_the_name(self):
        reply = thought(ago(10), "Kelli", "Sent it.", channel="servest", chan_id=SWANZO, author_id=KELLI)
        plan = self.close_with(reply)
        self.assertEqual(self.closes(plan), [])
        self.assertEqual(plan.counts["close_wrong_channel"], 1)

    def test_thread_reply_with_matching_parent_id_closes(self):
        reply = thought(ago(10), "Kelli", "Sent it.", chan_id=THREAD, parent_id=SERVEST, author_id=KELLI)
        self.assertEqual(len(self.closes(self.close_with(reply))), 1)

    def test_a_clients_reply_never_closes(self):
        reply = thought(ago(10), "Thabo", "Any update?", author_id=THABO, in_reply_to=self.opener["metadata"]["source"])
        plan = self.close_with(reply)
        self.assertEqual(self.closes(plan), [])
        self.assertEqual(plan.counts["close_non_member"], 1)

    def test_a_client_using_a_members_name_is_refused_on_the_id(self):
        reply = thought(ago(10), "Kelli", "Done.", author_id=THABO)
        self.assertEqual(self.closes(self.close_with(reply)), [])

    def test_pre_c4_reply_falls_back_to_name_with_a_weak_note(self):
        reply = thought(ago(10), "Kelli", "Sent it.", c4=False)
        plan = self.close_with(reply)
        self.assertEqual(len(self.closes(plan)), 1)
        self.assertTrue(any("weak" in n for n in plan.notes), plan.notes)

    def test_pre_c4_reply_from_an_unknown_name_is_refused(self):
        reply = thought(ago(10), "Sipho", "Sent it.", c4=False)
        plan = self.close_with(reply)
        self.assertEqual(self.closes(plan), [])
        self.assertEqual(plan.counts["close_non_member"], 1)

    def test_reply_earlier_than_opened_is_refused(self):
        early = thought(ago(60), "Kelli", "Earlier chat.", author_id=KELLI)
        self.assertEqual(self.closes(self.close_with(early)), [])

    def test_reopen_then_the_same_reply_does_not_close_again(self):
        reply = thought(ago(10), "Kelli", "Sent it.", author_id=KELLI)
        reopened = loop_rec(self.key, opened=ago(50), reopened=ago(5), line="fact_reopen")
        plan = self.close_with(reply, loop=reopened)
        self.assertEqual(self.closes(plan), [])
        self.assertEqual(plan.counts["close_before_open"], 1)

    def test_a_reply_after_the_reopen_closes(self):
        reply = thought(ago(2), "Kelli", "Sent it again.", author_id=KELLI)
        reopened = loop_rec(self.key, opened=ago(50), reopened=ago(5), line="fact_reopen")
        [w] = self.closes(self.close_with(reply, loop=reopened))
        self.assertEqual(w.supersedes, "fact_reopen")

    def test_closing_message_not_in_the_window_is_refused(self):
        out = {"existing": [{"key": self.key, "status": "closed_by", "message": "m99"}], "new": []}
        plan, _ = classify(out, [self.opener], loops_reply(self.loop))
        self.assertEqual(plan.writes, [])
        self.assertEqual(plan.counts["close_bad_id"], 1)

    def test_key_not_offered_is_ignored(self):
        reply = thought(ago(10), "Kelli", "Sent it.", author_id=KELLI)
        _, msgs = classify(None, [self.opener, reply], loops_reply(self.loop))
        out = {"existing": [{"key": "999", "status": "closed_by", "message": mid_of(msgs, reply)}], "new": []}
        plan, _ = classify(out, [self.opener, reply], loops_reply(self.loop))
        self.assertEqual(plan.writes, [])
        self.assertEqual(plan.counts["unknown_key"], 1)


# --- C2 keys and generations (v3.1 rows 1 to 3) ---------------------------------------------------------------


class Generations(unittest.TestCase):
    def setUp(self):
        self.opener = thought(ago(100), "Thabo", "Please add Zola as supervisor and give her the reports role.", author_id=THABO)
        self.key = msg_id(self.opener)
        self.later = thought(ago(20), "Thabo", "Zola still cannot see reports.", author_id=THABO, in_reply_to=self.opener["metadata"]["source"])
        self.thoughts = [self.opener, self.later]

    def run_new(self, loops, *items_fn):
        _, msgs = classify(None, self.thoughts, loops)
        m = {t["id"]: mid_of(msgs, t) for t in self.thoughts}
        out = {"existing": [], "new": [fn(m) for fn in items_fn]}
        plan, _ = classify(out, self.thoughts, loops)
        return plan

    def both(self, m):
        return [m[self.opener["id"]], m[self.later["id"]]]

    def test_rule1_an_open_loop_re_reported_by_title_adds_evidence_once_and_keeps_reopened(self):
        lp = loop_rec(self.key, opened=ago(100), reopened=ago(50), evidence=[self.key], line="fact_open", title="Supervisor access for Zola")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("supervisor ACCESS for Zola!", self.both(m)))
        [w] = plan.writes
        self.assertEqual((w.kind, w.key, w.supersedes), ("update", self.key, "fact_open"))
        _, f = parse_line(w.claim)
        self.assertEqual(f["evidence"].split(","), [self.key, msg_id(self.later)])
        self.assertEqual(when(f["reopened"]), ago(50))
        self.assertEqual(f["title"], "Supervisor access for Zola", "a re-sighting keeps the recorded title")

    def test_rule1_an_open_loop_re_reported_by_key_with_another_title_attaches(self):
        lp = loop_rec(self.key, opened=ago(100), evidence=[self.key], title="Supervisor access for Zola")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Zola's supervisor rights", self.both(m), key=self.key))
        self.assertEqual([(w.kind, w.key) for w in plan.writes], [("update", self.key)])

    def test_rule1_resighting_with_nothing_new_writes_nothing(self):
        lp = loop_rec(self.key, opened=ago(100), evidence=[self.key, msg_id(self.later)], title="Supervisor access for Zola")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Supervisor access for Zola", self.both(m)))
        self.assertEqual(plan.writes, [])

    def test_rule1_parked_resighting_writes_nothing(self):
        lp = loop_rec(self.key, opened=ago(100), state="parked", title="Supervisor access for Zola")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Supervisor access for Zola", self.both(m)))
        self.assertEqual(plan.writes, [])
        self.assertEqual(plan.counts["resighted_parked"], 1)

    def test_s1_a_re_reported_open_loop_beside_a_new_ask_on_the_same_opener(self):
        """Review row 1, S1: the new ask must be recorded, the open loop must not be duplicated as :b."""
        lp = loop_rec(self.key, opened=ago(100), evidence=[self.key], title="Zebra: confirm the KZN list", line="fact_z")
        plan = self.run_new(loops_reply(lp),
                            lambda m: new_item("Zebra: confirm the KZN list", [m[self.opener["id"]]]),
                            lambda m: new_item("Apple: send the Swanzo export", self.both(m)))
        got = writes_of(plan)
        self.assertEqual(list(got), [("open", f"{self.key}:b")])
        self.assertEqual(got[("open", f"{self.key}:b")]["title"], "Apple: send the Swanzo export")

    def test_fresh_letters_skip_the_ones_the_family_already_uses(self):
        g1 = loop_rec(self.key, opened=ago(100), title="Zebra: confirm the KZN list")
        gb = loop_rec(f"{self.key}:b", opened=ago(100), title="Mango: book the site visit")
        plan = self.run_new(loops_reply(g1, gb),
                            lambda m: new_item("Apple: send the Swanzo export", self.both(m)),
                            lambda m: new_item("Banana: renew the licence", self.both(m)))
        self.assertEqual(sorted(w.key for w in plan.writes), [f"{self.key}:c", f"{self.key}:d"])

    def test_s2_a_second_ask_on_a_resolved_opener_is_recorded_not_suppressed(self):
        """Review row 2, S2: suppression compares what is owed, not only times."""
        lp = loop_rec(self.key, opened=ago(100), state="resolved", closed=ago(48), learned=ago(48), title="Confirm the KZN list")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Send the Swanzo export", [m[self.opener["id"]]]))
        self.assertEqual([(w.kind, w.key) for w in plan.writes], [("open", f"{self.key}:b")])
        self.assertEqual(plan.counts["resighted_closed"], 0)

    def test_rule2_an_attached_item_with_only_old_messages_is_suppressed_and_counted(self):
        for attach in ("key", "title"):
            with self.subTest(attach=attach):
                lp = loop_rec(self.key, opened=ago(100), state="closed", closed=ago(10), title="Supervisor access for Zola")
                plan = self.run_new(loops_reply(lp), lambda m: new_item("Supervisor access for Zola" if attach == "title" else "Something else",
                                                                         self.both(m), key=self.key if attach == "key" else None))
                self.assertEqual(plan.writes, [])
                self.assertEqual(plan.counts["resighted_closed"], 1)

    def test_rule2_suppression_compares_the_items_own_key_not_a_finished_sibling(self):
        closed_b = loop_rec(f"{self.key}:b", opened=ago(100), state="closed", closed=ago(5), title="Supervisor access for Zola")
        plan = self.run_new(loops_reply(closed_b), lambda m: new_item("Reports role for Zola", self.both(m)))
        self.assertEqual([w.key for w in plan.writes], [self.key], "an unattached item on a fresh letter is never suppressed by a sibling")

    def test_rule2_an_attached_item_with_a_later_message_opens_generation_two_from_the_new_ask(self):
        lp = loop_rec(self.key, opened=ago(100), state="closed", closed=ago(50), title="Reports role for Zola")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Reports role for Zola", self.both(m)))
        [w] = plan.writes
        self.assertEqual((w.kind, w.key, w.supersedes), ("open", f"{self.key}:2", None))
        _, f = parse_line(w.claim)
        self.assertEqual(when(f["opened"]), ago(20), "generation 2 opens at the new ask, so the old closing reply cannot close it")

    def test_rule2_generation_three_when_two_is_finished(self):
        g1 = loop_rec(self.key, opened=ago(100), state="closed", closed=ago(90), title="Reports role for Zola")
        g2 = loop_rec(f"{self.key}:2", opened=ago(80), state="resolved", closed=ago(40), learned=ago(40), title="Reports role for Zola")
        plan = self.run_new(loops_reply(g1, g2), lambda m: new_item("Reports role for Zola", self.both(m), key=self.key))
        self.assertEqual([w.key for w in plan.writes], [f"{self.key}:3"])

    def test_row17_a_resolve_claiming_a_future_time_is_read_at_when_it_was_learned(self):
        lp = loop_rec(self.key, opened=ago(100), state="resolved", closed=datetime(2099, 1, 1, tzinfo=UTC), learned=ago(30),
                      title="Reports role for Zola")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Reports role for Zola", self.both(m)))
        self.assertEqual([w.key for w in plan.writes], [f"{self.key}:2"], "the message 20 h ago is later than the resolve learned 30 h ago")

    def test_a_closed_loop_keeps_its_message_time_even_if_learned_later(self):
        lp = loop_rec(self.key, opened=ago(100), state="closed", closed=ago(10), learned=ago(1), title="Reports role for Zola")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Reports role for Zola", self.both(m)))
        self.assertEqual(plan.writes, [])

    def test_rule3_two_asks_in_one_message_get_b_in_title_order(self):
        plan = self.run_new(loops_reply(),
                            lambda m: new_item("Supervisor access for Zola", [m[self.opener["id"]]]),
                            lambda m: new_item("Reports role for Zola", self.both(m)))
        got = {w.key: parse_line(w.claim)[1]["title"] for w in plan.writes}
        self.assertEqual(got, {self.key: "Reports role for Zola", f"{self.key}:b": "Supervisor access for Zola"})

    def test_two_items_with_one_title_make_one_loop_with_both_evidence(self):
        # Only the first in title order cites the later message: losing either item's evidence shows.
        plan = self.run_new(loops_reply(),
                            lambda m: new_item("Reports role for zola.", [m[self.opener["id"]]]),
                            lambda m: new_item("Reports role for Zola", [m[self.later["id"]], m[self.opener["id"]]]))
        [w] = plan.writes
        _, f = parse_line(w.claim)
        self.assertEqual(f["evidence"].split(","), [self.key, msg_id(self.later)])
        self.assertEqual(f["title"], "Reports role for Zola", "the first in title order names the loop")

    def test_unreadable_line_on_the_opener_blocks_its_new_loops(self):
        plan = self.run_new(loops_reply(unreadable=[{"subject": f"loop:{self.key}", "lineId": "fact_bad"}]),
                            lambda m: new_item("Supervisor for Zola", [m[self.opener["id"]]]))
        self.assertEqual(plan.writes, [])
        self.assertEqual(plan.counts["unreadable_conflict"], 1)

    def test_an_unknown_key_on_a_new_item_is_counted_and_ignored(self):
        plan = self.run_new(loops_reply(), lambda m: new_item("Reports role for Zola", self.both(m), key="1234567890123456789"))
        self.assertEqual([w.key for w in plan.writes], [self.key])
        self.assertEqual(plan.counts["unknown_key_new"], 1)

    def test_opener_is_the_oldest_cited_message_not_the_first_listed(self):
        plan = self.run_new(loops_reply(), lambda m: new_item("Reports role for Zola", [m[self.later["id"]], m[self.opener["id"]]]))
        [w] = plan.writes
        self.assertEqual(w.key, self.key)
        self.assertEqual(w.source, self.opener["metadata"]["source"])


class Channels(unittest.TestCase):
    def test_s3_evidence_from_another_channel_is_dropped_and_the_named_channel_decides(self):
        """Review row 3, S3: an older context message in #billing must not make it a billing loop."""
        context = thought(ago(80), "Charne", "context: billing run is Friday", channel="billing", chan_id=BILLING, author_id=KELLI)
        ask = thought(ago(30), "Thabo", "Can someone fix the Servest export?", author_id=THABO)
        ts = [context, ask]
        _, msgs = classify(None, ts, loops_reply())
        out = {"existing": [], "new": [new_item("Fix the Servest export", [mid_of(msgs, context), mid_of(msgs, ask)])]}
        plan, _ = classify(out, ts, loops_reply())
        [w] = plan.writes
        _, f = parse_line(w.claim)
        self.assertEqual((w.key, f["channel"], f["channel_id"], f["client"], f["evidence"]), (msg_id(ask), "servest", SERVEST, "servest", msg_id(ask)))
        self.assertEqual(plan.counts["cross_channel"], 1)

    def test_an_item_with_no_evidence_in_its_named_channel_is_dropped(self):
        t = thought(ago(30), "Lerato", "Export fails.", channel="swanzo", chan_id=SWANZO, author_id=LERATO)
        _, msgs = classify(None, [t], loops_reply())
        out = {"existing": [], "new": [new_item("Export", [mid_of(msgs, t)], channel="servest")]}
        plan, _ = classify(out, [t], loops_reply())
        self.assertEqual(plan.writes, [])
        self.assertEqual((plan.counts["cross_channel"], plan.counts["bad_channel"]), (1, 1))

    def test_evidence_add_from_another_channel_is_dropped(self):
        opener = thought(ago(80), "Thabo", "Export fails.", author_id=THABO)
        elsewhere = thought(ago(10), "Lerato", "Same here.", channel="swanzo", chan_id=SWANZO, author_id=LERATO)
        lp = loop_rec(msg_id(opener), opened=ago(80))
        _, msgs = classify(None, [opener, elsewhere], loops_reply(lp))
        out = {"existing": [{"key": lp["key"], "status": "evidence_add", "evidence": [mid_of(msgs, elsewhere)]}], "new": []}
        plan, _ = classify(out, [opener, elsewhere], loops_reply(lp))
        self.assertEqual(plan.writes, [])
        self.assertEqual(plan.counts["cross_channel"], 1)

    def test_a_thread_message_counts_as_its_parent_channel(self):
        ask = thought(ago(30), "Thabo", "In a thread.", chan_id=THREAD, parent_id=SERVEST, author_id=THABO)
        _, msgs = classify(None, [ask], loops_reply())
        out = {"existing": [], "new": [new_item("Thread ask", [mid_of(msgs, ask)])]}
        plan, _ = classify(out, [ask], loops_reply())
        _, f = parse_line(plan.writes[0].claim)
        self.assertEqual((f["channel"], f["channel_id"], f["client"]), ("servest", SERVEST, "servest"), "a thread loop keys on its parent channel")


class NewLoops(unittest.TestCase):
    def test_drops_as_today_bad_id_portal_too_young_bad_type(self):
        old = thought(ago(30), "Thabo", "Please fix the export.", author_id=THABO)
        portal = thought(ago(30), "Thabo", "Who resets passwords?", author_id=THABO)
        young = thought(ago(1), "Thabo", "Can someone call me?", author_id=THABO)
        promise = thought(ago(10), "Kelli", "I'll send it tomorrow.", author_id=KELLI)
        ts = [old, portal, young, promise]
        _, msgs = classify(None, ts, loops_reply(), portal={portal["metadata"]["source"]})
        m = {t["id"]: mid_of(msgs, t) for t in ts}
        out = {"existing": [], "new": [
            new_item("Invented", ["m77"]),
            new_item("No evidence", []),
            new_item("Password reset", [m[portal["id"]]]),
            new_item("Call back", [m[young["id"]]]),
            new_item("Send it", [m[promise["id"]]], type_="unkept_promise"),  # 10 h < 24 h
            new_item("Export fix", [m[old["id"]]], type_="feature_request"),
            new_item("Export fix", [m[old["id"]]]),
        ]}
        plan, _ = classify(out, ts, loops_reply(), portal={portal["metadata"]["source"]})
        self.assertEqual([w.key for w in plan.writes], [msg_id(old)])
        self.assertEqual((plan.counts["bad_id"], plan.counts["on_portal"], plan.counts["too_young"], plan.counts["bad_type"]), (2, 1, 2, 1))

    def test_client_comes_from_the_mapping_over_the_model(self):
        t = thought(ago(30), "Lerato", "Export fails.", channel="swanzo", chan_id=SWANZO, author_id=LERATO)
        i = thought(ago(30), "Devon", "I'll write the notes.", channel="dev-internal", chan_id=INTERNAL, author_id=DEVON)
        ts = [t, i]
        _, msgs = classify(None, ts, loops_reply())
        out = {"existing": [], "new": [
            new_item("Export", [mid_of(msgs, t)], channel="swanzo", client="servest"),
            new_item("Notes", [mid_of(msgs, i)], type_="unkept_promise", channel="dev-internal", client="madeup"),
        ]}
        plan, _ = classify(out, ts, loops_reply())
        got = {w.key: parse_line(w.claim)[1] for w in plan.writes}
        self.assertEqual((got[msg_id(t)]["channel"], got[msg_id(t)]["channel_id"], got[msg_id(t)]["client"]), ("swanzo", SWANZO, "swanzo"))
        self.assertEqual(got[msg_id(i)]["client"], "internal")

    def test_row4_a_mixed_channel_loop_naming_a_known_client_gets_that_client(self):
        t = thought(ago(30), "Thabo", "Servest portal is down for all supervisors.", channel="urgent_support", chan_id=URGENT, author_id=THABO)
        _, msgs = classify(None, [t], loops_reply())
        out = {"existing": [], "new": [new_item("Servest portal outage", [mid_of(msgs, t)], channel="urgent_support", client="servest")]}
        plan, _ = classify(out, [t], loops_reply(), clients={"servest", "swanzo", "lungile"})
        self.assertEqual(parse_line(plan.writes[0].claim)[1]["client"], "servest")
        out["new"][0]["client"] = "client:lungile"
        plan, _ = classify(out, [t], loops_reply(), clients={"servest", "swanzo", "lungile"})
        self.assertEqual(parse_line(plan.writes[0].claim)[1]["client"], "lungile", "a client with no mapped channel is still on the list")

    def test_message_ids_never_leak_into_title_or_summary(self):
        t = thought(ago(30), "Thabo", "Export fails.", author_id=THABO)
        _, msgs = classify(None, [t], loops_reply())
        out = {"existing": [], "new": [new_item("Export (m1) fails", [mid_of(msgs, t)], summary="Asked in m1, m2 and nothing since.")]}
        plan, _ = classify(out, [t], loops_reply())
        _, f = parse_line(plan.writes[0].claim)
        self.assertNotRegex(f["title"] + f["summary"], r"\bm\d+\b")


class Updates(unittest.TestCase):
    def setUp(self):
        self.opener = thought(ago(80), "Thabo", "Export fails.", author_id=THABO)
        self.nudge = thought(ago(20), "Thabo", "Any news?", author_id=THABO)
        self.key = msg_id(self.opener)

    def run_existing(self, lp, *entries_fn):
        ts = [self.opener, self.nudge]
        _, msgs = classify(None, ts, loops_reply(lp))
        m = {t["id"]: mid_of(msgs, t) for t in ts}
        out = {"existing": [fn(m) for fn in entries_fn], "new": []}
        plan, _ = classify(out, ts, loops_reply(lp))
        return plan

    def test_owner_to_or_from_unclear_is_ignored(self):
        for old, new in (("unclear", "Kelli"), ("Kelli", "unclear"), ("Kelli", ""), ("Kelli", "kelli")):
            with self.subTest(old=old, new=new):
                lp = loop_rec(self.key, opened=ago(80), owner=old)
                plan = self.run_existing(lp, lambda m: {"key": self.key, "status": "owner_now", "owner": new, "message": m[self.nudge["id"]]})
                self.assertEqual(plan.writes, [])

    def test_owner_name_to_name_writes_one_open_line_keeping_the_rest(self):
        lp = loop_rec(self.key, opened=ago(80), owner="Kelli", reopened=ago(60), title="Export fix for Servest", line="fact_h")
        plan = self.run_existing(lp, lambda m: {"key": self.key, "status": "owner_now", "owner": "Devon", "message": m[self.nudge["id"]]})
        [w] = plan.writes
        _, f = parse_line(w.claim)
        self.assertEqual((w.kind, w.supersedes, f["owner"], f["title"]), ("update", "fact_h", "Devon", "Export fix for Servest"))
        self.assertEqual(when(f["opened"]), ago(80))
        self.assertEqual(when(f["reopened"]), ago(60))

    def test_evidence_add_writes_only_when_the_stored_list_changes(self):
        lp = loop_rec(self.key, opened=ago(80), evidence=[self.key, msg_id(self.nudge)])
        plan = self.run_existing(lp, lambda m: {"key": self.key, "status": "evidence_add", "evidence": [m[self.nudge["id"]]]})
        self.assertEqual(plan.writes, [])
        lp2 = loop_rec(self.key, opened=ago(80), evidence=[self.key])
        plan2 = self.run_existing(lp2, lambda m: {"key": self.key, "status": "evidence_add", "evidence": [m[self.nudge["id"]], "m404"]})
        [w] = plan2.writes
        self.assertEqual(parse_line(w.claim)[1]["evidence"].split(","), [self.key, msg_id(self.nudge)])

    def test_one_line_per_loop_per_run_and_a_close_wins(self):
        reply = thought(ago(5), "Kelli", "Fixed.", author_id=KELLI)
        ts = [self.opener, self.nudge, reply]
        lp = loop_rec(self.key, opened=ago(80), owner="Kelli", title="Export again")
        _, msgs = classify(None, ts, loops_reply(lp))
        m = {t["id"]: mid_of(msgs, t) for t in ts}
        out = {"existing": [
            {"key": self.key, "status": "evidence_add", "evidence": [m[self.nudge["id"]]]},
            {"key": self.key, "status": "owner_now", "owner": "Devon"},
            {"key": self.key, "status": "closed_by", "message": m[reply["id"]]},
        ], "new": [new_item("Export again", [m[self.opener["id"]], m[self.nudge["id"]]])]}
        plan, _ = classify(out, ts, loops_reply(lp))
        self.assertEqual([(w.kind, w.key) for w in plan.writes], [("close", self.key)])


# --- the recorded transcript ----------------------------------------------------------------------------------


class RecordedTranscript(unittest.TestCase):
    def setUp(self):
        self.thoughts = json.loads((FIX / "window.json").read_text(encoding="utf-8"))
        self.pulse = json.loads((FIX / "pulse.json").read_text(encoding="utf-8"))
        self.loops = json.loads((FIX / "loops.json").read_text(encoding="utf-8"))
        self.answer = json.loads((FIX / "model_answer.json").read_text(encoding="utf-8"))
        self.portal = {le["source"] for le in self.pulse["looseEnds"]}
        self.mapping = ol.client_map(self.pulse)

    def test_transcript_has_the_recorded_shape(self):
        msgs = ol.load(self.thoughts, self.portal)
        got = ol.transcript(msgs, self.mapping)
        self.assertEqual(got.strip("\n"), (FIX / "transcript.txt").read_text(encoding="utf-8").strip("\n"))

    def test_recorded_answer_yields_the_expected_keys(self):
        msgs = ol.load(self.thoughts, self.portal)
        m = members()
        m.learn(msgs)
        plan = ol.classify(self.answer, msgs, self.loops, m, self.mapping, NOW, None)
        opens = {w.key: parse_line(w.claim)[1]["title"] for w in plan.writes if w.kind == "open"}
        self.assertEqual(opens, {
            S1: "Bellville site added to the portal",
            f"{S1}:b": "September incident report for Servest",
            D1: "APIM routing notes for the team",
            f"{W0}:b": "Reports role for Zola",  # a different thing owed on W0's opener: a fresh letter, not W0's generation
        })
        self.assertEqual([w.key for w in plan.writes if w.kind == "close"], [W1])
        self.assertEqual([w for w in plan.writes if w.kind == "update"], [], "owner from unclear is ignored")
        self.assertEqual((plan.counts["resighted_closed"], plan.counts["on_portal"]), (1, 1), "the Supervisor item attaches to W0 by key")
        self.assertEqual(parse_line(next(w for w in plan.writes if w.key == D1).claim)[1]["client"], "internal")


# --- the whole run, against fakes -----------------------------------------------------------------------------


class Run(JobCase):
    def test_dry_run_writes_nothing_and_says_what_it_would_do(self):
        net = fixture_net()
        code, out, _ = self.run_main(net)
        self.assertEqual(code, 0)
        self.assertEqual(net.captures, [])
        self.assertEqual(net.posts, [])
        self.assertEqual([c["url"] for c in net.calls if c["method"] != "GET"], [ANTHROPIC])
        self.assertIn("would open 4, close 1, update 0", out)
        self.assertIn("Bellville site added to the portal", out, "the dry run prints the post it would make")

    def test_post_writes_one_line_per_transition_then_posts_from_a_fresh_read(self):
        net = fixture_net()
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(sorted(c["subject"] for c in net.captures), sorted(f"loop:{k}" for k in (S1, f"{S1}:b", D1, f"{W0}:b", W1)))
        [close] = net.captures_for(W1)
        self.assertEqual(close["supersedes"], "fact_w1")
        self.assertTrue(close["content"].startswith("CLOSED/1 | key=" + W1))
        self.assertTrue(all(c.get("occurred_at") for c in net.captures))
        loops_at = [i for i, c in enumerate(net.calls) if "/browse/api/loops" in c["url"]]
        mcp_at = [i for i, c in enumerate(net.calls) if c["url"] == BASE + "/mcp"]
        self.assertGreaterEqual(len(loops_at), 2, "/loops is read again after the writes")
        self.assertGreater(loops_at[-1], mcp_at[-1])
        text = self.posted(net)
        for title in ("Bellville site added to the portal", "September incident report for Servest", "Reports role for Zola",
                      "APIM routing notes for the team", "Site list export for Servest"):
            self.assertIn(title, text)
        self.assertNotIn("Quarterly review pack", text, "parked loops are left out")
        self.assertNotIn("6498 export fails on large sites](", text.split("Closed in channel")[0], "a closed loop is not listed as open")
        self.assertIn(f"https://discord.com/channels/{GUILD}/{SWANZO}/{W2}", text, "the evidence close links its reply")
        self.assertIn("1 re-sightings of closed loops suppressed", text)
        self.assertIn("to resolve, press /loops in the xactco server", text.lower())
        self.assertTrue(all(p["allowed_mentions"] == {"parse": []} for p in net.posts))
        self.assertTrue(all(len(p["content"]) <= 2000 for p in net.posts))

    def test_the_model_sees_finished_loops_whose_opener_is_in_the_window_and_the_client_list(self):
        net = fixture_net()
        net.records["1000000000000000001"] = loop_rec("1000000000000000001", opened=ago(900), state="closed", closed=ago(800), title="Ancient thing")
        self.run_main(net)
        user = net.user_message()
        finished = user.split("Loops already finished")[1].split("Messages")[0]
        self.assertIn(f"key {W0}", finished)
        self.assertIn("Supervisor access for Zola", finished)
        self.assertNotIn("1000000000000000001", user, "a finished loop whose opener is outside the window is not shown")
        self.assertNotIn(f"key {W1}", finished, "an open loop is listed with the open ones")
        self.assertRegex(user, r"Clients: .*servest.*swanzo")

    def test_newest_loops_come_first(self):
        net = fixture_net()
        self.run_main(net, "--post")
        text = self.posted(net)
        self.assertLess(text.index("September incident report"), text.index("APIM routing notes"))
        self.assertLess(text.index("APIM routing notes"), text.index("Reports role for Zola"))
        self.assertLess(text.index("Reports role for Zola"), text.index("Site list export for Servest"))

    def test_every_call_has_a_timeout_and_the_model_streams(self):
        net = fixture_net()
        self.run_main(net, "--post")
        model = [c for c in net.calls if c["url"] == ANTHROPIC]
        others = [c for c in net.calls if c["url"] != ANTHROPIC]
        self.assertTrue(others)
        self.assertEqual({c["timeout"] for c in others}, {30})
        self.assertEqual(len(model), 1)
        self.assertTrue(net.model_requests[0]["stream"], "only a streamed call can live with a silence timeout")
        self.assertLessEqual(model[0]["timeout"], 180)

    def test_grysstof_calls_carry_the_key_and_the_actor(self):
        net = fixture_net()
        self.run_main(net, "--post")
        for c in net.calls:
            if c["url"].startswith(BASE):
                self.assertEqual(c["headers"].get("x-brain-key"), "test-key")
                self.assertEqual(c["headers"].get("x-brain-actor"), "open-loops")

    def test_sse_reply_from_mcp_is_decoded(self):
        net = fixture_net(mcp="sse")
        code, _, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, err)
        self.assertEqual(len(net.captures), 5)

    def test_a_reworded_or_foreign_confirmation_is_not_taken_as_written(self):
        for reply in ("Captured as observation", f"Recorded fact fact_9 about loop:{W1}:2 (from x)", "Recorded fact fact_9 about loop:999 (from x)"):
            with self.subTest(reply=reply):
                g = ol.Grysstof(BASE + "/mcp", "k")
                w = ol.Write("close", W1, "CLOSED/1 | key=" + W1, "fact_w1", "s", "p", "2026-10-26T08:00:00.000Z", {})
                with mock.patch.object(ol, "http_text", return_value=(rpc({"content": [{"type": "text", "text": reply}]}).decode(), None)):
                    with self.assertRaises(ol.JobError):
                        g.capture(w)

    # --- row 5: writes and their failures

    def test_error_after_the_line_exists_rereads_and_does_not_write_twice(self):
        net = fixture_net()
        net.mcp_faults = ["error_after_write"]  # the first write (the close) lands, then the reply is an error
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(net.captures), 5, "no second write for the line that already landed")
        self.assertIn("landed", out + err)

    def test_a_superseding_write_that_failed_cleanly_is_retried_once(self):
        net = fixture_net()
        net.mcp_faults = ["error_before_write"]  # the close (it has supersedes) fails without writing
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(net.captures_for(W1)), 2)

    def test_a_new_loop_write_is_never_retried(self):
        net = fixture_net()
        net.mcp_faults = [None, "error_before_write"]  # the close goes through; the first new open fails without writing
        code, out, err = self.run_main(net, "--post")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(net.captures), 5, "the failed new open is not sent again")
        self.assertIn("1 ledger write failed", self.posted(net))

    def test_a_timed_out_write_that_lands_late_is_found_on_the_one_re_read(self):
        net = fixture_net()
        net.mcp_faults = [None, "timeout_late:0"]  # the server lands the new open before the job's re-read
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(net.captures), 5)
        self.assertTrue(self.sleeps, "the job pauses before its re-read")
        self.assertIn("landed", out + err)

    def test_a_timed_out_write_still_missing_after_the_re_read_is_unknown_and_never_forked(self):
        net = fixture_net()
        net.mcp_faults = [None, "timeout_late:5"]  # it lands only after the job has looked
        code, out, err = self.run_main(net, "--post")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(net.captures), 5, "a timed-out write is not sent again")
        self.assertIn("unknown", (out + err).lower())
        self.assertIn("unknown", self.posted(net).lower())
        timed_out = net.captures[1]["subject"]
        net.flush_pending()
        self.assertEqual(len([f for f in net.ledger[timed_out] if not f.get("supersededBy")]), 1, "one head: no fork")

    def test_a_timed_out_superseding_write_is_not_retried_either(self):
        net = fixture_net()
        net.mcp_faults = ["timeout"]  # the close dies on the wire
        code, out, err = self.run_main(net, "--post")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(net.captures_for(W1)), 1)
        self.assertIn("unknown", (out + err).lower())

    # --- row 7: a fresh read for the post; a conflict is not a failure

    def test_a_loop_resolved_during_the_run_is_a_conflict_not_a_failure(self):
        net = fixture_net()

        def kelli_resolves():  # while the model thinks, Kelli presses Resolve on W1
            net.ledger[f"loop:{W1}"] = [{"id": "fact_kelli", "subject": f"loop:{W1}", "claim": f"RESOLVED/1 | key={W1}", "supersedes": "fact_w1"},
                                        {"id": "fact_w1", "subject": f"loop:{W1}", "claim": f"OPEN/1 | key={W1}", "supersededBy": "fact_kelli"}]
            net.records[W1].update({"state": "resolved", "lineId": "fact_kelli", "closed": iso(NOW), "learnedAt": iso(NOW)})

        net.model_hooks.append(kelli_resolves)
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(net.captures_for(W1)), 1, "a stale supersedes is not retried")
        text = self.posted(net)
        self.assertNotIn("6498 export fails on large sites", text.split("Closed in channel")[0], "the fresh read shows it resolved")
        self.assertIn("1 loop changed by someone else during the run", text)
        self.assertNotIn("write failed", text)

    def test_a_loop_parked_during_the_run_is_left_out_of_the_post(self):
        net = fixture_net()
        net.model_hooks.append(lambda: net.records[X1].update({"state": "parked", "until": "2026-11-09", "lineId": "fact_park"}))
        code, _, _ = self.run_main(net, "--post")
        self.assertEqual(code, 0)
        self.assertNotIn("Site list export for Servest", self.posted(net))

    # --- the model

    def test_model_failure_posts_the_recorded_list_under_a_stale_header(self):
        failures = {
            "http 529": ("http", 529),
            "timeout": socket.timeout("timed out"),
            "stream error": sse([{"type": "message_start", "message": {"usage": {"input_tokens": 5}}},
                                 {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}]),
            "refusal": model_stream(EMPTY_ANSWER, stop="refusal"),
            "cut off": model_stream('{"existing": [], "new": [', stop="max_tokens"),
            "no json": "I could not find any loops.",
            "stream ends early": sse([{"type": "message_start", "message": {"usage": {"input_tokens": 5}}},
                                      {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": EMPTY_ANSWER}}]),
        }
        for name, model in failures.items():
            with self.subTest(name):
                net = fixture_net()
                net.model = model
                code, out, err = self.run_main(net, "--post")
                self.assertNotEqual(code, 0)
                self.assertEqual(net.captures, [])
                text = self.posted(net)
                self.assertIn("model pass failed; list may be stale", text)
                self.assertIn("6498 export fails on large sites", text, "the recorded open loops are still listed")
                self.assertNotIn("Quarterly review pack", text)

    def test_a_console_that_is_not_utf8_still_gets_the_failure_out(self):
        for post in (False, True):
            with self.subTest(post=post):
                net = fixture_net()
                net.model = ("http", 401)
                net.clock = self.clock
                out_raw, err_raw = io.BytesIO(), io.BytesIO()
                out = io.TextIOWrapper(out_raw, encoding="cp1252", errors="strict")
                err = io.TextIOWrapper(err_raw, encoding="cp1252", errors="strict")
                argv = ["--env", str(self.env_path)] + (["--post"] if post else [])
                with mock.patch("urllib.request.urlopen", net), mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", err):
                    code = ol.main(argv)  # must not raise UnicodeEncodeError
                out.flush()
                err.flush()
                printed = out_raw.getvalue().decode("cp1252") + err_raw.getvalue().decode("cp1252")
                self.assertEqual(net.unexpected, [])
                self.assertNotEqual(code, 0)
                self.assertIn("model.failed", printed)
                if post:
                    self.assertIn("⚠", self.posted(net), "Discord still gets the marks")
                    self.assertIn("model pass failed; list may be stale", self.posted(net))
                else:
                    self.assertIn("model pass failed; list may be stale", printed)

    def test_model_failure_dry_run_posts_nothing(self):
        net = fixture_net()
        net.model = ("http", 500)
        code, out, _ = self.run_main(net)
        self.assertNotEqual(code, 0)
        self.assertEqual((net.posts, net.captures), ([], []))
        self.assertIn("model pass failed; list may be stale", out)

    def test_row28_the_model_sits_behind_one_ask_function_chosen_by_env(self):
        seen = []

        def fake_provider(env):
            def ask(system, user):
                seen.append((system, user))
                return EMPTY_ANSWER
            return ask

        self.env_path.write_text(ENV_TEXT.replace("ANTHROPIC_API_KEY=test-anthropic\n", "") + "OPEN_LOOPS_MODEL_PROVIDER=fake\n", encoding="utf-8")
        net = fixture_net()
        with mock.patch.dict(ol.PROVIDERS, {"fake": fake_provider}):
            code, out, err = self.run_main(net)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(net.model_requests, [], "no Anthropic call when another provider is chosen")
        [(system, user)] = seen
        self.assertEqual(system, ol.SYSTEM)
        self.assertIn("[m1]", user)

    def test_an_unknown_provider_fails_in_one_line_before_any_call(self):
        self.env_path.write_text(ENV_TEXT + "OPEN_LOOPS_MODEL_PROVIDER=nope\n", encoding="utf-8")
        net = fixture_net()
        code, _, err = self.run_main(net)
        self.assertNotEqual(code, 0)
        self.assertEqual(net.calls, [])
        self.assertIn("nope", err)

    # --- row 6: SIGTERM and the deadline

    def test_sigterm_during_the_model_call_runs_the_failure_path(self):
        net = fixture_net()
        net.model_hooks.append(lambda: signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None))
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 1)
        self.assertEqual(net.captures, [])
        self.assertEqual(len(net.posts), 1)
        self.assertIn("Open loops job failed", net.posts[0]["content"])
        self.assertIn("SIGTERM", net.posts[0]["content"])

    def test_sigterm_during_the_writes_stops_them_and_says_so(self):
        net = fixture_net()
        net.mcp_faults = [None, "sigterm"]
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 1)
        self.assertEqual(len(net.captures), 2, "nothing is written after the signal")
        self.assertIn("SIGTERM", self.posted(net))

    def test_a_model_pass_that_runs_past_the_deadline_falls_back_to_the_stale_post(self):
        net = fixture_net()
        net.model_hooks.append(lambda: self.clock.advance(ol.DEADLINE_SECONDS + 5))
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 1)
        self.assertEqual(net.captures, [])
        self.assertIn("model pass failed; list may be stale", self.posted(net))

    def test_a_slow_stream_is_abandoned_at_the_deadline_not_read_to_the_end(self):
        net = fixture_net()
        net.model = EMPTY_ANSWER + " " * 4000  # about 110 text deltas, some 350 lines
        net.stream_tick = 10                   # ten seconds a line: the 780 s run out after about 78 lines
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 1)
        self.assertLess(net.stream_lines_read, 100, "the job stops reading at the deadline")
        self.assertEqual(net.captures, [])
        self.assertIn("model pass failed; list may be stale", self.posted(net))

    def test_the_model_call_never_waits_past_the_deadline(self):
        net = fixture_net()
        start = self.clock.t  # the run's deadline starts here
        original = net.browse

        def slow_loops(route, q):
            if route == "/loops" and not net.model_requests:
                self.clock.t = start + ol.DEADLINE_SECONDS - 50  # the reads took all but 50 s
            return original(route, q)

        net.browse = slow_loops
        self.run_main(net)
        [model] = [c for c in net.calls if c["url"] == ANTHROPIC]
        self.assertLessEqual(model["timeout"], 50)

    def test_writes_stop_at_the_deadline_and_the_rest_are_counted(self):
        net = fixture_net()
        net.mcp_faults = [f"advance:{ol.DEADLINE_SECONDS}"]  # the first write takes the rest of the time
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 1)
        self.assertEqual(len(net.captures), 1)
        text = self.posted(net)
        self.assertIn("4 ledger writes not made", text)
        self.assertIn("Site list export for Servest", text, "the post still goes out, from a fresh read")

    # --- reads

    def test_grysstof_down_posts_one_failure_line(self):
        net = fixture_net()
        net.route_override["/pulse/overview"] = http_error(BASE + "/browse/api/pulse/overview", 500)
        code, _, err = self.run_main(net, "--post")
        self.assertEqual(code, 1)
        self.assertEqual(net.captures, [])
        self.assertEqual(len(net.posts), 1)
        self.assertIn("Open loops job failed", net.posts[0]["content"])
        self.assertEqual(len([ln for ln in err.splitlines() if ln.strip()]), 1)
        self.assertEqual(net.model_requests, [])

    def test_gate_denial_on_browse_is_a_loud_failure_not_an_empty_list(self):
        net = fixture_net()
        net.route_override["/thoughts"] = FakeResp(rpc(error={"code": -32001, "message": "Unauthorized: missing or invalid authentication."}))
        code, _, err = self.run_main(net)
        self.assertEqual(code, 1)
        self.assertIn("Unauthorized", err)
        self.assertEqual(net.model_requests, [])

    def test_window_pages_by_offset_until_a_short_page(self):
        ts = [thought(ago(30 - i), "Thabo", f"message {i}", author_id=THABO) for i in range(7)]
        net = FakeNet(thoughts=ts, model=EMPTY_ANSWER)
        with mock.patch.object(ol, "PAGE", 3):
            code, _, err = self.run_main(net)
        self.assertEqual(code, 0, err)
        queries = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(c["url"]).query)) for c in net.calls if "/browse/api/thoughts" in c["url"]]
        self.assertEqual([q["offset"] for q in queries], ["0", "3", "6"])
        self.assertEqual((queries[0]["source_prefix"], queries[0]["order"]), ("discord:", "oldest"))
        self.assertEqual(when(queries[0]["since"]), NOW - timedelta(days=7))
        self.assertIn("[m7]", net.user_message())

    def test_the_window_cap_is_the_window_total_and_fails_loudly(self):
        ts = [thought(ago(30 - i), "Thabo", f"message {i}", author_id=THABO) for i in range(7)]
        net = FakeNet(thoughts=ts, model=EMPTY_ANSWER)
        with mock.patch.object(ol, "PAGE", 3), mock.patch.object(ol, "WINDOW_CAP", 6):
            code, _, err = self.run_main(net)
        self.assertEqual(code, 1)
        self.assertIn("6", err)
        self.assertIn("total", err)
        self.assertEqual(net.model_requests, [])

    def test_row27_a_repeated_page_restarts_the_read_once(self):
        ts = [thought(ago(30 - i), "Thabo", f"message {i}", author_id=THABO) for i in range(7)]
        net = FakeNet(thoughts=ts, model=EMPTY_ANSWER)
        net.repeat_once = True  # a backfill shifted the offsets once
        with mock.patch.object(ol, "PAGE", 3):
            code, out, err = self.run_main(net)
        self.assertEqual(code, 0, out + err)
        self.assertIn("message 6", net.user_message())
        self.assertEqual(net.user_message().count("message 0"), 1, "nothing is read twice")

    def test_a_server_that_always_ignores_offset_fails_after_one_restart(self):
        ts = [thought(ago(30 - i), "Thabo", f"message {i}", author_id=THABO) for i in range(7)]
        net = FakeNet(thoughts=ts, model=EMPTY_ANSWER)
        net.ignore_offset = True
        with mock.patch.object(ol, "PAGE", 3):
            code, _, _ = self.run_main(net)
        self.assertEqual(code, 1)
        self.assertLessEqual(len([c for c in net.calls if "/thoughts" in c["url"]]), 4)

    def test_row13_loops_are_paged_by_offset_not_refused(self):
        lps = [loop_rec(snow(ago(200 + i)), opened=ago(200 + i), title=f"Loop number {i:02d}") for i in range(5)]
        net = FakeNet(loops=loops_reply(*lps), model=EMPTY_ANSWER)
        with mock.patch.object(ol, "LOOPS_PAGE", 2):
            code, _, err = self.run_main(net)
        self.assertEqual(code, 0, err)
        offsets = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(c["url"]).query)).get("offset") for c in net.calls if "/browse/api/loops" in c["url"]]
        self.assertEqual(offsets, ["0", "2", "4"])
        for lp in lps:
            self.assertIn(f"key {lp['key']}", net.user_message())

    def test_a_loops_route_that_ignores_offset_fails_instead_of_duplicating(self):
        lps = [loop_rec(snow(ago(200 + i)), opened=ago(200 + i)) for i in range(5)]
        net = FakeNet(loops=loops_reply(*lps), model=EMPTY_ANSWER)
        net.ignore_loops_offset = True
        with mock.patch.object(ol, "LOOPS_PAGE", 2):
            code, _, err = self.run_main(net)
        self.assertEqual(code, 1)
        self.assertIn("loops", err.lower())
        self.assertEqual(net.model_requests, [])

    def test_more_than_sixty_open_loops_are_capped_and_said(self):
        lps = [loop_rec(snow(ago(200 + i)), opened=ago(200 + i), title=f"Loop number {i}") for i in range(62)]
        net = FakeNet(loops=loops_reply(*lps), model=EMPTY_ANSWER)
        code, _, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, err)
        user = net.user_message()
        self.assertEqual(sum(1 for lp in lps if f"key {lp['key']}" in user), 60)
        self.assertIn(f"key {lps[0]['key']}", user, "the newest loops are offered")
        self.assertNotIn(f"key {lps[61]['key']}", user)
        self.assertIn("2 loops not evaluated", self.posted(net))

    # --- the post

    def test_post_caps_at_fifteen_and_counts_the_rest(self):
        lps = [loop_rec(snow(ago(200 + i)), opened=ago(200 + i), title=f"Loop number {i:02d}") for i in range(18)]
        net = FakeNet(loops=loops_reply(*lps), model=EMPTY_ANSWER)
        code, _, _ = self.run_main(net, "--post")
        text = self.posted(net)
        self.assertEqual(code, 0)
        self.assertIn("Loop number 14", text)
        self.assertNotIn("Loop number 15", text)
        self.assertIn("3 older, see /loops in the Xactco server", text)

    def test_a_loop_the_portal_lists_is_marked_not_repeated(self):
        opener = thought(ago(40), "Thabo", "Who resets passwords?", author_id=THABO)
        lp = loop_rec(msg_id(opener), opened=ago(40), title="Password reset for Thabo", summary="Long summary that should not repeat.")
        pulse = {"looseEnds": [{"source": opener["metadata"]["source"], "channel": "servest"}],
                 "mapping": [{"channel": "servest", "client": "client:servest", "how": "auto", "messages": 1}]}
        net = FakeNet(thoughts=[opener], pulse=pulse, loops=loops_reply(lp), model=EMPTY_ANSWER)
        self.run_main(net, "--post")
        text = self.posted(net)
        self.assertIn("Password reset for Thabo", text)
        self.assertIn("portal", text.split("Password reset for Thabo")[1].splitlines()[0])
        self.assertNotIn("Long summary that should not repeat.", text)

    def test_row25_model_text_is_escaped_in_the_post(self):
        lp = loop_rec(snow(ago(40)), opened=ago(40), title="**Urgent** ~~old~~ <@123> @everyone `x` [y](z)",
                      summary="Ping <@&456> and #general > quote _it_", owner="Kelli_* @here")
        net = FakeNet(loops=loops_reply(lp), model=EMPTY_ANSWER)
        self.run_main(net, "--post")
        text = self.posted(net)
        for raw in ("**Urgent**", "~~old~~", "<@123>", "<@&456>", "`x`", "[y](z)", "_it_", "Kelli_*"):
            self.assertNotIn(raw, text)
        self.assertIn(r"\*\*Urgent\*\*", text)
        self.assertIn(r"\<\@123\>", text)

    def test_row24_a_rate_limited_webhook_is_retried_after_retry_after(self):
        net = fixture_net()
        net.webhook_429 = 1
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        self.assertGreaterEqual(len(net.posts), 1)
        self.assertIn(0.25, self.sleeps)
        self.assertNotIn("Open loops job failed", self.posted(net))

    def test_a_webhook_that_keeps_rate_limiting_fails_loudly(self):
        net = fixture_net()
        net.webhook_429 = 50
        code, _, err = self.run_main(net, "--post")
        self.assertEqual(code, 1)
        self.assertIn("429", err)

    def test_unreadable_lines_are_said_not_dropped(self):
        net = fixture_net()
        net.unreadable = [{"subject": "loop:42", "lineId": "fact_bad"}]
        code, _, _ = self.run_main(net, "--post")
        self.assertEqual(code, 0)
        self.assertIn("1 loop lines unreadable", self.posted(net))

    # --- settings

    def test_missing_settings_fail_in_one_line_before_any_read(self):
        self.env_path.write_text(ENV_TEXT.replace(f"XACTCO_MEMBERS={MEMBERS_RAW}\n", ""), encoding="utf-8")
        net = fixture_net()
        code, _, err = self.run_main(net)
        self.assertNotEqual(code, 0)
        self.assertEqual(net.calls, [])
        self.assertIn("XACTCO_MEMBERS", err)
        self.assertEqual(len([ln for ln in err.splitlines() if ln.strip()]), 1)
        net = fixture_net()
        code, _, _ = self.run_main(net, "--post")
        self.assertNotEqual(code, 0)
        self.assertEqual([c["url"] for c in net.calls], [WEBHOOK + "?wait=true"])
        self.assertIn("XACTCO_MEMBERS", net.posts[0]["content"])

    def test_missing_env_file_fails_in_one_line(self):
        net = fixture_net()
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("urllib.request.urlopen", net), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ol.main(["--env", str(Path(self.tmp.name) / "nope.env")])
        self.assertNotEqual(code, 0)
        self.assertEqual(net.calls, [])
        self.assertEqual(len([ln for ln in err.getvalue().splitlines() if ln.strip()]), 1)


class Unpark(JobCase):
    TITLE = "Quarterly review pack for Servest"

    def parked_net(self, until, *, thoughts=(), with_open_line=True):
        opened = ago(300)
        key = snow(opened)
        proof = f"https://discord.com/channels/{GUILD}/{SERVEST}/{key}"
        # The OPEN line as it sits in the ledger, written out by hand from C1.
        open_claim = (f"OPEN/1 | key={key} | client=servest | type=unticketed_ask | owner=Kelli | channel=servest | "
                      f"channel_id={SERVEST} | opened={iso(opened)} | reopened=- | title={self.TITLE} | "
                      f"summary=The quarterly review pack was asked for. | evidence={key}")
        parked = loop_rec(key, opened=opened, state="parked", title=self.TITLE, summary="(as the view shows it)", line="fact_parked")
        parked.update({"until": until, "byUser": KELLI, "byName": "kelli", "note": "after the QBR"})
        net = FakeNet(thoughts=thoughts, loops=loops_reply(parked), model=EMPTY_ANSWER)
        history = [{"id": "fact_parked", "subject": f"loop:{key}", "proof": proof, "supersedes": "fact_open" if with_open_line else None,
                    "claim": f"PARKED/1 | key={key} | by_user={KELLI} | by_name=kelli | until={until} | note=after the QBR"}]
        if with_open_line:
            history.append({"id": "fact_open", "subject": f"loop:{key}", "proof": proof, "supersededBy": "fact_parked", "claim": open_claim})
        net.ledger[f"loop:{key}"] = history
        return net, key, open_claim

    def test_an_expired_parked_loop_is_unparked_and_offered(self):
        for until in ("2026-10-26", "2026-10-27", "2026-10-27T05:00:00Z"):  # yesterday, today, 07:00 SAST today
            with self.subTest(until=until):
                net, key, open_claim = self.parked_net(until)
                code, out, err = self.run_main(net, "--post")
                self.assertEqual(code, 0, out + err)
                [w] = net.captures_for(key)
                self.assertEqual(w["supersedes"], "fact_parked")
                tag, fields = parse_line(w["content"])
                self.assertEqual(tag, "OPEN/1")
                self.assertEqual(fields, parse_line(open_claim)[1], "every OPEN field comes from the OPEN line before it")
                self.assertNotIn("note=", w["content"])
                self.assertEqual(w["source"], f"discord:{GUILD}/{SERVEST}/{key}")
                self.assertIn(f"key {key}", net.user_message(), "it is offered to the model")
                self.assertIn(self.TITLE, self.posted(net))

    def test_a_parked_loop_not_yet_due_is_left_alone(self):
        for until in ("2026-10-28", "2026-10-27T06:00:00Z"):  # tomorrow, 08:00 SAST today
            with self.subTest(until=until):
                net, key, _ = self.parked_net(until)
                code, _, _ = self.run_main(net, "--post")
                self.assertEqual(code, 0)
                self.assertEqual(net.captures, [])
                self.assertNotIn(key, net.user_message())
                self.assertNotIn(self.TITLE, self.posted(net))

    def test_row15_an_until_nobody_can_read_is_logged_not_silently_kept(self):
        for until in ("2026-02-30", "not a date", ""):
            with self.subTest(until=until):
                net, key, _ = self.parked_net(until)
                code, out, err = self.run_main(net, "--post")
                self.assertEqual(code, 0)
                self.assertEqual(net.captures, [])
                self.assertIn("unpark.bad_until", out + err)
                self.assertIn(key, out + err)

    def test_dry_run_says_it_would_unpark_and_writes_nothing(self):
        net, key, _ = self.parked_net("2026-10-26")
        code, out, _ = self.run_main(net)
        self.assertEqual(code, 0)
        self.assertEqual((net.captures, net.posts), ([], []))
        self.assertIn("would unpark 1", out)
        self.assertIn(f"key {key}", net.user_message())

    def test_a_close_later_in_the_run_supersedes_the_unpark_line_not_the_parked_one(self):
        reply = thought(ago(10), "Kelli", "The pack is on the portal.", author_id=KELLI)
        net, key, _ = self.parked_net("2026-10-26", thoughts=[reply])
        net.model = json.dumps({"existing": [{"key": key, "status": "closed_by", "message": "m1"}], "new": []})
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        unpark, close = net.captures_for(key)
        self.assertEqual(unpark["supersedes"], "fact_parked")
        self.assertTrue(close["content"].startswith("CLOSED/1"))
        head = next(f for f in net.ledger[f"loop:{key}"] if f["claim"] == unpark["content"])
        self.assertEqual(close["supersedes"], head["id"])

    def test_no_open_line_in_the_history_fails_loudly_and_the_loop_stays_parked(self):
        net, key, _ = self.parked_net("2026-10-26", with_open_line=False)
        code, out, err = self.run_main(net, "--post")
        self.assertNotEqual(code, 0)
        self.assertEqual(net.captures, [])
        self.assertIn("unpark.failed", err)
        self.assertNotIn(key, net.user_message())
        self.assertIn("1 ledger write failed", self.posted(net))

    def test_unparked_by_a_person_during_the_run_is_a_conflict_not_a_failure(self):
        net, key, _ = self.parked_net("2026-10-26")
        net.ledger[f"loop:{key}"][0]["supersededBy"] = "fact_kelli_unpark"
        net.ledger[f"loop:{key}"].insert(0, {"id": "fact_kelli_unpark", "subject": f"loop:{key}", "claim": "OPEN/1 | key=" + key, "supersedes": "fact_parked"})
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(net.captures_for(key)), 1)
        self.assertIn("1 loop changed by someone else during the run", self.posted(net))


class Check(JobCase):
    def test_check_reads_and_compares_the_clock_and_writes_nothing(self):
        net = fixture_net(skew_seconds=12)
        code, out, err = self.run_main(net, "--check", "--post")
        self.assertEqual(code, 0, out + err)
        self.assertEqual((net.captures, net.posts, net.model_requests), ([], [], []))
        self.assertIn("clock", out.lower())
        self.assertNotIn("test-anthropic", out + err, "a secret is never printed")
        self.assertNotIn("test-key", out + err)

    def test_check_fails_on_a_clock_more_than_sixty_seconds_off(self):
        for skew in (61, -75):
            with self.subTest(skew=skew):
                net = fixture_net(skew_seconds=skew)
                code, out, err = self.run_main(net, "--check")
                self.assertNotEqual(code, 0)
                self.assertIn("clock", (out + err).lower())

    def test_check_fails_when_a_secret_is_missing(self):
        self.env_path.write_text(ENV_TEXT.replace("ANTHROPIC_API_KEY=test-anthropic\n", ""), encoding="utf-8")
        net = fixture_net()
        code, out, err = self.run_main(net, "--check")
        self.assertNotEqual(code, 0)
        self.assertIn("ANTHROPIC_API_KEY", out + err)


class Lock(JobCase):
    def setUp(self):
        super().setUp()
        self.lock_path = str(Path(self.tmp.name) / "open-loops.lock")

    def test_a_second_run_fails_fast_while_the_lock_is_held(self):
        held = ol.acquire_lock(self.lock_path)
        self.addCleanup(held.close)
        net = fixture_net()
        started = time.monotonic()
        code, out, err = self.run_main(net, "--lock", self.lock_path, "--post")
        self.assertLess(time.monotonic() - started, 5)
        self.assertNotEqual(code, 0)
        self.assertEqual(net.calls, [])
        self.assertIn("lock", (out + err).lower())

    def test_a_lock_older_than_an_hour_is_posted_once(self):
        held = ol.acquire_lock(self.lock_path)
        self.addCleanup(held.close)
        old = time.time() - 2 * 3600
        os.utime(self.lock_path, (old, old))
        net = fixture_net()
        code, _, _ = self.run_main(net, "--lock", self.lock_path, "--post")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(net.posts), 1)
        self.assertIn("previous run still holding the lock", net.posts[0]["content"])
        self.assertEqual([c for c in net.calls if not c["url"].startswith(WEBHOOK)], [])

    def test_an_old_lock_in_a_dry_run_posts_nothing(self):
        held = ol.acquire_lock(self.lock_path)
        self.addCleanup(held.close)
        old = time.time() - 2 * 3600
        os.utime(self.lock_path, (old, old))
        net = fixture_net()
        code, out, err = self.run_main(net, "--lock", self.lock_path)
        self.assertNotEqual(code, 0)
        self.assertEqual(net.calls, [])
        self.assertIn("previous run still holding the lock", out + err)

    def test_the_lock_is_released_when_the_run_ends(self):
        net = fixture_net()
        code, _, _ = self.run_main(net, "--lock", self.lock_path)
        self.assertEqual(code, 0)
        again = ol.acquire_lock(self.lock_path)
        again.close()


if __name__ == "__main__":
    unittest.main()
