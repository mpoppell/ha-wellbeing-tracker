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
function toast(msg, actionLabel, onAction) {
  const t = document.getElementById("toast");
  const parts = [el("span", {}, msg)];
  if (actionLabel) {
    parts.push(el("button", { type: "button", class: "toast-action", onclick: async () => {
      t.classList.remove("show");
      await onAction();
    } }, actionLabel));
  }
  t.replaceChildren(...parts);
  t.classList.toggle("has-action", !!actionLabel);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), actionLabel ? 6000 : 2200);
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
  allTrackers: [],
  person: null,
  editing: false,
  historyDays: 14,
};

function fmtNum(n) {
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

// "30 mg", or "2 × 30 mg (60 mg)"
function doseText(t, e) {
  const c = t.config;
  const n = e && e.value_num != null ? e.value_num : 1;
  const strength = e && e.value_json && e.value_json.dose != null ? e.value_json.dose : c.dose;
  const unit = c.unit || "";
  if (strength == null || strength === "") return n === 1 ? "1 dose" : `${fmtNum(n)} doses`;
  const one = `${fmtNum(strength)} ${unit}`.trim();
  return n === 1 ? one : `${fmtNum(n)} × ${one} (${fmtNum(n * Number(strength))} ${unit})`.replace(" )", ")");
}

// 0.5 -> "½", 1.5 -> "1½", 2 -> "2"
function fmtQty(q) {
  const v = Number(q);
  const whole = Math.trunc(v);
  const frac = Math.round((v - whole) * 1000) / 1000;
  const sym = { 0.25: "¼", 0.5: "½", 0.75: "¾" }[frac];
  if (!frac) return String(whole);
  return sym ? (whole ? String(whole) : "") + sym : fmtNum(v);
}

// "½ dose", "2 tablets"
function qtyText(t, q) {
  return `${fmtQty(q)} ${plural(t.config.counted_as || "dose", Number(q) > 1 ? 2 : 1)}`;
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
    case "medication": return doseText(t, e);
    case "factor":
      if (c.mode === "bool") return e.value_num ? "Yes" : "No";
      return `${fmtNum(e.value_num)}${c.unit ? " " + c.unit : ""}`;
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

/* ================= check-in dashboard ================= */

function entriesFor(trackerId) {
  return state.dayEntries.filter((e) => e.tracker_id === trackerId);
}

function dailyEntry(t) {
  return t.frequency === "daily" ? entriesFor(t.id)[0] || null : null;
}

// Everything on Check-in saves the moment you tap it.
function updateSaveBar() { /* no save bar */ }

async function loadDay() {
  const isToday = state.day === isoDay(new Date());
  const [entries, doses, person, all] = await Promise.all([
    api("GET", `api/entries?from=${state.day}&to=${state.day}`),
    isToday ? api("GET", "api/doses/today").catch(() => []) : Promise.resolve([]),
    api("GET", "api/reminders/settings").catch(() => state.person),
    api("GET", "api/trackers?include_hidden=true"),
  ]);
  state.dayEntries = entries;
  state.doses = doses;
  state.person = person;
  state.allTrackers = all;
  state.trackers = all.filter((t) => !t.hidden);
  state.nextCheckin = isToday ? (await api("GET", "api/checkins/next").catch(() => ({}))).time : null;
}

async function renderCheckin(view) {
  if (!view.children.length) view.replaceChildren(el("p", { class: "loading" }, "Loading…"));
  await loadDay();
  drawCheckin(view);
}

const viewEl = () => document.getElementById("view");

async function refreshCheckin() {
  await loadDay();
  drawCheckin(viewEl());
}

async function quickSave(items, when) {
  try {
    const res = await api("POST", "api/checkin", { logged_at: when || loggedAtFor(state.day), items });
    await refreshCheckin();
    return res;
  } catch (err) { toast(err.message); return null; }
}

async function removeEntry(entry) {
  try {
    await api("DELETE", `api/entries/${entry.id}`);
    await refreshCheckin();
  } catch (err) { toast(err.message); }
}

/* ---------- icons ---------- */

Object.assign(ICONS, {
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1.1",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  pill: "M10.5 20.5l10-10a5 5 0 0 0-7-7l-10 10a5 5 0 0 0 7 7zM8.5 8.5l7 7",
  move: "M7 7l-4 4 4 4M17 7l4 4-4 4M3 11h18",
  copy: "M8 8h11v11H8zM5 16V5h11",
});

const SECTION_ICONS = [
  [/feel|mood|emotion/, "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10zM5 12h3l2-3 2 5 2-3h5"],
  [/symptom|pain|side effect|body/, "M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0zM12 17v-5"],
  [/sleep|rest/, "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"],
  [/medic|meds|supplement/, ICONS.pill],
  [/life|habit|activ|exercise|social/, "M5 19c0-8 5-13 14-14 0 9-5 14-13 14zM5 19l7-7"],
  [/note|journal|diary/, "M4 20h4L19 9l-4-4L4 16v4z"],
  [/water|drink|food|nutrition|diet/, "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"],
];
function sectionIcon(name) {
  const hit = SECTION_ICONS.find(([re]) => re.test(name.toLowerCase()));
  return svgIcon(hit ? hit[1] : "M4 6h16M4 12h16M4 18h10");
}

const FACE_MOUTHS = ["M8 17q4-4.5 8 0", "M8.5 16.3q3.5-2.3 7 0", "M8.5 15.5h7", "M8.5 14.5q3.5 2.5 7 0", "M7.8 13.8q4.2 5 8.4 0"];
function faceIcon(level) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("class", "face");
  for (const [tag, attrs] of [
    ["circle", { cx: 12, cy: 12, r: 9.5 }],
    ["circle", { cx: 9, cy: 10, r: 0.9, class: "eye" }],
    ["circle", { cx: 15, cy: 10, r: 0.9, class: "eye" }],
    ["path", { d: FACE_MOUTHS[level] }],
  ]) {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    s.append(n);
  }
  return s;
}

function barsIcon(level) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("class", "bars");
  [[5, 14, 3, 5], [10.5, 10, 3, 9], [16, 6, 3, 13]].forEach(([x, y, w, h], i) => {
    const r = document.createElementNS(ns, "rect");
    Object.entries({ x, y, width: w, height: h, rx: 1.2 }).forEach(([k, v]) => r.setAttribute(k, v));
    r.setAttribute("class", i < level ? "on" : "off");
    s.append(r);
  });
  if (level === 0) {
    const l = document.createElementNS(ns, "path");
    l.setAttribute("d", "M4 20L20 4");
    l.setAttribute("class", "slash");
    s.append(l);
  }
  return s;
}

const SEVERITY_COLOURS = ["var(--sev0)", "var(--sev1)", "var(--sev2)", "var(--sev3)"];
const SCALE_VARS = ["--r1", "--r2", "--r3", "--r4", "--r5"];

function scaleBin(cfg, v) {
  const n = cfg.max - cfg.min + 1;
  return Math.min(4, Math.floor(((v - cfg.min) * 5) / n));
}

function scaleColor(cfg, v) {
  return `var(${SCALE_VARS[scaleBin(cfg, v)]})`;
}

function ratingText(c, v) {
  const label = (c.labels || [])[v - c.min];
  return label ? `${label} (${v})` : `${v} of ${c.max}`;
}

/* ---------- layout: which sections, in what order ---------- */

const isMeds = (t) => t.kind === "medication";

function sectionName(t) {
  return t.group_name || (isMeds(t) ? "Meds/Supplements" : "Other");
}

// Sections in the saved order, then any new ones in the order their items appear.
function dashboardSections(includeHidden) {
  const saved = (state.person && state.person.dashboard && state.person.dashboard.sections) || [];
  const trackers = includeHidden ? state.allTrackers : state.trackers;
  const byName = new Map();
  for (const t of trackers) {
    const n = sectionName(t);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(t);
  }
  const out = [];
  for (const s of saved) out.push({ name: s.name, hidden: s.hidden, items: byName.get(s.name) || [] });
  for (const [name, items] of byName) {
    if (!saved.some((s) => s.name === name)) out.push({ name, hidden: false, items });
  }
  // Meds/Supplements first by default, like Bearable, unless you've arranged them yourself
  if (!saved.length) out.sort((a, b) => Number(b.items.some(isMeds)) - Number(a.items.some(isMeds)));
  return out;
}

async function saveLayout(sections) {
  state.person = await api("PUT", "api/reminders/settings",
    { dashboard: { sections: sections.map((s) => ({ name: s.name, hidden: !!s.hidden })) } });
}

let collapsed = new Set();
try { collapsed = new Set(JSON.parse(localStorage.getItem("wbt-collapsed") || "[]")); } catch { /* private mode */ }
function toggleCollapsed(key) {
  if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
  try { localStorage.setItem("wbt-collapsed", JSON.stringify([...collapsed])); } catch { /* ignore */ }
  drawCheckin(viewEl());
}

/* ---------- small building blocks ---------- */

function rowName(t) {
  return el("span", { class: "brow-name" }, t.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, t.emoji) : null, t.name);
}

function levelLine(text, colour, onClear) {
  if (!text) return null;
  return el("span", { class: "brow-level", style: colour ? `--lc:${colour}` : "" },
    onClear ? el("button", { type: "button", class: "clear", "aria-label": "Clear", title: "Clear", onclick: onClear }, svgIcon(ICONS.minus)) : null,
    el("span", {}, text));
}

function brow(t, levelNode, right, below) {
  return el("div", { class: "brow" },
    el("div", { class: "brow-main" },
      el("div", { class: "brow-text" }, rowName(t), levelNode),
      right ? el("div", { class: "brow-right" }, right) : null),
    below || null);
}

function tile(content, attrs = {}) {
  return el("button", { type: "button", class: "tile", ...attrs }, content);
}

/* ---------- the screen ---------- */

function drawCheckin(view) {
  const today = isoDay(new Date());
  const name = (state.me.display_name || state.me.username || "").split(" ")[0];
  const isToday = state.day === today;
  const editing = !!state.editing;

  const head = el("header", { class: "head head-row" },
    el("div", {},
      el("h1", {}, editing ? "Edit your dashboard" : isToday ? (name ? `How are you, ${name}?` : "How are you?")
        : `Check-in for ${state.day === addDays(today, -1) ? "yesterday" : dayLabel(state.day)}`),
      editing ? el("p", {}, "Reorder, rename or hide sections, and edit, move or hide anything in them.")
        : el("div", { class: "dayswitch" },
            el("button", { type: "button", class: "iconbtn", "aria-label": "Previous day", onclick: () => changeDay(-1) }, svgIcon(ICONS.left)),
            el("span", { class: "day-label" }, longDate(state.day)),
            el("button", { type: "button", class: "iconbtn", "aria-label": "Next day", disabled: isToday, onclick: () => changeDay(1) }, svgIcon(ICONS.right))),
      !editing && isToday && state.nextCheckin ? el("p", { class: "row-sub" }, `Next check-in reminder at ${niceTime(state.nextCheckin)}`) : null),
    editing
      ? el("button", { type: "button", class: "primary small", onclick: () => { state.editing = false; drawCheckin(view); } }, "Done")
      : el("button", { type: "button", class: "iconbtn", "aria-label": "Edit dashboard", title: "Edit dashboard",
          onclick: () => { state.editing = true; drawCheckin(view); } }, svgIcon(ICONS.edit)),
  );

  const sections = dashboardSections(editing).filter((s) => editing || (!s.hidden && s.items.length));
  const cards = sections.map((s, i) => editing ? editSectionCard(s, i, sections, view) : sectionCard(s, view));

  const extra = [];
  if (editing) {
    extra.push(el("div", { class: "actions" },
      el("button", { type: "button", class: "secondary", onclick: () => addSection(sections) }, "+ Add section")));
  } else if (!state.trackers.length) {
    extra.push(el("div", { class: "empty" },
      el("p", {}, "You're not tracking anything yet."),
      el("button", { type: "button", class: "primary", onclick: () => { state.editing = true; drawCheckin(view); } }, "Set up your dashboard")));
  }
  view.replaceChildren(...[head, !editing && isToday ? dueCard(view) : null, ...cards, ...extra].filter(Boolean));
}

