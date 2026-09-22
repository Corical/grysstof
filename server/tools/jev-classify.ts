/**
 * Classify a channel dump: per message, five typed questions, answered by whichever Classifier the env
 * selects (see classifier.ts). Writes the rows back with `gate` answers and reports pass rate and cost.
 *
 *   deno run --env-file=.env.xactco --allow-net --allow-env --allow-read --allow-write \
 *     tools/jev-classify.ts <messages.json> [out.json] [--limit=N] [--concurrency=4]
 */
import { type Answers, classifierFromEnv, passesGate } from "./classifier.ts";

const [inPath, outPath] = Deno.args.filter((a: string) => !a.startsWith("--"));
const flag = (name: string, dflt: number) => Number(Deno.args.find((a: string) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt);
const limit = flag("limit", Infinity);
const concurrency = flag("concurrency", 4);
if (!inPath) {
  console.error("usage: jev-classify.ts <messages.json> [out.json] [--limit=N] [--concurrency=N]");
  Deno.exit(2);
}
const classifier = classifierFromEnv(Deno.env);

type Row = { at: string; proof: string; text: string; gate?: Answers & { by: string; pass: boolean } };
const rows = (JSON.parse(await Deno.readTextFile(inPath)) as Row[]).slice(0, limit);

let inTok = 0, outTok = 0, done = 0, failed = 0;
const started = Date.now();
let next = 0;
async function worker() {
  while (next < rows.length) {
    const i = next++;
    const r = rows[i];
    try {
      const c = await classifier.classify(r.text);
      r.gate = { ...c.answers, by: c.by, pass: passesGate(c.answers) };
      inTok += c.input_tokens;
      outTok += c.output_tokens;
    } catch (e) {
      failed++;
      console.error(`row ${i}: ${String(e).slice(0, 200)}`);
    }
    if (++done % 50 === 0) console.error(`${done}/${rows.length} ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const passed = rows.filter((r) => r.gate?.pass).length;
const usd = inTok / 1e6 * classifier.usdPerMillionInput + outTok / 1e6 * classifier.usdPerMillionOutput;
console.error(JSON.stringify({ classifier: classifier.name, rows: rows.length, failed, passed, pass_rate: +(passed / rows.length).toFixed(3), input_tokens: inTok, output_tokens: outTok, usd: +usd.toFixed(4), seconds: Math.round((Date.now() - started) / 1000) }));
const out = JSON.stringify(rows, null, 1);
if (outPath) await Deno.writeTextFile(outPath, out);
else console.log(out);
