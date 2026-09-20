/**
 * The browser for what an instance holds. One static page; every number on
 * it comes from /browse/api/*, which goes through the ports, so the page is
 * the same on every limb. It holds no data of its own and is served without
 * a key; the key is asked for once and kept in the browser's localStorage.
 *
 * Kept free of backticks and "${" so it can live in a String.raw literal.
 */
export const BROWSE_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grysstof</title>
<style>
  :root { --bg:#14161a; --panel:#1c1f25; --line:#2c3038; --fg:#e6e7ea; --dim:#9aa0ab; --accent:#7cc4ff; --subject:#f2b84b; --fact:#7cc4ff; --old:#5b6170; --ok:#6fd38a; --thought:#c39cf0; --hub:#ff9f7a; }
  * { box-sizing:border-box; }
  html, body { height:100%; margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, "Segoe UI", sans-serif; }
  body { display:grid; grid-template-rows:auto 1fr; }
  header { display:flex; gap:12px; align-items:center; padding:8px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0 8px 0 0; font-weight:600; }
  header .tenant { color:var(--subject); font-family:ui-monospace, Consolas, monospace; }
  header input[type=search] { flex:1; min-width:240px; }
  input, select, button { background:#0f1114; color:var(--fg); border:1px solid var(--line); border-radius:4px; padding:5px 8px; font:inherit; }
  button { cursor:pointer; } button:hover { border-color:var(--accent); }
  button.on { border-color:var(--accent); color:var(--accent); }
  main { display:grid; grid-template-columns:300px 1fr 420px; min-height:0; }
  aside, section { min-height:0; overflow:auto; }
  aside { border-right:1px solid var(--line); padding:10px 12px; }
  #detail { border-left:1px solid var(--line); padding:12px 16px; }
  h2 { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--dim); margin:14px 0 6px; }
  ul { list-style:none; margin:0; padding:0; }
  li.row { display:flex; justify-content:space-between; gap:8px; padding:4px 6px; border-radius:4px; cursor:pointer; white-space:nowrap; overflow:hidden; }
  li.row:hover, li.row.sel { background:#262a33; }
  li.row .n { color:var(--dim); font-variant-numeric:tabular-nums; }
  #graph { position:relative; background:radial-gradient(circle at 50% 40%, #191c22 0, var(--bg) 70%); }
  #graph svg { width:100%; height:100%; display:block; }
  #graph .ctl { position:absolute; top:10px; right:10px; display:flex; gap:4px; }
  #graph .legend { position:absolute; left:10px; bottom:10px; display:flex; gap:14px; font-size:12px; color:var(--dim); }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; vertical-align:-1px; }
  .node text { font-size:11px; fill:var(--fg); pointer-events:none; paint-order:stroke; stroke:var(--bg); stroke-width:3px; }
  .node.subject text, .node.hub text { font-size:13px; font-weight:600; }
  .link { stroke:#3a3f4a; stroke-width:1.2px; }
  .link.supersedes { stroke:var(--subject); stroke-dasharray:4 3; }
  .node.sel circle { stroke:#fff; stroke-width:2.5px; }
  table.kv { border-collapse:collapse; width:100%; }
  table.kv td { padding:3px 6px 3px 0; vertical-align:top; border-bottom:1px solid var(--line); }
  table.kv td:first-child { color:var(--dim); white-space:nowrap; width:1%; }
  .claim { white-space:pre-wrap; background:#0f1114; border:1px solid var(--line); border-radius:4px; padding:8px 10px; margin:6px 0 10px; }
  .chain li { padding:6px 8px; border-left:3px solid var(--fact); margin:4px 0; background:#0f1114; }
  .chain li.old { border-left-color:var(--old); color:var(--dim); }
  .chain li.cur { border-left-color:var(--ok); }
  .chain .meta { font-size:12px; color:var(--dim); }
  .tag { display:inline-block; background:#262a33; border-radius:3px; padding:1px 6px; margin:2px 3px 2px 0; font-size:12px; }
  a { color:var(--accent); }
  .stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(110px,1fr)); gap:6px; }
  .stat { background:#0f1114; border:1px solid var(--line); border-radius:4px; padding:6px 8px; }
  .stat b { display:block; font-size:18px; font-variant-numeric:tabular-nums; }
  .stat span { font-size:11px; color:var(--dim); }
  #msg { color:var(--dim); font-size:12px; margin-left:auto; }
  .filters { display:grid; grid-template-columns:1fr; gap:4px; }
  .filters select { width:100%; min-width:0; }
  aside { overflow-x:hidden; }
</style>
</head>
<body>
<header>
  <h1>Grysstof <span class="tenant" id="tenant">…</span></h1>
  <button id="modeFacts" class="on">Facts</button>
  <button id="modeThoughts">Thoughts</button>
  <input type="search" id="q" placeholder="search claims and thoughts by meaning…">
  <label>show <input type="number" id="limit" value="300" min="10" max="2000" step="50" style="width:80px"></label>
  <button id="keyBtn" title="set the instance key">key</button>
  <span id="msg"></span>
</header>
<main>
  <aside>
    <div class="stats" id="stats"></div>
    <h2>Subjects <span id="subjectCount"></span></h2>
    <ul id="subjects"></ul>
    <h2>Thought filters</h2>
    <div class="filters">
      <select id="fType"><option value="">any type</option></select>
      <select id="fTopic"><option value="">any topic</option></select>
      <select id="fPerson"><option value="">any person</option></select>
      <button id="apply">apply</button>
    </div>
    <h2>Search results</h2>
    <ul id="results"></ul>
  </aside>
  <section id="graph">
    <svg></svg>
    <div class="ctl"><button id="zin">+</button><button id="zout">−</button><button id="fit">Fit</button><button id="labels" class="on">labels</button></div>
    <div class="legend" id="legend"></div>
  </section>
  <section id="detail"><p style="color:var(--dim)">Pick a subject on the left or a node in the graph.</p></section>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script>
(function () {
  var KEY = "grysstof.key";
  var $ = function (id) { return document.getElementById(id); };
  var state = { mode: "facts", subjects: [], summary: null, histories: {}, thoughts: [], selected: null, labels: true };

  function key() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function askKey(force) {
    var k = key();
    if (k && !force) return k;
    k = prompt("Key for this Grysstof instance (the x-brain-key it was started with)") || "";
    try { localStorage.setItem(KEY, k); } catch (e) {}
    return k;
  }
  function msg(t) { $("msg").textContent = t || ""; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function short(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function when(iso) {
    var t = Date.parse(iso || ""); if (isNaN(t)) return "";
    var d = new Date(t), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  // A seeded note's heading is generic ("Next step"); the client in front of it is what tells them apart.
  function tlabel(t, n) { var m = t.metadata || {}; return short((m.client ? m.client + " · " : "") + (m.heading || t.content), n); }
  // A proof is free text from a writer; only a web address becomes a link.
  function link(s, label) { s = String(s || ""); return /^https?:\/\//i.test(s) ? '<a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(label || s) + '</a>' : esc(s); }

  function api(path) {
    return fetch("/browse/api" + path, { headers: { "x-brain-key": key(), "x-brain-actor": "browser" } }).then(function (r) {
      return r.json().then(function (j) {
        // The gate refuses as JSON-RPC (200 + code -32001) or, for challenge schemes, as 401.
        if (r.status === 401 || (j && j.error && j.error.code === -32001)) { askKey(true); throw new Error("key refused; set it and retry"); }
        if (!r.ok || (j && typeof j.error === "string")) throw new Error((j && (j.error.message || j.error)) || r.status);
        return j;
      });
    });
  }

  function load() {
    msg("loading…");
    return api("/overview").then(function (o) {
      state.subjects = o.subjects; state.summary = o.summary; $("tenant").textContent = o.tenant;
      renderStats(); renderSubjects(); renderFilters();
      return Promise.all(state.subjects.slice(0, 80).map(function (s) { return history(s.subject); }));
    }).then(function () { msg(""); draw(); }).catch(function (e) { msg(String(e.message || e)); });
  }
  function history(subject) {
    if (state.histories[subject]) return Promise.resolve(state.histories[subject]);
    return api("/history?subject=" + encodeURIComponent(subject)).then(function (h) { state.histories[subject] = h.facts; return h.facts; });
  }
  function loadThoughts() {
    var p = "/thoughts?limit=" + $("limit").value;
    ["Type", "Topic", "Person"].forEach(function (f) { var v = $("f" + f).value; if (v) p += "&" + f.toLowerCase() + "=" + encodeURIComponent(v); });
    msg("loading thoughts…");
    return api(p).then(function (t) { state.thoughts = t.thoughts; msg(t.thoughts.length + " thoughts"); draw(); }).catch(function (e) { msg(String(e.message || e)); });
  }

  function renderStats() {
    var s = state.summary || { count: 0, types: {}, topics: {}, people: {} }, lines = 0, cur = 0;
    state.subjects.forEach(function (x) { lines += x.lines; cur += x.current; });
    $("stats").innerHTML =
      '<div class="stat"><b>' + state.subjects.length + '</b><span>subjects</span></div>' +
      '<div class="stat"><b>' + cur + '</b><span>current facts</span></div>' +
      '<div class="stat"><b>' + lines + '</b><span>fact lines</span></div>' +
      '<div class="stat"><b>' + s.count + '</b><span>thoughts</span></div>' +
      '<div class="stat"><b>' + Object.keys(s.people || {}).length + '</b><span>people</span></div>' +
      '<div class="stat"><b>' + Object.keys(s.topics || {}).length + '</b><span>topics</span></div>';
  }
  function renderSubjects() {
    $("subjectCount").textContent = "(" + state.subjects.length + ")";
    $("subjects").innerHTML = state.subjects.map(function (s) {
      return '<li class="row" data-s="' + esc(s.subject) + '" title="' + esc(s.subject) + ' · newest ' + when(s.latestAt) + '"><span>' + esc(s.subject) + '</span><span class="n">' + s.current + '/' + s.lines + '</span></li>';
    }).join("") || '<li style="color:var(--dim)">no facts yet</li>';
    Array.prototype.forEach.call($("subjects").querySelectorAll("li.row"), function (li) {
      li.onclick = function () { selectSubject(li.getAttribute("data-s")); };
    });
  }
  function renderFilters() {
    var s = state.summary || {};
    [["fType", s.types], ["fTopic", s.topics], ["fPerson", s.people]].forEach(function (p) {
      var sel = $(p[0]), first = sel.options[0].outerHTML, keys = Object.keys(p[1] || {}).sort(function (a, b) { return p[1][b] - p[1][a]; });
      sel.innerHTML = first + keys.map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + ' (' + p[1][k] + ')</option>'; }).join("");
    });
  }

  function selectSubject(subject) {
    Array.prototype.forEach.call($("subjects").querySelectorAll("li.row"), function (li) { li.classList.toggle("sel", li.getAttribute("data-s") === subject); });
    history(subject).then(function (facts) {
      state.selected = { kind: "subject", id: subject };
      var byId = {}; facts.forEach(function (f) { byId[f.id] = f; });
      $("detail").innerHTML = '<h2>Subject</h2><div style="font-size:16px;font-weight:600;color:var(--subject)">' + esc(subject) + '</div>' +
        '<h2>History · newest first · ' + facts.length + ' line(s)</h2><ul class="chain">' + facts.map(function (f) {
          return '<li class="' + (f.supersededBy ? "old" : "cur") + '" data-id="' + esc(f.id) + '">' + esc(f.claim) +
            '<div class="meta">' + when(f.learnedAt) + ' · ' + esc(f.learnedBy) + ' · ' + esc(f.source) +
            (f.confirmed ? ' · <span style="color:var(--ok)">confirmed by ' + esc(f.confirmedBy) + '</span>' : '') +
            (f.supersedes ? ' · replaces ' + esc(short(byId[f.supersedes] ? byId[f.supersedes].claim : f.supersedes, 40)) : '') +
            (f.supersededBy ? ' · replaced by ' + esc(short(byId[f.supersededBy] ? byId[f.supersededBy].claim : f.supersededBy, 40)) : '') +
            (f.proof ? ' · ' + link(f.proof, "proof") : '') + '</div></li>';
        }).join("") + '</ul>';
      Array.prototype.forEach.call($("detail").querySelectorAll("li[data-id]"), function (li) { li.onclick = function () { showFact(byId[li.getAttribute("data-id")]); }; });
      if (state.mode !== "facts") { state.mode = "facts"; setMode(); } else highlight(subject);
    });
  }
  function showFact(f) {
    state.selected = { kind: "fact", id: f.id };
    $("detail").innerHTML = '<h2>Fact ' + (f.supersededBy ? '<span style="color:var(--old)">· superseded</span>' : '<span style="color:var(--ok)">· current</span>') + '</h2>' +
      '<div class="claim">' + esc(f.claim) + '</div><table class="kv">' +
      kv("subject", '<a href="#" id="toSubject">' + esc(f.subject) + '</a>') + kv("source", esc(f.source)) + (f.proof ? kv("proof", link(f.proof)) : "") +
      kv("learned", when(f.learnedAt) + " by " + esc(f.learnedBy)) + kv("confirmed", f.confirmed ? "yes, " + when(f.confirmedAt) + " by " + esc(f.confirmedBy) : "no") +
      kv("supersedes", f.supersedes ? esc(f.supersedes) : "—") + kv("superseded by", f.supersededBy ? esc(f.supersededBy) : "—") +
      kv("tags", (f.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join("") || "—") + kv("id", '<code>' + esc(f.id) + '</code>') + '</table>';
    $("toSubject").onclick = function (e) { e.preventDefault(); selectSubject(f.subject); };
    highlight(f.id);
  }
  function showThought(t) {
    state.selected = { kind: "thought", id: t.id };
    var m = t.metadata || {};
    $("detail").innerHTML = '<h2>Thought · ' + when(t.createdAt) + '</h2><div class="claim">' + esc(t.content) + '</div><table class="kv">' +
      Object.keys(m).map(function (k) { var v = m[k]; return kv(k, Array.isArray(v) ? v.map(function (x) { return '<span class="tag">' + esc(x) + '</span>'; }).join("") : esc(typeof v === "object" ? JSON.stringify(v) : v)); }).join("") +
      kv("id", '<code>' + esc(t.id) + '</code>') + '</table>';
    highlight(t.id);
  }
  function kv(k, v) { return '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>'; }

  function search(q) {
    if (!q.trim()) { $("results").innerHTML = ""; return; }
    msg("searching…");
    Promise.all([api("/facts?q=" + encodeURIComponent(q) + "&limit=25&includeSuperseded=true"), api("/recall?q=" + encodeURIComponent(q) + "&limit=25")]).then(function (r) {
      var items = r[0].facts.map(function (f) { return { t: "fact", s: f.score, o: f, label: f.subject + " · " + short(f.claim, 60) }; })
        .concat(r[1].thoughts.map(function (t) { return { t: "thought", s: t.score, o: t, label: tlabel(t, 70) }; }))
        .sort(function (a, b) { return b.s - a.s; });
      $("results").innerHTML = items.map(function (i, n) {
        return '<li class="row" data-n="' + n + '" title="' + esc(i.label) + '"><span><i style="color:' + (i.t === "fact" ? "var(--fact)" : "var(--thought)") + '">●</i> ' + esc(i.label) + '</span><span class="n">' + i.s.toFixed(2) + '</span></li>';
      }).join("") || '<li style="color:var(--dim)">nothing</li>';
      Array.prototype.forEach.call($("results").querySelectorAll("li.row"), function (li) {
        li.onclick = function () { var i = items[+li.getAttribute("data-n")]; if (i.t === "fact") showFact(i.o); else showThought(i.o); };
      });
      msg(items.length + " hit(s)");
    }).catch(function (e) { msg(String(e.message || e)); });
  }

  // Graph: subjects are hubs and facts hang off them, supersede links between facts;
  // or thoughts hang off people/topic/client hubs. Same drawing code for both.
  var svg = d3.select("#graph svg"), g = svg.append("g"), sim = null, nodeSel = null;
  var zoom = d3.zoom().scaleExtent([0.1, 6]).on("zoom", function (e) { g.attr("transform", e.transform); });
  svg.call(zoom);
  svg.append("defs").append("marker").attr("id", "arrow").attr("viewBox", "0 -4 8 8").attr("refX", 14).attr("markerWidth", 7).attr("markerHeight", 7).attr("orient", "auto")
    .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", "var(--subject)");

  function build() {
    var nodes = [], links = [], seen = {};
    var add = function (n) { if (!seen[n.id]) { seen[n.id] = n; nodes.push(n); } return seen[n.id]; };
    if (state.mode === "facts") {
      state.subjects.forEach(function (s) {
        add({ id: s.subject, kind: "subject", label: s.subject, r: 9 + Math.min(12, s.lines) });
        var facts = state.histories[s.subject] || [];
        facts.forEach(function (f) {
          add({ id: f.id, kind: "fact", label: short(f.claim, 48), r: f.supersededBy ? 4 : 6, old: !!f.supersededBy, ok: f.confirmed, data: f });
          links.push({ source: s.subject, target: f.id, kind: "has" });
        });
        facts.forEach(function (f) { if (f.supersedes && seen[f.supersedes]) links.push({ source: f.id, target: f.supersedes, kind: "supersedes" }); });
      });
    } else {
      state.thoughts.forEach(function (t) {
        var m = t.metadata || {};
        add({ id: t.id, kind: "thought", label: tlabel(t, 40), r: 4, data: t });
        var hubs = [].concat(m.people || [], m.topics || [], m.client ? ["client:" + m.client] : [], m.type ? ["type:" + m.type] : []);
        hubs.forEach(function (h) {
          h = String(h); var hub = add({ id: "hub:" + h, kind: "hub", label: h, r: 6, deg: 0 }); hub.deg++;
          links.push({ source: t.id, target: hub.id, kind: "tagged" });
        });
      });
      nodes.forEach(function (n) { if (n.kind === "hub") n.r = 6 + Math.min(16, Math.sqrt(n.deg) * 2); });
    }
    return { nodes: nodes, links: links };
  }

  function draw() {
    var d = build();
    g.selectAll("*").remove();
    var w = $("graph").clientWidth, h = $("graph").clientHeight;
    if (sim) sim.stop();
    sim = d3.forceSimulation(d.nodes)
      .force("link", d3.forceLink(d.links).id(function (n) { return n.id; }).distance(function (l) { return l.kind === "supersedes" ? 30 : 55; }).strength(0.6))
      .force("charge", d3.forceManyBody().strength(function (n) { return n.kind === "subject" || n.kind === "hub" ? -260 : -40; }))
      .force("center", d3.forceCenter(w / 2, h / 2)).force("collide", d3.forceCollide(function (n) { return n.r + 4; }));
    var link = g.append("g").selectAll("line").data(d.links).join("line").attr("class", function (l) { return "link " + l.kind; })
      .attr("marker-end", function (l) { return l.kind === "supersedes" ? "url(#arrow)" : null; });
    nodeSel = g.append("g").selectAll("g").data(d.nodes).join("g").attr("class", function (n) { return "node " + n.kind; })
      .call(d3.drag().on("start", function (e, n) { if (!e.active) sim.alphaTarget(0.3).restart(); n.fx = n.x; n.fy = n.y; })
        .on("drag", function (e, n) { n.fx = e.x; n.fy = e.y; }).on("end", function (e, n) { if (!e.active) sim.alphaTarget(0); n.fx = null; n.fy = null; }));
    nodeSel.append("circle").attr("r", function (n) { return n.r; })
      .attr("fill", function (n) { return n.kind === "subject" ? "var(--subject)" : n.kind === "hub" ? "var(--hub)" : n.kind === "thought" ? "var(--thought)" : n.old ? "var(--old)" : "var(--fact)"; })
      .attr("stroke", function (n) { return n.ok ? "var(--ok)" : "none"; }).attr("stroke-width", 2);
    nodeSel.append("text").attr("dx", function (n) { return n.r + 3; }).attr("dy", 4).text(function (n) { return n.label; }).style("display", state.labels ? null : "none");
    nodeSel.append("title").text(function (n) { return n.kind === "fact" ? n.data.claim : n.kind === "thought" ? n.data.content.slice(0, 400) : n.label; });
    nodeSel.on("click", function (e, n) {
      if (n.kind === "subject") selectSubject(n.id); else if (n.kind === "fact") showFact(n.data); else if (n.kind === "thought") showThought(n.data);
      else if (n.kind === "hub") { $("detail").innerHTML = '<h2>Hub</h2><div style="font-size:16px;font-weight:600;color:var(--hub)">' + esc(n.label) + '</div><p>' + n.deg + ' thought(s) carry this label.</p>'; highlight(n.id); }
    });
    sim.on("tick", function () {
      link.attr("x1", function (l) { return l.source.x; }).attr("y1", function (l) { return l.source.y; }).attr("x2", function (l) { return l.target.x; }).attr("y2", function (l) { return l.target.y; });
      nodeSel.attr("transform", function (n) { return "translate(" + n.x + "," + n.y + ")"; });
    });
    $("legend").innerHTML = state.mode === "facts"
      ? '<span><i style="background:var(--subject)"></i>subject</span><span><i style="background:var(--fact)"></i>current fact</span><span><i style="background:var(--old)"></i>superseded</span><span><i style="background:var(--fact);box-shadow:0 0 0 2px var(--ok)"></i>confirmed</span><span style="color:var(--subject)">- - ▶ replaces</span>'
      : '<span><i style="background:var(--hub)"></i>person / topic / client / type</span><span><i style="background:var(--thought)"></i>thought</span>';
    // The layout is still moving at 900 ms; fit again once it settles, but only for this draw (a drag restarts the simulation).
    var settled = false;
    setTimeout(fit, 900);
    sim.on("end", function () { if (!settled) { settled = true; fit(); } });
  }
  function highlight(id) { if (nodeSel) nodeSel.classed("sel", function (n) { return n.id === id; }); }
  function fit() {
    var b = g.node().getBBox(), w = $("graph").clientWidth, h = $("graph").clientHeight;
    if (!b.width || !b.height) return;
    var k = Math.min(4, 0.9 / Math.max(b.width / w, b.height / h));
    svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity.translate(w / 2 - k * (b.x + b.width / 2), h / 2 - k * (b.y + b.height / 2)).scale(k));
  }
  function setMode() {
    $("modeFacts").classList.toggle("on", state.mode === "facts"); $("modeThoughts").classList.toggle("on", state.mode === "thoughts");
    if (state.mode === "thoughts") loadThoughts(); else draw();
  }

  $("modeFacts").onclick = function () { state.mode = "facts"; setMode(); };
  $("modeThoughts").onclick = function () { state.mode = "thoughts"; setMode(); };
  $("apply").onclick = function () { state.mode = "thoughts"; setMode(); };
  $("limit").onchange = function () { if (state.mode === "thoughts") loadThoughts(); };
  $("zin").onclick = function () { svg.transition().call(zoom.scaleBy, 1.4); };
  $("zout").onclick = function () { svg.transition().call(zoom.scaleBy, 0.7); };
  $("fit").onclick = fit;
  $("labels").onclick = function () { state.labels = !state.labels; $("labels").classList.toggle("on", state.labels); g.selectAll(".node text").style("display", state.labels ? null : "none"); };
  $("keyBtn").onclick = function () { askKey(true); load(); };
  var timer = null; $("q").oninput = function () { clearTimeout(timer); timer = setTimeout(function () { search($("q").value); }, 350); };
  window.addEventListener("resize", function () { if (sim) { sim.force("center", d3.forceCenter($("graph").clientWidth / 2, $("graph").clientHeight / 2)).alpha(0.3).restart(); } });

  askKey(false); load();
})();
</script>
</body>
</html>`;