async function changeDay(delta) {
  const next = addDays(state.day, delta);
  if (next > isoDay(new Date())) return;
  state.day = next;
  await renderCheckin(viewEl());
}

/* ---------- a section card (accordion) ---------- */

function answeredCount(items) {
  if (items.some(isMeds)) return new Set(state.dayEntries.filter((e) => items.some((t) => t.id === e.tracker_id)).map((e) => e.tracker_id)).size;
  return items.filter((t) => entriesFor(t.id).length).length;
}

function sectionCard(s, view) {
  const key = `section:${s.name}`;
  const open = !collapsed.has(key);
  const meds = s.items.some(isMeds);
  const count = answeredCount(s.items);
  const header = el("div", { class: "card-head" },
    el("button", { type: "button", class: "card-toggle", "aria-expanded": String(open), onclick: () => toggleCollapsed(key) },
      el("span", { class: "card-icon" }, sectionIcon(s.name)),
      el("span", { class: "card-title" }, s.name),
      count ? el("span", { class: "card-count", "aria-label": `${count} logged today` }, String(count)) : null,
      el("span", { class: "card-chevron" }, svgIcon(open ? ICONS.up : ICONS.down))),
    el("button", { type: "button", class: "iconbtn plain", "aria-label": `${s.name} options`, title: "Options",
      onclick: () => openSectionMenu(s, view) }, svgIcon(ICONS.dots)));

  let body = null;
  if (open) {
    if (meds) body = medsBody(s, view);
    else {
      const rows = [];
      const chips = [];
      for (const t of s.items) {
        if (t.kind === "factor" && t.config.mode === "bool") chips.push(t);
        else rows.push(trackerRow(t, view));
      }
      body = [...rows, chips.length ? el("div", { class: "bchips" }, chips.map(factorChip),
        el("button", { type: "button", class: "chip chip-add", "aria-label": `Add something to ${s.name}`,
          onclick: () => openTrackerSheet({ kind: "factor", group_name: s.name, config: { mode: "bool" } }, view) }, svgIcon(ICONS.plus))) : null];
    }
  }
  return el("section", { class: `card${open ? "" : " closed"}` }, header, open ? el("div", { class: "card-body" }, body) : null);
}

function openSectionMenu(s, view) {
  const sheet = document.getElementById("sheet");
  const meds = s.items.some(isMeds);
  const item = (label, fn) => el("button", { type: "button", class: "menu-item", onclick: () => { sheet.close(); fn(); } }, label);
  sheet.replaceChildren(el("div", { class: "sheet-body" },
    el("h2", {}, s.name),
    el("div", { class: "menu" },
      meds ? item("Add a medication", () => openTrackerSheet({ kind: "medication", group_name: s.name }, view))
        : item(`Add something to ${s.name}`, () => openTrackerSheet({ kind: "rating", group_name: s.name }, view)),
      meds ? item("Create a group", () => openGroupSheet(null, view)) : null,
      meds ? item("Reminders and phones", () => { location.hash = "#/settings"; }) : null,
      item("Edit dashboard", () => { state.editing = true; drawCheckin(view); })),
    el("div", { class: "actions" }, el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Close"))));
  sheet.showModal();
}

/* ---------- edit mode ---------- */

function editSectionCard(s, i, sections, view) {
  const move = async (d) => {
    const order = sections.slice();
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await saveLayout(order);
    drawCheckin(view);
  };
  const toggleHidden = async () => {
    const order = sections.map((x) => x.name === s.name ? { ...x, hidden: !x.hidden } : x);
    await saveLayout(order);
    drawCheckin(view);
  };
  const rename = async () => {
    const to = (prompt("Rename section", s.name) || "").trim();
    if (!to || to === s.name) return;
    try {
      await api("POST", "api/sections/rename", { from: s.name, to });
      if (!s.items.length) await saveLayout(sections.map((x) => x.name === s.name ? { ...x, name: to } : x));
      await refreshCheckin();
    } catch (err) { toast(err.message); }
  };
  const header = el("div", { class: "card-head edit" },
    el("span", { class: "card-icon" }, sectionIcon(s.name)),
    el("span", { class: "card-title" }, s.name, s.hidden ? el("span", { class: "muted-tag" }, " Hidden") : null),
    el("div", { class: "edit-tools" },
      el("button", { type: "button", class: "iconbtn plain", "aria-label": `Move ${s.name} up`, disabled: i === 0, onclick: () => move(-1) }, svgIcon(ICONS.up)),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": `Move ${s.name} down`, disabled: i === sections.length - 1, onclick: () => move(1) }, svgIcon(ICONS.down)),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": `Rename ${s.name}`, onclick: rename }, svgIcon(ICONS.edit)),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": s.hidden ? `Show ${s.name}` : `Hide ${s.name}`,
        title: s.hidden ? "Show section" : "Hide section", onclick: toggleHidden }, svgIcon(s.hidden ? ICONS.eye : ICONS.eyeOff))));

  const meds = s.items.some(isMeds) || /med|supplement/i.test(s.name);
  const rows = s.items.map((t, j) => editItemRow(t, j, s, sections, view));
  const add = el("button", { type: "button", class: "secondary small add-in-section",
    onclick: () => openTrackerSheet(meds ? { kind: "medication", group_name: s.name } : { kind: "rating", group_name: s.name }, view) },
    `+ Add to ${s.name}`);
  const groups = meds && state.person ? el("div", { class: "edit-groups" },
    el("span", { class: "row-sub" }, "Groups"),
    el("div", { class: "bchips small" },
      state.person.med_groups.map((g) => el("button", { type: "button", class: "chip", onclick: () => openGroupSheet(g, view) }, g.name, svgIcon(ICONS.edit))),
      el("button", { type: "button", class: "chip", onclick: () => openGroupSheet(null, view) }, "+ New group"))) : null;
  return el("section", { class: `card editing${s.hidden ? " dim" : ""}` }, header,
    el("div", { class: "card-body" }, rows.length ? rows : el("p", { class: "row-sub" }, "Nothing here yet."), groups, add));
}

function editItemRow(t, j, s, sections, view) {
  const siblings = s.items;
  const move = async (d) => {
    const other = siblings[j + d];
    if (!other) return;
    const order = state.allTrackers.map((x) => x.id);
    const a = order.indexOf(t.id);
    const b = order.indexOf(other.id);
    [order[a], order[b]] = [order[b], order[a]];
    await api("POST", "api/trackers/order", { ids: order });
    await refreshCheckin();
  };
  const toggleHidden = async () => {
    await api("PATCH", `api/trackers/${t.id}`, { hidden: !t.hidden });
    await refreshCheckin();
  };
  const moveTo = () => {
    const sheet = document.getElementById("sheet");
    const pick = async (name) => {
      sheet.close();
      await api("PATCH", `api/trackers/${t.id}`, { group_name: name });
      await refreshCheckin();
    };
    sheet.replaceChildren(el("div", { class: "sheet-body" },
      el("h2", {}, `Move ${t.name} to`),
      el("div", { class: "menu" }, sections.filter((x) => x.name !== s.name).map((x) =>
        el("button", { type: "button", class: "menu-item", onclick: () => pick(x.name) }, x.name))),
      el("div", { class: "actions" }, el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel"))));
    sheet.showModal();
  };
  return el("div", { class: `edit-row${t.hidden ? " dim" : ""}` },
    el("div", { class: "brow-text" }, rowName(t), el("span", { class: "row-sub" }, t.hidden ? "Hidden" : describeTracker(t))),
    el("div", { class: "edit-tools" },
      el("button", { type: "button", class: "iconbtn plain", "aria-label": `Move ${t.name} up`, disabled: j === 0, onclick: () => move(-1) }, svgIcon(ICONS.up)),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": `Move ${t.name} down`, disabled: j === siblings.length - 1, onclick: () => move(1) }, svgIcon(ICONS.down)),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": `Edit ${t.name}`, title: "Edit", onclick: () => openTrackerSheet(t, view) }, svgIcon(ICONS.edit)),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": `Move ${t.name} to another section`, title: "Move to another section", onclick: moveTo }, svgIcon(ICONS.move)),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": t.hidden ? `Show ${t.name}` : `Hide ${t.name}`,
        title: t.hidden ? "Show" : "Hide", onclick: toggleHidden }, svgIcon(t.hidden ? ICONS.eye : ICONS.eyeOff))));
}

async function addSection(sections) {
  const name = (prompt("Name the new section") || "").trim();
  if (!name) return;
  if (sections.some((s) => s.name === name)) { toast("There's already a section with that name"); return; }
  await saveLayout([...sections, { name, hidden: false, items: [] }]);
  drawCheckin(viewEl());
}

/* ---------- due now ---------- */

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
    return el("div", { class: "brow" },
      el("div", { class: "brow-text" },
        el("span", { class: "brow-name" }, d.name, d.amount ? el("span", { class: "due-amount" }, ` ${d.amount}`) : null),
        el("span", { class: "row-sub" }, status)),
      el("div", { class: "due-actions" },
        el("button", { type: "button", class: "primary small", onclick: () => act(d, "taken") }, "Taken now"),
        el("button", { type: "button", class: "secondary small", onclick: () => {
          const t = state.trackers.find((x) => x.id === d.tracker_id);
          if (t) openDoseDialog(t, null);
        } }, "Taken at…"),
        d.last_call ? null : el("button", { type: "button", class: "secondary small", onclick: () => act(d, "snooze") }, "Snooze"),
        el("button", { type: "button", class: "secondary small", onclick: () => act(d, "skip") }, "Skip")));
  });
  const laterText = later.length ? `Later today: ${joinNames(later.map((d) => `${d.name}${d.amount ? " " + d.amount : ""} at ${niceTime(d.time)}`))}` : null;
  return el("section", { class: "card due-card", "aria-label": "Medications due" },
    el("div", { class: "card-head" },
      el("span", { class: "card-icon" }, svgIcon(ICONS.bell)),
      el("span", { class: "card-title" }, due.length ? "Due now" : "Coming up"),
      due.length ? el("span", { class: "card-count" }, String(due.length)) : null),
    el("div", { class: "card-body" }, rows, laterText ? el("p", { class: "row-sub due-later" }, laterText) : null));
}

/* ---------- Meds/Supplements ---------- */

function plural(word, n) {
  if (!word) return "";
  if (Number(n) === 1) return word;
  if (/(s|x|ch|sh)$/.test(word)) return word + "es";
  return word + "s";
}

function usualText(t) {
  const c = t.config;
  const q = c.quantity ?? 1;
  return `${fmtNum(q)} ${plural(c.counted_as || "dose", q)}`;
}

