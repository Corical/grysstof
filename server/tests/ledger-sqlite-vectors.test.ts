import { assert, assertEquals } from "@std/assert";
import { SqliteLedger } from "../adapters/ledger/sqlite.ts";
import { BagOfWordsEmbedder, type Embedder } from "../adapters/memory/vectors.ts";

const A = { tenant: "xactco", actor: "agent:test" };

class CountingEmbedder implements Embedder {
  calls = 0;
  private readonly inner = new BagOfWordsEmbedder();
  readonly model: string = "bag-of-words";
  readonly dimensions = this.inner.dimensions;
  embed(text: string): Promise<number[]> {
    this.calls++;
    return this.inner.embed(text);
  }
}

Deno.test("[ledger/sqlite] with an embedder, find works by meaning, not word overlap; superseded lines stay out", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const e = new CountingEmbedder();
  const l = new SqliteLedger(path, undefined, e);
  const generic = await l.assert(A, { subject: "client:servest", claim: "Kelli decided all Servest workflows must be generic before further rollout", source: "discord:1/2/3" });
  await l.assert(A, { subject: "client:servest", claim: "Servest paid their invoice on 13 March 2026", source: "discord:1/2/4" });
  const overruled = await l.assert(A, { subject: "client:servest", claim: "Kelli overruled waiting for the client review: load the generic workflows first", source: "discord:1/2/5", supersedes: generic.id });
  const found = await l.find(A, "workflows generic rollout decision Kelli", { limit: 3 });
  assert(found.length >= 1, "something found");
  assertEquals(found[0].id, overruled.id, "the current line about generic workflows ranks first");
  assert(found.every((f) => f.id !== generic.id), "the superseded line is left out by default");
  assert(found[0].score > 0 && found[0].score <= 1);
  const withOld = await l.find(A, "workflows generic rollout decision Kelli", { limit: 3, includeSuperseded: true });
  assert(withOld.some((f) => f.id === generic.id));
  l.close();
});

Deno.test("[ledger/sqlite] vectors survive a restart without re-embedding; lines written before the embedder are embedded on start", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const plain = new SqliteLedger(path);
  const old = await plain.assert(A, { subject: "client:acme", claim: "Acme renewal signed for 2027", source: "s" });
  plain.close();

  const e1 = new CountingEmbedder();
  const l1 = new SqliteLedger(path, undefined, e1);
  await l1.ready;
  assertEquals(e1.calls, 1, "the pre-existing line is embedded once on start");
  const fresh = await l1.assert(A, { subject: "client:acme", claim: "Acme asked for a price review in Q1", source: "s" });
  assertEquals(e1.calls, 2);
  l1.close();

  const e2 = new CountingEmbedder();
  const l2 = new SqliteLedger(path, undefined, e2);
  await l2.ready;
  assertEquals(e2.calls, 0, "both vectors came back from the table");
  const hits = await l2.find(A, "renewal signed", { limit: 2 });
  assertEquals(e2.calls, 1, "only the query was embedded");
  assertEquals(hits[0]?.id, old.id);
  assert(hits.some((h) => h.id === fresh.id) || hits.length === 1);
  l2.close();
});

Deno.test("[ledger/sqlite] a different embedder model ignores stored vectors and re-embeds", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const l = new SqliteLedger(path, undefined, new CountingEmbedder());
  await l.assert(A, { subject: "s", claim: "one line", source: "s" });
  l.close();
  class OtherModel extends CountingEmbedder {
    override readonly model = "other";
  }
  const o = new OtherModel();
  const l2 = new SqliteLedger(path, undefined, o);
  await l2.ready;
  assertEquals(o.calls, 1, "stored vector was for another model, so it was re-embedded");
  l2.close();
});
