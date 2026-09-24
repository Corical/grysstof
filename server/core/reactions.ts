/**
 * Reactions on a message: who acknowledged it and how. Stored on the thought as
 * metadata.reactions (the current state, replaced whole on every update), shown by the
 * tools as one line: "👍 by Kelli, Devon; ✅ ×1". Shared by the core tools and the writers.
 */

/** One emoji on one message: how many people, and which of them are known (display names, people only). */
export type Reaction = { emoji: string; count: number; by: string[] };

/** "👍 by Kelli, Devon; ✅ ×1": who acknowledged the message, in one line. */
export function describeReactions(reactions: Reaction[]): string {
  return reactions.map((r) => {
    if (!r.by.length) return `${r.emoji} ×${r.count}`;
    const more = r.count - r.by.length;
    return `${r.emoji} by ${r.by.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  }).join("; ");
}

/** metadata.reactions read defensively: anything malformed is ignored, never a crash in a listing. */
export function reactionsIn(value: unknown): Reaction[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is Reaction =>
    r !== null && typeof r === "object" && typeof r.emoji === "string" && Number.isFinite(r.count) && Array.isArray(r.by) &&
    r.by.every((b: unknown) => typeof b === "string")
  );
}
