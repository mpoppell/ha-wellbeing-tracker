// Wellbeing Tracker front end. Plain JS, no build step.
// All URLs are relative so they work behind Home Assistant's ingress path.
"use strict";

/* ================= helpers ================= */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "html") throw new Error("no raw html");
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svgIcon(path) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", path);
  s.append(p);
  return s;
}

const ICONS = {
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  edit: "M4 20h4L19 9l-4-4L4 16v4z",
  minus: "M6 12h12",
  plus: "M12 6v12M6 12h12",
  bell: "M6 16v-5a6 6 0 0112 0v5l1.5 2h-15L6 16zM10 20a2 2 0 004 0",
  close: "M6 6l12 12M18 6L6 18",
};

// "07:00" -> "7am", "13:30" -> "1:30pm"
function niceTime(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  return `${h % 12 || 12}${m ? ":" + pad(m) : ""}${suffix}`;
}

// 420 -> "7 h", 90 -> "1.5 h", 45 -> "45 min"
function niceGap(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.round((minutes / 60) * 100) / 100;
  return `${h} h`;
}

function joinNames(list) {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

async function api(method, path, body) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  let data = null;
  try { data = await resp.json(); } catch { /* empty body */ }
  if (!resp.ok) {
    const msg = data && typeof data.detail === "string" ? data.detail : `Request failed (${resp.status})`;
    throw new Error(msg);
  }
  return data;
}

const pad = (n) => String(n).padStart(2, "0");

