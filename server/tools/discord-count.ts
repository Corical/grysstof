// How much history is there? Counts human messages per readable channel, total and since a date. Diagnostic only.
const token = Deno.env.get("DISCORD_BOT_TOKEN")!;
const since = Deno.args[0] ?? "2026-01-01";
const sinceSnowflake = ((BigInt(Date.parse(since)) - 1420070400000n) << 22n).toString();
const API = "https://discord.com/api/v10";
const h = { authorization: `Bot ${token}` };

async function get<T>(path: string): Promise<T | null> {
  for (;;) {
    const r = await fetch(`${API}${path}`, { headers: h });
    if (r.status === 429) {
      const wait = Number((await r.json()).retry_after ?? 1) * 1000;
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (!r.ok) return null;
    return await r.json() as T;
  }
}

type Msg = { id: string; type: number; author: { bot?: boolean }; content: string; timestamp: string };
const guilds = (await get<{ id: string; name: string }[]>("/users/@me/guilds"))!;
let grand = 0, grandSince = 0, chars = 0;
for (const g of guilds) {
  const chans = (await get<{ id: string; name: string; type: number }[]>(`/guilds/${g.id}/channels`))!;
  for (const c of chans.filter((c) => c.type === 0)) {
    let before: string | undefined;
    let total = 0, recent = 0, oldest = "";
    for (;;) {
      const page = await get<Msg[]>(`/channels/${c.id}/messages?limit=100${before ? `&before=${before}` : ""}`);
      if (!page) { total = -1; break; }
      if (page.length === 0) break;
      for (const m of page) {
        if (m.author.bot || ![0, 19].includes(m.type) || !m.content.trim()) continue;
        total++;
        chars += m.content.length;
        if (BigInt(m.id) >= BigInt(sinceSnowflake)) recent++;
        oldest = m.timestamp.slice(0, 10);
      }
      before = page[page.length - 1].id;
      if (page.length < 100) break;
    }
    if (total < 0) continue;
    grand += total; grandSince += recent;
    console.log(`${String(total).padStart(6)} ${String(recent).padStart(6)}  #${c.name}  (oldest ${oldest})`);
  }
}
console.log(`\ntotal human messages: ${grand}; since ${since}: ${grandSince}; characters: ${chars}`);
