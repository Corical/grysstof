/**
 * Pulse: the portal over captured client conversations. One static page; every number comes
 * from /browse/api/pulse/*, computed by core/pulse.ts. Served without a key; the key is asked
 * for once and kept in the browser. Kept free of backticks and "${" so it can live in a
 * String.raw literal.
 */
export const PULSE_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grysstof Pulse</title>
<style>
  :root { --bg:#111317; --panel:#191c22; --panel2:#1f232a; --line:#2b3039; --fg:#e8e9ec; --dim:#98a0ad; --faint:#6b7280;
          --accent:#7cc4ff; --warn:#f2b84b; --bad:#ff7a7a; --ok:#6fd38a; --person:#c39cf0; --client:#ff9f7a; }
  * { box-sizing:border-box; }
  html, body { height:100%; margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, "Segoe UI", sans-serif; }
  body { display:grid; grid-template-rows:auto 1fr; }
  header { display:flex; gap:10px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
  header h1 { font-size:17px; margin:0 6px 0 0; font-weight:650; letter-spacing:.01em; }
  header h1 span { color:var(--accent); }
  header .tenant { color:var(--warn); font-family:ui-monospace, Consolas, monospace; font-size:12px; }
  nav { display:flex; gap:4px; }
  nav button { background:transparent; border:1px solid transparent; color:var(--dim); padding:5px 11px; border-radius:6px; cursor:pointer; font:inherit; }
  nav button:hover { color:var(--fg); border-color:var(--line); }
  nav button.on { color:var(--fg); background:var(--panel2); border-color:var(--line); }
  #q { flex:1; min-width:260px; background:#0d0f12; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:7px 11px; font:inherit; }
  #q:focus { outline:none; border-color:var(--accent); }
  #msg { color:var(--dim); font-size:12px; }
  button.plain { background:#0d0f12; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 10px; cursor:pointer; font:inherit; }
  button.plain:hover { border-color:var(--accent); }
  main { min-height:0; overflow:auto; }
  .view { display:none; padding:16px; } .view.on { display:block; }
  .view.full.on { display:grid; padding:0; height:100%; }
  h2 { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--dim); margin:18px 0 8px; font-weight:600; }
  .totals { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px,1fr)); gap:10px; margin-bottom:6px; }
  .total { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .total b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
  .total span { color:var(--dim); font-size:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; cursor:pointer; transition:border-color .15s, transform .15s; position:relative; }
  .card:hover { border-color:var(--accent); transform:translateY(-1px); }
  .card .top { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
  .card .name { font-size:16px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .card .chan { color:var(--faint); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .badge { display:inline-block; border-radius:999px; padding:1px 8px; font-size:12px; font-weight:600; white-space:nowrap; }
  .badge.warn { background:rgba(242,184,75,.15); color:var(--warn); border:1px solid rgba(242,184,75,.35); }
  .badge.ok { background:rgba(111,211,138,.12); color:var(--ok); border:1px solid rgba(111,211,138,.3); }
  .badge.quiet { background:rgba(255,122,122,.12); color:var(--bad); border:1px solid rgba(255,122,122,.3); }
  .nums { display:flex; gap:16px; margin:8px 0 4px; font-size:12px; color:var(--dim); }
  .nums b { color:var(--fg); font-size:15px; font-variant-numeric:tabular-nums; margin-right:3px; }
  .spark { width:100%; height:38px; display:block; margin:6px 0; }
  .people { display:flex; gap:4px; flex-wrap:wrap; }
  .who { display:inline-flex; align-items:center; gap:5px; background:var(--panel2); border-radius:999px; padding:1px 8px 1px 2px; font-size:12px; color:var(--dim); white-space:nowrap; }
  .who i { width:18px; height:18px; border-radius:50%; display:inline-grid; place-items:center; font-style:normal; font-size:10px; color:#111; font-weight:700; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:1px; }
  table.list { width:100%; border-collapse:collapse; }
  table.list th { text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); font-weight:600; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; position:sticky; top:0; background:var(--bg); }
  table.list td { padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; white-space:nowrap; }
  table.list td.text { white-space:normal; width:100%; }
  table.list tr:hover td { background:#161920; }
  .tablewrap { overflow-x:auto; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  .conv { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; margin-bottom:10px; cursor:pointer; }
  .conv:hover { border-color:var(--accent); }
  .conv .meta { color:var(--dim); font-size:12px; display:flex; gap:10px; flex-wrap:wrap; }
  .conv .open, .conv .last { margin-top:6px; }
  .conv .last { border-left:3px solid var(--ok); padding-left:8px; color:#cfd3da; }
  .conv .open { border-left:3px solid var(--accent); padding-left:8px; }
  .conv .open b, .conv .last b { color:var(--fg); }
  .react { display:inline-block; background:var(--panel2); border:1px solid var(--line); border-radius:999px; padding:0 7px; margin:3px 4px 0 0; font-size:12px; color:var(--dim); }
  .split { display:grid; grid-template-columns:minmax(0,1fr) minmax(360px,32%); gap:16px; }
  .facts li { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:6px; padding:7px 10px; margin-bottom:6px; list-style:none; }
  .facts li .m { color:var(--faint); font-size:11px; margin-top:2px; }
  ul.facts { padding:0; margin:0; }
  #explore { grid-template-columns:minmax(0,1fr) 420px; }
  #graph { position:relative; min-height:0; background:radial-gradient(circle at 50% 40%, #171a20 0, var(--bg) 72%); }
  #graph svg { width:100%; height:100%; display:block; }
  #graph .hint { position:absolute; inset:0; display:grid; place-items:center; color:var(--faint); text-align:center; pointer-events:none; padding:20px; }
  #graph .legend { position:absolute; left:12px; bottom:10px; display:flex; gap:14px; font-size:12px; color:var(--dim); flex-wrap:wrap; background:rgba(17,19,23,.7); padding:4px 8px; border-radius:6px; }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; vertical-align:-1px; }
  #side { border-left:1px solid var(--line); overflow:auto; padding:14px 16px; background:var(--panel); }
  .msgline { padding:6px 0 8px; border-bottom:1px solid var(--line); }
  .msgline.hit { background:rgba(124,196,255,.07); margin:0 -8px; padding:6px 8px 8px; border-radius:6px; }
  .msgline .h { font-size:12px; color:var(--dim); } .msgline .h b { color:var(--fg); }
  .msgline .t { white-space:pre-wrap; word-break:break-word; margin-top:2px; }
  .reply { color:var(--faint); font-size:12px; }
  .node text { font-size:11px; fill:var(--fg); pointer-events:none; paint-order:stroke; stroke:var(--bg); stroke-width:3px; }
  .node.client text { font-size:14px; font-weight:700; }
  .link { stroke:#343a45; stroke-width:1px; fill:none; }
  .link.reply { stroke:var(--accent); stroke-width:1.8px; }
  .link.reacted { stroke:var(--ok); stroke-dasharray:3 3; }
  .link.in { stroke:var(--client); stroke-opacity:.5; }
  .link.said { stroke:#4a4062; }
  .node.sel circle { stroke:#fff; stroke-width:2.5px; }
  .tip { position:fixed; pointer-events:none; background:#0b0d10; border:1px solid var(--line); border-radius:6px; padding:6px 9px; max-width:420px; font-size:12px; display:none; z-index:10; }
  .empty { color:var(--faint); padding:18px 0; }
  .back { margin-bottom:6px; }
  .pill { display:inline-block; background:var(--panel2); border-radius:4px; padding:0 6px; font-size:12px; color:var(--dim); margin-right:4px; }
  @media (max-width:900px) { .split, #explore { grid-template-columns:1fr; } #side { border-left:0; border-top:1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <h1>Grysstof <span>Pulse</span></h1>
  <span class="tenant" id="tenant"></span>
  <nav id="tabs">
    <button data-v="clients" class="on">Clients</button>
    <button data-v="loose">Loose ends</button>
    <button data-v="explore">Explore</button>
    <button data-v="recent">Recent</button>
    <button data-v="mapping">Mapping</button>
  </nav>
  <input id="q" type="search" placeholder="Ask anything — e.g. marlin schedules, NFC tags, licences — and see the conversations">
  <span id="msg"></span>
  <button class="plain" id="keybtn" title="Set the access key">Key</button>
</header>
<main>
  <section class="view on" id="clients"></section>
  <section class="view" id="client"></section>
  <section class="view" id="loose"></section>
  <section class="view full" id="explore">
    <div id="graph"><svg></svg><div class="hint" id="hint">Type in the box above: the matching messages appear as bubbles,<br>pulled together with the conversations around them, who said what, who reacted, and which client it was.</div>
      <div class="legend"><span><i style="background:var(--accent)"></i>highlighted message</span><span><i style="background:hsl(150,62%,66%)"></i>other messages (colour = channel)</span><span><i style="background:var(--person)"></i>person</span><span><i style="background:var(--client)"></i>client</span><span style="color:var(--accent)">── reply</span><span style="color:var(--ok)">- - reacted</span></div>
    </div>
    <aside id="side"><div class="empty">Click a bubble to read its conversation.</div></aside>
  </section>
  <section class="view" id="recent"></section>
  <section class="view" id="mapping"></section>
</main>
<div class="tip" id="tip"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script>
(function () {
  var KEY = "grysstof.key";
  var $ = function (id) { return document.getElementById(id); };
  var state = { overview: null, view: "clients" };

  function key() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function askKey(force) {
    var k = key();
    if (k && !force) return k;
    k = prompt("Key for this Grysstof instance (the x-brain-key it was started with)") || "";
    try { localStorage.setItem(KEY, k); } catch (e) {}
    return k;
  }
  function msg(t) { $("msg").textContent = t || ""; }
  function esc(s) { return String(s == null ? "" : s).replace(/<[@#]!?\d{15,}>/g, "@…").replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function short(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function when(iso) { var t = Date.parse(iso || ""); if (isNaN(t)) return ""; var d = new Date(t); return d.getDate() + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()] + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function ago(iso) {
    if (!iso) return "no activity";
    var h = (Date.now() - Date.parse(iso)) / 3600000;
    if (h < 1) return "just now"; if (h < 48) return Math.floor(h) + "h ago";
    return Math.floor(h / 24) + " days ago";
  }
  function ageText(hours) { return hours < 24 ? hours + "h" : Math.round(hours / 24) + "d"; }
  function nice(client) { return String(client || "").replace(/^client:/, "").replace(/[-_]/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function hue(s) { var h = 0; s = String(s || ""); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function colour(s) { return "hsl(" + hue(s) + ",62%,66%)"; }
  function initials(n) { return String(n || "?").split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase(); }
  function who(name) { return '<span class="who"><i style="background:' + colour(name) + '">' + esc(initials(name)) + '</i>' + esc(name) + '</span>'; }
  function discordLink(source, label) {
    var m = /^discord:([^/]+)\/(\d+)\/(\d+)$/.exec(source || "");
    return m ? '<a href="https://discord.com/channels/' + m[1] + '/' + m[2] + '/' + m[3] + '" target="_blank" rel="noopener noreferrer">' + esc(label || "open in Discord") + '</a>' : "";
  }
  function reactions(list) { return (list || []).map(function (r) { return '<span class="react">' + esc(r.emoji) + (r.by && r.by.length ? " " + esc(r.by.join(", ")) + (r.count > r.by.length ? " +" + (r.count - r.by.length) : "") : " ×" + r.count) + '</span>'; }).join(""); }

  function api(path) {
    return fetch("/browse/api" + path, { headers: { "x-brain-key": key(), "x-brain-actor": "pulse" } }).then(function (r) {
      return r.json().then(function (j) {
        if (r.status === 401 || (j && j.error && j.error.code === -32001)) { askKey(true); throw new Error("key refused; set it and reload"); }
        if (!r.ok || (j && typeof j.error === "string")) throw new Error((j && (j.error.message || j.error)) || r.status);
        return j;
      });
    });
  }

  function show(v) {
    state.view = v;
    Array.prototype.forEach.call(document.querySelectorAll(".view"), function (s) { s.classList.toggle("on", s.id === v); });
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) { b.classList.toggle("on", b.getAttribute("data-v") === v || (v === "client" && b.getAttribute("data-v") === "clients")); });
    try { history.replaceState(null, "", "#" + v); } catch (e) {}
  }

  function spark(daily, tall) {
    var max = Math.max.apply(null, daily.concat([1])), w = 300, h = tall ? 60 : 38, step = w / daily.length;
    var bars = daily.map(function (n, i) { var bh = n ? Math.max(2, n / max * (h - 6)) : 0; return '<rect x="' + (i * step + 1) + '" y="' + (h - 1 - bh) + '" width="' + (step - 2) + '" height="' + bh + '" rx="1.5" fill="' + (i >= 23 ? "var(--accent)" : "#3b4453") + '"><title>' + (29 - i === 0 ? "last 24 hours" : (29 - i) + " days ago") + ': ' + n + '</title></rect>'; }).join("");
    return '<svg class="spark" style="height:' + (tall ? 90 : 38) + 'px" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><line x1="0" y1="' + (h - 0.5) + '" x2="' + w + '" y2="' + (h - 0.5) + '" stroke="#2b3039" stroke-width="1" vector-effect="non-scaling-stroke"></line>' + bars + '</svg>' +
      (tall ? '<div style="display:flex;justify-content:space-between;color:var(--faint);font-size:11px;margin-top:-2px"><span>30 days ago</span><span>this week (blue)</span><span>today</span></div>' : "");
  }

  function status(c) {
    if (c.looseEnds) return '<span class="badge warn">' + c.looseEnds + ' loose end' + (c.looseEnds > 1 ? "s" : "") + '</span>';
    if (c.last30 && !c.last7) return '<span class="badge quiet">quiet this week</span>';
    if (c.last7) return '<span class="badge ok">active</span>';
    return '<span class="badge quiet">no recent talk</span>';
  }

  function renderClients() {
    var o = state.overview, t = o.totals;
    var loose = o.looseEndsTotal, active = o.cards.filter(function (c) { return c.last7; }).length;
    var html = '<div class="totals">' +
      '<div class="total"><b>' + t.messages.toLocaleString() + '</b><span>messages captured</span></div>' +
      '<div class="total"><b>' + active + ' / ' + o.cards.length + '</b><span>clients active this week</span></div>' +
      '<div class="total"><b style="color:var(--warn)">' + loose + '</b><span>loose ends (30 days)</span></div>' +
      '<div class="total"><b>' + esc(ago(t.newest)) + '</b><span>last message captured</span></div></div>';
    html += '<h2>Clients — most in need of attention first</h2><div class="cards">' + o.cards.map(function (c) {
      return '<div class="card" data-client="' + esc(c.client) + '"><div class="top"><div class="name">' + esc(nice(c.client)) + '</div>' + status(c) + '</div>' +
        '<div class="chan">' + (c.channels.length ? c.channels.map(function (x) { return "#" + esc(x); }).join(" · ") : "no channel mapped") + '</div>' +
        spark(c.daily) +
        '<div class="nums"><span><b>' + c.last7 + '</b>7 days</span><span><b>' + c.last30 + '</b>30 days</span><span><b>' + c.facts + '</b>facts</span><span style="margin-left:auto">' + esc(ago(c.lastAt)) + '</span></div>' +
        '<div class="people">' + c.people.slice(0, 5).map(function (p) { return who(p.name); }).join("") + '</div></div>';
    }).join("") + '</div>';
    $("clients").innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll(".card"), function (el) { el.onclick = function () { openClient(el.getAttribute("data-client")); }; });
  }

  function convHtml(c, withClient) {
    return '<div class="conv" data-src="' + esc(c.opener.source) + '"><div class="meta"><span>#' + esc(c.channel) + '</span>' + (withClient && c.client ? '<span>' + esc(nice(c.client)) + '</span>' : "") +
      '<span>' + esc(when(c.start)) + (c.size > 1 ? ' → ' + esc(when(c.end)) : "") + '</span><span>' + c.size + ' message' + (c.size > 1 ? "s" : "") + '</span><span>' + c.people.map(esc).join(", ") + '</span></div>' +
      '<div class="open"><b>' + esc(c.opener.author || "") + ':</b> ' + esc(short(c.opener.text, 260)) + '</div>' +
      (c.size > 1 ? '<div class="last"><b>' + esc(c.last.author || "") + ':</b> ' + esc(short(c.last.text, 260)) + ' ' + reactions(c.last.reactions) + '</div>' : "") + '</div>';
  }
  function wireConvs(root) { Array.prototype.forEach.call(root.querySelectorAll(".conv"), function (el) { el.onclick = function () { openThread(el.getAttribute("data-src")); }; }); }

  function looseTable(list, withClient) {
    if (!list.length) return '<div class="empty">Nothing open: every ask in this window got a visible response.</div>';
    return '<div class="tablewrap"><table class="list"><thead><tr><th>Age</th>' + (withClient ? '<th>Client</th>' : "") + '<th>Channel</th><th>Who</th><th>Ask</th><th></th></tr></thead><tbody>' + list.map(function (m) {
      return '<tr><td style="color:' + (m.ageHours > 72 ? "var(--bad)" : m.ageHours > 24 ? "var(--warn)" : "var(--dim)") + '">' + ageText(m.ageHours) + '</td>' +
        (withClient ? '<td>' + esc(m.client ? nice(m.client) : "internal") + '</td>' : "") + '<td>#' + esc(m.channel) + '</td><td>' + (m.author ? who(m.author) : "") + '</td>' +
        '<td class="text">' + esc(short(m.text, 300)) + '</td><td><a href="#" data-src="' + esc(m.source) + '" class="thr">thread</a> · ' + discordLink(m.source, "Discord") + '</td></tr>';
    }).join("") + '</tbody></table></div>';
  }
  function wireThreads(root) { Array.prototype.forEach.call(root.querySelectorAll("a.thr"), function (a) { a.onclick = function (e) { e.preventDefault(); openThread(a.getAttribute("data-src")); }; }); }

  function renderLoose() {
    var el = $("loose");
    var o = state.overview;
    el.innerHTML = '<h2>Loose ends — ' + o.looseEndsTotal + ' asks with no visible response (last 30 days)</h2><p style="color:var(--dim);margin-top:0">An ask is a question or a request (please, can you…); an @mention says who was asked. It counts as picked up when it got a reply, a reaction, or the person it named spoke later in the same conversation. An answer by phone or in another channel is not seen, so open the thread before chasing. Oldest first' + (o.looseEnds.length < o.looseEndsTotal ? "; showing the first " + o.looseEnds.length : "") + '.</p>' + looseTable(o.looseEnds, true);
    wireThreads(el);
  }

  function renderRecent() {
    var el = $("recent");
    el.innerHTML = '<h2>Latest conversations across all channels</h2>' + state.overview.recent.map(function (c) { return convHtml(c, true); }).join("");
    wireConvs(el);
  }

  function renderMapping() {
    var el = $("mapping");
    el.innerHTML = '<h2>Discord channel → client</h2><p style="color:var(--dim);margin-top:0">Worked out from the names (#grainfieldchicken → grainfield). To correct one, capture a fact with subject <code>channel:&lt;name&gt;</code> and the content <code>client:&lt;slug&gt;</code> or <code>internal</code>; the newest fact wins and the history is kept.</p>' +
      '<div class="tablewrap"><table class="list"><thead><tr><th>Channel</th><th>Client</th><th>How</th><th>Messages</th></tr></thead><tbody>' +
      state.overview.mapping.map(function (m) { return '<tr><td>#' + esc(m.channel) + '</td><td>' + (m.client ? '<a href="#" data-client="' + esc(m.client) + '" class="cl">' + esc(nice(m.client)) + '</a>' : '<span style="color:var(--faint)">internal</span>') + '</td><td>' + (m.how === "set" ? '<span class="badge warn">set by fact</span>' : '<span class="pill">auto</span>') + '</td><td>' + m.messages + '</td></tr>'; }).join("") +
      '</tbody></table></div>';
    Array.prototype.forEach.call(el.querySelectorAll("a.cl"), function (a) { a.onclick = function (e) { e.preventDefault(); openClient(a.getAttribute("data-client")); }; });
  }

  function openClient(client) {
    msg("loading " + nice(client) + "…");
    api("/pulse/client?client=" + encodeURIComponent(client)).then(function (d) {
      var c = d.card, el = $("client");
      el.innerHTML = '<button class="plain back" id="backbtn">← All clients</button>' +
        '<div class="top" style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap"><h1 style="margin:6px 0">' + esc(nice(client)) + '</h1>' + status(c) +
        '<span style="color:var(--dim)">' + c.channels.map(function (x) { return "#" + esc(x); }).join(" · ") + '</span><span style="color:var(--dim)">last talk ' + esc(ago(c.lastAt)) + '</span></div>' +
        '<div class="totals"><div class="total"><b>' + c.last7 + '</b><span>messages this week</span></div><div class="total"><b>' + c.last30 + '</b><span>last 30 days</span></div><div class="total"><b style="color:var(--warn)">' + d.looseEnds.length + '</b><span>loose ends (60 days)</span></div><div class="total"><b>' + c.facts + '</b><span>facts on record</span></div></div>' +
        spark(c.daily, true) + '<div class="people" style="margin:10px 0 8px">' + c.people.map(function (p) { return who(p.name + " · " + p.messages); }).join("") + '</div>' +
        '<div class="split"><div><h2>Loose ends</h2>' + looseTable(d.looseEnds, false) + '<h2>Conversations</h2>' + (d.conversations.length ? d.conversations.map(function (x) { return convHtml(x, false); }).join("") : '<div class="empty">No conversations captured.</div>') + '</div>' +
        '<div><h2>What we know (current facts)</h2><ul class="facts">' + (d.facts.length ? d.facts.map(function (f) { return '<li>' + esc(f.claim) + '<div class="m">' + esc(when(f.occurredAt || f.learnedAt)) + ' · ' + esc(f.learnedBy) + (f.confirmed ? ' · confirmed' : '') + '</div></li>'; }).join("") : '<li>No facts recorded.</li>') + '</ul></div></div>';
      $("backbtn").onclick = function () { show("clients"); };
      wireConvs(el); wireThreads(el);
      show("client"); msg("");
      $("client").scrollTop = 0;
    }).catch(function (e) { msg(e.message); });
  }

  function threadHtml(d, hitSource) {
    return '<h2 style="margin-top:0">#' + esc(d.channel) + (d.client ? ' · ' + esc(nice(d.client)) : "") + '</h2><div style="color:var(--dim);font-size:12px;margin-bottom:6px">' + esc(when(d.start)) + ' → ' + esc(when(d.end)) + ' · ' + d.size + ' messages · ' + discordLink(d.opener.source, "open in Discord") + '</div>' +
      d.messages.map(function (m) {
        return '<div class="msgline' + (m.source === hitSource ? " hit" : "") + '" id="m-' + esc(m.id) + '"><div class="h"><b>' + esc(m.author || "?") + '</b> · ' + esc(when(m.at)) + (m.inReplyTo ? ' <span class="reply">↩ reply</span>' : "") + '</div><div class="t">' + esc(m.text) + '</div>' + reactions(m.reactions) + '</div>';
      }).join("");
  }

  function openThread(source) {
    msg("loading thread…");
    api("/pulse/thread?source=" + encodeURIComponent(source)).then(function (d) {
      show("explore");
      // The graph follows what was opened: this conversation's bubbles, not the last search's.
      $("q").value = "";
      $("hint").style.display = "none";
      draw(d.graph);
      $("side").innerHTML = threadHtml(d, source);
      var hit = document.querySelector("#side .msgline.hit"); if (hit) hit.scrollIntoView({ block: "center" });
      msg("Conversation in #" + d.channel + (d.client ? " · " + nice(d.client) : "") + " · " + d.size + " message" + (d.size > 1 ? "s" : ""));
    }).catch(function (e) { msg(e.message); });
  }

  // --- Explore: bubbles ---
  var svg = d3.select("#graph svg"), g = svg.append("g"), sim = null;
  var zoom = d3.zoom().scaleExtent([0.15, 5]).on("zoom", function (e) { g.attr("transform", e.transform); });
  svg.call(zoom);
  function fit() {
    var b = g.node().getBBox(), box = $("graph").getBoundingClientRect();
    if (!b.width || !b.height) return;
    var k = Math.min(2.2, 0.9 / Math.max(b.width / box.width, b.height / box.height));
    svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(box.width / 2 - k * (b.x + b.width / 2), box.height / 2 - k * (b.y + b.height / 2)).scale(k));
  }
  var tip = $("tip");
  function explore(q) {
    if (!q.trim()) return;
    show("explore");
    msg("searching…");
    api("/pulse/explore?q=" + encodeURIComponent(q)).then(function (d) {
      $("hint").style.display = d.nodes.length ? "none" : "grid";
      if (!d.nodes.length) $("hint").innerHTML = "Nothing matched “" + esc(q) + "”. Try other words.";
      draw(d);
      msg(d.hits.length + " matching messages · " + d.nodes.filter(function (n) { return n.kind === "message"; }).length + " in view");
      var first = d.nodes.filter(function (n) { return n.hit; })[0];
      if (first) openSide(first);
    }).catch(function (e) { msg(e.message); });
  }
  function radius(n) { return n.kind === "client" ? 22 : n.kind === "person" ? 7 + Math.min(8, n.weight) : (n.hit ? 11 : 6) + Math.min(8, Math.sqrt(n.weight - 1) * 2.2); }
  function fill(n) { return n.kind === "client" ? "var(--client)" : n.kind === "person" ? "var(--person)" : n.hit ? "var(--accent)" : colour(n.channel); }
  function draw(d) {
    g.selectAll("*").remove();
    if (sim) sim.stop();
    var box = $("graph").getBoundingClientRect(), w = box.width, h = box.height;
    var link = g.append("g").selectAll("path").data(d.links).join("path").attr("class", function (l) { return "link " + l.kind; });
    var emoji = g.append("g").selectAll("text").data(d.links.filter(function (l) { return l.kind === "reacted"; })).join("text").attr("font-size", 12).attr("text-anchor", "middle").text(function (l) { return l.label; });
    var node = g.append("g").selectAll("g").data(d.nodes).join("g").attr("class", function (n) { return "node " + n.kind; })
      .call(d3.drag().on("start", function (e, n) { if (!e.active) sim.alphaTarget(0.3).restart(); n.fx = n.x; n.fy = n.y; })
        .on("drag", function (e, n) { n.fx = e.x; n.fy = e.y; }).on("end", function (e, n) { if (!e.active) sim.alphaTarget(0); n.fx = null; n.fy = null; }));
    node.append("circle").attr("r", radius).attr("fill", fill).attr("fill-opacity", function (n) { return n.kind === "message" && !n.hit ? 0.8 : 1; }).attr("stroke", function (n) { return n.hit ? "#fff" : "none"; }).attr("stroke-width", 1.5);
    node.filter(function (n) { return n.kind !== "message"; }).append("text").attr("dy", function (n) { return -radius(n) - 5; }).attr("text-anchor", "middle").text(function (n) { return n.kind === "client" ? nice(n.id) : n.label; });
    node.filter(function (n) { return n.kind === "message" && n.hit; }).append("text").attr("dx", 14).attr("dy", 4).text(function (n) { return short(n.label, 40); });
    node.on("mousemove", function (e, n) {
      tip.style.display = "block"; tip.style.left = (e.clientX + 14) + "px"; tip.style.top = (e.clientY + 12) + "px";
      tip.innerHTML = n.kind === "message" ? "<b>" + esc(n.author || "?") + "</b> · #" + esc(n.channel) + " · " + esc(when(n.at)) + "<br>" + esc(short(n.text, 240)) + (n.reactions && n.reactions.length ? "<br>" + reactions(n.reactions) : "") : "<b>" + esc(n.kind === "client" ? nice(n.id) : n.label) + "</b>";
    }).on("mouseleave", function () { tip.style.display = "none"; }).on("click", function (e, n) {
      node.classed("sel", function (x) { return x === n; });
      if (n.kind === "message") openSide(n); else if (n.kind === "client") openClient(n.id);
    });
    sim = d3.forceSimulation(d.nodes)
      .force("link", d3.forceLink(d.links).id(function (n) { return n.id; }).distance(function (l) { return l.kind === "next" ? 34 : l.kind === "in" ? 130 : l.kind === "reply" ? 44 : 70; }).strength(function (l) { return l.kind === "next" ? 0.9 : l.kind === "said" ? 0.15 : 0.3; }))
      .force("charge", d3.forceManyBody().strength(function (n) { return n.kind === "client" ? -900 : n.kind === "person" ? -220 : -90; }))
      .force("x", d3.forceX(w / 2).strength(0.03)).force("y", d3.forceY(h / 2).strength(0.05))
      .force("collide", d3.forceCollide(function (n) { return radius(n) + 6; }));
    sim.on("end", fit);
    sim.on("tick", function () {
      link.attr("d", function (l) { return "M" + l.source.x + "," + l.source.y + "L" + l.target.x + "," + l.target.y; });
      emoji.attr("x", function (l) { return (l.source.x + l.target.x) / 2; }).attr("y", function (l) { return (l.source.y + l.target.y) / 2; });
      node.attr("transform", function (n) { return "translate(" + n.x + "," + n.y + ")"; });
    });
  }
  function openSide(n) {
    api("/pulse/thread?source=" + encodeURIComponent(sourceOf(n))).then(function (d) {
      $("side").innerHTML = threadHtml(d, sourceOf(n));
      var hit = document.querySelector("#side .msgline.hit"); if (hit) hit.scrollIntoView({ block: "center" });
    }).catch(function (e) { $("side").innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function sourceOf(n) { return n.source || ""; }

  function load() {
    msg("loading…");
    return api("/pulse/overview").then(function (o) {
      state.overview = o;
      $("tenant").textContent = o.tenant;
      renderClients(); renderLoose(); renderRecent(); renderMapping();
      msg("");
    }).catch(function (e) { msg(e.message); });
  }

  Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) { b.onclick = function () { show(b.getAttribute("data-v")); }; });
  $("q").addEventListener("keydown", function (e) { if (e.key === "Enter") explore($("q").value); });
  $("keybtn").onclick = function () { askKey(true); load(); };
  if (!key()) askKey(false);
  load().then(function () { var h = (location.hash || "").slice(1); if (h && h !== "client" && $(h)) show(h); });
})();
</script>
</body>
</html>`;
