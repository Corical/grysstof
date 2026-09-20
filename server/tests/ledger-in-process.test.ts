import { SqliteLedger } from "../adapters/ledger/sqlite.ts";
import { runLedgerContract } from "./ledger.contract.ts";

runLedgerContract("ledger/sqlite", () => { const d = Deno.makeTempDirSync({ prefix: "ob1-lsq-" }); const l = new SqliteLedger(`${d}/l.db`); return Promise.resolve({ ledger: l, close: async () => { l.close(); await Deno.remove(d, { recursive: true }); } }); });
