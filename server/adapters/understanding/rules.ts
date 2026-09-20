/**
 * RulesUnderstander: tags a thought with regular expressions, no model.
 * Deterministic, free, offline. Proves the Understanding socket does not
 * require an LLM and gives the matrix a tagger whose output is predictable
 * enough to assert on. It is deliberately modest: dates in ISO form,
 * capitalised names that are not sentence starts, a task when the text
 * tells someone to do something, an idea when it says so, a reference when
 * it is mostly a link.
 */
import type { Understander, Understanding } from "../../core/ports/mod.ts";

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const NAME = /(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})?)\b/gm;
const TASK = /\b(todo|to do|must|should|need to|needs to|remember to|action:|follow up|deadline)\b/i;
const IDEA = /\b(idea:|what if|we could|maybe we)\b/i;
const PERSON_NOTE = /\b(met|spoke to|call with|meeting with|catch-up with)\s+[A-Z]/;
const URL = /https?:\/\/\S+/g;
const STOP = new Set(["The", "This", "That", "These", "Those", "There", "Then", "When", "What", "Where", "Which", "While", "With", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "February", "March", "April", "June", "July", "August", "September", "October", "November", "December"]);

export class RulesUnderstander implements Understander {
  understand(text: string): Promise<Understanding> {
    const t = text.trim();
    if (!t) return Promise.reject(new Error("Nothing to understand"));

    const dates = [...new Set([...t.matchAll(ISO_DATE)].map((m) => m[1]))].filter((d) => !Number.isNaN(Date.parse(d))).slice(0, 20);
    const people = [...new Set([...t.matchAll(NAME)].map((m) => m[1]).filter((n) => !STOP.has(n.split(" ")[0])))].slice(0, 20);
    const words = t.toLowerCase().replace(URL, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
    const topics = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([w]) => w);

    const urls = t.match(URL) ?? [];
    const type: Understanding["type"] = urls.join("").length > t.length / 2
      ? "reference"
      : TASK.test(t)
      ? "task"
      : IDEA.test(t)
      ? "idea"
      : PERSON_NOTE.test(t)
      ? "person_note"
      : "observation";

    const action_items = type === "task"
      ? t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => TASK.test(s)).map((s) => s.slice(0, 200)).slice(0, 20)
      : [];

    return Promise.resolve({ people, action_items, dates_mentioned: dates, topics: topics.length ? topics : ["uncategorized"], type });
  }
}