function strengthText(t) {
  const c = t.config;
  return c.dose != null && c.dose !== "" ? `${fmtNum(c.dose)}${c.unit || ""}` : (c.unit || "");
}

function medsBody(s, view) {
  const gkey = `groups:${s.name}`;
  const groupsOpen = !collapsed.has(gkey);
  const groups = (state.person && state.person.med_groups) || [];
  const groupBlock = el("div", { class: "med-groups" },
    el("div", { class: "med-groups-head" },
      el("button", { type: "button", class: "sub-toggle", "aria-expanded": String(groupsOpen), onclick: () => toggleCollapsed(gkey) },
        "Groups", svgIcon(groupsOpen ? ICONS.up : ICONS.down)),
      el("button", { type: "button", class: "link inline-icon", onclick: () => copyLast(s) }, svgIcon(ICONS.copy), "Copy last")),
    groupsOpen ? el("div", { class: "bchips small" },
      groups.map((g) => el("button", { type: "button", class: "chip", title: `Log ${g.name}`, onclick: () => logGroup(g) }, g.name)),
      el("button", { type: "button", class: "chip chip-ghost", onclick: () => openGroupSheet(null, view) }, "+ Create new group")) : null);
  const rows = s.items.filter(isMeds).map((t) => medRow(t, view));
  const others = s.items.filter((t) => !isMeds(t)).map((t) => trackerRow(t, view));
  return [groupBlock, ...rows, ...others];
}

function medRow(t, view) {
  const taken = entriesFor(t.id).slice().reverse(); // earliest first
  const c = t.config;
  const planned = state.doses.filter((d) => d.tracker_id === t.id && d.local_day === state.day && d.status !== "cancelled");
  const totalQty = taken.reduce((a, e) => a + Number(e.value_num || 1), 0);
  const totalStrength = taken.reduce((a, e) => {
    const strength = e.value_json && e.value_json.dose != null ? e.value_json.dose : c.dose;
    return strength != null && strength !== "" ? a + Number(strength) * Number(e.value_num || 1) : a;
  }, 0);
  const add = el("button", { type: "button", class: "dose-add", "aria-label": `Log ${t.name}`, onclick: () => openDoseDialog(t, null) }, svgIcon(ICONS.plus));
  const squares = taken.map((e) => el("div", { class: "dose-cell" },
    el("button", { type: "button", class: "dose-square", "aria-label": `${t.name} at ${timeOf(e.logged_at)}, ${doseText(t, e)}. Change or delete`,
      onclick: () => openDoseDialog(t, e) }, fmtQty(e.value_num ?? 1)),
    el("span", { class: "dose-time" }, timeOf(e.logged_at))));
  const strength = strengthText(t);
  const title = el("div", { class: "brow-text" },
    el("div", { class: "med-title" },
      el("span", { class: "brow-name" }, t.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, t.emoji) : null, t.name),
      strength ? el("span", { class: "med-strength" }, ` (${strength})`) : null),
    planned.length
      ? el("button", { type: "button", class: "row-sub med-plan", title: "Change reminders",
          "aria-label": `Reminders today: ${planned.map((d) => `${qtyText(t, d.quantity)} at ${niceTime(d.time)}, ${d.status}`).join("; ")}. Change reminders`,
          onclick: () => openScheduleSheet(t, view) },
          planned.map((d) => el("span", { class: `plan-dose plan-${d.status}` },
            `${qtyText(t, d.quantity)} at ${niceTime(d.time)}`,
            d.status === "taken" ? el("span", { class: "plan-mark", "aria-hidden": "true" }, " ✓")
              : d.status === "skipped" || d.status === "missed" ? el("span", { class: "plan-mark" }, ` (${d.status})`) : null)))
      : el("div", { class: "row-sub" }, usualText(t)));
  if (!taken.length) {
    return el("div", { class: "med-row" }, el("div", { class: "brow-main" }, title, add));
  }
  return el("div", { class: "med-row" }, title,
    el("div", { class: "med-main" },
      el("div", { class: "dose-cells" }, squares, el("div", { class: "dose-cell" }, add)),
      el("div", { class: "med-total", "aria-label": "Total today" },
        el("strong", {}, qtyText(t, totalQty)),
        totalStrength ? el("span", {}, `${fmtNum(totalStrength)}${c.unit || ""}`) : null)));
}

// The dose dialog: ×N with −1/−0.5/+0.5/+1, strength, time, delete, Confirm.
function openDoseDialog(t, entry) {
  const sheet = document.getElementById("sheet");
  const c = t.config;
  const day = entry ? entry.day : state.day;
  const now = new Date();
  let time = entry ? /T(\d{2}:\d{2})/.exec(entry.logged_at)[1] : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const dueNow = entry ? null : state.doses.find((d) => d.tracker_id === t.id && (d.status === "due" || (d.status === "scheduled" && d.local_day === state.day)));
  let count = entry ? Number(entry.value_num ?? 1) : Number(dueNow ? dueNow.quantity : c.quantity ?? 1);
  let strength = entry && entry.value_json && entry.value_json.dose != null ? entry.value_json.dose : c.dose;

  const countOut = el("span", { class: "dose-big", "aria-live": "polite" });
  const drawCount = () => { countOut.textContent = `× ${fmtNum(count)}`; };
  drawCount();
  const step = (d) => { count = Math.max(0.25, Math.round((count + d) * 4) / 4); drawCount(); };

  const strengthBtn = el("button", { type: "button", class: "strength-edit" });
  const strengthInput = el("input", { type: "number", min: "0", step: "any", inputmode: "decimal", hidden: true, "aria-label": "Strength", style: "width:6em" });
  const drawStrength = () => strengthBtn.replaceChildren(el("span", {}, strength != null && strength !== "" ? fmtNum(strength) : "Add"), svgIcon(ICONS.edit));
  strengthBtn.addEventListener("click", () => { strengthBtn.hidden = true; strengthInput.hidden = false; strengthInput.value = strength ?? ""; strengthInput.focus(); });
  strengthInput.addEventListener("change", () => { strength = strengthInput.value === "" ? null : Number(strengthInput.value); drawStrength(); strengthInput.hidden = true; strengthBtn.hidden = false; });
  drawStrength();

  const timeBtn = el("button", { type: "button", class: "time-pill" });
  const timeInput = el("input", { type: "time", hidden: true, "aria-label": "Time taken" });
  const drawTime = () => timeBtn.replaceChildren(niceTime(time));
  timeBtn.addEventListener("click", () => { timeBtn.hidden = true; timeInput.hidden = false; timeInput.value = time; timeInput.focus(); });
  timeInput.addEventListener("change", () => { time = timeInput.value || time; drawTime(); timeInput.hidden = true; timeBtn.hidden = false; });
  drawTime();

  const err = el("p", { class: "form-error", hidden: true });
  const confirmIt = async () => {
    const [h, m] = time.split(":").map(Number);
    const when = dayToDate(day);
    when.setHours(h, m, 0, 0);
    if (when > new Date()) { err.textContent = "That time hasn't happened yet."; err.hidden = false; return; }
    const value_json = strength != null && strength !== "" ? { dose: Number(strength) } : null;
    try {
      if (entry) await api("PATCH", `api/entries/${entry.id}`, { logged_at: localISO(when), value_num: count, value_json });
      else await api("POST", "api/checkin", { logged_at: localISO(when), items: [{ tracker_id: t.id, value_num: count, value_json }] });
      sheet.close();
      await refreshCheckin();
      toast(entry ? "Dose changed" : `${t.name} logged at ${niceTime(time)}`);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };

  const body = el("div", { class: "dose-dialog" },
    el("div", { class: "dose-top" },
      entry ? el("button", { type: "button", class: "iconbtn plain dose-delete", "aria-label": "Delete this dose", title: "Delete",
        onclick: async () => {
          if (!confirm(`Delete the ${t.name} dose at ${niceTime(time)}?`)) return;
          sheet.close();
          await removeEntry(entry);
          toast("Dose deleted");
        } }, svgIcon(ICONS.trash)) : null,
      el("button", { type: "button", class: "iconbtn plain dose-close", "aria-label": "Close", onclick: () => sheet.close() }, svgIcon(ICONS.close)),
      el("div", { class: "dose-count" }, svgIcon(ICONS.pill), countOut),
      el("div", { class: "dose-steps" }, [-1, -0.5, 0.5, 1].map((d) =>
        el("button", { type: "button", class: "round-step", "aria-label": `${d > 0 ? "Add" : "Take away"} ${Math.abs(d)}`, onclick: () => step(d) },
          d > 0 ? `+${d}` : `${d}`)))),
    el("div", { class: "dose-bottom" },
      el("div", { class: "brow-name" }, t.name),
      el("div", { class: "dose-meta" },
        el("div", { class: "dose-strength" }, el("div", {}, strengthBtn, strengthInput), el("span", { class: "row-sub" }, c.unit || "strength")),
        el("div", {}, timeBtn, timeInput)),
      err),
    el("button", { type: "button", class: "primary confirm", onclick: confirmIt }, entry ? "Save changes" : "Confirm"));
  sheet.classList.add("center");
  sheet.addEventListener("close", () => sheet.classList.remove("center"), { once: true });
  sheet.replaceChildren(body);
  sheet.showModal();
}

async function logGroup(g) {
  const items = g.items.filter((it) => state.trackers.some((t) => t.id === it.tracker_id))
    .map((it) => ({ tracker_id: it.tracker_id, value_num: it.quantity }));
  if (!items.length) { toast(`${g.name} has no medications to log`); return; }
  const res = await quickSave(items, loggedAtFor(state.day));
  if (res) toast(`${g.name} logged (${items.length})`, "Undo", async () => {
    for (const e of res.saved) await api("DELETE", `api/entries/${e.id}`).catch(() => {});
    await refreshCheckin();
  });
}

// Copy the doses from the last day you logged any, at the same times.
async function copyLast(s) {
  const medIds = new Set(s.items.filter(isMeds).map((t) => t.id));
  const past = await api("GET", `api/entries?from=${addDays(state.day, -30)}&to=${addDays(state.day, -1)}`);
  const meds = past.filter((e) => medIds.has(e.tracker_id));
  if (!meds.length) { toast("Nothing logged in the last 30 days to copy"); return; }
  const lastDay = meds.map((e) => e.day).sort().pop();
  const fromDay = meds.filter((e) => e.day === lastDay);
  const now = new Date();
  const copies = fromDay.map((e) => {
    const [h, m] = /T(\d{2}):(\d{2})/.exec(e.logged_at).slice(1).map(Number);
    const when = dayToDate(state.day);
    when.setHours(h, m, 0, 0);
    return { e, when };
  }).filter(({ when }) => when <= now);
  if (!copies.length) { toast(`Nothing from ${dayLabel(lastDay)} has come round yet today`); return; }
  const names = (id) => (state.trackers.find((t) => t.id === id) || {}).name;
  const summary = copies.map(({ e, when }) => `${names(e.tracker_id)} at ${timeOf(localISO(when))}`).join(", ");
  if (!confirm(`Copy from ${dayLabel(lastDay)}: ${summary}?`)) return;
  const created = [];
  try {
    for (const { e, when } of copies.reverse()) {
      const r = await api("POST", "api/checkin", { logged_at: localISO(when),
        items: [{ tracker_id: e.tracker_id, value_num: e.value_num, value_json: e.value_json }] });
      created.push(...r.saved);
    }
  } catch (err) { toast(err.message); }
  await refreshCheckin();
  toast(`Copied ${created.length} from ${dayLabel(lastDay)}`, "Undo", async () => {
    for (const e of created) await api("DELETE", `api/entries/${e.id}`).catch(() => {});
    await refreshCheckin();
  });
}

function openGroupSheet(g, view) {
  const sheet = document.getElementById("sheet");
  const meds = state.trackers.filter(isMeds);
  const name = el("input", { type: "text", maxlength: "30", value: g ? g.name : "", placeholder: "For example Morning", required: true });
  const picks = meds.map((t) => {
    const it = g ? g.items.find((x) => x.tracker_id === t.id) : null;
    const box = el("input", { type: "checkbox" });
    box.checked = !!it;
    let qty = it ? it.quantity : Number(t.config.quantity ?? 1);
    const out = el("output", {}, fmtNum(qty));
    const step = (d) => { qty = Math.max(0.5, Math.round((qty + d) * 2) / 2); out.textContent = fmtNum(qty); box.checked = true; };
    return { t, box, get qty() { return qty; }, node: el("div", { class: "group-pick" },
      el("label", { class: "check" }, box, el("span", {}, t.name, el("span", { class: "row-sub" }, ` ${strengthText(t)}`))),
      el("div", { class: "stepper" },
        el("button", { type: "button", class: "iconbtn", "aria-label": `Less ${t.name}`, onclick: () => step(-0.5) }, svgIcon(ICONS.minus)),
        out,
        el("button", { type: "button", class: "iconbtn", "aria-label": `More ${t.name}`, onclick: () => step(0.5) }, svgIcon(ICONS.plus)))) };
  });
  const err = el("p", { class: "form-error", hidden: true });
  const save = async (groups) => {
    try {
      state.person = await api("PUT", "api/reminders/settings", { med_groups: groups });
      sheet.close();
      drawCheckin(viewEl());
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };
  const form = el("form", { method: "dialog" },
    el("h2", {}, g ? `Edit ${g.name}` : "Create a group"),
    el("p", { class: "row-sub", style: "margin:-8px 0 14px" }, "Tap a group to log everything in it at once."),
    err,
    field("Name", name),
    meds.length ? el("div", { class: "field" }, el("span", {}, "Medications and how many"), picks.map((p) => p.node))
      : notice("Add a medication first."),
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, g ? "Save group" : "Create group"),
      g ? el("button", { type: "button", class: "secondary danger", onclick: () => {
        if (!confirm(`Delete the ${g.name} group? Your medications stay.`)) return;
        save(state.person.med_groups.filter((x) => x.id !== g.id));
      } }, "Delete") : null,
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel")));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const items = picks.filter((p) => p.box.checked).map((p) => ({ tracker_id: p.t.id, quantity: p.qty }));
    const updated = { id: g ? g.id : undefined, name: name.value, items };
    const groups = (state.person.med_groups || []).filter((x) => !g || x.id !== g.id);
    if (g) groups.splice(state.person.med_groups.findIndex((x) => x.id === g.id), 0, updated);
    else groups.push(updated);
    save(groups);
  });
  sheet.replaceChildren(form);
  sheet.showModal();
}

