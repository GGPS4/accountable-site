/* Accountable dashboard. Reads/writes data/*.json in your repo through the GitHub API. */
(() => {
  "use strict";

  // ------------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const DAY_NAMES = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  const OUTCOMES = ["saved", "debt", "lost"];
  const LABEL = { saved: "Success", lost: "Failed", debt: "Debt", none: "Error" };
  const VENMO_LABEL = { pending: "Pending", settled: "Paid", cancelled: "Declined", expired: "Expired", failed: "Failed", error: "Not sent", queued: "Queued" };
  const ICON = {
    saved: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.2 2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    lost: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    debt: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 3.8V6l1.5 1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    none: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 3v3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="6" cy="9" r="1" fill="currentColor"/></svg>',
  };

  const store = {
    get(k, d = null) { try { const v = localStorage.getItem("acc." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("acc." + k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem("acc." + k); } catch { /* ignore */ } },
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n, cents = null) => {
    const v = Number(n) || 0;
    const showCents = cents ?? (Math.round(v * 100) % 100 !== 0);
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: showCents ? 2 : 0, maximumFractionDigits: showCents ? 2 : 0 });
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  // ------------------------------------------------------------------ time zones
  function tz() { return state.config?.settings?.timezone || "America/New_York"; }
  function parts(date, zone = tz()) {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    const o = {};
    for (const p of f.formatToParts(date)) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, wd: o.weekday.toLowerCase().slice(0, 3) };
  }
  function zonedToUtc(y, m, d, hh, mm, zone = tz()) {
    let guess = Date.UTC(y, m - 1, d, hh, mm);
    for (let i = 0; i < 2; i++) {
      const p = parts(new Date(guess), zone);
      const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
      guess += Date.UTC(y, m - 1, d, hh, mm) - asUtc;
    }
    return new Date(guess);
  }
  const fmt = (date, opts) => new Intl.DateTimeFormat("en-US", { timeZone: tz(), ...opts }).format(date);
  const fmtTime = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
  function ago(date) {
    const s = Math.max(0, (Date.now() - date) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  function until(date) {
    const s = Math.max(0, (date - Date.now()) / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `in ${d}d ${h}h`;
    if (h) return `in ${h}h ${m}m`;
    return m ? `in ${m}m` : "due now";
  }

  // ------------------------------------------------------------------ state
  const state = {
    creds: store.get("creds", null),
    config: null, configSha: null,
    log: { entries: [], meta: {} },
    demo: false,
    range: store.get("range", "all"),
    filter: "all",
    showTest: null,
    historyLimit: 15,
    activityLimit: 20,
    firstPaint: true,
    editing: null,
  };

  // ------------------------------------------------------------------ GitHub API
  async function gh(path, opts = {}) {
    const { owner, repo, token } = state.creds;
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      ...opts,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
      cache: "no-store",
    });
    if (!res.ok) {
      const msg = res.status === 401 ? "GitHub rejected the token. Check it in settings."
        : res.status === 404 ? "Repo or file not found. Check the owner, repo name and token access."
        : res.status === 409 ? "conflict"
        : `GitHub error ${res.status}`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

  async function readFile(path) {
    const meta = await gh(`/contents/${path}`);
    let text;
    if (meta.content) text = unb64(meta.content);
    else text = await (await fetch(meta.download_url, { cache: "no-store" })).text(); // files over 1 MB
    return { data: JSON.parse(text), sha: meta.sha };
  }
  async function saveConfig(message) {
    if (state.demo) { toast("Preview only. Connect GitHub to save."); return true; }
    const body = (sha) => JSON.stringify({ message, sha, content: b64(JSON.stringify(state.config, null, 2) + "\n") });
    setSync("Saving…");
    try {
      const r = await gh(`/contents/data/schedules.json`, { method: "PUT", body: body(state.configSha) });
      state.configSha = r.content.sha;
    } catch (e) {
      if (e.status !== 409) { setSync(""); throw e; }
      const fresh = await readFile("data/schedules.json"); // someone else changed it: retry on top
      const r = await gh(`/contents/data/schedules.json`, { method: "PUT", body: body(fresh.sha) });
      state.configSha = r.content.sha;
    }
    setSync("Saved");
    setTimeout(() => setSync(`Updated ${fmt(new Date(), { hour: "numeric", minute: "2-digit" })}`), 2500);
    return true;
  }

  async function load({ quiet = false } = {}) {
    if (!state.creds?.token) return showConnect();
    if (!quiet) setSync("Loading…");
    try {
      const [cfg, log] = await Promise.all([readFile("data/schedules.json"), readFile("data/log.json")]);
      state.config = cfg.data; state.configSha = cfg.sha;
      state.log = log.data;
      state.demo = false;
      setSync(`Updated ${fmt(new Date(), { hour: "numeric", minute: "2-digit" })}`);
      showDashboard();
    } catch (e) {
      setSync("");
      if (!quiet) { toast(e.message, true); showConnect(); }
    }
  }

  // ------------------------------------------------------------------ derived data
  function visibleEntries() {
    const showTest = state.showTest ?? true;
    const entries = (state.log.entries || []).filter((e) => showTest || !e.test);
    if (state.range === "all") return entries;
    const cutoff = Date.now() - Number(state.range) * 86400000;
    return entries.filter((e) => new Date(e.scheduled_for) >= cutoff);
  }
  function totals(entries) {
    const t = { saved: 0, lost: 0, debt: 0, n: { saved: 0, lost: 0, debt: 0 } };
    for (const e of entries) if (t[e.outcome] !== undefined) { t[e.outcome] += e.amount; t.n[e.outcome]++; }
    return t;
  }
  const byTime = (a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for);

  function nextCharge() {
    const now = new Date();
    const taken = new Set((state.log.entries || []).map((e) => e.key));
    let best = null;
    for (const s of state.config?.schedules || []) {
      if (!s.active || !s.days?.length) continue;
      const [hh, mm] = s.time.split(":").map(Number);
      const today = parts(now);
      for (let i = 0; i < 8; i++) {
        const base = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
        const dayKey = DAYS[(base.getUTCDay() + 6) % 7];
        if (!s.days.includes(dayKey)) continue;
        const when = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm);
        const key = `${s.id}:${base.toISOString().slice(0, 10)}`;
        if (when <= now || taken.has(key)) continue;
        if (!best || when < best.when) best = { when, s };
        break;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ render
  function render() {
    const entries = visibleEntries();
    const t = totals(entries);
    renderHero(entries, t);
    renderPulse(entries);
    renderTrend(entries);
    renderTasks(entries);
    renderCalendar();
    renderHistory();
    renderActivity();
    $("#testBanner").hidden = !state.config?.settings?.test_mode;
    state.firstPaint = false;
  }

  function renderHero(entries, t) {
    const total = t.saved + t.lost + t.debt;
    const count = t.n.saved + t.n.lost + t.n.debt;
    const span = state.range === "all" ? "" : ` in the last ${state.range} days`;
    $("#heroTitle").textContent = count
      ? `${money(total)} on the line across ${plural(count, "check-in")}${span}.`
      : state.range === "all" ? "No check-ins yet. Your first charge will show up here." : `No check-ins${span}.`;

    const ledger = $("#ledger");
    ledger.classList.toggle("empty", !total);
    ledger.classList.toggle("intro", state.firstPaint);
    ledger.innerHTML = total ? OUTCOMES.filter((k) => t[k] > 0).map((k) => {
      const pct = (t[k] / total) * 100;
      return `<div class="seg-fill ${k}" style="flex-grow:${t[k]}" data-k="${k}">${pct >= 12 ? `<span>${Math.round(pct)}%</span>` : ""}</div>`;
    }).join("") : "";
    ledger.setAttribute("aria-label", total ? `Saved ${money(t.saved)}, debt ${money(t.debt)}, lost ${money(t.lost)}` : "No data yet");
    $$(".seg-fill", ledger).forEach((el) => {
      const k = el.dataset.k;
      bindTip(el, () => `<b>${{ saved: "Money saved", debt: "Debt", lost: "Money lost" }[k]}</b><div class="tr"><span>${plural(t.n[k], "check-in")}</span>${money(t[k], true)}</div><div class="tr"><span>Share</span>${Math.round((t[k] / total) * 100)}%</div>`);
    });

    $("#vSaved").textContent = money(t.saved);
    $("#vLost").textContent = money(t.lost);
    $("#vDebt").textContent = money(t.debt);
    $("#sSaved").textContent = `${plural(t.n.saved, "request")} declined, task done`;
    $("#sLost").textContent = `${plural(t.n.lost, "request")} paid, task missed`;
    $("#sDebt").textContent = t.n.debt ? `${plural(t.n.debt, "request")} still open` : "Nothing outstanding";
    $$("#range button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.range === state.range)));
  }

  function renderPulse(entries) {
    const resolved = entries.filter((e) => e.outcome === "saved" || e.outcome === "lost").sort(byTime);
    let streak = 0;
    for (let i = resolved.length - 1; i >= 0 && resolved[i].outcome === "saved"; i--) streak++;
    let best = 0, run = 0;
    for (const e of resolved) { run = e.outcome === "saved" ? run + 1 : 0; best = Math.max(best, run); }
    $("#streak").textContent = streak;
    $("#streakUnit").textContent = streak === 1 ? "task in a row" : "tasks in a row";
    $("#streakSub").textContent = resolved.length ? `Best run: ${best}` : "Starts with the first declined request";
    const last = entries.filter((e) => OUTCOMES.includes(e.outcome)).sort(byTime).slice(-21);
    $("#streakDots").innerHTML = last.map((e) => `<i class="${e.outcome}"></i>`).join("");

    const rate = resolved.length ? Math.round((resolved.filter((e) => e.outcome === "saved").length / resolved.length) * 100) : 0;
    $("#rate").textContent = rate;
    $("#rateSub").textContent = resolved.length ? `${resolved.filter((e) => e.outcome === "saved").length} of ${plural(resolved.length, "resolved task")}` : "No resolved tasks yet";
    updateNext();
  }
  function updateNext() {
    const n = nextCharge();
    $("#nextIn").textContent = n ? until(n.when) : "None scheduled";
    $("#nextWhat").textContent = n
      ? `${n.s.task}, ${money(n.s.amount, true)} on ${fmt(n.when, { weekday: "short" })} at ${fmt(n.when, { hour: "numeric", minute: "2-digit" })}`
      : "Add a charge to the weekly schedule";
  }

  // weekly stacked bars
  function weekStart(date) {
    const p = parts(date);
    const local = new Date(Date.UTC(p.y, p.m - 1, p.d));
    local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
    return local.toISOString().slice(0, 10);
  }
  function renderTrend(entries) {
    const box = $("#trend");
    const weeksWanted = state.range === "30" ? 5 : state.range === "90" ? 13 : 12;
    const nowWeek = weekStart(new Date());
    const weeks = [];
    for (let i = weeksWanted - 1; i >= 0; i--) {
      const d = new Date(nowWeek + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 7 * i);
      weeks.push({ key: d.toISOString().slice(0, 10), date: d, saved: 0, debt: 0, lost: 0, n: { saved: 0, debt: 0, lost: 0 } });
    }
    const idx = Object.fromEntries(weeks.map((w, i) => [w.key, i]));
    for (const e of entries) {
      const i = idx[weekStart(new Date(e.scheduled_for))];
      if (i === undefined || !OUTCOMES.includes(e.outcome)) continue;
      weeks[i][e.outcome] += e.amount; weeks[i].n[e.outcome]++;
    }
    const W = Math.max(280, box.clientWidth), H = box.clientHeight || 240;
    const padL = 40, padB = 26, padT = 8, padR = 4;
    const max = Math.max(1, ...weeks.map((w) => w.saved + w.debt + w.lost));
    const step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const colW = (W - padL - padR) / weeks.length;
    const barW = Math.min(30, colW * 0.56);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly saved, debt and lost amounts"><g class="grid axis">`;
    for (let v = 0; v <= top + 1e-9; v += step) {
      svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${money(v)}</text>`;
    }
    svg += `</g><g class="axis">`;
    const every = colW < 34 ? 3 : colW < 52 ? 2 : 1;
    weeks.forEach((w, i) => {
      if ((weeks.length - 1 - i) % every) return;
      svg += `<text x="${padL + colW * i + colW / 2}" y="${H - 6}" text-anchor="middle">${fmtUTC(w.date)}</text>`;
    });
    svg += `</g>`;
    weeks.forEach((w, i) => {
      const cx = padL + colW * i + colW / 2, x = cx - barW / 2;
      let acc = 0, segs = "";
      const present = OUTCOMES.filter((k) => w[k] > 0);
      present.forEach((k, j) => {
        const y0 = y(acc), y1 = y(acc + w[k]);
        const gap = j > 0 ? 2 : 0;
        const h = Math.max(0, y0 - y1 - gap);
        segs += j === present.length - 1
          ? `<path class="f-${k}" d="${roundTop(x, y1, barW, h, 4)}"/>`
          : `<rect class="f-${k}" x="${x}" y="${y1}" width="${barW}" height="${h}"/>`;
        acc += w[k];
      });
      svg += `<g class="bar-col" data-i="${i}"><rect class="bar-bg" x="${padL + colW * i + 2}" y="${padT}" width="${colW - 4}" height="${H - padT - padB}" rx="6"/>${segs}<rect class="bar-hit" x="${padL + colW * i}" y="0" width="${colW}" height="${H}"/></g>`;
    });
    svg += `</svg>`;
    box.innerHTML = svg;
    $$(".bar-col", box).forEach((g) => {
      const w = weeks[+g.dataset.i];
      bindTip(g, () => {
        const end = new Date(w.date); end.setUTCDate(end.getUTCDate() + 6);
        const rows = OUTCOMES.map((k) => `<div class="tr"><span><i class="k ${k}"></i>${{ saved: "Saved", debt: "Debt", lost: "Lost" }[k]}</span>${money(w[k], true)}</div>`).join("");
        return `<b>${fmtUTC(w.date)} to ${fmtUTC(end)}</b>${rows}`;
      });
    });
  }
  const fmtUTC = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function roundTop(x, y, w, h, r) {
    r = Math.min(r, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function renderTasks(entries) {
    const groups = new Map();
    for (const e of entries.slice().sort(byTime)) {
      if (!OUTCOMES.includes(e.outcome)) continue;
      const g = groups.get(e.schedule_id) || { name: e.task, saved: 0, lost: 0, debt: 0, n: { saved: 0, lost: 0, debt: 0 } };
      g.name = e.task; g[e.outcome] += e.amount; g.n[e.outcome]++;
      groups.set(e.schedule_id, g);
    }
    const list = [...groups.values()].sort((a, b) => (b.saved + b.lost + b.debt) - (a.saved + a.lost + a.debt));
    $("#tasks").innerHTML = list.length ? list.map((g) => {
      const resolved = g.n.saved + g.n.lost;
      const rate = resolved ? Math.round((g.n.saved / resolved) * 100) : null;
      const segs = OUTCOMES.filter((k) => g[k] > 0).map((k) => `<i class="${k}" style="flex-grow:${g[k]}"></i>`).join("");
      const count = g.n.saved + g.n.lost + g.n.debt;
      return `<div class="task-row">
        <div class="task-name" title="${esc(g.name)}">${esc(g.name)}</div>
        <div class="task-rate">${rate === null ? "–" : rate + "%"}<small>done</small></div>
        <div class="mini" role="img" aria-label="Saved ${money(g.saved)}, debt ${money(g.debt)}, lost ${money(g.lost)}">${segs}</div>
        <div class="task-meta">${money(g.saved)} saved, ${money(g.lost)} lost${g.debt ? `, ${money(g.debt)} owed` : ""} over ${plural(count, "check-in")}</div>
      </div>`;
    }).join("") : `<p class="empty">Each task's success rate shows up after its first check-in.</p>`;
  }

  function renderCalendar() {
    const sch = state.config?.schedules || [];
    const today = parts(new Date());
    const nowMin = today.hh * 60 + today.mm;
    const perWeek = sch.filter((s) => s.active).reduce((a, s) => a + (s.days?.length || 0), 0);
    const weekly = sch.filter((s) => s.active).reduce((a, s) => a + (s.days?.length || 0) * s.amount, 0);
    $("#calSub").textContent = sch.length
      ? `${plural(perWeek, "check-in")} a week, up to ${money(weekly, true)} at stake. Times are ${tz().replace(/_/g, " ")}.`
      : "Add the first charge to start the schedule.";
    $("#calendar").innerHTML = DAYS.map((d) => {
      const items = sch.filter((s) => s.days?.includes(d)).sort((a, b) => a.time.localeCompare(b.time));
      const isToday = d === today.wd;
      return `<div class="cal-day${isToday ? " today" : ""}">
        <div class="cal-dname">${DAY_NAMES[d]}${isToday ? "<em>Today</em>" : ""}</div>
        ${items.map((s) => {
          const [h, m] = s.time.split(":").map(Number);
          const past = isToday && h * 60 + m < nowMin;
          return `<button class="chip${s.active ? "" : " off"}${past ? " past" : ""}" data-id="${esc(s.id)}">
            <div class="t">${fmtTime(s.time)}${s.active ? "" : ", paused"}</div>
            <div class="n">${esc(s.task)}</div>
            <div class="a">${money(s.amount, true)}</div>
          </button>`;
        }).join("")}
        <button class="add-slot" data-day="${d}" aria-label="Add a charge on ${DAY_NAMES[d]}">+ Add</button>
      </div>`;
    }).join("");
    $$("#calendar .chip").forEach((b) => b.addEventListener("click", () => openCharge(sch.find((s) => s.id === b.dataset.id))));
    $$("#calendar .add-slot").forEach((b) => b.addEventListener("click", () => openCharge(null, b.dataset.day)));
  }

  function renderHistory() {
    const showTest = state.showTest ?? true;
    let rows = (state.log.entries || []).filter((e) => showTest || !e.test).slice().sort(byTime).reverse();
    if (state.filter !== "all") rows = rows.filter((e) => e.outcome === state.filter);
    const shown = rows.slice(0, state.historyLimit);
    $("#historyBody").innerHTML = shown.map((e) => {
      const when = new Date(e.scheduled_for);
      const vs = VENMO_LABEL[e.status] || e.status;
      const vsub = e.status === "pending" && e.last_checked ? `, checked ${ago(new Date(e.last_checked))}` : "";
      const oc = OUTCOMES.includes(e.outcome) ? e.outcome : "none";
      return `<tr class="main" tabindex="0" aria-expanded="false" data-id="${esc(e.id)}">
        <td>${fmt(when, { weekday: "short", month: "short", day: "numeric" })}<div class="when-sub">${fmt(when, { hour: "numeric", minute: "2-digit" })}</div></td>
        <td class="task">${esc(e.task)}${e.test ? '<span class="test-tag">Test</span>' : ""}</td>
        <td class="num">${money(e.amount, true)}</td>
        <td><span class="pill ${oc}">${ICON[oc]}${LABEL[oc]}</span></td>
        <td class="vstat">${esc(vs)}${vsub}</td>
        <td><span class="caret" aria-hidden="true">›</span></td>
      </tr>`;
    }).join("");
    const empty = $("#historyEmpty");
    empty.hidden = rows.length > 0;
    empty.textContent = state.filter === "all" ? "No requests yet. They appear here as soon as the first one is sent." : `No ${LABEL[state.filter].toLowerCase()} entries.`;
    let more = $("#historyMore");
    if (rows.length > shown.length) {
      if (!more) {
        more = document.createElement("button"); more.id = "historyMore"; more.className = "btn ghost more";
        more.addEventListener("click", () => { state.historyLimit += 40; renderHistory(); });
        $(".table-wrap").after(more);
      }
      more.textContent = `Show ${Math.min(40, rows.length - shown.length)} more`;
      more.hidden = false;
    } else if (more) more.hidden = true;

    $$("#historyBody tr.main").forEach((tr) => {
      const toggle = () => {
        const open = tr.getAttribute("aria-expanded") === "true";
        tr.setAttribute("aria-expanded", String(!open));
        if (open) { tr.nextElementSibling?.classList.contains("detail") && tr.nextElementSibling.remove(); return; }
        const e = state.log.entries.find((x) => x.id === tr.dataset.id);
        const d = document.createElement("tr"); d.className = "detail";
        d.innerHTML = `<td colspan="6"><ol class="events">${(e.events || []).map((ev) => `<li><time>${fmt(new Date(ev.at), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time><span>${esc(ev.message)}</span></li>`).join("") || "<li><span>No messages yet.</span></li>"}
          ${e.recipient ? `<li><time>Recipient</time><span>@${esc(e.recipient)}</span></li>` : ""}
          ${e.payment_id ? `<li><time>Venmo ID</time><span>${esc(e.payment_id)}</span></li>` : ""}</ol></td>`;
        tr.after(d);
      };
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
    });
  }

  function renderActivity() {
    const showTest = state.showTest ?? true;
    const events = [];
    for (const e of state.log.entries || []) {
      if (!showTest && e.test) continue;
      for (const ev of e.events || []) events.push({ ...ev, task: e.task, test: e.test });
    }
    events.sort((a, b) => new Date(b.at) - new Date(a.at));
    $("#activity").innerHTML = events.slice(0, state.activityLimit).map((ev) => `
      <li><span class="dot ${esc(ev.type)}"></span>
        <span class="msg"><b>${esc(ev.task)}</b>. ${esc(ev.message)}</span>
        <time datetime="${esc(ev.at)}" title="${fmt(new Date(ev.at), { dateStyle: "medium", timeStyle: "short" })}">${fmt(new Date(ev.at), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
      </li>`).join("") || `<li><span></span><span class="msg" style="color:var(--ink-3)">Nothing has happened yet.</span><span></span></li>`;
    $("#moreActivity").hidden = events.length <= state.activityLimit;
  }

  // ------------------------------------------------------------------ tooltip
  const tip = $("#tooltip");
  function bindTip(el, html) {
    el.addEventListener("pointerenter", (e) => { if (e.pointerType === "touch") return; tip.innerHTML = html(); tip.hidden = false; moveTip(e); el.classList.add("on"); });
    el.addEventListener("pointermove", moveTip);
    el.addEventListener("pointerleave", () => { tip.hidden = true; el.classList.remove("on"); });
    el.addEventListener("click", (e) => { if (e.pointerType !== "touch" && e.pointerType !== "") return; tip.innerHTML = html(); tip.hidden = false; moveTip(e); setTimeout(() => (tip.hidden = true), 2400); });
  }
  function moveTip(e) {
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
  }

  // ------------------------------------------------------------------ toasts / sync label
  function toast(msg, err = false) {
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : ""); t.textContent = msg;
    $("#toasts").append(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 220); }, err ? 5200 : 2600);
  }
  function setSync(text) { const s = $("#sync"); s.textContent = text; s.hidden = !text; }

  // ------------------------------------------------------------------ charge editor
  const chargeDlg = $("#chargeDialog"), chargeForm = $("#chargeForm");
  $("#dayPicker").innerHTML = DAYS.map((d) => `<label><input type="checkbox" name="days" value="${d}"><span>${DAY_NAMES[d].slice(0, 2)}</span></label>`).join("");
  function updatePerWeek() {
    const n = $$("#dayPicker input:checked").length;
    $("#perWeek").textContent = n === 7 ? "Every day" : n ? `${n} time${n === 1 ? "" : "s"} a week` : "Pick at least one day";
  }
  $("#dayPicker").addEventListener("change", updatePerWeek);

  function openCharge(s, presetDay) {
    state.editing = s || null;
    chargeForm.reset();
    $("#chargeTitle").textContent = s ? "Edit charge" : "New charge";
    $("#deleteCharge").hidden = !s;
    $("#saveCharge").textContent = s ? "Save changes" : "Add charge";
    const f = chargeForm.elements;
    f.task.value = s?.task || "";
    f.note.value = s?.note || "";
    f.amount.value = s ? Number(s.amount).toFixed(2) : "";
    f.time.value = s?.time || "09:00";
    f.recipient.value = s?.recipient || "";
    f.recipient.placeholder = state.config?.settings?.default_recipient ? `Default: ${state.config.settings.default_recipient}` : "Set a default in settings";
    f.active.checked = s ? s.active !== false : true;
    const days = s?.days || (presetDay ? [presetDay] : ["mon", "wed", "fri"]);
    $$("#dayPicker input").forEach((i) => (i.checked = days.includes(i.value)));
    updatePerWeek();
    chargeDlg.showModal();
  }
  chargeDlg.addEventListener("close", async () => {
    if (chargeDlg.returnValue !== "save") return;
    const f = chargeForm.elements;
    const days = $$("#dayPicker input:checked").map((i) => i.value);
    if (!days.length) { toast("Pick at least one day.", true); return openCharge(state.editing); }
    const data = {
      task: f.task.value.trim(),
      note: f.note.value.trim() || `Accountable: ${f.task.value.trim()}`,
      amount: Math.round(parseFloat(f.amount.value) * 100) / 100,
      time: f.time.value,
      days: DAYS.filter((d) => days.includes(d)),
      recipient: f.recipient.value.trim().replace(/^@/, ""),
      active: f.active.checked,
    };
    const list = state.config.schedules;
    if (state.editing) Object.assign(state.editing, data);
    else list.push({ id: slug(data.task), ...data });
    render();
    try {
      await saveConfig(`${state.editing ? "Update" : "Add"} charge: ${data.task}`);
      toast(state.editing ? "Charge updated" : "Charge added");
    } catch (e) { toast(e.message, true); }
  });
  $("#deleteCharge").addEventListener("click", async () => {
    const s = state.editing;
    if (!s || !confirm(`Delete "${s.task}"? Past history stays in the log.`)) return;
    state.config.schedules = state.config.schedules.filter((x) => x !== s);
    chargeDlg.close("deleted");
    render();
    try { await saveConfig(`Delete charge: ${s.task}`); toast("Charge deleted"); } catch (e) { toast(e.message, true); }
  });
  const slug = (t) => (t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "charge") + "-" + Math.random().toString(36).slice(2, 6);

  // ------------------------------------------------------------------ settings
  const setDlg = $("#settingsDialog"), setForm = $("#settingsForm");
  function fillTimezones() {
    let zones = [];
    try { zones = Intl.supportedValuesOf("timeZone"); } catch { zones = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"]; }
    $("#tzSelect").innerHTML = zones.map((z) => `<option>${z}</option>`).join("");
  }
  function guessRepo() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    // The site may live in a separate public repo (e.g. "accountable-site") that reads the private "accountable" repo.
    const hosted = m ? (location.pathname.split("/").filter(Boolean)[0] || "") : "";
    return { owner: m ? m[1] : "", repo: hosted.replace(/-site$/, "") || "accountable" };
  }
  function openSettings() {
    const f = setForm.elements, g = guessRepo(), st = state.config?.settings || {};
    f.owner.value = state.creds?.owner || g.owner;
    f.repo.value = state.creds?.repo || g.repo || "accountable";
    f.token.value = state.creds?.token || "";
    f.default_recipient.value = st.default_recipient || "";
    f.grace_hours.value = String(st.grace_hours ?? 2);
    f.timezone.value = st.timezone || "America/New_York";
    f.test_mode.checked = st.test_mode ?? true;
    $("#disconnect").hidden = !state.creds;
    setDlg.showModal();
  }
  setDlg.addEventListener("close", async () => {
    if (setDlg.returnValue !== "save") return;
    const f = setForm.elements;
    const creds = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() };
    const credsChanged = JSON.stringify(creds) !== JSON.stringify(state.creds);
    if (creds.token) { state.creds = creds; store.set("creds", creds); }
    const next = { timezone: f.timezone.value, default_recipient: f.default_recipient.value.trim().replace(/^@/, ""), grace_hours: Number(f.grace_hours.value), test_mode: f.test_mode.checked };
    if (credsChanged && creds.token) { await load(); }
    if (!state.config) return;
    const prev = state.config.settings || {};
    if (JSON.stringify({ ...prev, ...next }) === JSON.stringify(prev)) return;
    state.config.settings = { ...prev, ...next };
    render();
    try { await saveConfig("Update settings"); toast("Settings saved"); } catch (e) { toast(e.message, true); }
  });
  $("#disconnect").addEventListener("click", () => { store.del("creds"); state.creds = null; setDlg.close("x"); showConnect(); toast("Disconnected from GitHub"); });

  // ------------------------------------------------------------------ screens
  function showConnect() { $("#connect").hidden = false; $("#dashboard").hidden = true; $("#runNow").hidden = true; }
  function showDashboard() {
    $("#connect").hidden = true; $("#dashboard").hidden = false;
    $("#runNow").hidden = state.demo;
    if (state.showTest === null) {
      const hasReal = (state.log.entries || []).some((e) => !e.test);
      state.showTest = !hasReal;
      $("#showTest").checked = state.showTest;
    }
    render();
  }

  // ------------------------------------------------------------------ demo data
  function demoData() {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const config = {
      settings: { timezone: "America/New_York", default_recipient: "jordan-m", grace_hours: 2, test_mode: false },
      schedules: [
        { id: "gym", task: "Morning gym check-in", note: "Accountable: no gym photo", amount: 5, time: "09:00", days: ["mon", "wed", "fri"], recipient: "", active: true },
        { id: "read", task: "Read 20 pages", note: "Accountable: reading", amount: 3, time: "22:30", days: DAYS.slice(), recipient: "", active: true },
        { id: "bed", task: "Phone off by midnight", note: "Accountable: screen time", amount: 10, time: "00:15", days: ["sat", "sun"], recipient: "", active: true },
        { id: "meal", task: "Meal prep for the week", note: "Accountable: meal prep", amount: 15, time: "18:00", days: ["sun"], recipient: "", active: false },
      ],
    };
    const entries = [];
    const now = Date.now();
    for (let day = 70; day >= 0; day--) {
      const d = new Date(now - day * 86400000);
      const p = parts(d, "America/New_York");
      for (const s of config.schedules) {
        if (!s.days.includes(p.wd)) continue;
        const [hh, mm] = s.time.split(":").map(Number);
        const when = zonedToUtc(p.y, p.m, p.d, hh, mm, "America/New_York");
        if (when > now) continue;
        if (s.id === "meal" && day < 20) continue;
        const improving = 0.45 + (70 - day) / 70 * 0.3;
        const r = rnd();
        const ageH = (now - when) / 3600000;
        let status = r < improving ? "cancelled" : "settled";
        if (ageH < 52 && rnd() < 0.85) status = "pending";
        const outcome = { cancelled: "saved", settled: "lost", pending: "debt" }[status];
        const req = new Date(+when + 4 * 60000), res = new Date(+req + (30 + Math.floor(rnd() * 300)) * 60000);
        const events = [{ at: req.toISOString(), type: "requested", message: `Requested ${money(s.amount, true)} from @jordan-m: “${s.note}”` }];
        if (status !== "pending") events.push({ at: res.toISOString(), type: status, message: status === "cancelled" ? "Declined — task completed" : `Paid ${money(s.amount, true)} — task missed` });
        entries.push({ id: Math.random().toString(36).slice(2, 12), key: `${s.id}:${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`, schedule_id: s.id, task: s.task, note: s.note, amount: s.amount, recipient: "jordan-m", scheduled_for: when.toISOString(), status, outcome, test: false, payment_id: String(4000000000 + Math.floor(rnd() * 1e9)), last_checked: new Date(now - 11 * 60000).toISOString(), events });
      }
    }
    return { config, log: { entries, meta: {} } };
  }
  $("#demoBtn").addEventListener("click", () => {
    const d = demoData();
    state.config = d.config; state.log = d.log; state.demo = true; state.showTest = null;
    showDashboard();
    toast("Showing sample data. Nothing here is saved.");
  });

  // ------------------------------------------------------------------ wiring
  $$("[data-open-settings]").forEach((b) => b.addEventListener("click", openSettings));
  $("#openSettings").addEventListener("click", openSettings);
  $("#addCharge").addEventListener("click", () => openCharge(null));
  $("#range").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.range = b.dataset.range; store.set("range", state.range); render(); });
  $("#statusFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.filter = b.dataset.f; state.historyLimit = 15;
    $$("#statusFilter button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    renderHistory();
  });
  $("#showTest").addEventListener("change", (e) => { state.showTest = e.target.checked; render(); });
  $("#moreActivity").addEventListener("click", () => { state.activityLimit += 30; renderActivity(); });
  $("#runNow").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try {
      const info = await gh("");
      await gh(`/actions/workflows/accountable.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: info.default_branch }) });
      toast("Check started. Results show up in a minute or two.");
      setTimeout(() => load({ quiet: true }), 75000);
    } catch (err) { toast(err.status === 403 ? "The token needs Actions: read and write to start a check." : err.message, true); }
    finally { setTimeout(() => (btn.disabled = false), 4000); }
  });

  // theme
  const savedTheme = store.get("theme", null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("#themeToggle").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next; store.set("theme", next);
    if (!$("#dashboard").hidden) renderTrend(visibleEntries());
  });

  let rz;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (!$("#dashboard").hidden) renderTrend(visibleEntries()); }, 120); });
  setInterval(() => { if (!$("#dashboard").hidden) updateNext(); }, 30000);
  setInterval(() => { if (state.creds?.token && !state.demo && document.visibilityState === "visible") load({ quiet: true }); }, 120000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.creds?.token && !state.demo) load({ quiet: true }); });

  fillTimezones();
  if (new URLSearchParams(location.search).has("demo")) $("#demoBtn").click();
  else load();
})();
