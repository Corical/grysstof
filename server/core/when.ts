/**
 * `until` is exclusive in the Memory port. A person or agent writing until=2026-09-23 means
 * "up to and including the 23rd", so a bare calendar date becomes the start of the next day
 * (UTC). Anything else passes through for the memory to validate, so a malformed value is
 * still an error, never a silent empty result. Shared by the MCP tools and the browse API.
 */
export function wholeDayUntil(until: string | undefined): string | undefined {
  if (until === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return until;
  const t = Date.parse(`${until}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== until) return until; // 2026-02-30 rolls over in Date; let the memory reject it
  return new Date(t + 86_400_000).toISOString();
}