/* ---------- other kinds of row ---------- */

function factorChip(t) {
  const on = entriesFor(t.id).some((e) => e.value_num);
  return el("button", {
    type: "button", class: "chip", "aria-pressed": String(on),
    onclick: () => quickSave([on ? { tracker_id: t.id, clear: true } : { tracker_id: t.id, value_num: 1 }]),
  }, t.emoji ? el("span", { "aria-hidden": "true" }, t.emoji) : null, t.name);
}

function goalAside(c, current) {
  if (!c.goal) return null;
  const done = Number(current) >= Number(c.goal);
  return `${fmtNum(current)} of ${fmtNum(c.goal)}${c.unit ? " " + c.unit : ""}${done ? " ✓" : ""}`;
}

function trackerRow(t, view) {
  const c = t.config;
  const entries = entriesFor(t.id);
  const latest = entries[0] || null;

  if (t.kind === "rating") {
    const level = latest ? levelLine(ratingText(c, latest.value_num), scaleColor(c, latest.value_num),
      t.frequency === "daily" ? () => removeEntry(latest) : null) : levelLine("Not logged yet", "var(--muted)");
    const chips = t.frequency === "many" && entries.length
      ? el("div", { class: "bchips small" }, entries.slice().reverse().map((e) => el("button", {
          type: "button", class: "chip", style: `--lc:${scaleColor(c, e.value_num)}`,
          "aria-label": `${t.name} ${ratingText(c, e.value_num)} at ${timeOf(e.logged_at)}. Change or delete`,
          onclick: () => openRatingDialog(t, e),
        }, el("strong", { class: "chip-num" }, String(e.value_num)), timeOf(e.logged_at))))
      : null;
    const add = t.frequency === "daily" && latest
      ? tile(el("span", { class: "tile-num", style: `color:${scaleColor(c, latest.value_num)}` }, String(latest.value_num)),
          { class: "tile tile-square", "aria-label": `Change ${t.name}`, onclick: () => openRatingDialog(t, latest) })
      : tile(svgIcon(ICONS.plus), { class: "tile tile-square", "aria-label": `Log ${t.name}`, onclick: () => openRatingDialog(t) });
    return brow(t, level, add, chips);
  }

  if (t.kind === "symptom") {
    const val = latest ? latest.value_num : null;
    const labels = state.meta.severity_labels;
    const level = val != null ? levelLine(labels[val], SEVERITY_COLOURS[val], () => quickSave([{ tracker_id: t.id, clear: true }])) : null;
    const tiles = el("div", { class: "level-tiles", role: "group", "aria-label": `${t.name} severity` },
      labels.map((label, i) => tile(barsIcon(i), {
        class: `tile tile-square${val === i ? " on" : ""}`, style: `--c:${SEVERITY_COLOURS[i]}`,
        "aria-pressed": String(val === i), "aria-label": label, title: label,
        onclick: () => quickSave([val === i ? { tracker_id: t.id, clear: true } : { tracker_id: t.id, value_num: i }]),
      })));
    return brow(t, level, tiles);
  }

  if (t.kind === "tags") {
    const current = t.frequency === "daily" ? latest
      : entries.find((e) => Date.now() - new Date(e.logged_at).getTime() < 60 * 60 * 1000) || null;
    const selected = new Set(current ? current.value_json || [] : []);
    const save = async (next) => {
      try {
        if (!next.length) { if (current) await removeEntry(current); return; }
        if (current && t.frequency === "many") {
          await api("PATCH", `api/entries/${current.id}`, { value_json: next });
          await refreshCheckin();
        } else {
          await quickSave([{ tracker_id: t.id, value_json: next }]);
        }
      } catch (err) { toast(err.message); }
    };
    const chips = el("div", { class: "bchips" },
      (c.options || []).map((opt) => el("button", {
        type: "button", class: "chip", "aria-pressed": String(selected.has(opt)),
        onclick: () => { if (selected.has(opt)) selected.delete(opt); else selected.add(opt); save([...selected]); },
      }, opt)),
      el("button", { type: "button", class: "chip chip-add", "aria-label": `Add a choice to ${t.name}`, onclick: async () => {
        const opt = (prompt(`Add a choice to ${t.name}`) || "").trim();
        if (!opt) return;
        try {
          await api("PATCH", `api/trackers/${t.id}`, { config: { options: [...(c.options || []), opt] } });
          selected.add(opt);
          await save([...selected]);
        } catch (err) { toast(err.message); }
      } }, svgIcon(ICONS.plus)));
    const others = t.frequency === "many" ? entries.filter((e) => e !== current) : [];
    const level = others.length ? levelLine(`Earlier: ${others.map((e) => `${(e.value_json || []).join(", ")} at ${timeOf(e.logged_at)}`).join("; ")}`, "var(--muted)") : null;
    return brow(t, level, null, chips);
  }

  if (t.kind === "factor") {
    const val = latest ? latest.value_num : null;
    if (c.mode === "count") {
      const current = val ?? 0;
      const step = (d) => {
        const next = Math.max(0, current + d);
        quickSave([next === 0 && latest ? { tracker_id: t.id, clear: true } : { tracker_id: t.id, value_num: next }]);
      };
      const stepper = el("div", { class: "level-tiles" },
        tile(svgIcon(ICONS.minus), { class: "tile tile-square", "aria-label": `Fewer ${t.name}`, disabled: current <= 0, onclick: () => step(-1) }),
        el("output", { class: "tile-num", "aria-live": "polite" }, fmtNum(current)),
        tile(svgIcon(ICONS.plus), { class: "tile tile-square", "aria-label": `More ${t.name}`, onclick: () => step(1) }));
      const text = goalAside(c, current) || (current ? `${fmtNum(current)} ${c.unit || ""}`.trim() : null);
      return brow(t, levelLine(text, current ? "var(--accent)" : "var(--muted)"), stepper);
    }
    const input = el("input", {
      type: "number", inputmode: "decimal", min: "0", step: "any", class: "tile-input",
      value: val ?? "", "aria-label": t.name, placeholder: "0",
      onchange: (ev) => {
        const v = ev.target.value;
        quickSave([v === "" ? { tracker_id: t.id, clear: true } : { tracker_id: t.id, value_num: Number(v) }]);
      },
    });
    return brow(t, levelLine(goalAside(c, val ?? 0), "var(--accent)"),
      el("div", { class: "level-tiles" }, input, c.unit ? el("span", { class: "row-sub" }, c.unit) : null));
  }

  if (t.kind === "medication") return medRow(t, view);

  if (t.kind === "sleep") {
    const s = latest ? latest.value_json || {} : {};
    const hours = s.hours ?? null;
    const quality = s.quality ?? null;
    const save = (h, q) => quickSave([h == null && q == null ? { tracker_id: t.id, clear: true } : { tracker_id: t.id, value_json: { hours: h, quality: q } }]);
    const shownHours = hours ?? 7.5;
    const qcfg = { min: 1, max: 5, labels: ["Awful", "Poor", "Okay", "Good", "Great"] };
    const stepper = el("div", { class: "level-tiles" },
      tile(svgIcon(ICONS.minus), { class: "tile tile-square", "aria-label": "Less sleep", onclick: () => save(Math.max(0, shownHours - 0.5), quality) }),
      el("output", { class: "tile-num" }, hours == null ? "–" : `${fmtNum(hours)}h`),
      tile(svgIcon(ICONS.plus), { class: "tile tile-square", "aria-label": "More sleep", onclick: () => save(Math.min(24, hours == null ? shownHours : hours + 0.5), quality) }));
    const qualityTiles = el("div", { class: "rating-grid one-row" }, [1, 2, 3, 4, 5].map((v) => el("div", { class: "rating-col", style: `--c:${scaleColor(qcfg, v)}` },
      faceIcon(v - 1),
      tile(String(v), { class: `tile tile-rating${quality === v ? " on" : ""}`, "aria-pressed": String(quality === v),
        "aria-label": `Sleep quality ${qcfg.labels[v - 1]}`, onclick: () => save(hours, quality === v ? null : v) }))));
    const text = [hours != null ? `${fmtNum(hours)} hours` : null, quality ? `${qcfg.labels[quality - 1]} sleep` : null].filter(Boolean).join(", ");
    return brow(t, levelLine(text || "Not logged yet", quality ? scaleColor(qcfg, quality) : "var(--muted)",
      latest ? () => removeEntry(latest) : null), stepper,
      el("div", { class: "brow-below" }, el("span", { class: "row-sub" }, "How well did you sleep?"), qualityTiles));
  }

  if (t.kind === "note") {
    const area = el("textarea", { "aria-label": t.name, placeholder: "Anything worth remembering about today?" });
    area.value = latest ? latest.note || "" : "";
    const saveBtn = el("button", { type: "button", class: "primary small", hidden: true, onclick: () => {
      const v = area.value.trim();
      if (!v && latest) removeEntry(latest);
      else if (v) quickSave([{ tracker_id: t.id, note: v }]).then(() => toast("Note saved"));
    } }, "Save note");
    area.addEventListener("input", () => { saveBtn.hidden = area.value === (latest ? latest.note || "" : ""); });
    return brow(t, null, null, el("div", { class: "brow-below" }, area, saveBtn));
  }

  return brow(t, levelLine("This type isn't supported yet.", "var(--muted)"));
}