function isoDay(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayToDate(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

function addDays(day, n) {
  const d = dayToDate(day);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

// ISO timestamp with the browser's own UTC offset, e.g. 2026-10-13T09:15:00+11:00
function localISO(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function loggedAtFor(day) {
  const now = new Date();
  if (day === isoDay(now)) return localISO(now);
  const d = dayToDate(day);
  d.setHours(now.getHours(), now.getMinutes(), 0, 0);
  return localISO(d);
}

function timeOf(iso) {
  // logged_at keeps its own offset; show the wall-clock time it was logged at
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return "";
  const h = Number(m[1]);
  const suffix = h < 12 ? "am" : "pm";
  return `${h % 12 || 12}:${m[2]}${suffix}`;
}

function dayLabel(day) {
  const today = isoDay(new Date());
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return dayToDate(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function longDate(day) {
  return dayToDate(day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ================= state ================= */

const state = {
  me: null,
  meta: { severity_labels: ["None", "Mild", "Moderate", "Severe"] },
  trackers: [],
  day: isoDay(new Date()),
  dayEntries: [],
  pending: new Map(), // tracker_id -> item to send
  doses: [], // today's medication doses from the reminder engine
  historyDays: 14,
};

const SCALE_VARS = ["--r1", "--r2", "--r3", "--r4", "--r5"];

function scaleColor(cfg, value) {
  const span = cfg.max - cfg.min;
  const idx = span === 0 ? 2 : Math.round(((value - cfg.min) / span) * 4);
  return `var(${SCALE_VARS[Math.max(0, Math.min(4, idx))]})`;
}

function ratingLabel(cfg, v) {
  const labels = cfg.labels || [];
  return labels.length ? labels[v - cfg.min] : `${v} of ${cfg.max}`;
}

function formatValue(t, e) {
  const c = t.config;
  switch (t.kind) {
    case "rating": return ratingLabel(c, e.value_num);
    case "tags": return (e.value_json || []).join(", ");
    case "symptom": return state.meta.severity_labels[e.value_num] || String(e.value_num);
    case "medication": {
      const dose = [c.dose, c.unit].filter(Boolean).join(" ");
      const times = e.value_num !== 1 ? `${e.value_num} doses` : "Taken";
      return dose ? `${times}, ${dose}` : times;
    }
    case "factor":
      if (c.mode === "bool") return e.value_num ? "Yes" : "No";
      return `${e.value_num}${c.unit ? " " + c.unit : ""}`;
    case "sleep": {
      const s = e.value_json || {};
      const parts = [];
      if (s.hours != null) parts.push(`${s.hours} h`);
      if (s.quality != null) parts.push(`quality ${s.quality} of 5`);
      return parts.join(", ");
    }
    case "note": return "";
    default: return "";
  }
}

const trackerById = (id) => state.trackers.find((t) => t.id === id);

/* ================= routing ================= */

const views = { checkin: renderCheckin, history: renderHistory, settings: renderSettings };

function currentTab() {
  const m = /^#\/(\w+)/.exec(location.hash);
  return m && views[m[1]] ? m[1] : "checkin";
}

let lastTab = null;
async function route() {
  const tab = currentTab();
  if (lastTab === "checkin" && tab !== "checkin" && state.pending.size) {
    if (!confirm("You have unsaved answers. Leave without saving?")) {
      location.hash = "#/checkin";
      return;
    }
    state.pending.clear();
  }
  lastTab = tab;
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  updateSaveBar();
  const view = document.getElementById("view");
  try {
    await views[tab](view);
  } catch (err) {
    view.replaceChildren(el("p", { class: "form-error" }, `Couldn't load this screen: ${err.message}`));
  }
}

/* ================= check-in ================= */

function entriesFor(trackerId) {
  return state.dayEntries.filter((e) => e.tracker_id === trackerId);
}

function dailyEntry(t) {
  return t.frequency === "daily" ? entriesFor(t.id)[0] || null : null;
}

// The value currently shown for a tracker: unsaved change first, then today's saved daily answer.
function shownValue(t) {
  const p = state.pending.get(t.id);
  if (p) return p.clear ? null : p;
  return dailyEntry(t);
}

function setPending(t, item) {
  const existing = dailyEntry(t);
  if (item === null) {
    // un-select: clear a saved daily answer, or just drop the unsaved change
    if (existing) state.pending.set(t.id, { tracker_id: t.id, clear: true });
    else state.pending.delete(t.id);
  } else {
    state.pending.set(t.id, { tracker_id: t.id, ...item });
  }
  updateSaveBar();
}

function updateSaveBar() {
  const bar = document.getElementById("savebar");
  const n = state.pending.size;
  bar.hidden = currentTab() !== "checkin" || n === 0;
  document.getElementById("save").textContent = n === 1 ? "Save 1 answer" : `Save ${n} answers`;
}

async function loadDay() {
  const isToday = state.day === isoDay(new Date());
  const [entries, doses] = await Promise.all([
    api("GET", `api/entries?from=${state.day}&to=${state.day}`),
    isToday ? api("GET", "api/doses/today").catch(() => []) : Promise.resolve([]),
  ]);
  state.dayEntries = entries;
  state.doses = doses;
}

async function renderCheckin(view) {
  if (!view.children.length) view.replaceChildren(el("p", { class: "loading" }, "Loading…"));
  await loadDay();
  drawCheckin(view);
}

function drawCheckin(view) {
  const today = isoDay(new Date());
  const name = (state.me.display_name || state.me.username || "").split(" ")[0];
  const isToday = state.day === today;

  const head = el("header", { class: "head" },
    el("h1", {}, isToday ? (name ? `How are you, ${name}?` : "How are you?")
      : `Check-in for ${state.day === addDays(today, -1) ? "yesterday" : dayLabel(state.day)}`),
    el("div", { class: "dayswitch" },
      el("button", { type: "button", class: "iconbtn", "aria-label": "Previous day", onclick: () => changeDay(-1) }, svgIcon(ICONS.left)),
      el("span", { class: "day-label" }, longDate(state.day)),
      el("button", { type: "button", class: "iconbtn", "aria-label": "Next day", disabled: isToday, onclick: () => changeDay(1) }, svgIcon(ICONS.right)),
    ),
  );

  const groups = new Map();
  for (const t of state.trackers) {
    const g = t.group_name || "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }

  const sections = [];
  for (const [g, list] of groups) {
    sections.push(el("section", { class: "group" },
      el("h2", {}, g),
      el("div", { class: "panel" }, list.map((t) => trackerRow(t, view))),
    ));
  }

  if (!state.trackers.length) {
    sections.push(el("div", { class: "empty" },
      el("p", {}, "You're not tracking anything yet."),
      el("a", { class: "primary", href: "#/settings", style: "display:inline-block;text-decoration:none" }, "Add trackers"),
    ));
  }
  view.replaceChildren(...[head, isToday ? dueCard(view) : null, ...sections].filter(Boolean));
}

function dueCard(view) {
  const due = state.doses.filter((d) => d.status === "due");
  const later = state.doses.filter((d) => d.status === "scheduled" && d.local_day === state.day);
  if (!due.length && !later.length) return null;

  const act = async (d, action) => {
    let reason;
    if (action === "skip") {
      reason = prompt(`Skipping ${d.name}. Add a reason? (optional)`);
      if (reason === null) return;
    }
    try {
      state.doses = await api("POST", `api/doses/${d.dose_id}`, { action, reason });
      state.dayEntries = await api("GET", `api/entries?from=${state.day}&to=${state.day}`);
      toast(action === "taken" ? `${d.name} taken` : action === "skip" ? `${d.name} skipped` : `${d.name} snoozed`);
      drawCheckin(view);
    } catch (err) { toast(err.message); }
  };

  const rows = due.map((d) => {
    const status = d.snoozed_until ? `Snoozed until ${niceTime(d.snoozed_until)}`
      : d.last_call ? `Past ${niceTime(d.latest)}. Skip today, or take it anyway?`
      : `Due since ${niceTime(d.time)}`;
    return el("div", { class: "due-row" },
      el("div", {},
        el("div", { class: "row-name" }, d.name, d.amount ? el("span", { class: "due-amount" }, ` ${d.amount}`) : null),
        el("div", { class: "row-sub" }, status)),
      el("div", { class: "due-actions" },
        el("button", { type: "button", class: "primary small", onclick: () => act(d, "taken") }, "Taken"),
        d.last_call ? null : el("button", { type: "button", class: "secondary small", onclick: () => act(d, "snooze") }, "Snooze"),
        el("button", { type: "button", class: "secondary small", onclick: () => act(d, "skip") }, "Skip")),
    );
  });
  const laterText = later.length
    ? `Later today: ${joinNames(later.map((d) => `${d.name} at ${niceTime(d.time)}`))}` : null;
  return el("section", { class: "due", "aria-label": "Medications due" },
    due.length ? el("h2", {}, due.length === 1 ? "Due now" : `${due.length} due now`) : null,
    rows,
    laterText ? el("p", { class: "row-sub due-later" }, laterText) : null,
  );
}

async function changeDay(delta) {
  const next = addDays(state.day, delta);
  if (next > isoDay(new Date())) return;
  if (state.pending.size && !confirm("You have unsaved answers. Switch day without saving?")) return;
  state.pending.clear();
  state.day = next;
  updateSaveBar();
  await renderCheckin(document.getElementById("view"));
}

function rowShell(t, aside, controls, sub) {
  const pending = state.pending.has(t.id);
  return el("div", { class: "row" },
    el("div", { class: "row-head" },
      el("span", { class: `row-name${pending ? " pending-dot" : ""}` },
        t.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, t.emoji) : null, t.name),
      aside,
    ),
    sub ? el("div", { class: "row-sub" }, sub) : null,
    el("div", { class: "controls" }, controls),
  );
}

function manyTodayNote(t) {
  const list = entriesFor(t.id);
  if (!list.length) return null;
  const last = list[0];
  const val = formatValue(t, last);
  const when = timeOf(last.logged_at);
  const count = list.length > 1 ? `${list.length} times, last ` : "";
  return `Logged ${count}${val ? val.toLowerCase() + " " : ""}at ${when}`;
}

function redraw(view) { drawCheckin(view); }

function trackerRow(t, view) {
  const shown = shownValue(t);
  const c = t.config;

  if (t.kind === "rating") {
    const n = c.max - c.min + 1;
    const val = shown ? shown.value_num : null;
    const buttons = [];
    for (let v = c.min; v <= c.max; v++) {
      buttons.push(el("button", {
        type: "button",
        "aria-pressed": String(val === v),
        "aria-label": ratingLabel(c, v),
        title: ratingLabel(c, v),
        style: `--c:${scaleColor(c, v)}`,
        onclick: () => { setPending(t, val === v ? null : { value_num: v }); redraw(view); },
      }, v));
    }
    const aside = el("span", { class: `row-aside${val != null ? " set" : ""}` }, val != null ? ratingLabel(c, val) : "");
    return rowShell(t, aside, el("div", { class: "scale", style: `--n:${n}` }, buttons),
      t.frequency === "many" ? manyTodayNote(t) : null);
  }

  if (t.kind === "symptom") {
    const val = shown ? shown.value_num : null;
    const labels = state.meta.severity_labels;
    const seg = el("div", { class: "seg severity", role: "group", "aria-label": `${t.name} severity` },
      labels.map((label, i) => el("button", {
        type: "button",
        "aria-pressed": String(val === i),
        style: `--sev:var(--sev${i})`,
        onclick: () => { setPending(t, val === i ? null : { value_num: i }); redraw(view); },
      }, label)));
    return rowShell(t, null, seg);
  }

  if (t.kind === "tags") {
    const selected = new Set(shown ? shown.value_json || [] : []);
    const chips = el("div", { class: "chips" }, (c.options || []).map((opt) => el("button", {
      type: "button",
      class: "chip",
      "aria-pressed": String(selected.has(opt)),
      onclick: () => {
        if (selected.has(opt)) selected.delete(opt); else selected.add(opt);
        setPending(t, selected.size ? { value_json: [...selected] } : null);
        redraw(view);
      },
    }, opt)));
    return rowShell(t, null, chips, t.frequency === "many" ? manyTodayNote(t) : null);
  }

  if (t.kind === "factor") {
    const val = shown ? shown.value_num : null;
    if (c.mode === "bool") {
      const seg = el("div", { class: "seg", role: "group", "aria-label": t.name },
        [["No", 0], ["Yes", 1]].map(([label, v]) => el("button", {
          type: "button",
          "aria-pressed": String(val === v),
          onclick: () => { setPending(t, val === v ? null : { value_num: v }); redraw(view); },
        }, label)));
      return rowShell(t, null, seg);
    }
    if (c.mode === "count") {
      const current = val ?? 0;
      const step = (d) => {
        const next = Math.max(0, current + d);
        setPending(t, { value_num: next });
        redraw(view);
      };
      const stepper = el("div", { class: "stepper" },
        el("button", { type: "button", class: "iconbtn", "aria-label": `Fewer ${t.name}`, disabled: current <= 0, onclick: () => step(-1) }, svgIcon(ICONS.minus)),
        el("output", { "aria-live": "polite" }, String(current)),
        el("button", { type: "button", class: "iconbtn", "aria-label": `More ${t.name}`, onclick: () => step(1) }, svgIcon(ICONS.plus)),
        c.unit ? el("span", { class: "row-sub" }, c.unit) : null,
      );
      return rowShell(t, null, stepper);
    }
    const input = el("input", {
      type: "number", inputmode: "decimal", min: "0", step: "any",
      value: val ?? "", "aria-label": t.name, placeholder: c.unit || "Amount",
      onchange: (ev) => {
        const v = ev.target.value;
        setPending(t, v === "" ? null : { value_num: Number(v) });
        redraw(view);
      },
    });
    return rowShell(t, null, el("div", { class: "inline-field" }, input, c.unit ? el("span", {}, c.unit) : null));
  }

  if (t.kind === "medication") {
    const taken = entriesFor(t.id);
    const marked = state.pending.has(t.id);
    const dose = [c.dose, c.unit].filter(Boolean).join(" ");
    const nextDose = state.doses.find((d) => d.tracker_id === t.id && d.status === "scheduled" && d.local_day === state.day);
    const sub = [dose, c.notes, nextDose ? `Next reminder ${niceTime(nextDose.time)}` : null].filter(Boolean).join(". ");
    const takenText = taken.length ? `Taken at ${taken.map((e) => timeOf(e.logged_at)).reverse().join(", ")}` : "Not taken yet";
    const btn = el("button", {
      type: "button", class: "med-taken", "aria-pressed": String(marked),
      onclick: () => {
        if (marked) state.pending.delete(t.id);
        else {
          if (taken.length && !confirm(`${t.name} is already logged ${dayLabel(state.day).toLowerCase()}. Log another dose?`)) return;
          state.pending.set(t.id, { tracker_id: t.id, value_num: 1 });
        }
        updateSaveBar();
        redraw(view);
      },
    }, marked ? "Taken, not saved yet" : "Mark as taken");
    return rowShell(t, el("span", { class: "row-aside" }, takenText), btn, sub || null);
  }

  if (t.kind === "sleep") {
    const s = shown ? shown.value_json || {} : {};
    const hours = s.hours ?? null;
    const quality = s.quality ?? null;
    const update = (h, q) => {
      setPending(t, h == null && q == null ? null : { value_json: { hours: h, quality: q } });
      redraw(view);
    };
    const shownHours = hours ?? 7.5;
    const stepper = el("div", { class: "stepper" },
      el("button", { type: "button", class: "iconbtn", "aria-label": "Less sleep", onclick: () => update(Math.max(0, shownHours - 0.5), quality) }, svgIcon(ICONS.minus)),
      el("output", {}, hours == null ? "–" : `${hours} h`),
      el("button", { type: "button", class: "iconbtn", "aria-label": "More sleep", onclick: () => update(Math.min(24, hours == null ? shownHours : hours + 0.5), quality) }, svgIcon(ICONS.plus)),
    );
    const qcfg = { min: 1, max: 5, labels: ["Awful", "Poor", "Okay", "Good", "Great"] };
    const scale = el("div", { class: "scale", style: "--n:5;flex:1" }, [1, 2, 3, 4, 5].map((v) => el("button", {
      type: "button", "aria-pressed": String(quality === v), "aria-label": `Sleep quality ${qcfg.labels[v - 1]}`,
      title: qcfg.labels[v - 1], style: `--c:${scaleColor(qcfg, v)}`,
      onclick: () => update(hours, quality === v ? null : v),
    }, v)));
    const aside = el("span", { class: `row-aside${quality ? " set" : ""}` }, quality ? qcfg.labels[quality - 1] : "");
    return rowShell(t, aside, el("div", {},
      el("div", { class: "inline-field" }, el("span", {}, "Hours"), stepper),
      el("div", { class: "inline-field" }, el("span", {}, "Quality"), scale),
    ));
  }

  if (t.kind === "note") {
    const p = state.pending.get(t.id);
    const saved = dailyEntry(t);
    const text = p ? (p.clear ? "" : p.note) : saved ? saved.note : "";
    const area = el("textarea", {
      "aria-label": t.name, placeholder: "Anything worth remembering about today?",
      oninput: (ev) => {
        const v = ev.target.value;
        if (v.trim()) state.pending.set(t.id, { tracker_id: t.id, note: v });
        else if (saved) state.pending.set(t.id, { tracker_id: t.id, clear: true });
        else state.pending.delete(t.id);
        updateSaveBar();
      },
    });
    area.value = text || "";
    return rowShell(t, null, area);
  }

  return rowShell(t, null, el("span", { class: "row-sub" }, "This tracker type isn't supported yet."));
}

async function saveCheckin() {
  if (!state.pending.size) return;
  const btn = document.getElementById("save");
  btn.disabled = true;
  try {
    const items = [...state.pending.values()];
    await api("POST", "api/checkin", { logged_at: loggedAtFor(state.day), items });
    state.pending.clear();
    await loadDay();
    toast("Saved");
    updateSaveBar();
    drawCheckin(document.getElementById("view"));
  } catch (err) {
    toast(`Not saved: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ================= history ================= */

async function renderHistory(view) {
  view.replaceChildren(el("p", { class: "loading" }, "Loading…"));
  const to = isoDay(new Date());
  const from = addDays(to, -(state.historyDays - 1));
  const entries = await api("GET", `api/entries?from=${from}&to=${to}`);
  const allTrackers = await api("GET", "api/trackers?include_hidden=true");
  const byId = new Map(allTrackers.map((t) => [t.id, t]));

  const head = el("header", { class: "head" },
    el("h1", {}, "History"),
    el("p", {}, `Last ${state.historyDays} days. Tap an entry to change or delete it.`),
  );

  if (!entries.length) {
    view.replaceChildren(head, el("div", { class: "empty" },
      el("p", {}, "Nothing logged in this period. Your check-ins will appear here."),
      el("a", { class: "primary", href: "#/checkin", style: "display:inline-block;text-decoration:none" }, "Check in now"),
    ));
    return;
  }

  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }

  const blocks = [];
  for (const [day, list] of byDay) {
    blocks.push(el("section", { class: "day-block" },
      el("h2", {}, dayLabel(day), daySummary(list, byId)),
      el("div", { class: "panel" }, list.map((e) => entryButton(e, byId.get(e.tracker_id)))),
    ));
  }

  const more = el("button", { type: "button", class: "secondary more", onclick: async () => {
    state.historyDays += 14;
    await renderHistory(view);
  } }, "Show earlier days");

  view.replaceChildren(head, ...blocks, more);
}

function daySummary(list, byId) {
  const parts = [];
  for (const key of ["mood", "energy"]) {
    const vals = list.filter((e) => byId.get(e.tracker_id)?.key === key).map((e) => e.value_num);
    if (!vals.length) continue;
    const t = list.map((e) => byId.get(e.tracker_id)).find((x) => x?.key === key);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const rounded = Math.round(avg);
    parts.push(el("span", {},
      el("span", { class: "swatch", style: `background:${scaleColor(t.config, rounded)}` }),
      `${t.name} ${ratingLabel(t.config, rounded).toLowerCase()}`));
  }
  return el("span", { class: "day-summary" }, parts);
}

function entryButton(e, t) {
  if (!t) return null;
  const val = formatValue(t, e);
  return el("button", { type: "button", class: "entry", onclick: () => openEntrySheet(e, t) },
    el("time", { datetime: e.logged_at }, timeOf(e.logged_at)),
    el("span", {},
      el("span", { class: "what" }, t.emoji ? `${t.emoji} ` : "", t.name),
      val ? el("span", { class: "val" }, `  ${val}`) : null,
      e.note ? el("span", { class: "note" }, e.note) : null,
    ),
  );
}

function openEntrySheet(e, t) {
  const sheet = document.getElementById("sheet");
  const val = formatValue(t, e);
  const body = el("div", { class: "sheet-body" },
    el("h2", {}, `${t.emoji ? t.emoji + " " : ""}${t.name}`),
    el("p", {}, `${longDate(e.day)} at ${timeOf(e.logged_at)}`),
    val ? el("p", {}, el("strong", {}, val)) : null,
    e.note ? el("p", { style: "white-space:pre-wrap" }, e.note) : null,
    el("div", { class: "actions" },
      el("button", { type: "button", class: "primary", onclick: () => {
        sheet.close();
        state.day = e.day;
        state.loadedDay = null;
        location.hash = "#/checkin";
      } }, "Change in check-in"),
      el("button", { type: "button", class: "secondary danger", onclick: async () => {
        if (!confirm(`Delete this ${t.name} entry?`)) return;
        try {
          await api("DELETE", `api/entries/${e.id}`);
          sheet.close();
          toast("Entry deleted");
          state.loadedDay = null;
          await renderHistory(document.getElementById("view"));
        } catch (err) { toast(err.message); }
      } }, "Delete entry"),
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Close"),
    ),
  );
  sheet.replaceChildren(body);
  sheet.showModal();
}

/* ================= settings ================= */

const KIND_INFO = {
  rating: "Rating",
  tags: "Pick from a list",
  symptom: "Symptom severity",
  medication: "Medication",
  factor: "Factor",
  sleep: "Sleep",
  note: "Note",
};

function describeTracker(t) {
  const c = t.config;
  const often = t.frequency === "daily" ? "once a day" : "every check-in";
  switch (t.kind) {
    case "rating": return `Rating ${c.min}–${c.max}, ${often}`;
    case "factor": return `${c.mode === "bool" ? "Yes or no" : c.mode === "count" ? `Count${c.unit ? " of " + c.unit : ""}` : `Amount${c.unit ? " in " + c.unit : ""}`}, ${often}`;
    case "medication": {
      const amount = [c.dose, c.unit].filter(Boolean).join(" ");
      const sch = t._schedule;
      let when = "No reminders";
      if (sch && sch.enabled && sch.settings.mode === "after") {
        const names = (id) => (state.trackers.find((x) => x.id === id) || {}).name || "another medication";
        when = `Reminders ${joinNames(sch.settings.after.map((r) => `${niceGap(r.minutes)} after ${names(r.tracker_id)}`))}`;
        if (sch.settings.max_per_day) when += `, up to ${sch.settings.max_per_day} a day`;
      } else if (sch && sch.enabled) {
        when = `Reminders at ${joinNames(sch.settings.times.map(niceTime))}`;
      }
      return [amount, when].filter(Boolean).join(". ");
    }
    case "tags": return `${(c.options || []).length} options, ${often}`;
    default: return `${KIND_INFO[t.kind]}, ${often}`;
  }
}

async function renderSettings(view) {
  view.replaceChildren(el("p", { class: "loading" }, "Loading…"));
  const all = await api("GET", "api/trackers?include_hidden=true");
  const visible = all.filter((t) => !t.hidden);
  const hidden = all.filter((t) => t.hidden);

  const head = el("header", { class: "head" },
    el("h1", {}, "Settings"),
    el("p", {}, "Choose what you track. Your list is private to you."),
  );

  const meds = visible.filter((t) => t.kind === "medication");
  const others = visible.filter((t) => t.kind !== "medication");
  const [schedules, person] = await Promise.all([
    Promise.all(meds.map((m) => api("GET", `api/trackers/${m.id}/schedule`).catch(() => null))),
    api("GET", "api/reminders/settings").catch(() => null),
  ]);
  meds.forEach((m, i) => { m._schedule = schedules[i]; });

  const phones = person ? person.devices.length : 0;
  const reminderSection = el("section", { class: "group" },
    el("h2", {}, "Reminders"),
    el("div", { class: "panel" },
      el("div", { class: "tracker-row" },
        el("div", { class: "info" },
          el("div", { class: "row-name" }, "Reminder settings"),
          el("div", { class: "row-sub" }, phones
            ? `Sending to ${phones === 1 ? "1 phone" : phones + " phones"}`
            : "No phone chosen yet, so reminders only show here")),
        el("button", { type: "button", class: "secondary", onclick: () => openPersonSheet(view) }, "Change"))),
  );

  const medSection = el("section", { class: "group" },
    el("h2", {}, "Medications"),
    meds.length
      ? el("div", { class: "panel" }, meds.map((t) => settingsRow(t, all, view)))
      : el("div", { class: "empty", style: "margin-top:0" }, el("p", {}, "No medications added yet.")),
    el("div", { class: "actions", style: "margin-top:12px" },
      el("button", { type: "button", class: "secondary", onclick: () => openTrackerSheet({ kind: "medication" }, view) }, "Add medication")),
  );

  const groups = new Map();
  for (const t of others) {
    const g = t.group_name || "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const trackerSections = [...groups].map(([g, list]) => el("section", { class: "group" },
    el("h2", {}, g),
    el("div", { class: "panel" }, list.map((t) => settingsRow(t, all, view))),
  ));

  const addRow = el("div", { class: "actions" },
    el("button", { type: "button", class: "primary", onclick: () => openTrackerSheet({ kind: "rating" }, view) }, "Add tracker"));

  const hiddenSection = hidden.length ? el("section", { class: "group" },
    el("h2", {}, "Hidden"),
    el("div", { class: "panel" }, hidden.map((t) => settingsRow(t, all, view))),
  ) : null;

  view.replaceChildren(...[head, medSection, reminderSection, ...trackerSections, addRow, hiddenSection,
    el("p", { class: "whoami" }, `Signed in to Home Assistant as ${state.me.display_name || state.me.username}`)].filter(Boolean));
}

function settingsRow(t, all, view) {
  // Arrows move a tracker within its own section on screen.
  const section = all.filter((x) => !x.hidden && (t.kind === "medication"
    ? x.kind === "medication"
    : x.kind !== "medication" && (x.group_name || "Other") === (t.group_name || "Other")));
  const i = section.findIndex((x) => x.id === t.id);
  const move = async (d) => {
    const neighbour = section[i + d];
    if (!neighbour) return;
    const order = all.map((x) => x.id);
    const a = order.indexOf(t.id);
    const b = order.indexOf(neighbour.id);
    [order[a], order[b]] = [order[b], order[a]];
    await api("POST", "api/trackers/order", { ids: order });
    await refreshTrackers();
    await renderSettings(view);
  };
  const last = section.length - 1;
  return el("div", { class: "tracker-row" },
    el("div", { class: "info" },
      el("div", { class: "row-name" }, t.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, t.emoji) : null, t.name),
      el("div", { class: "row-sub" }, describeTracker(t)),
    ),
    t.hidden
      ? el("button", { type: "button", class: "secondary", onclick: async () => {
          await api("PATCH", `api/trackers/${t.id}`, { hidden: false });
          await refreshTrackers();
          await renderSettings(view);
        } }, "Show")
      : [
          el("button", { type: "button", class: "iconbtn", "aria-label": `Move ${t.name} up`, disabled: i <= 0, onclick: () => move(-1) }, svgIcon(ICONS.up)),
          el("button", { type: "button", class: "iconbtn", "aria-label": `Move ${t.name} down`, disabled: i >= last, onclick: () => move(1) }, svgIcon(ICONS.down)),
        ],
    t.kind === "medication" && !t.hidden
      ? el("button", { type: "button", class: "iconbtn", "aria-label": `Reminders for ${t.name}`, onclick: () => openScheduleSheet(t, view) }, svgIcon(ICONS.bell))
      : null,
    el("button", { type: "button", class: "iconbtn", "aria-label": `Edit ${t.name}`, onclick: () => openTrackerSheet(t, view) }, svgIcon(ICONS.edit)),
  );
}

function field(label, control, hint) {
  return el("label", { class: "field" }, el("span", {}, label), control, hint ? el("span", { class: "hint" }, hint) : null);
}

function openTrackerSheet(t, view) {
  const isNew = !t.id;
  const sheet = document.getElementById("sheet");
  const c = t.config || {};
  let kind = t.kind;

  const name = el("input", { type: "text", name: "name", required: true, maxlength: "60", value: t.name || "", autocomplete: "off" });
  const emoji = el("input", { type: "text", name: "emoji", maxlength: "8", value: t.emoji || "", autocomplete: "off" });
  const groupNames = [...new Set(state.trackers.map((x) => x.group_name).filter(Boolean))];
  const group = el("input", { type: "text", name: "group", maxlength: "40", value: t.group_name ?? "", list: "group-names", autocomplete: "off" });
  const groupList = el("datalist", { id: "group-names" }, groupNames.map((g) => el("option", { value: g })));
  const freq = el("select", { name: "frequency" },
    el("option", { value: "many" }, "Every check-in (log several times a day)"),
    el("option", { value: "daily" }, "Once a day (later answers replace it)"));
  freq.value = t.frequency || (["symptom", "factor", "sleep", "note"].includes(kind) ? "daily" : "many");

  const kindSelect = el("select", { name: "kind" },
    ["rating", "symptom", "factor", "tags", "note"].map((k) => el("option", { value: k }, KIND_INFO[k])));
  kindSelect.value = kind;

  const extra = el("div", {});
  const err = el("p", { class: "form-error", hidden: true });

  // kind-specific inputs, rebuilt when the kind changes
  const inputs = {};
  function drawExtra() {
    extra.replaceChildren();
    if (kind === "rating") {
      inputs.labels = el("input", { type: "text", value: (c.labels || []).join(", "), placeholder: "Awful, Bad, Okay, Good, Great" });
      extra.append(field("Labels for 1 to 5", inputs.labels, "Optional. Five words separated by commas."));
    } else if (kind === "tags") {
      inputs.options = el("textarea", { placeholder: "One option per line" });
      inputs.options.value = (c.options || []).join("\n");
      extra.append(field("Options", inputs.options, "One per line."));
    } else if (kind === "factor") {
      inputs.mode = el("select", {},
        el("option", { value: "bool" }, "Yes or no"),
        el("option", { value: "count" }, "Count (cups, drinks…)"),
        el("option", { value: "amount" }, "Amount (minutes, km…)"));
      inputs.mode.value = c.mode || "bool";
      inputs.unit = el("input", { type: "text", maxlength: "20", value: c.unit || "", placeholder: "cups" });
      extra.append(field("Type", inputs.mode), field("Unit", inputs.unit, "Only for counts and amounts."));
    } else if (kind === "medication") {
      inputs.dose = el("input", { type: "text", maxlength: "40", value: c.dose || "", placeholder: "30" });
      inputs.unit = el("input", { type: "text", maxlength: "20", value: c.unit || "", placeholder: "mg" });
      inputs.notes = el("input", { type: "text", maxlength: "200", value: c.notes || "", placeholder: "With breakfast" });
      extra.append(
        el("div", { class: "field-pair" }, field("Dose", inputs.dose), field("Unit", inputs.unit)),
        field("Notes", inputs.notes),
        t.id ? el("button", { type: "button", class: "secondary", onclick: () => openScheduleSheet(t, view) }, "Reminders…") : null,
      );
    }
  }
  drawExtra();
  kindSelect.addEventListener("change", () => {
    kind = kindSelect.value;
    freq.value = ["symptom", "factor", "note"].includes(kind) ? "daily" : "many";
    drawExtra();
  });

  function readConfig() {
    if (kind === "rating") {
      const labels = inputs.labels.value.split(",").map((s) => s.trim()).filter(Boolean);
      return { min: c.min || 1, max: c.max || 5, labels };
    }
    if (kind === "tags") return { options: inputs.options.value.split("\n").map((s) => s.trim()).filter(Boolean) };
    if (kind === "factor") return { mode: inputs.mode.value, unit: inputs.unit.value.trim() };
    if (kind === "medication") return { dose: inputs.dose.value.trim(), unit: inputs.unit.value.trim(), notes: inputs.notes.value.trim() };
    return {};
  }

  const form = el("form", { method: "dialog" },
    el("h2", {}, isNew ? (kind === "medication" ? "Add medication" : "Add tracker") : `Edit ${t.name}`),
    err,
    isNew && kind !== "medication" ? field("What kind of tracker?", kindSelect) : null,
    field("Name", name),
    el("div", { class: "field-pair" },
      field("Emoji", emoji),
      kind === "medication" ? el("span") : field("Section", group),
    ),
    groupList,
    extra,
    ["sleep", "medication"].includes(kind) ? null : field("How often", freq),
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, isNew ? "Add" : "Save changes"),
      !isNew ? el("button", { type: "button", class: "secondary", onclick: async () => {
        await api("PATCH", `api/trackers/${t.id}`, { hidden: !t.hidden });
        sheet.close();
        toast(t.hidden ? `${t.name} shown` : `${t.name} hidden`);
        await refreshTrackers();
        await renderSettings(view);
      } }, t.hidden ? "Show" : "Hide") : null,
      !isNew ? el("button", { type: "button", class: "secondary danger", onclick: async () => {
        if (!confirm(`Delete ${t.name} and everything logged for it? Hide it instead to keep its history.`)) return;
        await api("DELETE", `api/trackers/${t.id}`);
        sheet.close();
        toast(`${t.name} deleted`);
        await refreshTrackers();
        await renderSettings(view);
      } }, "Delete") : null,
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel"),
    ),
  );

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const payload = {
      name: name.value,
      emoji: emoji.value.trim() || null,
      config: readConfig(),
    };
    if (kind !== "medication") payload.group_name = group.value.trim();
    if (!["sleep", "medication"].includes(kind)) payload.frequency = freq.value;
    try {
      const saved = isNew
        ? await api("POST", "api/trackers", { kind, ...payload })
        : await api("PATCH", `api/trackers/${t.id}`, payload);
      sheet.close();
      toast(isNew ? `${payload.name.trim()} added` : "Changes saved");
      await refreshTrackers();
      await renderSettings(view);
      if (isNew && kind === "medication") openScheduleSheet(saved, view, { turnOn: true });
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });

  sheet.replaceChildren(form);
  sheet.showModal();
  name.focus();
}

/* ================= reminders ================= */

let haOptionsCache = null;
async function haOptions() {
  if (!haOptionsCache) {
    try { haOptionsCache = await api("GET", "api/ha/options"); }
    catch { haOptionsCache = { connected: false, phones: [], speakers: [], voices: [], toggles: [], datetimes: [], people: [] }; }
  }
  return haOptionsCache;
}

function switchField(label, checked, hint) {
  const input = el("input", { type: "checkbox", role: "switch", class: "switch" });
  input.checked = !!checked;
  const node = el("label", { class: "switch-field" },
    el("span", { class: "switch-text" }, el("span", { class: "switch-label" }, label),
      hint ? el("span", { class: "hint" }, hint) : null),
    input);
  return { node, input };
}

function selectOf(options, value) {
  const sel = el("select", {}, options.map(([v, label]) => el("option", { value: v }, label)));
  sel.value = value == null ? "" : String(value);
  return sel;
}

function notice(...children) {
  return el("div", { class: "notice" }, children);
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const NAG_CHOICES = [
  ["once", "Once only"],
  ["gently", "Gently"],
  ["firmly", "Firmly"],
  ["custom", "My own pattern"],
];
const NAG_HINTS = {
  once: "One reminder, no repeats.",
  gently: "Every 30 minutes, up to 4 more times.",
  firmly: "Every 10 minutes, up to 6 more times.",
  custom: "",
};

async function openScheduleSheet(t, view, opts = {}) {
  const sheet = document.getElementById("sheet");
  let sched, person, ha;
  try {
    [sched, person, ha] = await Promise.all([
      api("GET", `api/trackers/${t.id}/schedule`), api("GET", "api/reminders/settings"), haOptions()]);
  } catch (err) { toast(err.message); return; }
  const s = sched.settings;

  const enabled = switchField(`Remind me to take ${t.name}`, sched.enabled || opts.turnOn);
  const body = el("div", { class: "sched-body" });
  const err = el("p", { class: "form-error", hidden: true });

  // ----- times -----
  const timeList = el("div", { class: "time-list" });
  const addTime = (value) => {
    const input = el("input", { type: "time", value, required: true, "aria-label": "Reminder time" });
    const row = el("div", { class: "time-row" }, input,
      el("button", { type: "button", class: "iconbtn", "aria-label": "Remove this time", onclick: () => {
        if (timeList.children.length > 1) row.remove();
      } }, svgIcon(ICONS.close)));
    timeList.append(row);
  };
  s.times.forEach(addTime);
  const addTimeBtn = el("button", { type: "button", class: "secondary small", onclick: () => addTime("12:00") }, "Add a time");

  // ----- days -----
  let mode = s.days.mode;
  const weekdays = new Set(s.days.weekdays);
  const dayChips = el("div", { class: "chips" }, WEEKDAYS.map((w, i) => {
    const b = el("button", { type: "button", class: "chip", "aria-pressed": String(weekdays.has(i)), onclick: () => {
      if (weekdays.has(i)) weekdays.delete(i); else weekdays.add(i);
      b.setAttribute("aria-pressed", String(weekdays.has(i)));
    } }, w);
    return b;
  }));
  const everyInput = el("input", { type: "number", min: "2", max: "60", value: s.days.every, inputmode: "numeric", style: "width:5em" });
  const startInput = el("input", { type: "date", value: s.days.start || isoDay(new Date()) });
  const weekdayPanel = el("div", { class: "subpanel" }, dayChips);
  const intervalPanel = el("div", { class: "subpanel inline-field" },
    el("span", {}, "Every"), everyInput, el("span", {}, "days, starting"), startInput);
  const modeSeg = el("div", { class: "seg", role: "group", "aria-label": "Which days" });
  const drawMode = () => {
    modeSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    weekdayPanel.hidden = mode !== "weekdays";
    intervalPanel.hidden = mode !== "interval";
  };
  [["daily", "Every day"], ["weekdays", "Some days"], ["interval", "Every few days"]].forEach(([m, label]) =>
    modeSeg.append(el("button", { type: "button", "data-mode": m, onclick: () => { mode = m; drawMode(); } }, label)));
  drawMode();

  // ----- after another dose -----
  const meds = state.trackers.filter((x) => x.kind === "medication");
  if (!meds.some((x) => x.id === t.id)) meds.unshift(t);
  const medOptions = meds.map((x) => [x.id, x.id === t.id ? `${x.name} (this one)` : x.name]);
  const ruleList = el("div", { class: "rule-list" });
  const addRule = (rule) => {
    const hours = el("input", { type: "number", min: "0.25", max: "24", step: "0.25", inputmode: "decimal",
      value: rule.minutes / 60, "aria-label": "Hours", style: "width:5.5em" });
    const which = selectOf(medOptions, rule.tracker_id);
    which.setAttribute("aria-label", "Medication");
    const row = el("div", { class: "rule-row" },
      hours, el("span", {}, "hours after I take"), which,
      el("button", { type: "button", class: "iconbtn", "aria-label": "Remove this rule", onclick: () => {
        if (ruleList.children.length > 1) row.remove();
      } }, svgIcon(ICONS.close)));
    ruleList.append(row);
  };
  const firstOther = meds.find((x) => x.id !== t.id);
  (s.after.length ? s.after : [{ tracker_id: (firstOther || t).id, minutes: 180 }]).forEach(addRule);
  const addRuleBtn = el("button", { type: "button", class: "secondary small", onclick: () => addRule({ tracker_id: t.id, minutes: 180 }) }, "Add another");
  const maxPerDay = el("input", { type: "number", min: "1", max: "24", inputmode: "numeric", value: s.max_per_day ?? "", placeholder: "No limit", style: "width:6em" });
  const afterBlock = el("div", {},
    field("Remind me", el("div", {}, ruleList, addRuleBtn),
      "Timed from when you actually take it: tapping Taken, logging it here, or a linked toggle. Pick this medication to repeat it, like every 3 hours."),
    field("At most", el("div", { class: "inline-field" }, maxPerDay, el("span", {}, "reminders a day")),
      "Stops the chain. Leave blank for no limit."),
  );

  let schedMode = s.mode;
  const timesBlock = el("div", {});
  const whenSeg = el("div", { class: "seg", role: "group", "aria-label": "How to time it" });
  const drawWhen = () => {
    whenSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === schedMode)));
    timesBlock.hidden = schedMode !== "times";
    afterBlock.hidden = schedMode !== "after";
  };
  [["times", "At set times"], ["after", "After another dose"]].forEach(([m, label]) =>
    whenSeg.append(el("button", { type: "button", "data-mode": m, onclick: () => { schedMode = m; drawWhen(); } }, label)));

  // ----- nagging -----
  const nag = selectOf(NAG_CHOICES, s.nag);
  const nagEvery = el("input", { type: "number", min: "1", max: "240", value: s.nag_every, inputmode: "numeric", style: "width:5em" });
  const nagRepeats = el("input", { type: "number", min: "0", max: "50", value: s.nag_repeats ?? "", inputmode: "numeric", style: "width:5em", placeholder: "∞" });
  const customPanel = el("div", { class: "subpanel" },
    el("div", { class: "inline-field" }, el("span", {}, "Every"), nagEvery, el("span", {}, "minutes")),
    el("div", { class: "inline-field" }, el("span", {}, "Up to"), nagRepeats, el("span", {}, "more times")),
    el("p", { class: "hint" }, "Leave blank to keep going until the latest time or the end of the day."));
  const nagHint = el("p", { class: "hint" });
  const drawNag = () => {
    customPanel.hidden = nag.value !== "custom";
    nagHint.textContent = NAG_HINTS[nag.value];
    nagHint.hidden = !NAG_HINTS[nag.value];
  };
  nag.addEventListener("change", drawNag);
  drawNag();

  // ----- latest time -----
  const latestOn = switchField("Stop at a latest time", !!s.latest_time,
    "No new reminders after this. Anything still waiting gets one last question: skip today, or take it anyway?");
  const latestInput = el("input", { type: "time", value: s.latest_time || "11:00", "aria-label": "Latest time" });
  const latestPanel = el("div", { class: "subpanel" }, latestInput);
  const drawLatest = () => { latestPanel.hidden = !latestOn.input.checked; };
  latestOn.input.addEventListener("change", drawLatest);
  drawLatest();

  // ----- hard to miss -----
  const hard = switchField("Make it hard to miss", s.hard_to_miss, "Step it up if a reminder goes unanswered.");
  const hardAfter = selectOf([2, 3, 4, 5, 6].map((n) => [n, `From reminder ${n}`]), s.hard_after);
  const alarm = switchField("Ring like an alarm", s.alarm_sound, "Sounds even on Do Not Disturb, except in your quiet hours.");
  const speakersReady = person.speakers.length && person.tts_entity;
  const announce = switchField("Announce it on speakers", s.announce, speakersReady
    ? "Uses the speakers in Reminder settings."
    : "Choose speakers and a voice in Reminder settings first.");
  const hardPanel = el("div", { class: "subpanel" }, field("Starting", hardAfter), alarm.node, announce.node);
  const drawHard = () => { hardPanel.hidden = !hard.input.checked; };
  hard.input.addEventListener("change", drawHard);
  drawHard();

  // ----- Home Assistant link -----
  const linked = selectOf([["", "None"], ...ha.toggles.map((x) => [x.entity_id, x.name])], s.linked_entity);
  const linkedTime = selectOf([["", "None"], ...ha.datetimes.map((x) => [x.entity_id, x.name])], s.linked_time_entity);
  const early = selectOf([[0, "Not at all"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [180, "3 hours"], [360, "6 hours"]], s.early_window);
  const linkDetails = el("details", { class: "more", open: !!(s.linked_entity || s.linked_time_entity) },
    el("summary", {}, "Home Assistant link and early doses"),
    field("Keep this toggle in sync", linked, "Turning it on counts as taken; taking it turns it on."),
    field("Set this date and time when taken", linkedTime),
    field("Count it if I log it early, up to", early));

  timesBlock.append(
    field("Times", el("div", {}, timeList, addTimeBtn)),
    field("Days", el("div", {}, modeSeg, weekdayPanel, intervalPanel)));
  drawWhen();
  body.append(
    field("When", whenSeg),
    timesBlock,
    afterBlock,
    field("Until I answer, remind me", el("div", {}, nag, nagHint, customPanel)),
    latestOn.node, latestPanel,
    hard.node, hardPanel,
    linkDetails,
  );
  const drawEnabled = () => { body.classList.toggle("dimmed", !enabled.input.checked); };
  enabled.input.addEventListener("change", drawEnabled);
  drawEnabled();

  const noPhone = !person.devices.length ? notice(
    "No phone is chosen yet, so reminders will only show on the Check-in screen. ",
    el("button", { type: "button", class: "link inline", onclick: () => openPersonSheet(view) }, "Choose phones")) : null;

  const form = el("form", { method: "dialog" },
    el("h2", {}, `Reminders for ${t.name}`),
    err, noPhone, enabled.node, body,
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, "Save reminders"),
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel")));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const settings = {
      mode: schedMode,
      after: [...ruleList.querySelectorAll(".rule-row")].map((r) => ({
        tracker_id: Number(r.querySelector("select").value),
        minutes: Math.round(Number(r.querySelector("input").value) * 60),
      })),
      max_per_day: maxPerDay.value === "" ? null : Number(maxPerDay.value),
      times: [...timeList.querySelectorAll("input")].map((i) => i.value).filter(Boolean),
      days: { mode, weekdays: [...weekdays].sort(), every: Number(everyInput.value), start: startInput.value },
      nag: nag.value,
      nag_every: Number(nagEvery.value),
      nag_repeats: nagRepeats.value === "" ? null : Number(nagRepeats.value),
      latest_time: latestOn.input.checked ? latestInput.value : null,
      hard_to_miss: hard.input.checked,
      hard_after: Number(hardAfter.value),
      alarm_sound: alarm.input.checked,
      announce: announce.input.checked,
      linked_entity: linked.value || null,
      linked_time_entity: linkedTime.value || null,
      early_window: Number(early.value),
    };
    try {
      await api("PUT", `api/trackers/${t.id}/schedule`, { enabled: enabled.input.checked, settings });
      sheet.close();
      toast(enabled.input.checked ? `Reminders for ${t.name} saved` : `Reminders for ${t.name} off`);
      if (currentTab() === "settings") await renderSettings(view);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      err.scrollIntoView({ block: "nearest" });
    }
  });

  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
}

async function openPersonSheet(view) {
  const sheet = document.getElementById("sheet");
  let s, ha;
  try {
    haOptionsCache = null; // phones may have been added since last time
    [s, ha] = await Promise.all([api("GET", "api/reminders/settings"), haOptions()]);
  } catch (err) { toast(err.message); return; }
  const err = el("p", { class: "form-error", hidden: true });

  const phoneBoxes = ha.phones.map((p) => {
    const box = el("input", { type: "checkbox", value: p.service });
    box.checked = s.devices.includes(p.service);
    return el("label", { class: "check" }, box, el("span", {}, p.name));
  });
  const phones = ha.phones.length ? el("div", { class: "checks" }, phoneBoxes)
    : notice(ha.connected
      ? "No phones with the Home Assistant app were found. Install the Companion app and sign in, then come back."
      : "Can't reach Home Assistant right now, so phones can't be listed.");
  const testBtn = el("button", { type: "button", class: "secondary small", onclick: async () => {
    try {
      await saveIt(false);
      const r = await api("POST", "api/reminders/test");
      toast(`Test sent to ${r.sent_to === 1 ? "1 phone" : r.sent_to + " phones"}`);
    } catch (e) { toast(e.message); }
  } }, "Send a test");

  const group = switchField("Combine medications due at the same time", s.group_doses, "One reminder instead of several.");
  const undo = switchField("Offer Undo after I answer", s.undo, "For a minute, in case of a mis-tap.");
  const swipe = switchField("Let me swipe reminders away", s.swipe_away, "When off, reminders stay until you answer them.");
  const snooze = selectOf([5, 10, 15, 20, 30, 45, 60].map((n) => [n, `${n} minutes`]), s.snooze_minutes);

  const quiet = switchField("Quiet hours", s.quiet.enabled, "No alarm sounds or speaker announcements. Reminders still arrive.");
  const qStart = el("input", { type: "time", value: s.quiet.start, "aria-label": "Quiet hours start" });
  const qEnd = el("input", { type: "time", value: s.quiet.end, "aria-label": "Quiet hours end" });
  const quietPanel = el("div", { class: "subpanel inline-field" }, el("span", {}, "From"), qStart, el("span", {}, "to"), qEnd);
  const drawQuiet = () => { quietPanel.hidden = !quiet.input.checked; };
  quiet.input.addEventListener("change", drawQuiet);
  drawQuiet();

  const speakerBoxes = ha.speakers.map((p) => {
    const box = el("input", { type: "checkbox", value: p.entity_id });
    box.checked = s.speakers.includes(p.entity_id);
    return el("label", { class: "check" }, box, el("span", {}, p.name));
  });
  const voice = selectOf([["", "Choose a voice"], ...ha.voices.map((v) => [v.entity_id, v.name])], s.tts_entity);
  const onlyHome = switchField("Only when I'm home", s.announce_only_home,
    ha.people.some((p) => p.is_you) ? "Uses your Home Assistant person." : "Needs a Home Assistant person linked to your user.");
  const speakerDetails = el("details", { class: "more", open: !!s.speakers.length },
    el("summary", {}, "Speaker announcements"),
    el("p", { class: "hint" }, "Used when a medication is set to announce. Pick where and which voice."),
    speakerBoxes.length ? el("div", { class: "checks" }, speakerBoxes) : notice("No speakers found."),
    field("Voice", voice), onlyHome.node);

  async function saveIt(close = true) {
    const payload = {
      devices: phoneBoxes.map((l) => l.querySelector("input")).filter((b) => b.checked).map((b) => b.value),
      group_doses: group.input.checked,
      undo: undo.input.checked,
      swipe_away: swipe.input.checked,
      snooze_minutes: Number(snooze.value),
      quiet: { enabled: quiet.input.checked, start: qStart.value, end: qEnd.value },
      speakers: speakerBoxes.map((l) => l.querySelector("input")).filter((b) => b.checked).map((b) => b.value),
      tts_entity: voice.value || null,
      announce_only_home: onlyHome.input.checked,
      person_entity: s.person_entity,
    };
    await api("PUT", "api/reminders/settings", payload);
    if (close) {
      sheet.close();
      toast("Reminder settings saved");
      if (currentTab() === "settings") await renderSettings(view);
    }
  }

  const form = el("form", { method: "dialog" },
    el("h2", {}, "Reminder settings"),
    err,
    field("Send reminders to", el("div", {}, phones, ha.phones.length ? testBtn : null),
      "Answering on one phone clears the reminder on the others."),
    group.node, undo.node, swipe.node,
    field("Snooze for", snooze),
    quiet.node, quietPanel,
    speakerDetails,
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, "Save"),
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel")));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    try { await saveIt(true); }
    catch (e) { err.textContent = e.message; err.hidden = false; }
  });

  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
}

/* ================= start ================= */

async function refreshTrackers() {
  state.trackers = await api("GET", "api/trackers");
}

async function start() {
  document.getElementById("save").addEventListener("click", saveCheckin);
  document.getElementById("discard").addEventListener("click", () => {
    state.pending.clear();
    updateSaveBar();
    drawCheckin(document.getElementById("view"));
  });
  document.getElementById("sheet").addEventListener("click", (ev) => {
    if (ev.target.id === "sheet") ev.target.close(); // tap outside closes
  });
  window.addEventListener("beforeunload", (ev) => {
    if (state.pending.size) ev.preventDefault();
  });
  window.addEventListener("hashchange", route);
  try {
    [state.me, state.meta] = await Promise.all([api("GET", "api/me"), api("GET", "api/meta")]);
    await refreshTrackers();
  } catch (err) {
    document.getElementById("view").replaceChildren(
      el("p", { class: "form-error" }, `Couldn't start: ${err.message}`));
    return;
  }
  route();
}

start();
