#!/usr/bin/env bash
# Plan 2 verification: every subject has facts; sample questions answer from the ledger by meaning.
# usage: tools/ledger-verify.sh [mcp-url]   (reads MCP_ACCESS_KEY from .env.xactco next to this script's parent)
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
URL="${1:-http://100.114.85.20:8788/mcp}"
KEY=$(grep -E "^MCP_ACCESS_KEY=" "$HERE/.env.xactco" | cut -d= -f2-)

q() {
  curl -s -m 90 "$URL" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
    -H "x-brain-key: $KEY" -H "x-brain-actor: claude-code:plan2-verify" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | python3 -c "import sys,json; r=sys.stdin.read(); d=json.loads(r.split('data:')[-1] if 'data:' in r else r); print(d['result']['content'][0]['text'])"
}

echo "=== lines per subject (fact_history header) ==="
CHANNELS="$HERE/tools/channels.json"; command -v cygpath >/dev/null && CHANNELS="$(cygpath -w "$CHANNELS")"
for s in $(python3 -c "import json,sys;print(' '.join(sorted(set(json.load(open(sys.argv[1])).values()))))" "$CHANNELS"); do
  printf "%-26s %s\n" "$s" "$(q fact_history "{\"subject\":\"$s\"}" | head -1)"
done

echo; echo "=== questions ==="
ask() {
  echo "Q: $1"
  q find_facts "{\"query\":\"$1\",\"limit\":2}" | python3 -c "
import sys,re; t=sys.stdin.read()
for b in t.split('--- Fact ')[1:]:
    m=re.search(r'\(([\d.]+)% match\)',b); sub=re.search(r'Subject: (\S+)',b); occ=re.search(r'Occurred: (\S{10})',b); claim=[l for l in b.split('\n') if l.startswith('  ')]
    print(f\"  {m.group(1) if m else '?':>5}%  {sub.group(1) if sub else '':22} {occ.group(1) if occ else '':10}  {claim[0].strip()[:130] if claim else ''}\")
if '--- Fact' not in t: print('  (nothing)')"
}
ask "what is blocking the Swanzo ticket"
ask "what is the status of the Qualikleen go-live and device rollout"
ask "what did the Xsit monthly meeting decide about team efficiency"
ask "what did Grainfield Chicken complain about and what did we commit to"
ask "who is the main contact at MPHE and what are they waiting on"
