// Which channels can the bot read, and what is the newest message in each? Diagnostic only.
const token = Deno.env.get("DISCORD_BOT_TOKEN")!;
const API = "https://discord.com/api/v10";
const h = { authorization: `Bot ${token}` };
const guilds = await (await fetch(`${API}/users/@me/guilds`, { headers: h })).json() as { id: string; name: string }[];
for (const g of guilds) {
  const chans = await (await fetch(`${API}/guilds/${g.id}/channels`, { headers: h })).json() as { id: string; name: string; type: number }[];
  console.log(`guild ${g.name}: ${chans.length} channels visible`);
  for (const c of chans.filter((c) => c.type === 0)) {
    const r = await fetch(`${API}/channels/${c.id}/messages?limit=1`, { headers: h });
    const body = await r.text();
    let last = "";
    if (r.ok) {
      const m = JSON.parse(body)[0];
      last = m ? `${m.timestamp.slice(0, 16)} ${m.author.username}: ${m.content.slice(0, 60)}` : "(empty)";
    }
    console.log(`  ${r.status} #${c.name} ${last}`);
  }
}
