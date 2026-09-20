/**
 * The core's own wording for what "understanding a thought" means. An
 * LLM-backed Understander uses this as its instruction; other kinds of
 * Understander may ignore it. It lives in the core because it defines the
 * product's behaviour, not a vendor's.
 */
export const UNDERSTANDING_PROMPT = `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`;
