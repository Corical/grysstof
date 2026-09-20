import { assert, assertEquals } from "@std/assert";
import { SqliteMemory } from "../adapters/memory/sqlite.ts";
import { BagOfWordsEmbedder } from "../adapters/memory/vectors.ts";
import { runMemoryContract } from "./memory.contract.ts";

const tempDb = () => {
  const dir = Deno.makeTempDirSync({ prefix: "ob1-sqlite-" });
  return { dir, path: `${dir}/brain.db` };
};

runMemoryContract("sqlite", () => {
  const { dir, path } = tempDb();
  const memory = new SqliteMemory(path, new BagOfWordsEmbedder());
  return Promise.resolve({ memory, close: async () => { memory.close(); await Deno.remove(dir, { recursive: true }); } });
});

const A = { tenant: "alice", actor: "alice" };
const B = { tenant: "bob", actor: "bob" };

Deno.test("[sqlite] survives a restart and keeps the (tenant, fingerprint) rule: same sentence in two tenants is two rows", async () => {
  const { dir, path } = tempDb();
  try {
    const m1 = new SqliteMemory(path, new BagOfWordsEmbedder());
    const a = await m1.remember(A, "The renewal is in March", { type: "observation" });
    const b = await m1.remember(B, "The renewal is in March", { type: "observation" });
    assert(a.id !== b.id);
    assertEquals(b.alreadyKnown, false);
    m1.close();
    const m2 = new SqliteMemory(path, new BagOfWordsEmbedder());
    assert(await m2.get(A, a.id));
    assertEquals(await m2.get(A, b.id), null, "bob's row is invisible to alice even by id");
    assertEquals((await m2.summary(B)).count, 1);
    assertEquals((await m2.recall(A, "renewal march", { limit: 5, minScore: 0 }))[0]?.id, a.id);
    m2.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("[sqlite] refuses to open a file embedded by a different model or width", async () => {
  const { dir, path } = tempDb();
  try {
    const m = new SqliteMemory(path, new BagOfWordsEmbedder(256));
    await m.remember(A, "seed", { type: "idea" });
    m.close();
    let message = "";
    try {
      new SqliteMemory(path, new BagOfWordsEmbedder(64));
    } catch (e) {
      message = (e as Error).message;
    }
    assert(message.includes("Re-seed"), message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
