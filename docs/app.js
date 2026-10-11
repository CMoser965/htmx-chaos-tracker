/* Chaos Tracker — GitHub Pages edition.
 *
 * GitHub Pages can only serve static files, so this file plays the part of the Flask
 * server from /server/app.py *inside the browser*:
 *   1. MockXHR replaces window.XMLHttpRequest. htmx makes its normal requests
 *      (GET/POST/PUT/PATCH/DELETE) and gets back real HTML fragments with real
 *      response headers (HX-Trigger, HX-Retarget, HX-Reswap, HX-Push-Url).
 *   2. FakeEventSource is handed to the htmx SSE extension via htmx.createEventSource,
 *      so sse-connect / sse-swap work unchanged; the "chaos monkey" pushes events into it.
 * The htmx attributes in the markup are identical in spirit to the server version.
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------ base path
  const BASE = location.pathname.replace(/index\.html$/, "").replace(/[^/]*$/, "") || "/";
  const API = BASE + "api/";

  // ------------------------------------------------------------------ tiny HTML templating
  class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const val = (v) => v instanceof Safe ? v.s : Array.isArray(v) ? v.map(val).join("") :
    (v === false || v == null) ? "" : esc(v);
  const h = (strings, ...vals) => new Safe(strings.reduce((a, s, i) => a + s + (i < vals.length ? val(vals[i]) : ""), ""));
  const raw = (s) => new Safe(s);

  // ------------------------------------------------------------------ data (localStorage)
  const SEVERITIES = ["low", "medium", "high", "critical"];
  const SEV_WEIGHT = { low: 1, medium: 2, high: 4, critical: 8 };
  const SEV_EMOJI = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };
  const CATEGORIES = ["infra", "code", "people", "office", "cosmic"];
  const STATUSES = ["open", "mitigating", "resolved"];
  const NEXT_STATUS = { open: "mitigating", mitigating: "resolved", resolved: "open" };
  const PAGE_SIZE = 6;
  const SEED = [
    ["Prod DB replaced with a CSV someone opened in Excel", "infra", "critical", "open", "Leading zeros are gone. So are the customer IDs."],
    ["Intern discovered `rm -rf` has no undo", "people", "high", "mitigating", "Backups exist. Probably. Somebody check."],
    ["Coffee machine returned HTTP 418", "office", "medium", "open", "It is, in fact, a teapot. Morale dropping."],
    ["DNS. It was DNS.", "infra", "high", "resolved", "It's always DNS."],
    ["Cosmic ray flipped a feature flag", "cosmic", "low", "open", "Dark mode now only works on Tuesdays."],
    ["Friday 4:59pm deploy", "code", "critical", "mitigating", "Merged with the message 'should be fine'."],
    ["Regex now matches the entire universe", "code", "medium", "open", ".* was a choice."],
    ["Slack status set to 'on fire' (literally)", "office", "low", "resolved", "Toaster incident. Fire marshal has been looped in."],
  ];
  const MONKEY_TITLES = [
    "Load balancer is balancing nothing", "CI went green for no reason (suspicious)",
    "Kubernetes pod achieved sentience", "Cache invalidation, again",
    "Timezone bug only affects leap seconds", "Printer is printing in Wingdings",
    "Someone pushed node_modules", "TLS cert expired 3 minutes ago",
    "Off-by-one error in the off-by-one fix", "Wi-Fi only works when standing on one leg",
    "The cloud is just raining now", "Mercury in retrograde (blamed in postmortem)",
    "Dependency left-pad'd itself", "Tabs vs spaces war broke out in #general",
  ];
  const KEY = "chaos-tracker-db-v1";
  let db;
  function seed() {
    const now = Date.now();
    db = { nextId: 1, events: {} };
    SEED.forEach(([t, c, s, st, d], i) => add(t, c, s, st, d, now - 17 * 60000 * (SEED.length - i)));
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* private mode */ } }
  function load() {
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { db = null; }
    if (!db || !db.events) seed();
    save();
  }
  function add(title, category, severity, status = "open", description = "", created = Date.now()) {
    const ev = { id: db.nextId++, title, category, severity, status, description, created };
    db.events[ev.id] = ev;
    const ids = Object.keys(db.events).map(Number);
    if (ids.length > 300) delete db.events[Math.min(...ids)];
    save();
    return ev;
  }
  const monkey = { on: false };

  function filtered({ q = "", severity = "", status = "" }, before) {
    q = q.trim().toLowerCase();
    let out = Object.values(db.events).sort((a, b) => b.id - a.id);
    if (q) out = out.filter((e) => e.title.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.category.includes(q));
    if (severity) out = out.filter((e) => e.severity === severity);
    if (status) out = out.filter((e) => e.status === status);
    if (before) out = out.filter((e) => e.id < before);
    return out;
  }
  function page(f, before) {
    const rows = filtered(f, before);
    return [rows.slice(0, PAGE_SIZE), rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1].id : null];
  }
  function stats() {
    const evs = Object.values(db.events);
    const by_status = Object.fromEntries(STATUSES.map((s) => [s, evs.filter((e) => e.status === s).length]));
    const by_sev = Object.fromEntries(SEVERITIES.map((s) => [s, evs.filter((e) => e.severity === s && e.status !== "resolved").length]));
    const score = evs.filter((e) => e.status !== "resolved")
      .reduce((a, e) => a + SEV_WEIGHT[e.severity] * (e.status === "open" ? 1 : 0.5), 0);
    const level = Math.min(100, Math.floor(score * 2.5));
    const mood = level < 20 ? "Suspiciously calm 🧘" : level < 45 ? "Mildly spicy 🌶️" : level < 75 ? "Things are on fire 🔥" : "Total meltdown ☢️";
    return { total: evs.length, by_status, by_sev, level, mood, now: new Date().toTimeString().slice(0, 8), monkey: monkey.on };
  }
  const ago = (t) => { const s = Math.floor((Date.now() - t) / 1000);
    return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };
  const qs = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

  // ------------------------------------------------------------------ templates (ported from Jinja)
  const badge = (text, title = "") => h`<span class="hx-badge" title="${title}">${text}</span>`;
  const T = {
    counter: (total, oob) => h`<strong id="event-count" class="count-pill"${oob ? raw(' hx-swap-oob="true"') : ""}>${total}</strong>`,
    row: (e, fresh) => h`
<tr id="event-${e.id}" class="sev-${e.severity} st-${e.status}${fresh ? " fresh" : ""}">
  <td><span class="sev" title="${e.severity}">${SEV_EMOJI[e.severity]}</span></td>
  <td><a href="${BASE}?event=${e.id}" class="title-link"
         hx-get="${API}events/${e.id}" hx-target="#detail" hx-swap="outerHTML" hx-push-url="${BASE}?event=${e.id}">${e.title}</a></td>
  <td><span class="tag">${e.category}</span></td>
  <td><button class="status status-${e.status}" hx-patch="${API}events/${e.id}/status" hx-target="closest tr" hx-swap="outerHTML"
              title="Click to advance → ${NEXT_STATUS[e.status]} (hx-patch)">${e.status} ➜</button></td>
  <td class="muted">${ago(e.created)}</td>
  <td class="right nowrap">
    <button class="icon" title="Edit inline (hx-get)" hx-get="${API}events/${e.id}/edit" hx-target="closest tr" hx-swap="outerHTML">✏️</button>
    <button class="icon" title="Delete (hx-delete + hx-confirm)" hx-delete="${API}events/${e.id}" hx-target="closest tr"
            hx-swap="outerHTML swap:500ms" hx-confirm="Sweep “${e.title}” under the rug?">🗑️</button>
  </td>
</tr>`,
    editRow: (e, error, d = e) => h`
<tr id="event-${e.id}" class="editing">
  <td><select name="severity">${SEVERITIES.map((s) => h`<option value="${s}"${d.severity === s ? raw(" selected") : ""}>${SEV_EMOJI[s]}</option>`)}</select></td>
  <td><input name="title" value="${d.title}" autofocus hx-put="${API}events/${e.id}" hx-trigger="keyup[key=='Enter']"
             hx-include="closest tr" hx-target="closest tr" hx-swap="outerHTML">
      ${error ? h`<div class="error">${error}</div>` : ""}</td>
  <td><select name="category">${CATEGORIES.map((c) => h`<option${d.category === c ? raw(" selected") : ""}>${c}</option>`)}</select></td>
  <td colspan="2">${badge("click-to-edit")}</td>
  <td class="right nowrap">
    <button hx-put="${API}events/${e.id}" hx-include="closest tr" hx-target="closest tr" hx-swap="outerHTML">Save</button>
    <button class="secondary" hx-get="${API}events/${e.id}/row" hx-target="closest tr" hx-swap="outerHTML">Cancel</button>
  </td>
</tr>`,
    rows: (rows, nextBefore, f, isMore) => h`${rows.length ? rows.map((e) => T.row(e)) :
      (isMore ? "" : h`<tr class="empty"><td colspan="6">No chaos matches. Enjoy the silence. 🕊️</td></tr>`)}
${nextBefore ? h`<tr id="load-more" class="load-more" hx-get="${API}events?${raw(qs({ before: nextBefore, ...f }))}"
    hx-trigger="revealed" hx-swap="outerHTML" hx-target="this">
  <td colspan="6"><span class="spinner"></span> Loading more chaos… ${badge('hx-trigger="revealed"')}</td></tr>` : ""}`,
    stats: (s, oob) => h`
<section id="stats" class="card stats" hx-get="${API}stats" hx-trigger="every 2s" hx-swap="outerHTML"${oob ? raw(' hx-swap-oob="true"') : ""}>
  <h2>Chaos level ${badge("polling · every 2s", 'hx-trigger="every 2s" polling, also refreshed via hx-swap-oob')}</h2>
  <div class="meter" role="meter" aria-valuenow="${s.level}" aria-valuemin="0" aria-valuemax="100"><div class="meter-fill" style="width: ${s.level}%"></div></div>
  <p class="mood"><strong>${s.level}%</strong> · ${s.mood}</p>
  <div class="stat-grid">
    <div><b>${s.by_status.open}</b><span>open</span></div><div><b>${s.by_status.mitigating}</b><span>mitigating</span></div>
    <div><b>${s.by_status.resolved}</b><span>resolved</span></div><div><b>${s.total}</b><span>total</span></div>
  </div>
  <p class="sev-line">${SEVERITIES.map((v) => h`<span>${SEV_EMOJI[v]} ${s.by_sev[v]}</span>`)}<span class="muted">active by severity</span></p>
  <p class="muted small">Last poll ${s.now}${s.monkey ? " · 🐒 monkey is loose" : ""}</p>
</section>`,
    monkey: (on) => h`<button id="monkey-btn" class="monkey${on ? " on" : ""}" hx-post="${API}monkey" hx-swap="outerHTML" hx-target="this">${on ? "🛑 Cage the monkey" : "🐒 Unleash chaos monkey"}</button>`,
    ticker: (e) => h`<span class="ticker-item">${SEV_EMOJI[e.severity]} <b>#${e.id}</b> ${e.title} <span class="muted">(${e.category})</span></span>`,
    formErrors: (errs) => h`<ul class="errors">${errs.map((e) => h`<li>${e}</li>`)}</ul>`,
    detail: (e) => h`
<aside id="detail" class="detail open"><div class="detail-inner">
  <button class="icon close" title="Close (hx-get + hx-select + hx-push-url)" hx-get="${BASE}" hx-select="#detail" hx-target="#detail" hx-swap="outerHTML" hx-push-url="true">✖</button>
  <p class="muted small">Incident #${e.id} · URL pushed with <code>hx-push-url</code> — try Back / refresh</p>
  <h3>${SEV_EMOJI[e.severity]} ${e.title}</h3>
  <dl><dt>Severity</dt><dd>${e.severity}</dd><dt>Category</dt><dd>${e.category}</dd><dt>Status</dt><dd>${e.status}</dd>
      <dt>Logged</dt><dd>${new Date(e.created).toLocaleString()} (${ago(e.created)})</dd></dl>
  <p>${e.description || "No details. Pure, unexplained chaos."}</p>
</div></aside>`,
    layout: (active, content) => h`
<div class="pages-banner">🧪 <b>GitHub Pages edition:</b> there is no backend here. A tiny mock server in <code>app.js</code> runs <em>in your browser</em>,
  answering htmx's requests with HTML fragments + <code>HX-*</code> headers, so every htmx feature works on static hosting.
  The chaos-monkey "SSE" stream is emulated in-browser too. Data lives in localStorage.
  <button class="secondary tiny" onclick="ChaosApp.reset()">Reset demo data</button>
  <a href="https://github.com/CMoser965/htmx-chaos-tracker/tree/main/server">Real Flask server version →</a></div>
<header class="topbar" hx-boost="true">
  <a href="${BASE}" class="brand">🌀 Chaos Tracker</a>
  <nav><a href="${BASE}" class="${active === "index" ? "active" : ""}">Incidents</a>
       <a href="${BASE}?page=about" class="${active === "about" ? "active" : ""}">htmx features</a>
       ${badge("hx-boost", "Nav links use hx-boost: AJAX navigation with history, no full reload")}</nav>
  <div class="counter-wrap" title="Updated out-of-band (hx-swap-oob) by create/edit/delete responses">chaos events: ${T.counter(Object.keys(db.events).length)} ${badge("hx-swap-oob")}</div>
</header>
<main>${content}</main>
<div id="toasts" aria-live="polite"></div>
<footer>htmx 2.0.4 · All UI behaviour is <code>hx-*</code> attributes; the "server" is <code>app.js</code>.</footer>`,
    index: (rows, nextBefore, f, detail) => h`
<div hx-ext="sse" sse-connect="${API}stream">
<div class="grid">
  <section class="card">
    <h2>Log new chaos ${badge("hx-post · afterbegin", 'hx-post hx-target="#event-rows" hx-swap="afterbegin" + HX-Trigger "chaos-logged" resets the form')}</h2>
    <form id="new-event" hx-post="${API}events" hx-target="#event-rows" hx-swap="afterbegin" hx-disabled-elt="find button"
          hx-on:chaos-logged="this.reset(); this.querySelector('[name=title]').focus()">
      <input name="title" placeholder="What just broke?" autocomplete="off">
      <div class="row2">
        <select name="severity">${SEVERITIES.map((s) => h`<option value="${s}"${s === "medium" ? raw(" selected") : ""}>${SEV_EMOJI[s]} ${s}</option>`)}</select>
        <select name="category">${CATEGORIES.map((c) => h`<option>${c}</option>`)}</select>
      </div>
      <textarea name="description" rows="2" placeholder="Details (optional)"></textarea>
      <div id="form-errors"></div>
      <div class="actions">
        <button type="submit">💥 Log it</button>
        <button type="button" class="secondary" hx-post="${API}events/random" hx-target="#event-rows" hx-swap="afterbegin"
                hx-disabled-elt="this" title="hx-post + hx-disabled-elt">🎲 Random chaos</button>
      </div>
      <p class="hint">Submit an empty title to see <code>HX-Retarget</code>/<code>HX-Reswap</code> put errors here.</p>
    </form>
  </section>
  ${T.stats(stats())}
  <section class="card monkey-card">
    <h2>Chaos monkey ${badge("SSE (emulated)", "htmx SSE extension (sse-connect + sse-swap) fed by an in-browser fake EventSource")}</h2>
    <p>Unleash the monkey and it pushes new incidents through the htmx <b>SSE extension</b>. On Pages the event stream is emulated in your browser.</p>
    ${T.monkey(monkey.on)}
    <div id="ticker" class="ticker" sse-swap="ticker">Waiting for chaos…</div>
  </section>
</div>
<section class="card">
  <div class="list-head">
    <h2>Incident log</h2>
    <form id="filters" class="filters" onsubmit="return false">
      <input type="search" name="q" value="${f.q}" placeholder="🔎 Search chaos…" hx-get="${API}events"
             hx-trigger="input changed delay:300ms, search" hx-target="#event-rows" hx-swap="innerHTML"
             hx-include="#filters" hx-indicator="#search-spinner" hx-sync="this:replace">
      <select name="severity" hx-get="${API}events" hx-trigger="change" hx-target="#event-rows" hx-swap="innerHTML" hx-include="#filters" hx-indicator="#search-spinner">
        <option value="">any severity</option>${SEVERITIES.map((s) => h`<option value="${s}"${f.severity === s ? raw(" selected") : ""}>${s}</option>`)}</select>
      <select name="status" hx-get="${API}events" hx-trigger="change" hx-target="#event-rows" hx-swap="innerHTML" hx-include="#filters" hx-indicator="#search-spinner">
        <option value="">any status</option>${STATUSES.map((s) => h`<option value="${s}"${f.status === s ? raw(" selected") : ""}>${s}</option>`)}</select>
      <span id="search-spinner" class="htmx-indicator spinner" aria-hidden="true"></span>
      ${badge("active search · HX-Push-Url", 'hx-trigger="input changed delay:300ms" + hx-indicator + hx-sync; "server" sends HX-Push-Url so filters are bookmarkable')}
    </form>
  </div>
  <table class="events">
    <thead><tr><th>Sev</th><th>Incident</th><th>Category</th><th>Status</th><th>When</th><th class="right">Actions</th></tr></thead>
    <tbody id="event-rows" sse-swap="chaos" hx-swap="afterbegin">${T.rows(rows, nextBefore, f)}</tbody>
  </table>
  <p class="legend">${["hx-get → edit row", "hx-put save", "hx-patch status", "hx-delete + hx-confirm + swap:500ms fade",
    'hx-trigger="revealed" infinite scroll', "hx-push-url detail"].map((b) => badge(b))}</p>
</section>
</div>
${detail ? T.detail(detail) : h`<aside id="detail" class="detail"></aside>`}`,
    about: () => h`
<section class="card prose">
  <h2>What this demo shows</h2>
  <p>You got here via an <code>hx-boost</code>ed link: htmx fetched this page with AJAX, swapped the <code>&lt;body&gt;</code>,
     and pushed a history entry. Hit Back to see history restore.</p>
  <table class="features"><thead><tr><th>Feature</th><th>Where to see it</th><th>Attributes / headers</th></tr></thead><tbody>
  ${[
    ["AJAX form", "“Log new chaos” card", "hx-post, hx-target, hx-swap=\"afterbegin\", hx-disabled-elt"],
    ["Form reset via server event", "After logging", "HX-Trigger: chaos-logged + hx-on:chaos-logged"],
    ["Validation retargeting", "Submit an empty title", "HX-Retarget, HX-Reswap"],
    ["Active search", "Search box & filters", "hx-trigger=\"input changed delay:300ms, search\", hx-include, hx-indicator, hx-sync"],
    ["Bookmarkable filters", "Address bar while filtering", "HX-Push-Url response header"],
    ["Click-to-edit", "✏️ on a row (Enter or Save)", "hx-get, hx-put, hx-include=\"closest tr\", keyup[key=='Enter']"],
    ["Status workflow", "Status pill", "hx-patch, hx-target=\"closest tr\""],
    ["Delete with confirm & fade", "🗑️ on a row", "hx-delete, hx-confirm, hx-swap=\"outerHTML swap:500ms\""],
    ["Polling", "Chaos level card", "hx-trigger=\"every 2s\""],
    ["Out-of-band swaps", "Header counter, stats card", "hx-swap-oob"],
    ["Toasts", "Bottom-right", "HX-Trigger: {\"showToast\": …}"],
    ["Infinite scroll", "Bottom of incident log", "hx-trigger=\"revealed\""],
    ["Detail drawer with history", "Click an incident title", "hx-push-url, hx-select"],
    ["Live push", "Chaos monkey", "SSE extension: hx-ext=\"sse\", sse-connect, sse-swap (emulated EventSource here)"],
    ["Boosted navigation", "Top nav", "hx-boost"],
  ].map(([a, b, c]) => h`<tr><td>${a}</td><td>${b}</td><td><code>${c}</code></td></tr>`)}
  </tbody></table>
  <p class="muted">Current total: ${Object.keys(db.events).length} events.</p>
</section>`,
  };

  // ------------------------------------------------------------------ the in-browser "server"
  const toast = (headers, message, level = "info", extra = {}) =>
    (headers["HX-Trigger"] = JSON.stringify({ showToast: { message, level }, ...extra }));
  const oob = () => `${T.counter(Object.keys(db.events).length, true)}${T.stats(stats(), true)}<div id="form-errors" hx-swap-oob="innerHTML"></div>`;
  const ok = (body, headers = {}, status = 200) => ({ status, headers, body: String(body) });
  const notFound = () => ok("<p>Not found</p>", {}, 404);

  function fullPage(params) {
    const pageName = params.get("page");
    let body, title = "Chaos Tracker · htmx demo";
    if (pageName === "about") { body = T.layout("about", T.about()); title = "htmx features · htmx demo"; }
    else {
      const f = { q: params.get("q") || "", severity: params.get("severity") || "", status: params.get("status") || "" };
      const [rows, nb] = page(f);
      const detail = db.events[params.get("event")];
      body = T.layout("index", T.index(rows, nb, f, detail));
    }
    return { title, body: String(body) };
  }

  function handle(method, url, form, headers) {
    const path = url.pathname;
    const p = url.searchParams;
    if (path === BASE || path === BASE + "index.html") {
      const { title, body } = fullPage(p);
      return ok(`<!doctype html><html><head><title>${esc(title)}</title></head><body>${body}</body></html>`);
    }
    if (!path.startsWith(API)) return null; // not ours -> real network
    const route = path.slice(API.length);
    const H = {};
    let m;
    if (route === "events" && method === "GET") {
      const f = { q: p.get("q") || "", severity: p.get("severity") || "", status: p.get("status") || "" };
      const before = Number(p.get("before")) || null;
      const [rows, nb] = page(f, before);
      if (!before) H["HX-Push-Url"] = BASE + (qs(f) ? "?" + qs(f) : "");
      return ok(T.rows(rows, nb, f, !!before), H);
    }
    if (route === "events" && method === "POST") {
      const title = (form.get("title") || "").trim(), severity = form.get("severity") || "medium", category = form.get("category") || "code";
      const errors = [];
      if (title.length < 3) errors.push("Give the chaos a title (3+ characters). Chaos deserves a name.");
      if (!SEVERITIES.includes(severity)) errors.push("Unknown severity.");
      if (!CATEGORIES.includes(category)) errors.push("Unknown category.");
      if (errors.length) return ok(T.formErrors(errors), { "HX-Retarget": "#form-errors", "HX-Reswap": "innerHTML" });
      const ev = add(title, category, severity, "open", (form.get("description") || "").trim());
      toast(H, `${SEV_EMOJI[severity]} Logged: ${title}`, "success", { "chaos-logged": true });
      return ok(T.row(ev, true) + oob(), H);
    }
    if (route === "events/random" && method === "POST") {
      const ev = monkeyEvent();
      toast(H, `🐒 Random chaos: ${ev.title}`, "warn");
      return ok(T.row(ev, true) + oob(), H);
    }
    if ((m = route.match(/^events\/(\d+)(\/(row|edit|status))?$/))) {
      const ev = db.events[m[1]];
      if (!ev) return notFound();
      const sub = m[3];
      if (!sub && method === "GET") return ok(T.detail(ev));
      if (sub === "row") return ok(T.row(ev));
      if (sub === "edit") return ok(T.editRow(ev));
      if (!sub && method === "PUT") {
        const title = (form.get("title") || "").trim();
        if (title.length < 3) return ok(T.editRow(ev, "Title needs 3+ characters",
          { title, severity: form.get("severity"), category: form.get("category") }));
        ev.title = title;
        if (SEVERITIES.includes(form.get("severity"))) ev.severity = form.get("severity");
        if (CATEGORIES.includes(form.get("category"))) ev.category = form.get("category");
        save();
        toast(H, `✏️ Updated #${ev.id}`, "info");
        return ok(T.row(ev, true) + oob(), H);
      }
      if (sub === "status" && method === "PATCH") {
        ev.status = STATUSES.includes(form.get("status")) ? form.get("status") : NEXT_STATUS[ev.status];
        save();
        const msg = { open: "😱 Re-opened", mitigating: "🧯 Mitigating", resolved: "✅ Resolved" }[ev.status];
        toast(H, `${msg}: ${ev.title}`, ev.status === "resolved" ? "success" : "info");
        return ok(T.row(ev, true) + oob(), H);
      }
      if (!sub && method === "DELETE") {
        delete db.events[ev.id]; save();
        toast(H, `🗑️ Swept under the rug: ${ev.title}`, "warn");
        return ok(oob(), H); // empty main content removes the row; OOB updates counters
      }
    }
    if (route === "stats") return ok(`${T.stats(stats())}${T.counter(Object.keys(db.events).length, true)}`); // OOB keeps header in sync with SSE inserts
    if (route === "monkey" && method === "POST") {
      monkey.on = !monkey.on;
      toast(H, monkey.on ? "🐒 Chaos monkey UNLEASHED" : "🐒 Chaos monkey back in its cage", monkey.on ? "warn" : "info");
      return ok(T.monkey(monkey.on), H);
    }
    return notFound();
  }

  // ------------------------------------------------------------------ MockXHR (what htmx talks to)
  const RealXHR = window.XMLHttpRequest;
  const latency = (url) => /api\/events$/.test(url.pathname) && url.searchParams.has("q") ? 280
    : url.searchParams.has("before") ? 400 : 90;
  class MockXHR {
    constructor() {
      this.readyState = 0; this.status = 0; this.statusText = ""; this.response = ""; this.responseText = "";
      this.responseURL = ""; this.timeout = 0; this.withCredentials = false;
      this._l = {}; this._req = {}; this._res = {};
      this.upload = { addEventListener() {}, removeEventListener() {} };
    }
    open(method, url) { this._method = method.toUpperCase(); this._url = new URL(url, location.href); this.readyState = 1; }
    setRequestHeader(k, v) { this._req[k.toLowerCase()] = v; }
    overrideMimeType() {}
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
    removeEventListener(t, fn) { this._l[t] = (this._l[t] || []).filter((f) => f !== fn); }
    _fire(t) { const ev = { type: t, target: this, lengthComputable: false, loaded: 0, total: 0 };
      (this._l[t] || []).forEach((f) => f.call(this, ev)); if (typeof this["on" + t] === "function") this["on" + t](ev); }
    getResponseHeader(n) { const k = Object.keys(this._res).find((x) => x.toLowerCase() === n.toLowerCase()); return k ? this._res[k] : null; }
    getAllResponseHeaders() { return Object.entries(this._res).map(([k, v]) => `${k.toLowerCase()}: ${v}\r\n`).join(""); }
    abort() { this._aborted = true; this.readyState = 4; this._fire("abort"); this._fire("loadend"); }
    send(body) {
      let form;
      if (body instanceof FormData) { form = new URLSearchParams(); for (const [k, v] of body) form.append(k, v); }
      else form = new URLSearchParams(typeof body === "string" ? body : "");
      // htmx puts GET/DELETE params into the query string; merge them for convenience
      for (const [k, v] of this._url.searchParams) if (!form.has(k)) form.append(k, v);
      const result = handle(this._method, this._url, form, this._req);
      this._fire("loadstart");
      if (!result) return this._network(body);
      setTimeout(() => {
        if (this._aborted) return;
        this.status = result.status; this.statusText = result.status === 200 ? "OK" : "Not Found";
        this._res = { "Content-Type": "text/html; charset=utf-8", ...result.headers };
        this.response = this.responseText = result.body; this.responseURL = this._url.href; this.readyState = 4;
        this._fire("load"); this._fire("loadend");
      }, latency(this._url));
    }
    _network(body) { // anything that isn't part of the mock goes to the real network
      fetch(this._url, { method: this._method, headers: this._req, body: ["GET", "HEAD"].includes(this._method) ? undefined : body })
        .then(async (r) => {
          this.status = r.status; this._res = Object.fromEntries(r.headers.entries());
          this.response = this.responseText = await r.text(); this.responseURL = r.url; this.readyState = 4;
          this._fire("load"); this._fire("loadend");
        }).catch(() => { this.readyState = 4; this._fire("error"); this._fire("loadend"); });
    }
  }
  window.XMLHttpRequest = MockXHR;

  // ------------------------------------------------------------------ fake EventSource for the SSE extension
  const sources = new Set();
  class FakeEventSource {
    constructor(url) {
      this.url = url; this.readyState = 0; this._l = {}; this.onopen = null; this.onerror = null; this.onmessage = null;
      sources.add(this);
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({ type: "open" }); }, 50);
    }
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
    removeEventListener(t, fn) { this._l[t] = (this._l[t] || []).filter((f) => f !== fn); }
    close() { this.readyState = 2; sources.delete(this); }
    _emit(type, data) { const ev = new MessageEvent(type, { data });
      (this._l[type] || []).forEach((f) => f(ev)); if (type === "message" && this.onmessage) this.onmessage(ev); }
  }
  htmx.createEventSource = (url) => new FakeEventSource(url);
  const broadcast = (type, data) => sources.forEach((s) => s.readyState === 1 && s._emit(type, String(data)));

  function monkeyEvent() {
    const r = Math.random() * 11;
    const sev = r < 3 ? "low" : r < 7 ? "medium" : r < 10 ? "high" : "critical";
    return add(MONKEY_TITLES[Math.floor(Math.random() * MONKEY_TITLES.length)],
      CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)], sev, "open", "Generated by the chaos monkey 🐒");
  }
  (function monkeyLoop() {
    setTimeout(() => {
      if (monkey.on) { const ev = monkeyEvent(); broadcast("chaos", T.row(ev, true)); broadcast("ticker", T.ticker(ev)); }
      monkeyLoop();
    }, 2500 + Math.random() * 2000);
  })();

  // ------------------------------------------------------------------ boot
  load();
  window.ChaosApp = {
    BASE,
    boot() {
      const root = document.getElementById("root");
      if (!root) return; // already booted (e.g. htmx re-running inline scripts)
      const { title, body } = fullPage(new URLSearchParams(location.search));
      document.title = title;
      root.outerHTML = body;
    },
    reset() { localStorage.removeItem(KEY); try { localStorage.removeItem("htmx-history-cache"); } catch (e) {} location.href = BASE; },
  };
})();