/* ---------- rating dialog: "Mood at 8:39pm" ---------- */

function openRatingDialog(t, entry = null) {
  const sheet = document.getElementById("sheet");
  const c = t.config;
  const now = new Date();
  let time = entry ? /T(\d{2}:\d{2})/.exec(entry.logged_at)[1] : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day = entry ? entry.day : state.day;
  const n = c.max - c.min + 1;

  const timeBtn = el("button", { type: "button", class: "time-edit" });
  const timeInput = el("input", { type: "time", value: time, hidden: true, "aria-label": "Time" });
  const drawTime = () => timeBtn.replaceChildren(el("span", {}, niceTime(time)), svgIcon(ICONS.edit));
  timeBtn.addEventListener("click", () => { timeBtn.hidden = true; timeInput.hidden = false; timeInput.focus(); });
  timeInput.addEventListener("change", () => { time = timeInput.value || time; drawTime(); timeInput.hidden = true; timeBtn.hidden = false; });
  drawTime();

  const choose = async (v) => {
    const [h, m] = time.split(":").map(Number);
    const when = dayToDate(day);
    when.setHours(h, m, 0, 0);
    if (when > new Date()) { toast("That time hasn't happened yet"); return; }
    try {
      if (entry) await api("PATCH", `api/entries/${entry.id}`, { value_num: v, logged_at: localISO(when) });
      else await api("POST", "api/checkin", { logged_at: localISO(when), items: [{ tracker_id: t.id, value_num: v }] });
      sheet.close();
      await refreshCheckin();
      toast(`${t.name}: ${ratingText(c, v)}`);
    } catch (err) { toast(err.message); }
  };

  const perCol = n > 5 ? Math.ceil(n / 5) : 1;
  const cols = [];
  for (let start = c.min; start <= c.max; start += perCol) {
    const values = [];
    for (let v = start; v < start + perCol && v <= c.max; v++) values.push(v);
    cols.push(el("div", { class: "rating-col", style: `--c:${scaleColor(c, start)}` },
      faceIcon(scaleBin(c, start)),
      values.map((v) => tile(String(v), {
        class: `tile tile-rating${entry && entry.value_num === v ? " on" : ""}`,
        "aria-label": ratingText(c, v), title: (c.labels || [])[v - c.min] || "",
        onclick: () => choose(v),
      }))));
  }

  const body = el("div", { class: "rating-dialog" },
    el("div", { class: "rating-head" },
      el("h2", {}, `${t.name} at `, timeBtn, timeInput),
      el("button", { type: "button", class: "iconbtn plain close", "aria-label": "Close", onclick: () => sheet.close() }, svgIcon(ICONS.close))),
    el("div", { class: `rating-grid${perCol === 1 ? " one-row" : ""}`, style: `--cols:${cols.length}` }, cols),
    entry ? el("div", { class: "actions center" },
      el("button", { type: "button", class: "link danger", onclick: async () => {
        if (!confirm(`Delete this ${t.name} entry?`)) return;
        sheet.close();
        await removeEntry(entry);
      } }, "Delete this entry")) : null);

  sheet.classList.add("center");
  sheet.addEventListener("close", () => sheet.classList.remove("center"), { once: true });
  sheet.replaceChildren(body);
  sheet.showModal();
}

/* ---------- quick actions ---------- */

async function takenNow(t) {
  await quickSave([{ tracker_id: t.id, value_num: Number(t.config.quantity ?? 1) }], localISO(new Date()));
  toast(`${t.name} logged at ${timeOf(localISO(new Date()))}`);
}

// Kept for other screens that open the dose editor
function openDoseSheet(t, view, entry = null) { openDoseDialog(t, entry); }

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
      } }, "Edit this day"),
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
  rating: "Rating (1 to 5 or 1 to 10)",
  tags: "Pick from a list",
  symptom: "Symptom (none to severe)",
  medication: "Medication",
  factor: "Habit or factor (yes/no, count or amount)",
  sleep: "Sleep",
  note: "Note",
};

const OFTEN = { many: "as often as you like", daily: "once a day" };

function describeTracker(t) {
  const c = t.config;
  const often = OFTEN[t.frequency] || "";
  switch (t.kind) {
    case "rating": return `Rated ${c.min}–${c.max}, ${often}`;
    case "symptom": return `None to severe, ${often}`;
    case "factor": {
      const what = c.mode === "bool" ? "Yes or no" : c.mode === "count" ? `Count${c.unit ? " of " + c.unit : ""}` : `Amount${c.unit ? " in " + c.unit : ""}`;
      return `${what}, ${often}`;
    }
    case "tags": return `Choose from ${(c.options || []).length} options, ${often}`;
    case "sleep": return "Hours and quality, once a day";
    case "note": return `Free text, ${often}`;
    case "medication": {
      const amount = [c.dose, c.unit].filter(Boolean).join(" ");
      return [amount, describeSchedule(t._schedule, t)].filter(Boolean).join(". ");
    }
    default: return often;
  }
}

function describeSchedule(sch, t) {
  if (!sch || !sch.enabled) return "No reminders";
  const s = sch.settings;
  if (s.mode === "after") {
    const name = (id) => (state.trackers.find((x) => x.id === id) || {}).name || "another medication";
    let text = `Reminds you ${joinNames(s.after.map((r) => `${niceGap(r.minutes)} after ${name(r.tracker_id)}`))}`;
    if (s.max_per_day) text += `, up to ${s.max_per_day} a day`;
    return text;
  }
  const days = describeDays(s.days) ? ", " + describeDays(s.days) : "";
  const amounts = s.amounts || {};
  if (t && Object.keys(amounts).length) {
    const usual = t.config.quantity ?? 1;
    return `Reminds you: ${joinNames(s.times.map((x) => `${qtyText(t, amounts[x] ?? usual)} at ${niceTime(x)}`))}${days}`;
  }
  return `Reminds you at ${joinNames(s.times.map(niceTime))}${days}`;
}

function describeDays(d) {
  if (!d || d.mode === "daily") return "every day";
  if (d.mode === "weekdays") {
    const set = d.weekdays.join(",");
    if (set === "0,1,2,3,4") return "on weekdays";
    if (set === "5,6") return "on weekends";
    return "on " + joinNames(d.weekdays.map((w) => WEEKDAYS[w]));
  }
  return `every ${d.every} days`;
}

function settingRow(title, sub, buttonLabel, onclick) {
  return el("div", { class: "tracker-row" },
    el("div", { class: "info" }, el("div", { class: "row-name" }, title), el("div", { class: "row-sub" }, sub)),
    el("button", { type: "button", class: "secondary", onclick }, buttonLabel));
}

async function renderSettings(view) {
  view.replaceChildren(el("p", { class: "loading" }, "Loading…"));
  const all = await api("GET", "api/trackers?include_hidden=true");
  const visible = all.filter((t) => !t.hidden);
  const hidden = all.filter((t) => t.hidden);

  const head = el("header", { class: "head" },
    el("h1", {}, "Settings"),
    el("p", {}, "Choose what you track and how you're reminded. Only you can see your list."),
  );

  const meds = visible.filter((t) => t.kind === "medication");
  const others = visible.filter((t) => t.kind !== "medication");
  const [schedules, person] = await Promise.all([
    Promise.all(meds.map((m) => api("GET", `api/trackers/${m.id}/schedule`).catch(() => null))),
    api("GET", "api/reminders/settings").catch(() => null),
  ]);
  meds.forEach((m, i) => { m._schedule = schedules[i]; });

  const medSection = el("section", { class: "group" },
    el("h2", {}, "Meds/Supplements"),
    meds.length
      ? el("div", { class: "panel" }, meds.map((t) => settingsRow(t, all, view)))
      : el("div", { class: "empty", style: "margin-top:0" }, el("p", {}, "No medications yet. Add one to log doses and get reminders.")),
    el("div", { class: "actions", style: "margin-top:12px" },
      el("button", { type: "button", class: "secondary", onclick: () => openTrackerSheet({ kind: "medication" }, view) }, "Add medication")),
  );

  const phones = person ? person.devices.length : 0;
  const ci = person ? person.checkins : null;
  const notifySection = el("section", { class: "group" },
    el("h2", {}, "Notifications"),
    el("div", { class: "panel" },
      settingRow("Phones and alerts",
        phones ? `Sending to ${phones === 1 ? "1 phone" : phones + " phones"}` : "No phone chosen yet, so reminders only show in this app",
        "Change", () => openPersonSheet(view)),
      settingRow("Check-in reminders",
        ci && ci.enabled ? `At ${joinNames(ci.times.map(niceTime))}, ${describeDays(ci.days)}` : "Off",
        "Change", () => openCheckinSheet(view)),
      settingRow("Water reminders",
        person && person.hydration.enabled
          ? `If you haven't had water for ${niceGap(person.hydration.every)}, ${niceTime(person.hydration.start)} to ${niceTime(person.hydration.end)}`
          : "Off",
        "Change", () => openWaterSheet(view))),
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
    el("button", { type: "button", class: "primary", onclick: () => openTrackerSheet({ kind: "rating" }, view) }, "Add something to track"));

  const hiddenSection = hidden.length ? el("section", { class: "group" },
    el("h2", {}, "Hidden"),
    el("p", { class: "hint", style: "margin:0 0 8px 4px" }, "Not shown on Check-in. Their history is kept."),
    el("div", { class: "panel" }, hidden.map((t) => settingsRow(t, all, view))),
  ) : null;

  view.replaceChildren(...[head, medSection, notifySection,
    el("h2", { class: "section-title" }, "What you track"),
    ...trackerSections, addRow, hiddenSection,
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
      ? el("button", { type: "button", class: "iconbtn", "aria-label": `Reminders for ${t.name}`, title: "Reminders", onclick: () => openScheduleSheet(t, view) }, svgIcon(ICONS.bell))
      : null,
    el("button", { type: "button", class: "iconbtn", "aria-label": `Edit ${t.name}`, title: "Edit", onclick: () => openTrackerSheet(t, view) }, svgIcon(ICONS.edit)),
  );
}

function field(label, control, hint) {
  return el("label", { class: "field" }, el("span", {}, label), control, hint ? el("span", { class: "hint" }, hint) : null);
}

/* ---------- emoji picker ---------- */

let emojiData = null;
async function loadEmoji() {
  if (!emojiData) {
    try { emojiData = await (await fetch("static/emoji.json")).json(); }
    catch { emojiData = []; }
  }
  return emojiData;
}

const EMOJI_SUGGEST = {
  medication: "💊 💉 🩹 🧴 🩺 🌡️ 🫀 🧠 ⏰ 🍵 🥛 💧",
  rating: "🙂 😊 😌 ⚡ 🔋 😴 💭 🧠 ❤️ 🌤️ 🎯 😤",
  symptom: "🤕 🥱 🌫️ 😰 🤢 🤧 😵‍💫 🦴 🔥 💢 🫁 😖",
  factor: "☕ 🍷 💧 🏃 🌳 👥 📱 🍎 🧘 🚶 🚭 🍫",
  tags: "💭 🏷️ 😊 🎭 🌈 📋",
  note: "📝 📓 ✏️ 💬 🗒️ 📖",
  sleep: "😴 🛌 🌙 💤 🛏️ ⏰",
};

function emojiPicker(value, getKind) {
  let current = value || "";
  const preview = el("span", { class: "emoji-current", "aria-hidden": "true" });
  const label = el("span", {});
  const toggleBtn = el("button", { type: "button", class: "emoji-button", "aria-expanded": "false" }, preview, label);
  const search = el("input", { type: "search", placeholder: "Search, for example pill, coffee, sleep", "aria-label": "Search icons", autocomplete: "off" });
  const grid = el("div", { class: "emoji-grid" });
  const status = el("p", { class: "hint", "aria-live": "polite" });
  const panel = el("div", { class: "emoji-panel", hidden: true },
    search, status, grid,
    el("button", { type: "button", class: "link", onclick: () => choose("") }, "Use no icon"));

  function show() {
    preview.textContent = current || "＋";
    label.textContent = current ? "Change icon" : "Choose an icon";
  }
  function choose(e) {
    current = e;
    show();
    panel.hidden = true;
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.focus();
  }
  function draw(list) {
    grid.replaceChildren(...list.slice(0, 120).map(([e, name]) => el("button", {
      type: "button", class: "emoji-cell", "aria-label": name, title: name,
      "aria-pressed": String(e === current), onclick: () => choose(e),
    }, e)));
  }
  async function update() {
    const data = await loadEmoji();
    const names = new Map(data.map((d) => [d[0], d[1]]));
    const q = search.value.trim().toLowerCase();
    if (!q) {
      const picks = (EMOJI_SUGGEST[getKind()] || EMOJI_SUGGEST.rating).split(" ");
      status.textContent = "Suggested. Search to see more.";
      draw(picks.map((e) => [e, names.get(e) || e]));
      return;
    }
    const terms = q.split(/\s+/);
    const scored = [];
    for (const [e, name, tags] of data) {
      const words = `${name} ${tags}`.toLowerCase().split(/[\s:,-]+/);
      if (!terms.every((t) => words.some((w) => w.startsWith(t)))) continue;
      const inName = terms.every((t) => name.toLowerCase().split(/[\s:,-]+/).some((w) => w.startsWith(t)));
      scored.push([inName ? 0 : 1, e, name]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    status.textContent = scored.length ? `${scored.length} found` : "No matches. Try another word.";
    draw(scored.map(([, e, name]) => [e, name]));
  }
  toggleBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggleBtn.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) { update(); search.focus(); }
  });
  search.addEventListener("input", update);
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); grid.querySelector("button")?.click(); }
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); choose(current); }
  });
  show();
  return { node: el("div", { class: "emoji-field" }, toggleBtn, panel), get value() { return current || null; } };
}

