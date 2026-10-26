"""Tests for open_loops.py. Standard library only; no network: every HTTP call goes to FakeNet.

Run from the repo root:  python3 -m unittest discover -s server/jobs -p "test_*.py"

These tests try to break the job: wrong channel, a client's reply, a reopened loop and the same reply,
an SSE reply, an error after the line was written, a model that fails, a lock still held. They do not
re-state the implementation.
"""
import contextlib
import email.message
import email.utils
import io
import json
import os
import socket
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
UTC = timezone.utc
SAST = timezone(timedelta(hours=2))
NOW = datetime(2026, 10, 27, 7, 30, tzinfo=SAST)  # Tuesday
GUILD = "268128051500417024"
SERVEST, SWANZO, INTERNAL = "1300000000000000101", "1300000000000000102", "1300000000000000103"
THREAD = "1300000000000000201"  # a thread under #servest
KELLI, DEVON = "900000000000000001", "900000000000000002"
THABO, LERATO = "700000000000000001", "700000000000000002"
BASE = "http://grysstof.test"
WEBHOOK = "https://discord.com/api/webhooks/1/test"
MEMBERS_RAW = f"{KELLI}:Kelli,{DEVON}:Devon"
ENV_TEXT = (
    "ANTHROPIC_API_KEY=test-anthropic\n"
    f"OPEN_LOOPS_WEBHOOK={WEBHOOK}\n"
    f"GRYSSTOF_URL={BASE}/mcp\n"
    "MCP_ACCESS_KEY=test-key\n"
    f"XACTCO_MEMBERS={MEMBERS_RAW}\n"
)
C1_OPEN_ORDER = ["key", "client", "type", "owner", "channel", "channel_id", "opened", "reopened", "title", "summary", "evidence"]

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


MAPPING = {"servest": "servest", "swanzo": "swanzo", "dev-internal": None}


def members():
    return ol.parse_members(MEMBERS_RAW)


def classify(out, thoughts, loops, *, portal=(), offered=None, mem=None):
    msgs = ol.load(thoughts, set(portal))
    m = mem or members()
    m.learn(msgs)
    return ol.classify(out, msgs, loops, m, MAPPING, NOW, offered), msgs


def mid_of(msgs, t) -> str:
    """The m-id the job gave this thought."""
    return next(m["id"] for m in msgs if m["source"] == t["metadata"]["source"])


# --- the fake network -------------------------------------------------------------------------------------------


class FakeResp:
    def __init__(self, body: bytes, status=200, headers=None):
        self._buf = io.BytesIO(body)
        self.status = status
        self.headers = email.message.Message()
        for k, v in (headers or {}).items():
            self.headers[k] = v

    def read(self, *a):
        return self._buf.read(*a)

    def __iter__(self):
        return iter(self._buf.readline, b"")

    def getcode(self):
        return self.status

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(url, code, body=b'{"error":"boom"}'):
    return urllib.error.HTTPError(url, code, "error", email.message.Message(), io.BytesIO(body))


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


