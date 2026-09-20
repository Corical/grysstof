import { KeywordMemory } from "../adapters/memory/keyword.ts";
import { VectorMemory } from "../adapters/memory/vector-in-process.ts";
import { FakeEmbedder } from "../adapters/memory/vectors.ts";
import { runMemoryContract } from "./memory.contract.ts";

runMemoryContract("keyword", () => Promise.resolve({ memory: new KeywordMemory() }));
runMemoryContract("vector", () => Promise.resolve({ memory: new VectorMemory(new FakeEmbedder()) }));