/* ---------- add or edit something to track ---------- */

function openTrackerSheet(t, view) {
  const isNew = !t.id;
  const sheet = document.getElementById("sheet");
  const c = t.config || {};
  let kind = t.kind;

  const name = el("input", { type: "text", name: "name", required: true, maxlength: "60", value: t.name || "", autocomplete: "off",
    placeholder: kind === "medication" ? "For example Vyvanse" : "For example Stress" });
  const icon = emojiPicker(t.emoji, () => kind);
  const groupNames = [...new Set(state.trackers.map((x) => x.group_name).filter(Boolean))];
  const group = el("input", { type: "text", name: "group", maxlength: "40", value: t.group_name ?? "", list: "group-names", autocomplete: "off", placeholder: "For example How you feel" });
  const groupList = el("datalist", { id: "group-names" }, groupNames.map((g) => el("option", { value: g })));
  const freq = el("select", { name: "frequency" },
    el("option", { value: "many" }, "As often as I like (every answer is kept)"),
    el("option", { value: "daily" }, "Once a day (a new answer replaces the old one)"));
  freq.value = t.frequency || (["symptom", "factor", "sleep", "note"].includes(kind) ? "daily" : "many");

  const kinds = ["rating", "symptom", "factor", "tags", "note", "medication"];
  if (kind === "sleep") kinds.push("sleep");
  const kindSelect = el("select", { name: "kind" }, kinds.map((k) => el("option", { value: k }, KIND_INFO[k])));
  kindSelect.value = kind;
  const logged = t.entry_count || 0;
  const kindHint = !isNew && logged
    ? `Changing the type clears the ${logged === 1 ? "1 thing" : logged + " things"} already logged for it, because they were recorded differently.`
    : null;

  const extra = el("div", {});
  const err = el("p", { class: "form-error", hidden: true });

  // kind-specific inputs, rebuilt when the kind changes
  const inputs = {};
  function drawExtra() {
    extra.replaceChildren();
    if (kind === "rating") {
      const startMax = kind === t.kind && c.max ? c.max : 10;
      inputs.scale = selectOf([[5, "1 to 5"], [10, "1 to 10"]], startMax);
      const labelsField = el("div", {});
      const drawLabels = () => {
        const max = Number(inputs.scale.value);
        const keep = kind === t.kind && (c.labels || []).length === max ? c.labels : [];
        inputs.labels = el("input", { type: "text", value: keep.join(", "),
          placeholder: max === 10 ? "Awful, Very bad, Bad, Poor, Meh, Okay, Fine, Good, Very good, Great" : "Awful, Bad, Okay, Good, Great" });
        labelsField.replaceChildren(field(`Words for 1 to ${max}`, inputs.labels,
          `Optional. ${max} words, lowest first, separated by commas.`));
      };
      inputs.scale.addEventListener("change", drawLabels);
      drawLabels();
      extra.append(field("Scale", inputs.scale, !isNew && kind === t.kind && logged
        ? "Changing the scale moves past answers to the same place on the new one." : null), labelsField);
    } else if (kind === "tags") {
      inputs.options = el("textarea", { placeholder: "Happy\nCalm\nAnxious" });
      inputs.options.value = (c.options || []).join("\n");
      extra.append(field("Choices", inputs.options, "One per line. You can pick several at once."));
    } else if (kind === "factor") {
      inputs.mode = el("select", {},
        el("option", { value: "bool" }, "Yes or no"),
        el("option", { value: "count" }, "A count (cups, drinks…)"),
        el("option", { value: "amount" }, "An amount (minutes, km…)"));
      inputs.mode.value = c.mode || "bool";
      inputs.unit = el("input", { type: "text", maxlength: "20", value: c.unit || "", placeholder: "cups" });
      inputs.goal = el("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: c.goal ?? "", placeholder: "None", style: "width:8em" });
      const unitField = field("Unit", inputs.unit, "Shown next to the number, for example cups.");
      const goalField = field("Daily goal", inputs.goal, "Optional. Shows your progress, like 3 of 8. Water reminders stop once it's reached.");
      const drawUnit = () => { unitField.hidden = goalField.hidden = inputs.mode.value === "bool"; };
      inputs.mode.addEventListener("change", drawUnit);
      drawUnit();
      extra.append(field("Answer type", inputs.mode), unitField, goalField);
    } else if (kind === "medication") {
      inputs.dose = el("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: c.dose ?? "", placeholder: "30" });
      inputs.unit = el("input", { type: "text", maxlength: "20", value: c.unit || "", placeholder: "mg", list: "dose-units" });
      inputs.notes = el("input", { type: "text", maxlength: "200", value: c.notes || "", placeholder: "With breakfast" });
      inputs.quantity = el("input", { type: "number", min: "0.5", step: "0.5", inputmode: "decimal", value: c.quantity ?? 1 });
      inputs.counted = el("input", { type: "text", maxlength: "20", value: c.counted_as || "", placeholder: "dose", list: "counted-as" });
      extra.append(...[
        el("div", { class: "field-pair" }, field("Usual dose", inputs.dose), field("Measured in", inputs.unit)),
        el("datalist", { id: "dose-units" }, ["mg", "mcg", "g", "ml", "IU", "tablets", "capsules", "drops", "puffs"].map((u) => el("option", { value: u }))),
        el("div", { class: "field-pair" }, field("Usually take", inputs.quantity), field("Counted as", inputs.counted)),
        el("datalist", { id: "counted-as" }, ["dose", "tablet", "capsule", "application", "drop", "puff", "spray", "scoop"].map((u) => el("option", { value: u }))),
        el("p", { class: "hint", style: "margin:-6px 0 14px" }, "Shown as \"1 dose\" or \"2 tablets\". You can change the amount and strength each time you log it."),
        field("Instructions", inputs.notes, "Optional. Shown on the reminder."),
        t.id ? el("button", { type: "button", class: "secondary", onclick: () => openScheduleSheet(t, view) }, "Set up reminders") : null,
      ].filter(Boolean));
    }
  }
  drawExtra();
  kindSelect.addEventListener("change", () => {
    kind = kindSelect.value;
    freq.value = ["symptom", "factor", "note"].includes(kind) ? "daily" : "many";
    drawExtra();
  });

  const groupFieldNode = field("Show it under", group, "The heading it appears under on Check-in.");
  const freqFieldNode = field("How often will you answer it?", freq);
  const drawKindFields = () => {
    groupFieldNode.hidden = kind === "medication";
    freqFieldNode.hidden = ["sleep", "medication"].includes(kind);
  };
  kindSelect.addEventListener("change", drawKindFields);
  drawKindFields();

  function readConfig() {
    if (kind === "rating") {
      const labels = inputs.labels.value.split(",").map((s) => s.trim()).filter(Boolean);
      return { min: 1, max: Number(inputs.scale.value), labels };
    }
    if (kind === "tags") return { options: inputs.options.value.split("\n").map((s) => s.trim()).filter(Boolean) };
    if (kind === "factor") return { mode: inputs.mode.value, unit: inputs.unit.value.trim(), goal: inputs.goal.value === "" ? null : inputs.goal.value };
    if (kind === "medication") return { dose: inputs.dose.value === "" ? null : inputs.dose.value, unit: inputs.unit.value.trim(),
      notes: inputs.notes.value.trim(), quantity: inputs.quantity.value || 1, counted_as: inputs.counted.value.trim() };
    return {};
  }

  const form = el("form", { method: "dialog" },
    el("h2", {}, isNew ? (t.kind === "medication" ? "Add medication" : "Add something to track") : `Edit ${t.name}`),
    err,
    isNew && kind === "medication" ? null : field("What kind?", kindSelect, kindHint),
    field("Name", name),
    el("div", { class: "field" }, el("span", {}, "Icon"), icon.node),
    groupFieldNode,
    groupList,
    extra,
    freqFieldNode,
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, isNew ? "Add" : "Save changes"),
      !isNew ? el("button", { type: "button", class: "secondary", onclick: async () => {
        await api("PATCH", `api/trackers/${t.id}`, { hidden: !t.hidden });
        sheet.close();
        toast(t.hidden ? `${t.name} is back on Check-in` : `${t.name} hidden from Check-in`);
        await refreshTrackers();
        await renderSettings(view);
      } }, t.hidden ? "Show on Check-in" : "Hide") : null,
      !isNew ? el("button", { type: "button", class: "secondary danger", onclick: async () => {
        if (!confirm(`Delete ${t.name} and everything logged for it? To keep its history, hide it instead.`)) return;
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
      emoji: icon.value,
      config: readConfig(),
    };
    if (kind !== "medication") payload.group_name = group.value.trim();
    else if (isNew && t.group_name) payload.group_name = t.group_name;
    if (!["sleep", "medication"].includes(kind)) payload.frequency = freq.value;
    if (!isNew && kind !== t.kind) {
      if (logged && !confirm(`Change ${t.name} to ${KIND_INFO[kind].toLowerCase()}? This clears the ${logged === 1 ? "1 thing" : logged + " things"} already logged for it.`)) return;
      payload.kind = kind;
      if (kind === "medication") payload.group_name = "Meds/Supplements";
    }
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

// A list of clock times with add and remove.
// A list of times. For a medication (opts.med), each time also has how many to take.
function timesEditor(times, opts = {}) {
  const t = opts.med;
  const usual = t ? Number(t.config.quantity ?? 1) : 1;
  const amounts = opts.amounts || {};
  const list = el("div", { class: "time-list" });
  const add = (value, qty) => {
    const input = el("input", { type: "time", value, required: true, class: "time-at", "aria-label": "Time" });
    const parts = [input];
    if (t) {
      const amount = el("input", { type: "number", min: "0.25", max: "100", step: "0.25", inputmode: "decimal",
        value: qty ?? usual, required: true, class: "time-qty", "aria-label": "How many to take" });
      const word = el("span", { class: "time-word" });
      const total = el("span", { class: "time-strength" });
      const draw = () => {
        const q = Number(amount.value) || 0;
        const strength = t.config.dose != null && t.config.dose !== "" ? `${fmtNum(q * Number(t.config.dose))}${t.config.unit || ""}` : "";
        word.textContent = plural(t.config.counted_as || "dose", q > 1 ? 2 : 1);
        total.textContent = strength ? `= ${strength}` : "";
      };
      amount.addEventListener("input", draw);
      draw();
      parts.push(amount, word);
      parts.extra = total;
    }
    const row = el("div", { class: t ? "time-row with-qty" : "time-row" }, ...parts,
      el("button", { type: "button", class: "iconbtn", "aria-label": "Remove this time", onclick: () => {
        if (list.children.length > 1) row.remove();
      } }, svgIcon(ICONS.close)), parts.extra || null);
    list.append(row);
  };
  times.forEach((v) => add(v, amounts[v]));
  const head = t ? el("div", { class: "time-row with-qty time-head", "aria-hidden": "true" },
    el("span", {}, "Time"), el("span", {}, "How many"), el("span", {}), el("span", {})) : null;
  const node = el("div", {}, head, list,
    el("button", { type: "button", class: "secondary small", onclick: () => add("12:00") }, "Add a time"));
  const rows = () => [...list.querySelectorAll(".time-row")];
  return {
    node,
    read: () => rows().map((r) => r.querySelector(".time-at").value).filter(Boolean),
    // {"19:00": 0.5, ...} for every time; the app drops ones that match the usual number
    readAmounts: () => Object.fromEntries(rows()
      .filter((r) => r.querySelector(".time-at").value && r.querySelector(".time-qty"))
      .map((r) => [r.querySelector(".time-at").value, Number(r.querySelector(".time-qty").value)])),
  };
}

// Every day / some days / every few days.
function daysEditor(days) {
  let mode = days.mode;
  const weekdays = new Set(days.weekdays);
  const chips = el("div", { class: "chips" }, WEEKDAYS.map((w, i) => {
    const b = el("button", { type: "button", class: "chip", "aria-pressed": String(weekdays.has(i)), onclick: () => {
      if (weekdays.has(i)) weekdays.delete(i); else weekdays.add(i);
      b.setAttribute("aria-pressed", String(weekdays.has(i)));
    } }, w);
    return b;
  }));
  const every = el("input", { type: "number", min: "2", max: "60", value: days.every, inputmode: "numeric", style: "width:5em", "aria-label": "Number of days" });
  const start = el("input", { type: "date", value: days.start || isoDay(new Date()), "aria-label": "First day" });
  const weekdayPanel = el("div", { class: "subpanel" }, chips);
  const intervalPanel = el("div", { class: "subpanel inline-field" },
    el("span", {}, "Every"), every, el("span", {}, "days, starting"), start);
  const seg = el("div", { class: "seg", role: "group", "aria-label": "Which days" });
  const draw = () => {
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    weekdayPanel.hidden = mode !== "weekdays";
    intervalPanel.hidden = mode !== "interval";
  };
  [["daily", "Every day"], ["weekdays", "Some days"], ["interval", "Every few days"]].forEach(([m, label]) =>
    seg.append(el("button", { type: "button", "data-mode": m, onclick: () => { mode = m; draw(); } }, label)));
  draw();
  return {
    node: el("div", {}, seg, weekdayPanel, intervalPanel),
    read: () => ({ mode, weekdays: [...weekdays].sort(), every: Number(every.value), start: start.value }),
  };
}

// What happens if a reminder isn't answered.
const NAG_CHOICES = [
  ["once", "Don't remind me again"],
  ["gently", "Remind me gently"],
  ["firmly", "Remind me firmly"],
  ["custom", "Choose my own"],
];
const NAG_HINTS = {
  once: "Just one notification.",
  gently: "Again every 30 minutes, up to 4 more times.",
  firmly: "Again every 10 minutes, up to 6 more times.",
  custom: "",
};

function nagEditor(s) {
  const nag = selectOf(NAG_CHOICES, s.nag);
  const everyInput = el("input", { type: "number", min: "1", max: "240", value: s.nag_every, inputmode: "numeric", style: "width:5em", "aria-label": "Minutes" });
  const repeats = el("input", { type: "number", min: "0", max: "50", value: s.nag_repeats ?? "", inputmode: "numeric", style: "width:5em", placeholder: "∞", "aria-label": "Times" });
  const hint = el("p", { class: "hint" });
  const custom = el("div", { class: "subpanel" },
    el("div", { class: "inline-field" }, el("span", {}, "Again every"), everyInput, el("span", {}, "minutes")),
    el("div", { class: "inline-field" }, el("span", {}, "Up to"), repeats, el("span", {}, "more times")),
    el("p", { class: "hint" }, "Leave the number of times blank to keep going until the latest time, or the end of the day."));
  const draw = () => {
    custom.hidden = nag.value !== "custom";
    hint.textContent = NAG_HINTS[nag.value];
    hint.hidden = !NAG_HINTS[nag.value];
  };
  nag.addEventListener("change", draw);
  draw();
  return {
    node: el("div", {}, nag, hint, custom),
    read: () => ({
      nag: nag.value,
      nag_every: Number(everyInput.value),
      nag_repeats: repeats.value === "" ? null : Number(repeats.value),
    }),
  };
}

function noPhoneNotice(person, view) {
  return person.devices.length ? null : notice(
    "No phone is chosen yet, so reminders will only show in this app. ",
    el("button", { type: "button", class: "link inline", onclick: () => openPersonSheet(view) }, "Choose phones"));
}

/* ---------- medication reminders ---------- */

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

  const times = timesEditor(s.times, { med: t, amounts: s.amounts || {} });
  const days = daysEditor(s.days);

  // ----- timed from another dose -----
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
  const maxPerDay = el("input", { type: "number", min: "1", max: "24", inputmode: "numeric", value: s.max_per_day ?? "", placeholder: "No limit", style: "width:6em", "aria-label": "Most reminders a day" });
  const afterBlock = el("div", {},
    field("Remind me", el("div", {}, ruleList,
      el("button", { type: "button", class: "secondary small", onclick: () => addRule({ tracker_id: t.id, minutes: 180 }) }, "Add another")),
      "Timed from when you actually take it: tapping Taken, logging it in the app, or a linked toggle. Choose this medication to repeat it, for example every 3 hours."),
    field("Stop after", el("div", { class: "inline-field" }, maxPerDay, el("span", {}, "reminders a day")),
      "Leave blank for no limit."),
  );

  let schedMode = s.mode;
  const timesBlock = el("div", {}, field("Times and amounts", times.node,
    `Set how many to take at each time, for example half at 7pm and one at 10pm. Usually ${usualText(t)}.`),
    field("Days", days.node));
  const whenSeg = el("div", { class: "seg", role: "group", "aria-label": "How to time it" });
  const drawWhen = () => {
    whenSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === schedMode)));
    timesBlock.hidden = schedMode !== "times";
    afterBlock.hidden = schedMode !== "after";
  };
  [["times", "At set times"], ["after", "After another dose"]].forEach(([m, label]) =>
    whenSeg.append(el("button", { type: "button", "data-mode": m, onclick: () => { schedMode = m; drawWhen(); } }, label)));
  drawWhen();

  const nag = nagEditor(s);

  // ----- latest time -----
  const latestOn = switchField("Set a latest time", !!s.latest_time,
    "No reminders after this. If it still isn't taken, you get one last question: skip today, or take it anyway?");
  const latestInput = el("input", { type: "time", value: s.latest_time || "11:00", "aria-label": "Latest time" });
  const latestPanel = el("div", { class: "subpanel" }, latestInput);
  const drawLatest = () => { latestPanel.hidden = !latestOn.input.checked; };
  latestOn.input.addEventListener("change", drawLatest);
  drawLatest();

  // ----- getting louder -----
  const hard = switchField("Get louder if I don't answer", s.hard_to_miss, "Steps it up after a few unanswered reminders.");
  const hardAfter = selectOf([[2, "The 2nd reminder"], [3, "The 3rd reminder"], [4, "The 4th reminder"], [5, "The 5th reminder"], [6, "The 6th reminder"]], s.hard_after);
  const alarm = switchField("Ring like an alarm", s.alarm_sound, "Plays even on Do Not Disturb, but not during your quiet hours.");
  const speakersReady = person.speakers.length && person.tts_entity;
  const announce = switchField("Announce it on speakers", s.announce, speakersReady
    ? "Uses the speakers chosen in Phones and alerts."
    : "Choose speakers and a voice in Phones and alerts first.");
  const hardPanel = el("div", { class: "subpanel" }, field("Starting from", hardAfter), alarm.node, announce.node);
  const drawHard = () => { hardPanel.hidden = !hard.input.checked; };
  hard.input.addEventListener("change", drawHard);
  drawHard();

  // ----- early doses and Home Assistant -----
  const early = selectOf([[0, "Don't count early doses"], [30, "Up to 30 minutes before"], [60, "Up to 1 hour before"],
    [120, "Up to 2 hours before"], [180, "Up to 3 hours before"], [360, "Up to 6 hours before"]], s.early_window);
  const linked = selectOf([["", "None"], ...ha.toggles.map((x) => [x.entity_id, x.name])], s.linked_entity);
  const linkedTime = selectOf([["", "None"], ...ha.datetimes.map((x) => [x.entity_id, x.name])], s.linked_time_entity);
  const linkDetails = el("details", { class: "more", open: !!(s.linked_entity || s.linked_time_entity) },
    el("summary", {}, "Link to Home Assistant"),
    field("Toggle to keep in sync", linked, "Switching it on counts as taken, and taking it here switches it on."),
    field("Date and time to update", linkedTime, "Set to the time you take it."));

  body.append(
    field("When", whenSeg),
    timesBlock,
    afterBlock,
    field("If I don't answer", nag.node),
    latestOn.node, latestPanel,
    hard.node, hardPanel,
    field("Already taken it before the reminder?", early, "A dose you log this early counts, so you won't be reminded."),
    linkDetails,
  );
  const drawEnabled = () => { body.classList.toggle("dimmed", !enabled.input.checked); };
  enabled.input.addEventListener("change", drawEnabled);
  drawEnabled();

  const form = el("form", { method: "dialog" },
    el("h2", {}, `Reminders for ${t.name}`),
    err, noPhoneNotice(person, view), enabled.node, body,
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
      times: times.read(),
      amounts: times.readAmounts(),
      days: days.read(),
      ...nag.read(),
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
      toast(enabled.input.checked ? `Reminders for ${t.name} saved` : `Reminders for ${t.name} turned off`);
      if (currentTab() === "settings") await renderSettings(view);
      else await refreshCheckin();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      err.scrollIntoView({ block: "nearest" });
    }
  });

  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
}

