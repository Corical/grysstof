"""Score the gate against reviewed facts: which fact-bearing messages would it drop, and at what threshold?
usage: python gate-score.py <gated.json> <facts.json>
"""
import json, sys, collections

gated = json.load(open(sys.argv[1], encoding="utf-8"))
facts = json.load(open(sys.argv[2], encoding="utf-8"))["facts"]
by_proof = {r["proof"]: r for r in gated if r.get("gate")}
KEEP_KINDS = {"decision", "status", "commitment", "problem", "contact"}

fact_proofs = set()
for f in facts:
    fact_proofs.update(p for p in f.get("proofs", []) if p in by_proof)
print(f"messages: {len(gated)}  fact-bearing messages: {len(fact_proofs)}  facts: {len(facts)}")

def gate(a, durable_t, kind_c, chatter_block=0.8):
    if a["kind"]["choice"] == "chatter" and a["durable"] < chatter_block:
        return False
    return a["durable"] >= durable_t or (a["kind"]["choice"] in KEEP_KINDS and a["kind"]["confidence"] >= kind_c)

print("\nkinds:", dict(collections.Counter(r["gate"]["kind"]["choice"] for r in gated if r.get("gate"))))
print("subject:", dict(collections.Counter(r["gate"]["subject"]["choice"] for r in gated if r.get("gate")).most_common(4)))

print("\n durable>=  kind_conf>=  pass%  recall(fact msgs)  dropped-fact-msgs")
rows = []
for dt in (0.5, 0.6, 0.7, 0.8, 0.9):
    for kc in (0.6, 0.7, 0.8, 0.9, 1.01):
        passed = [r for r in gated if r.get("gate") and gate(r["gate"], dt, kc)]
        pp = {r["proof"] for r in passed}
        recall = len(fact_proofs & pp) / max(1, len(fact_proofs))
        rows.append((dt, kc, len(passed) / len(gated), recall, len(fact_proofs - pp)))
for dt, kc, pr, rc, dropped in rows:
    print(f"   {dt:.1f}        {kc:.2f}      {pr*100:4.0f}%       {rc*100:4.0f}%            {dropped}")

print("\nfact-bearing messages the CURRENT gate (0.6 / 0.7) drops:")
for p in sorted(fact_proofs):
    r = by_proof[p]
    if not gate(r["gate"], 0.6, 0.7):
        a = r["gate"]
        print(f"  durable={a['durable']:.2f} kind={a['kind']['choice']}({a['kind']['confidence']:.2f}) | {r['text'][:110]}")