class FakeNet:
    """Stands in for urllib.request.urlopen. Grysstof (browse + /mcp with a tiny ledger), Anthropic, Discord."""

    def __init__(self, *, thoughts=(), pulse=None, loops=None, model=None, mcp="json", skew_seconds=0):
        self.thoughts = sorted(thoughts, key=lambda t: (t["createdAt"], t["id"]))
        self.pulse = pulse if pulse is not None else {"looseEnds": [], "mapping": [
            {"channel": "servest", "client": "client:servest", "how": "auto", "messages": 1},
            {"channel": "swanzo", "client": "client:swanzo", "how": "auto", "messages": 1},
            {"channel": "dev-internal", "client": None, "how": "auto", "messages": 1}]}
        self.loops = loops if loops is not None else loops_reply()
        self.model = model
        self.mcp_mode = mcp
        self.mcp_faults = []  # per-call overrides consumed in order: "error_after_write", "error_before_write", "timeout"
        self.ledger = {}  # subject -> facts, newest first
        self.route_override = {}  # route -> FakeResp | Exception
        self.ignore_offset = False
        self.skew_seconds = skew_seconds
        self.calls, self.unexpected, self.posts, self.captures, self.model_requests = [], [], [], [], []
        self._fact = 0
        for lp in self.loops.get("loops", []):
            self.ledger[lp["subject"]] = [{"id": lp["lineId"], "subject": lp["subject"], "claim": "OPEN/1 | key=" + lp["key"]}]

    # urlopen(req, timeout=...)
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
            return self.browse(parts.path[len("/browse/api"):], query, url)
        if url == BASE + "/mcp" and method == "POST":
            return self.mcp(json.loads(body))
        if url == "https://api.anthropic.com/v1/messages" and method == "POST":
            return self.anthropic(json.loads(body), url)
        if url.startswith(WEBHOOK) and method == "POST":
            self.posts.append(json.loads(body))
            return FakeResp(b'{"id": "1"}')
        if url == "https://discord.com/api/v10/gateway" and method == "GET":
            date = email.utils.format_datetime(NOW.astimezone(UTC) + timedelta(seconds=self.skew_seconds), usegmt=True)
            return FakeResp(b'{"url": "wss://gateway.discord.gg"}', headers={"Date": date})
        self.unexpected.append((method, url))
        raise urllib.error.URLError(f"unexpected url in test: {method} {url}")

    def browse(self, route, q, url):
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
            return FakeResp(json.dumps({"thoughts": rows[offset:offset + limit]}).encode())
        if route == "/pulse/overview":
            return FakeResp(json.dumps(self.pulse).encode())
        if route == "/loops":
            return FakeResp(json.dumps(self.loops).encode())
        if route == "/history":
            return FakeResp(json.dumps({"facts": self.ledger.get(q.get("subject", ""), [])}).encode())
        return FakeResp(json.dumps({"error": f"No browse route {route}"}).encode(), status=404)

    def mcp(self, body):
        assert body["method"] == "tools/call" and body["params"]["name"] == "capture_thought", body
        args = body["params"]["arguments"]
        self.captures.append(args)
        fault = self.mcp_faults.pop(0) if self.mcp_faults else None
        if fault == "timeout":
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
        if head and sup:
            head["supersededBy"] = fid
        facts.insert(0, {"id": fid, "subject": subject, "claim": args["content"], "source": args.get("source"),
                         "proof": args.get("proof"), "supersedes": sup, "learnedAt": iso(NOW), "tags": []})
        if fault == "error_after_write":  # the SQLite limb: the line is written, then the embedder fails
            return FakeResp(rpc({"content": [{"type": "text", "text": "Failed to capture: embedding request failed"}], "isError": True}))
        result = {"content": [{"type": "text", "text": f"Recorded fact {fid} about {subject} (from {args.get('source')}, by open-loops, unconfirmed)"}]}
        if self.mcp_mode == "sse":
            return FakeResp(sse([{"type": "message", "jsonrpc": "2.0", "id": 1, "result": result}]).replace(b"event: message\n", b"event: message\n"),
                            headers={"Content-Type": "text/event-stream"})
        return FakeResp(rpc(result), headers={"Content-Type": "application/json"})

    def anthropic(self, body, url):
        self.model_requests.append(body)
        m = self.model
        if isinstance(m, BaseException):
            raise m
        if isinstance(m, tuple) and m[0] == "http":
            raise http_error(url, m[1], b'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
        if isinstance(m, bytes):
            return FakeResp(m, headers={"Content-Type": "text/event-stream"})
        return FakeResp(model_stream(m), headers={"Content-Type": "text/event-stream"})

    def captures_for(self, key):
        return [c for c in self.captures if c["subject"] == f"loop:{key}"]


class JobCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env_path = Path(self.tmp.name) / "job.env"
        self.env_path.write_text(ENV_TEXT, encoding="utf-8")
        p = mock.patch.object(ol, "now_sast", return_value=NOW)
        p.start()
        self.addCleanup(p.stop)

    def run_main(self, net, *args, env=True):
        out, err = io.StringIO(), io.StringIO()
        argv = (["--env", str(self.env_path)] if env else []) + list(args)
        with mock.patch("urllib.request.urlopen", net), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ol.main(argv)
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


# --- C1: the line ---------------------------------------------------------------------------------------------


class LineFormat(unittest.TestCase):
    HOSTILE = [
        "a | b | key=evil",
        "line one\nline two\r\nline three",
        "ctl\x00\x07\x1b[31mred",
        "🚀 **bold** _it_ [link](https://x.test) <@123> @everyone",
        "#servest > thread",
        "x" * 500,
        "  spaced\t\tout  ",
        "uni line sep",
    ]

    def fields(self, title, owner="Kelli", summary="s"):
        return {"key": "123", "client": "servest", "type": "unanswered_question", "owner": owner, "channel": "servest",
                "channel_id": SERVEST, "opened": "2026-10-26T08:00:00.000Z", "reopened": None, "title": title,
                "summary": summary, "evidence": ["5", "3"]}

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
                self.assertEqual(f["owner"], ol.sanitise(bad))
                self.assertEqual(f["summary"], ol.sanitise(bad, 300))
                self.assertLessEqual(len(f["title"]), 120)
                self.assertLessEqual(len(f["summary"]), 300)
                self.assertNotIn("|", f["title"])

    def test_sanitise_strips_controls_and_pipes_but_keeps_emoji(self):
        self.assertEqual(ol.sanitise("a|b\nc\x07d  e"), "ab c d e")
        self.assertEqual(ol.sanitise("🚀 ok"), "🚀 ok")

    def test_reopened_absent_is_a_dash(self):
        _, f = parse_line(ol.open_line(self.fields("t")))
        self.assertEqual(f["reopened"], "-")

    def test_evidence_keeps_the_newest_eight_in_time_order(self):
        ids = [str(i) for i in (11, 2, 9, 4, 10, 1, 7, 3, 8, 5, 6)]
        f = self.fields("t")
        f["evidence"] = ids
        _, out = parse_line(ol.open_line(f))
        self.assertEqual(out["evidence"].split(","), ["4", "5", "6", "7", "8", "9", "10", "11"])

    def test_closed_line_caps_the_reason(self):
        tag, f = parse_line(ol.closed_line("123", "456", "2026-10-26T08:00:00.000Z", "r|" * 300))
        self.assertEqual(tag, "CLOSED/1")
        self.assertEqual(list(f), ["key", "by_message", "closed", "reason"])
        self.assertLessEqual(len(f["reason"]), 200)
        self.assertNotIn("|", f["reason"])


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
        plan, msgs = classify(None, [self.opener, reply], loops_reply(loop or self.loop), mem=mem)
        out = {"existing": [{"key": self.key, "status": "closed_by", "message": mid_of(msgs, reply)}], "new": []}
        plan, msgs = classify(out, [self.opener, reply], loops_reply(loop or self.loop), mem=mem)
        return plan

    def closes(self, plan):
        return [w for w in plan.writes if w.kind == "close"]

    def test_member_reply_in_the_same_channel_closes(self):
        reply = thought(ago(10), "Kelli", "Sent it.", author_id=KELLI, in_reply_to=self.opener["metadata"]["source"])
        plan = self.close_with(reply)
        [w] = self.closes(plan)
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


# --- C2 keys and generations; C5 updates ---------------------------------------------------------------------


def new_item(title, evidence, *, type_="unanswered_question", owner="unclear", channel="servest", client="servest", summary=None):
    return {"channel": channel, "client": client, "type": type_, "title": title, "summary": summary or f"{title}.",
            "owner": owner, "evidence": evidence, "why_open": "No reply in the channel."}


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

    def test_rule1_open_key_resighting_adds_evidence_once_and_keeps_reopened(self):
        lp = loop_rec(self.key, opened=ago(100), reopened=ago(50), evidence=[self.key], line="fact_open")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Supervisor for Zola", [m[self.opener["id"]], m[self.later["id"]]]))
        [w] = plan.writes
        self.assertEqual((w.kind, w.key, w.supersedes), ("update", self.key, "fact_open"))
        _, f = parse_line(w.claim)
        self.assertEqual(f["evidence"].split(","), [self.key, msg_id(self.later)])
        self.assertEqual(when(f["reopened"]), ago(50))
        self.assertEqual(f["title"], lp["title"], "a re-sighting keeps the recorded title")

    def test_rule1_resighting_with_nothing_new_writes_nothing(self):
        lp = loop_rec(self.key, opened=ago(100), evidence=[self.key, msg_id(self.later)])
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Supervisor for Zola", [m[self.opener["id"]], m[self.later["id"]]]))
        self.assertEqual(plan.writes, [])

    def test_rule1_parked_resighting_writes_nothing(self):
        lp = loop_rec(self.key, opened=ago(100), state="parked")
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Supervisor for Zola", [m[self.opener["id"]], m[self.later["id"]]]))
        self.assertEqual(plan.writes, [])
        self.assertEqual(plan.counts["resighted_parked"], 1)

    def test_rule2_all_cited_before_the_close_is_suppressed_and_counted(self):
        lp = loop_rec(self.key, opened=ago(100), state="closed", closed=ago(10))
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Supervisor for Zola", [m[self.opener["id"]], m[self.later["id"]]]))
        self.assertEqual(plan.writes, [])
        self.assertEqual(plan.counts["resighted_closed"], 1)

    def test_rule2_a_later_message_opens_generation_two_from_the_new_ask(self):
        lp = loop_rec(self.key, opened=ago(100), state="closed", closed=ago(50))
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Reports role for Zola", [m[self.opener["id"]], m[self.later["id"]]]))
        [w] = plan.writes
        self.assertEqual((w.kind, w.key, w.supersedes), ("open", f"{self.key}:2", None))
        _, f = parse_line(w.claim)
        self.assertEqual(f["key"], f"{self.key}:2")
        self.assertEqual(when(f["opened"]), ago(20), "generation 2 opens at the new ask, so the old closing reply cannot close it")

    def test_rule2_generation_three_when_two_is_finished(self):
        g1 = loop_rec(self.key, opened=ago(100), state="closed", closed=ago(90))
        g2 = loop_rec(f"{self.key}:2", opened=ago(80), state="resolved", closed=ago(40))
        plan = self.run_new(loops_reply(g1, g2), lambda m: new_item("Reports role for Zola", [m[self.opener["id"]], m[self.later["id"]]]))
        self.assertEqual([w.key for w in plan.writes], [f"{self.key}:3"])

    def test_rule2_resolved_without_a_closed_time_uses_when_it_was_written(self):
        lp = loop_rec(self.key, opened=ago(100), state="resolved", learned=ago(10))
        plan = self.run_new(loops_reply(lp), lambda m: new_item("Supervisor for Zola", [m[self.opener["id"]], m[self.later["id"]]]))
        self.assertEqual(plan.writes, [])
        self.assertEqual(plan.counts["resighted_closed"], 1)

    def test_rule3_two_asks_in_one_message_get_b_in_title_order(self):
        plan = self.run_new(loops_reply(),
                            lambda m: new_item("Supervisor access for Zola", [m[self.opener["id"]]]),
                            lambda m: new_item("Reports role for Zola", [m[self.opener["id"]], m[self.later["id"]]]))
        got = {w.key: parse_line(w.claim)[1]["title"] for w in plan.writes}
        self.assertEqual(got, {self.key: "Reports role for Zola", f"{self.key}:b": "Supervisor access for Zola"})

    def test_resighting_and_a_new_ask_on_one_closed_opener_do_not_make_a_b_loop(self):
        lp = loop_rec(self.key, opened=ago(100), state="closed", closed=ago(50))
        plan = self.run_new(loops_reply(lp),
                            lambda m: new_item("Supervisor access for Zola", [m[self.opener["id"]]]),
                            lambda m: new_item("Reports role for Zola", [m[self.opener["id"]], m[self.later["id"]]]))
        self.assertEqual([w.key for w in plan.writes], [f"{self.key}:2"])
        self.assertEqual(plan.counts["resighted_closed"], 1)

    def test_unreadable_line_on_the_subject_blocks_the_write(self):
        plan = self.run_new(loops_reply(unreadable=[{"subject": f"loop:{self.key}", "lineId": "fact_bad"}]),
                            lambda m: new_item("Supervisor for Zola", [m[self.opener["id"]]]))
        self.assertEqual(plan.writes, [])
        self.assertEqual(plan.counts["unreadable_conflict"], 1)

    def test_opener_is_the_oldest_cited_message_not_the_first_listed(self):
        plan = self.run_new(loops_reply(), lambda m: new_item("Reports role for Zola", [m[self.later["id"]], m[self.opener["id"]]]))
        [w] = plan.writes
        self.assertEqual(w.key, self.key)
        self.assertEqual(w.source, self.opener["metadata"]["source"])


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

    def test_channel_and_client_come_from_the_opener_and_the_mapping(self):
        t = thought(ago(30), "Lerato", "Export fails.", channel="swanzo", chan_id=SWANZO, author_id=LERATO)
        i = thought(ago(30), "Devon", "I'll write the notes.", channel="dev-internal", chan_id=INTERNAL, author_id=DEVON)
        th = thought(ago(30), "Thabo", "In a thread.", chan_id=THREAD, parent_id=SERVEST, author_id=THABO)
        ts = [t, i, th]
        _, msgs = classify(None, ts, loops_reply())
        m = {x["id"]: mid_of(msgs, x) for x in ts}
        out = {"existing": [], "new": [
            new_item("Export", [m[t["id"]]], channel="servest", client="servest"),      # the model names the wrong channel and client
            new_item("Notes", [m[i["id"]]], type_="unkept_promise", channel="dev-internal", client="madeup"),
            new_item("Thread ask", [m[th["id"]]], channel="servest", client=None),
        ]}
        plan, _ = classify(out, ts, loops_reply())
        got = {w.key: parse_line(w.claim)[1] for w in plan.writes}
        self.assertEqual((got[msg_id(t)]["channel"], got[msg_id(t)]["channel_id"], got[msg_id(t)]["client"]), ("swanzo", SWANZO, "swanzo"))
        self.assertEqual(got[msg_id(i)]["client"], "internal")
        self.assertEqual((got[msg_id(th)]["channel_id"], got[msg_id(th)]["client"]), (SERVEST, "servest"), "a thread loop keys on its parent channel")

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
        lp = loop_rec(self.key, opened=ago(80), owner="Kelli")
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
            f"{W0}:2": "Reports role for Zola",
        })
        self.assertEqual([w.key for w in plan.writes if w.kind == "close"], [W1])
        self.assertEqual([w for w in plan.writes if w.kind == "update"], [], "owner from unclear is ignored")
        self.assertEqual((plan.counts["resighted_closed"], plan.counts["on_portal"]), (1, 1))
        w0_2 = next(w for w in plan.writes if w.key == f"{W0}:2")
        self.assertEqual(when(parse_line(w0_2.claim)[1]["opened"]), datetime(2026, 10, 26, 11, 0, tzinfo=SAST))
        self.assertEqual(parse_line(next(w for w in plan.writes if w.key == D1).claim)[1]["client"], "internal")