/* ---------- check-in reminders ---------- */

async function openCheckinSheet(view) {
  const sheet = document.getElementById("sheet");
  let person;
  try { person = await api("GET", "api/reminders/settings"); }
  catch (err) { toast(err.message); return; }
  const c = person.checkins;
  const err = el("p", { class: "form-error", hidden: true });

  const enabled = switchField("Remind me to check in", c.enabled, "A nudge to note how you're doing.");
  const times = timesEditor(c.times);
  const days = daysEditor(c.days);
  const nag = nagEditor(c);
  const buttons = selectOf([["mood", "Mood: Good, Okay, Bad"], ["snooze", "Snooze, Not now"]], c.buttons);
  const recent = selectOf([[0, "Always remind me"], [30, "In the last 30 minutes"], [60, "In the last hour"],
    [120, "In the last 2 hours"], [180, "In the last 3 hours"]], c.skip_if_recent);
  const expire = selectOf([[60, "1 hour"], [120, "2 hours"], [180, "3 hours"], [360, "6 hours"]], c.expire_after);

  const body = el("div", { class: "sched-body" },
    field("Times", times.node),
    field("Days", days.node),
    field("Buttons on the notification", buttons, "Quick mood answers log your mood without opening the app."),
    field("If I don't answer", nag.node),
    field("Skip the reminder if I've checked in", recent),
    field("Remove the reminder after", expire, "Unanswered check-in reminders tidy themselves away."),
  );
  const drawEnabled = () => { body.classList.toggle("dimmed", !enabled.input.checked); };
  enabled.input.addEventListener("change", drawEnabled);
  drawEnabled();

  const form = el("form", { method: "dialog" },
    el("h2", {}, "Check-in reminders"),
    err, noPhoneNotice(person, view), enabled.node, body,
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, "Save"),
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel")));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    try {
      await api("PUT", "api/reminders/settings", { checkins: {
        enabled: enabled.input.checked,
        times: times.read(),
        days: days.read(),
        ...nag.read(),
        buttons: buttons.value,
        skip_if_recent: Number(recent.value),
        expire_after: Number(expire.value),
      } });
      sheet.close();
      toast(enabled.input.checked ? "Check-in reminders saved" : "Check-in reminders turned off");
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

/* ---------- water reminders ---------- */

async function openWaterSheet(view) {
  const sheet = document.getElementById("sheet");
  let person;
  try { person = await api("GET", "api/reminders/settings"); }
  catch (err) { toast(err.message); return; }
  const h = person.hydration;
  const err = el("p", { class: "form-error", hidden: true });
  const counts = state.trackers.filter((x) => x.kind === "factor" && ["count", "amount"].includes(x.config.mode));
  const waterDefault = counts.find((x) => x.key === "water");

  const enabled = switchField("Remind me to drink water", h.enabled, "A nudge when you haven't logged any water for a while.");
  const tracker = selectOf(counts.map((x) => [x.id, `${x.name}${x.config.unit ? " (" + x.config.unit + ")" : ""}`]),
    h.tracker_id ?? (waterDefault ? waterDefault.id : ""));
  const every = selectOf([[60, "1 hour"], [90, "1.5 hours"], [120, "2 hours"], [180, "3 hours"], [240, "4 hours"]], h.every);
  const start = el("input", { type: "time", value: h.start, "aria-label": "From" });
  const end = el("input", { type: "time", value: h.end, "aria-label": "Until" });
  const days = daysEditor(h.days);
  const amount = el("input", { type: "number", min: "1", max: "5000", value: h.amount, inputmode: "numeric", style: "width:7em", "aria-label": "One drink" });
  const amountField = field("One drink is", el("div", { class: "inline-field" }, amount, el("span", {}, "ml or your unit")),
    "Used when water is measured as an amount. The reminder offers one or two drinks.");
  const drawAmount = () => {
    const t = counts.find((x) => String(x.id) === tracker.value);
    amountField.hidden = !t || t.config.mode !== "amount";
  };
  tracker.addEventListener("change", drawAmount);
  drawAmount();
  const chosen = counts.find((x) => String(x.id) === tracker.value);
  const goalNote = chosen && chosen.config.goal
    ? `Stops once you reach your daily goal of ${fmtNum(chosen.config.goal)} ${chosen.config.unit || ""}.`.replace(" .", ".")
    : "Tip: give it a daily goal in Settings so reminders stop once you reach it.";

  const body = el("div", { class: "sched-body" },
    counts.length ? field("Count it in", tracker, goalNote)
      : notice("Add something to track measured as a count or amount, like Water, first."),
    field("Remind me if I haven't logged any for", every),
    field("Between", el("div", { class: "inline-field" }, start, el("span", {}, "and"), end)),
    field("Days", days.node),
    amountField,
  );
  const drawEnabled = () => { body.classList.toggle("dimmed", !enabled.input.checked); };
  enabled.input.addEventListener("change", drawEnabled);
  drawEnabled();

  const form = el("form", { method: "dialog" },
    el("h2", {}, "Water reminders"),
    el("p", { class: "row-sub", style: "margin:-8px 0 14px" }, "The notification has buttons to log a drink straight away."),
    err, noPhoneNotice(person, view), enabled.node, body,
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, "Save"),
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel")));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    try {
      await api("PUT", "api/reminders/settings", { hydration: {
        enabled: enabled.input.checked,
        tracker_id: tracker.value ? Number(tracker.value) : null,
        every: Number(every.value),
        start: start.value,
        end: end.value,
        days: days.read(),
        amount: Number(amount.value),
      } });
      sheet.close();
      toast(enabled.input.checked ? "Water reminders saved" : "Water reminders turned off");
      if (currentTab() === "settings") await renderSettings(view);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });

  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
}

