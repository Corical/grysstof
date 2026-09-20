import { assert, assertEquals } from "@std/assert";
import { JsonFileMemory } from "../adapters/memory/jsonfile.ts";
import { BagOfWordsEmbedder } from "../adapters/memory/vectors.ts";
import { runMemoryContract } from "./memory.contract.ts";

const tempDir = () => Deno.makeTempDirSync({ prefix: "ob1-jsonfile-" });

runMemoryContract("jsonfile", () => {
  const dir = tempDir();
  return Promise.resolve({ memory: new JsonFileMemory(dir, new BagOfWordsEmbedder()), close: () => Deno.remove(dir, { recursive: true }) });
});

const A = { tenant: "alice", actor: "alice" };

Deno.test("[jsonfile] survives a restart: a new instance over the same directory sees the same thoughts and ids", async () => {
  const dir = tempDir();
  try {
    const first = new JsonFileMemory(dir, new BagOfWordsEmbedder());
    const { id } = await first.remember(A, "Acme renewed the contract in March", { type: "observation", topics: ["acme"] });
    const second = new JsonFileMemory(dir, new BagOfWordsEmbedder());
    const got = await second.get(A, id);
    assert(got, "thought missing after restart");
    assertEquals(got.content, "Acme renewed the contract in March");
    const found = await second.recall(A, "acme contract renewal", { limit: 5, minScore: 0 });
    assertEquals(found[0]?.id, id);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("[jsonfile] refuses a file written by a different embedder instead of mixing widths", async () => {
  const dir = tempDir();
  try {
    await new JsonFileMemory(dir, new BagOfWordsEmbedder(256)).remember(A, "one", { type: "idea" });
    const other = new JsonFileMemory(dir, new BagOfWordsEmbedder(64));
    let message = "";
    try {
      await other.get(A, "x");
    } catch (e) {
      message = (e as Error).message;
    }
    assert(message.includes("Re-seed"), `expected a re-seed message, got: ${message}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("[jsonfile] ids are not UUIDs and the core does not care", async () => {
  const dir = tempDir();
  try {
    const m = new JsonFileMemory(dir, new BagOfWordsEmbedder());
    const { id } = await m.remember(A, "an id shape test", { type: "idea" });
    assert(id.startsWith("jf_"));
    assert(!/^[0-9a-f-]{36}$/i.test(id));
    assert(await m.get(A, id));
    assertEquals(await m.get(A, "00000000-0000-0000-0000-000000000000"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("[jsonfile] a tenant name that is not a safe file name is refused, not written somewhere surprising", async () => {
  const dir = tempDir();
  try {
    const m = new JsonFileMemory(dir, new BagOfWordsEmbedder());
    let message = "";
    try {
      await m.remember({ tenant: "../escape", actor: "x" }, "content", {});
    } catch (e) {
      message = (e as Error).message;
    }
    assert(message.includes("file name"), message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