# --- the whole run, against fakes -----------------------------------------------------------------------------


class Run(JobCase):
    def test_dry_run_writes_nothing_and_says_what_it_would_do(self):
        net = fixture_net()
        code, out, _ = self.run_main(net)
        self.assertEqual(code, 0)
        self.assertEqual(net.captures, [])
        self.assertEqual(net.posts, [])
        self.assertEqual([c["url"] for c in net.calls if c["method"] != "GET"], ["https://api.anthropic.com/v1/messages"])
        self.assertIn("would open 4, close 1, update 0", out)

    def test_post_writes_one_line_per_transition_then_posts(self):
        net = fixture_net()
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(c["subject"] for c in net.captures),
                         sorted(f"loop:{k}" for k in (S1, f"{S1}:b", D1, f"{W0}:2", W1)))
        [close] = net.captures_for(W1)
        self.assertEqual(close["supersedes"], "fact_w1")
        self.assertTrue(close["content"].startswith("CLOSED/1 | key=" + W1))
        self.assertTrue(all(c.get("occurred_at") for c in net.captures))
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

    def test_newest_loops_come_first(self):
        net = fixture_net()
        self.run_main(net, "--post")
        text = self.posted(net)
        self.assertLess(text.index("Reports role for Zola"), text.index("APIM routing notes"))
        self.assertLess(text.index("APIM routing notes"), text.index("Site list export for Servest"))

    def test_every_call_has_a_timeout_and_the_model_streams(self):
        net = fixture_net()
        self.run_main(net, "--post")
        model = [c for c in net.calls if c["url"] == "https://api.anthropic.com/v1/messages"]
        others = [c for c in net.calls if c["url"] != "https://api.anthropic.com/v1/messages"]
        self.assertTrue(others)
        self.assertEqual({c["timeout"] for c in others}, {30})
        self.assertEqual(len(model), 1)
        self.assertTrue(net.model_requests[0]["stream"], "only a streamed call can live with a silence timeout")
        self.assertIsNotNone(model[0]["timeout"])
        self.assertLessEqual(model[0]["timeout"], 180)

    def test_a_reworded_or_foreign_confirmation_is_not_taken_as_written(self):
        for reply in ("Captured as observation", f"Recorded fact fact_9 about loop:{W1}:2 (from x)", "Recorded fact fact_9 about loop:999 (from x)"):
            with self.subTest(reply=reply):
                g = ol.Grysstof(BASE + "/mcp", "k")
                w = ol.Write("close", W1, "CLOSED/1 | key=" + W1, "fact_w1", "s", "p", "2026-10-26T08:00:00.000Z", {})
                with mock.patch.object(ol, "http_text", return_value=(rpc({"content": [{"type": "text", "text": reply}]}).decode(), None)):
                    with self.assertRaises(ol.JobError):
                        g.capture(w)

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

    def test_error_after_the_line_exists_rereads_and_does_not_write_twice(self):
        net = fixture_net()
        net.mcp_faults = ["error_after_write"]  # the first write lands, then the reply is an error
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(net.captures), 5, "no second write for the line that already landed")
        self.assertIn("landed", out + err)

    def test_error_before_the_write_is_retried_once(self):
        net = fixture_net()
        net.mcp_faults = ["error_before_write"]
        code, out, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(len(net.captures), 6)

    def test_two_failures_on_one_write_give_up_and_exit_nonzero(self):
        net = fixture_net()
        net.mcp_faults = ["error_before_write", "timeout"]
        code, out, err = self.run_main(net, "--post")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(net.captures), 6)
        self.assertIn("1 ledger write failed", self.posted(net))

    def test_a_loop_changed_by_someone_else_is_not_overwritten(self):
        net = fixture_net()
        # Kelli resolved W1 after the job read /loops: its head is no longer fact_w1.
        net.ledger[f"loop:{W1}"] = [{"id": "fact_kelli", "subject": f"loop:{W1}", "claim": f"RESOLVED/1 | key={W1}", "supersedes": "fact_w1"},
                                    {"id": "fact_w1", "subject": f"loop:{W1}", "claim": f"OPEN/1 | key={W1}", "supersededBy": "fact_kelli"}]
        code, out, err = self.run_main(net, "--post")
        self.assertNotEqual(code, 0)
        self.assertEqual(len(net.captures_for(W1)), 1, "a stale supersedes is not retried")
        self.assertIn("changed", (out + err).lower())

    def test_model_failure_posts_the_recorded_list_under_a_stale_header(self):
        failures = {
            "http 529": ("http", 529),
            "timeout": socket.timeout("timed out"),
            "stream error": sse([{"type": "message_start", "message": {"usage": {"input_tokens": 5}}},
                                 {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}]),
            "refusal": model_stream('{"existing": [], "new": []}', stop="refusal"),
            "cut off": model_stream('{"existing": [], "new": [', stop="max_tokens"),
            "no json": "I could not find any loops.",
            "stream ends early": sse([{"type": "message_start", "message": {"usage": {"input_tokens": 5}}},
                                      {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": '{"existing": [], "new": []}'}}]),
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

    def test_model_failure_dry_run_posts_nothing(self):
        net = fixture_net()
        net.model = ("http", 500)
        code, out, _ = self.run_main(net)
        self.assertNotEqual(code, 0)
        self.assertEqual((net.posts, net.captures), ([], []))
        self.assertIn("model pass failed; list may be stale", out)

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
        net = FakeNet(thoughts=ts, model='{"existing": [], "new": []}')
        with mock.patch.object(ol, "PAGE", 3):
            code, _, err = self.run_main(net)
        self.assertEqual(code, 0, err)
        offsets = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(c["url"]).query)).get("offset")
                   for c in net.calls if "/browse/api/thoughts" in c["url"]]
        self.assertEqual(offsets, ["0", "3", "6"])
        user = net.model_requests[0]["messages"][0]["content"]
        self.assertIn("[m7]", user)
        self.assertIn("message 6", user)
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(net.calls[0]["url"]).query)) if "/thoughts" in net.calls[0]["url"] else \
            dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(next(c["url"] for c in net.calls if "/thoughts" in c["url"])).query))
        self.assertEqual((q["source_prefix"], q["order"]), ("discord:", "oldest"))
        self.assertEqual(when(q["since"]), NOW - timedelta(days=7))

    def test_window_at_the_cap_fails_loudly(self):
        ts = [thought(ago(30 - i), "Thabo", f"message {i}", author_id=THABO) for i in range(7)]
        net = FakeNet(thoughts=ts, model='{"existing": [], "new": []}')
        with mock.patch.object(ol, "PAGE", 3), mock.patch.object(ol, "WINDOW_CAP", 6):
            code, _, err = self.run_main(net)
        self.assertEqual(code, 1)
        self.assertIn("6", err)
        self.assertEqual(net.model_requests, [])

    def test_a_server_that_ignores_offset_fails_instead_of_looping(self):
        ts = [thought(ago(30 - i), "Thabo", f"message {i}", author_id=THABO) for i in range(7)]
        net = FakeNet(thoughts=ts, model='{"existing": [], "new": []}')
        net.ignore_offset = True
        with mock.patch.object(ol, "PAGE", 3):
            code, _, _ = self.run_main(net)
        self.assertEqual(code, 1)
        self.assertLessEqual(len([c for c in net.calls if "/thoughts" in c["url"]]), 2)

    def test_a_truncated_loops_list_fails_loudly(self):
        net = fixture_net()
        net.loops["total"] = 9
        code, _, err = self.run_main(net)
        self.assertEqual(code, 1)
        self.assertIn("loops", err.lower())

    def test_more_than_sixty_open_loops_are_capped_and_said(self):
        lps = [loop_rec(snow(ago(200 + i)), opened=ago(200 + i), title=f"Loop number {i}") for i in range(62)]
        net = FakeNet(loops=loops_reply(*lps), model='{"existing": [], "new": []}')
        code, _, err = self.run_main(net, "--post")
        self.assertEqual(code, 0, err)
        user = net.model_requests[0]["messages"][0]["content"]
        self.assertEqual(sum(1 for lp in lps if f"key {lp['key']}" in user), 60)
        self.assertIn(f"key {lps[0]['key']}", user, "the newest loops are offered")
        self.assertNotIn(f"key {lps[61]['key']}", user)
        self.assertIn("2 loops not evaluated", self.posted(net))

    def test_post_caps_at_fifteen_and_counts_the_rest(self):
        lps = [loop_rec(snow(ago(200 + i)), opened=ago(200 + i), title=f"Loop number {i:02d}") for i in range(18)]
        net = FakeNet(loops=loops_reply(*lps), model='{"existing": [], "new": []}')
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
        net = FakeNet(thoughts=[opener], pulse=pulse, loops=loops_reply(lp), model='{"existing": [], "new": []}')
        self.run_main(net, "--post")
        text = self.posted(net)
        self.assertIn("Password reset for Thabo", text)
        self.assertIn("portal", text.split("Password reset for Thabo")[1].splitlines()[0])
        self.assertNotIn("Long summary that should not repeat.", text)

    def test_unreadable_lines_are_said_not_dropped(self):
        net = fixture_net()
        net.loops["unreadable"] = [{"subject": "loop:42", "lineId": "fact_bad"}]
        code, _, _ = self.run_main(net, "--post")
        self.assertEqual(code, 0)
        self.assertIn("1 loop lines unreadable", self.posted(net))

    def test_missing_settings_fail_in_one_line_before_any_read(self):
        self.env_path.write_text(ENV_TEXT.replace(f"XACTCO_MEMBERS={MEMBERS_RAW}\n", ""), encoding="utf-8")
        net = fixture_net()
        code, _, err = self.run_main(net)
        self.assertNotEqual(code, 0)
        self.assertEqual(net.calls, [])
        self.assertIn("XACTCO_MEMBERS", err)
        self.assertEqual(len([ln for ln in err.splitlines() if ln.strip()]), 1)
        # With --post the channel is told too, and nothing else is called.
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