/* ---------- phones and alerts ---------- */

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
      ? "No phones with the Home Assistant app were found. Install the Companion app, sign in, then come back."
      : "Can't reach Home Assistant right now, so phones can't be listed.");
  const testBtn = el("button", { type: "button", class: "secondary small", onclick: async () => {
    try {
      await saveIt(false);
      const r = await api("POST", "api/reminders/test");
      toast(`Test sent to ${r.sent_to === 1 ? "1 phone" : r.sent_to + " phones"}`);
    } catch (e) { toast(e.message); }
  } }, "Send a test");

  const group = switchField("Combine medications due at the same time", s.group_doses, "One notification instead of several.");
  const undo = switchField("Show an Undo button after I answer", s.undo, "Stays for a minute, in case you tapped the wrong thing.");
  const swipe = switchField("Let me swipe medication reminders away", s.swipe_away, "When this is off, they stay until you answer them.");
  const snooze = selectOf([5, 10, 15, 20, 30, 45, 60].map((n) => [n, `${n} minutes`]), s.snooze_minutes);

  const quiet = switchField("Quiet hours", s.quiet.enabled, "No alarm sounds or speaker announcements. Notifications still arrive.");
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
    ha.people.some((p) => p.is_you) ? "Uses your Home Assistant person to tell if you're home." : "Needs a Home Assistant person linked to your user.");
  const speakerDetails = el("details", { class: "more", open: !!s.speakers.length },
    el("summary", {}, "Speaker announcements"),
    el("p", { class: "hint" }, "Used when a medication reminder is set to be announced."),
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
    };
    await api("PUT", "api/reminders/settings", payload);
    if (close) {
      sheet.close();
      toast("Phones and alerts saved");
      if (currentTab() === "settings") await renderSettings(view);
    }
  }

  const form = el("form", { method: "dialog" },
    el("h2", {}, "Phones and alerts"),
    err,
    field("Send notifications to", el("div", {}, phones, ha.phones.length ? testBtn : null),
      "Answering on one phone clears it from the others."),
    group.node, undo.node, swipe.node,
    field("Snooze length", snooze),
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

/* ================= theme ================= */

// The app opens inside Home Assistant on the same address, so it can read the
// colours of whichever theme Home Assistant is showing (light, dark or a custom
// theme) and use them. Outside Home Assistant it follows the system setting.
const HA_THEME_VARS = {
  "--base": ["--primary-background-color"],
  "--surface": ["--card-background-color", "--ha-card-background"],
  "--sunken": ["--secondary-background-color"],
  "--ink": ["--primary-text-color"],
  "--muted": ["--secondary-text-color"],
  "--line": ["--divider-color"],
  "--accent": ["--primary-color"],
  "--accent-ink": ["--text-primary-color"],
  "--danger": ["--error-color"],
};

function haThemeSource() {
  try {
    if (window.parent && window.parent !== window && window.parent.document) {
      return window.parent.document.documentElement;
    }
  } catch { /* not inside Home Assistant */ }
  return null;
}

function isDarkColour(colour) {
  const probe = document.createElement("span");
  probe.style.color = colour;
  probe.style.display = "none";
  document.documentElement.append(probe);
  const rgb = getComputedStyle(probe).color.match(/[\d.]+/g) || [255, 255, 255];
  probe.remove();
  const [r, g, b] = rgb.slice(0, 3).map((v) => Number(v) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

function applyTheme() {
  const root = document.documentElement;
  const host = haThemeSource();
  const found = {};
  if (host) {
    try {
      const cs = window.parent.getComputedStyle(host);
      for (const [ours, theirs] of Object.entries(HA_THEME_VARS)) {
        for (const name of theirs) {
          const value = cs.getPropertyValue(name).trim();
          if (value) { found[ours] = value; break; }
        }
      }
    } catch { /* ignore */ }
  }
  let dark;
  if (found["--base"]) {
    dark = isDarkColour(found["--base"]);
    for (const name of Object.keys(HA_THEME_VARS)) {
      if (found[name]) root.style.setProperty(name, found[name]);
      else root.style.removeProperty(name);
    }
  } else {
    dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    for (const name of Object.keys(HA_THEME_VARS)) root.style.removeProperty(name);
  }
  root.dataset.theme = dark ? "dark" : "light";
}

function watchTheme() {
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  const host = haThemeSource();
  if (host) {
    try {
      new MutationObserver(applyTheme).observe(host, { attributes: true, attributeFilter: ["style", "class"] });
      const head = host.querySelector("head");
      if (head) new MutationObserver(applyTheme).observe(head, { childList: true, subtree: true, characterData: true });
    } catch { /* ignore */ }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) applyTheme(); });
}

watchTheme();

/* ================= start ================= */

async function refreshTrackers() {
  state.trackers = await api("GET", "api/trackers");
}

async function start() {
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
