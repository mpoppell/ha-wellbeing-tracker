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
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  edit: "M4 20h4L19 9l-4-4L4 16v4z",
  minus: "M6 12h12",
  plus: "M12 6v12M6 12h12",
  bell: "M6 16v-5a6 6 0 0112 0v5l1.5 2h-15L6 16zM10 20a2 2 0 004 0",
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.2 4.2L19 7",
  chevron: "M9 6l6 6-6 6",
};

// 12 or 24-hour clock, following the time format in your Home Assistant profile.
let clock24 = false;
function detectClock() {
  const cycle = (lang) => {
    try { return new Intl.DateTimeFormat(lang, { hour: "numeric" }).resolvedOptions().hourCycle; } catch { return "h12"; }
  };
  try {
    const ha = window.parent !== window && window.parent.document.querySelector("home-assistant");
    const loc = ha && ha.hass && ha.hass.locale;
    if (loc) {
      if (loc.time_format === "24") return true;
      if (loc.time_format === "12") return false;
      return ["h23", "h24"].includes(cycle(loc.time_format === "language" ? loc.language : undefined));
    }
  } catch { /* not inside Home Assistant */ }
  return ["h23", "h24"].includes(cycle(undefined));
}

// "07:00" -> "7am" (or "07:00"), "13:30" -> "1:30pm" (or "13:30")
function niceTime(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (clock24) return `${pad(h)}:${pad(m)}`;
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
  if (clock24) return `${m[1]}:${m[2]}`;
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

function shortDate(day) {
  return dayToDate(day).toLocaleDateString(undefined, { day: "numeric", month: "short", year: day.slice(0, 4) === String(new Date().getFullYear()) ? undefined : "numeric" });
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
  const hide = () => t.classList.remove("show");
  const wait = actionLabel ? 10000 : 3000;
  toastTimer = setTimeout(hide, wait);
  // WCAG 2.2.1: don't take an Undo away while someone's reaching for it
  t.onmouseenter = t.onfocusin = () => clearTimeout(toastTimer);
  t.onmouseleave = t.onfocusout = () => { clearTimeout(toastTimer); toastTimer = setTimeout(hide, 4000); };
}

// Keep keyboard and screen reader users where they were when the screen redraws after a save.
function focusSnapshot(root) {
  const a = document.activeElement;
  if (!root || !a || a === document.body || !root.contains(a)) return () => {};
  const tag = a.tagName;
  const label = a.getAttribute("aria-label");
  const text = a.textContent.trim();
  const titleOf = (n) => {
    const c = n.closest(".card"); const h = c && c.querySelector(".card-title");
    const r = n.closest(".brow, .med-row, .edit-row"); const rn = r && r.querySelector(".brow-name, .row-name");
    return `${h ? h.textContent : ""}|${rn ? rn.textContent : ""}`;
  };
  const where = titleOf(a);
  const inSpot = !!a.closest(".spotlight");
  return () => {
    const now = document.activeElement;
    if (now && now !== document.body && root.contains(now)) return;
    const same = [...root.querySelectorAll(tag)].filter((x) => x.getAttribute("aria-label") === label && x.textContent.trim() === text);
    let target = same.find((x) => titleOf(x) === where) || (same.length === 1 ? same[0] : null);
    if (!target && inSpot) target = root.querySelector(".spotlight button, .spotlight input");
    if (!target && label) target = [...root.querySelectorAll(`[aria-label="${CSS.escape(label)}"]`)][0];
    if (target) target.focus({ preventScroll: true });
  };
}

// Every dialog is named by its heading, for screen readers.
{
  const show = HTMLDialogElement.prototype.showModal;
  let n = 0;
  HTMLDialogElement.prototype.showModal = function showModal() {
    if (!this.hasAttribute("aria-label")) {
      const h = this.querySelector("h2");
      if (h) { if (!h.id) h.id = `dialog-title-${++n}`; this.setAttribute("aria-labelledby", h.id); }
    }
    return show.call(this);
  };
}

const motionOK = () => !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

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
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

// "30 mg", or "2 × 30 mg (60 mg)"
function doseText(t, e) {
  const c = t.config;
  const n = e && e.value_num != null ? e.value_num : 1;
  const strength = e && e.value_json && e.value_json.dose != null ? e.value_json.dose : c.dose;
  const unit = c.unit || "";
  if (strength == null || strength === "") return qtyText(t, n);
  const one = `${fmtNum(strength)} ${unit}`.trim();
  return n === 1 ? one : `${qtyText(t, n)} (${fmtNum(n * Number(strength))} ${unit})`.replace(" )", ")");
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
      if (s.hours != null) parts.push(hm(Math.round(s.hours * 60)));
      if (s.quality != null) parts.push(`quality ${s.quality} of 5`);
      return parts.join(", ");
    }
    case "note": return "";
    case "gratitude": return e.note || "";
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
  const prev = addDays(state.day, -1);
  const [entries, prevEntries, doses, person, all, supply] = await Promise.all([
    api("GET", `api/entries?from=${state.day}&to=${state.day}`),
    api("GET", `api/entries?from=${prev}&to=${prev}`).catch(() => []),
    isToday ? api("GET", "api/doses/today").catch(() => []) : Promise.resolve([]),
    api("GET", "api/reminders/settings").catch(() => state.person),
    api("GET", "api/trackers?include_hidden=true"),
    api("GET", "api/supply").catch(() => []),
  ]);
  state.inbox = isToday ? await api("GET", "api/inbox").catch(() => []) : [];
  state.wake = isToday ? await api("GET", "api/wake").catch(() => null) : null;
  state.sleep = all.some((t) => t.kind === "sleep" && !t.hidden) ? await api("GET", "api/sleep?days=30").catch(() => null) : null;
  state.supply = new Map(supply.map((x) => [x.tracker_id, x]));
  state.dayEntries = entries;
  state.prevEntries = prevEntries;
  state.doses = doses;
  state.person = person;
  state.allTrackers = all;
  state.trackers = all.filter((t) => !t.hidden);
  state.nextCheckin = isToday ? (await api("GET", "api/checkins/next").catch(() => ({}))).time : null;
  if (isToday) await loadEncouragement();
}

async function renderCheckin(view) {
  if (!view.children.length) view.replaceChildren(el("p", { class: "loading" }, "Loading…"));
  await loadDay();
  drawCheckin(view);
}

const viewEl = () => document.getElementById("view");

// Draw the current screen again after a change made from a sheet.
async function redraw() {
  await refreshTrackers();
  const tab = currentTab();
  if (tab === "checkin") await refreshCheckin();
  else await views[tab](viewEl());
}

// Delete a logged entry straight away, with Undo in the toast instead of "Are you sure?".
async function deleteWithUndo(entry, what) {
  try {
    await api("DELETE", `api/entries/${entry.id}`);
  } catch (err) { toast(err.message); return; }
  await redraw();
  toast(`${what} deleted`, "Undo", async () => {
    try {
      await api("POST", "api/checkin", { logged_at: entry.logged_at, items: [{
        tracker_id: entry.tracker_id, value_num: entry.value_num, value_json: entry.value_json, note: entry.note }] });
      await redraw();
      toast(`${what} is back`);
    } catch (err) { toast(err.message); }
  });
}

async function refreshCheckin() {
  await loadDay();
  drawCheckin(viewEl());
}

async function quickSave(items, when) {
  try {
    const res = await api("POST", "api/checkin", { logged_at: when || loggedAtFor(state.day), items });
    await refreshCheckin();
    offerBreathing(items);
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
  [/reflect|good thing|gratitude|grateful/, "M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5"],
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
    if (saved.some((s) => s.name === name)) continue;
    const section = { name, hidden: false, items };
    // Good things go just after How you feel when they're new, not at the bottom
    const after = saved.length && items.some((t) => t.kind === "gratitude")
      ? out.findIndex((x) => x.items.some((t) => t.key === "mood")) : -1;
    if (after >= 0) out.splice(after + 1, 0, section); else out.push(section);
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

function levelLine(text, colour, onClear, note) {
  if (!text && !note) return null;
  return el("span", { class: "brow-level", style: colour ? `--lc:${colour}` : "" },
    onClear && text ? el("button", { type: "button", class: "clear", "aria-label": "Clear", title: "Clear", onclick: onClear }, svgIcon(ICONS.minus)) : null,
    text && colour && colour !== "var(--muted)" ? el("span", { class: "level-dot", "aria-hidden": "true" }) : null,
    text ? el("span", { class: colour === "var(--muted)" ? "level-muted" : "level-text" }, text) : null,
    note ? el("span", { class: "level-note" }, text ? ` · ${note}` : note) : null);
}

// Nothing logged yet: say what you said yesterday, if anything, and otherwise nothing at all.
function notYet(t) {
  const y = yesterdayText(t);
  return y ? levelLine(null, null, null, y) : null;
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
  const restoreFocus = focusSnapshot(view);
  const today = isoDay(new Date());
  const name = (state.me.display_name || state.me.username || "").split(" ")[0];
  const isToday = state.day === today;
  const editing = !!state.editing;

  const head = el("header", { class: "head head-row" },
    el("div", {},
      el("h1", {}, editing ? "Edit your dashboard" : isToday ? (name ? `How are you, ${name}?` : "How are you?")
        : `Check-in for ${state.day === addDays(today, -1) ? "yesterday" : dayLabel(state.day)}`),
      editing ? el("p", {}, "Drag the handles to reorder sections and what's in them. Rename, hide or edit anything.")
        : el("div", { class: "dayswitch" },
            el("button", { type: "button", class: "iconbtn", "aria-label": "Previous day", onclick: () => changeDay(-1) }, svgIcon(ICONS.left)),
            el("span", { class: "day-label" }, longDate(state.day)),
            el("button", { type: "button", class: "iconbtn", "aria-label": "Next day", disabled: isToday, onclick: () => changeDay(1) }, svgIcon(ICONS.right))),
      editing ? null : progressLine(isToday)),
    editing
      ? el("button", { type: "button", class: "primary small", onclick: () => { state.editing = false; drawCheckin(view); } }, "Done")
      : el("div", { class: "head-actions" },
          inboxButton(),
          el("button", { type: "button", class: "iconbtn", "aria-label": "Edit dashboard", title: "Edit dashboard",
            onclick: () => { state.editing = true; drawCheckin(view); } }, svgIcon(ICONS.edit))),
  );

  const sections = dashboardSections(editing).filter((s) => editing || (!s.hidden && s.items.length));
  let cards = sections.map((s, i) => editing ? editSectionCard(s, i, sections, view) : sectionCard(s, view));
  if (editing) {
    const sectionList = el("div", { class: "sortable-list sections" }, cards);
    makeSortable(sectionList, async (from, to, keyboard) => {
      await saveLayout(moved(sections, from, to));
      drawCheckin(view);
      if (keyboard) document.querySelector(`.card.editing[data-name="${CSS.escape(sections[from].name)}"] .drag-handle`)?.focus();
    });
    cards = [sectionList];
  }

  const banners = [];
  if (!editing && !isToday) {
    banners.push(el("div", { class: "banner" },
      el("span", {}, `Anything you change is saved to ${longDate(state.day)}.`),
      el("button", { type: "button", class: "link inline", onclick: () => { state.day = today; renderCheckin(view); } }, "Back to today")));
  }
  const paused = pausedUntil();
  if (!editing && paused) {
    banners.push(el("div", { class: "banner" },
      el("span", {}, `Reminders are paused until ${paused}.`),
      el("button", { type: "button", class: "link inline", onclick: () => setPause(null) }, "Resume")));
  }

  const extra = [];
  if (editing) {
    extra.push(el("div", { class: "actions" },
      el("button", { type: "button", class: "secondary", onclick: () => addSection(sections) }, "+ Add section")));
  } else if (!state.trackers.length) {
    extra.push(el("div", { class: "empty" },
      el("p", {}, "Pick a few things to track. Start small: 3 to 5 is plenty, and you can add more any time."),
      el("button", { type: "button", class: "primary", onclick: () => openTrackerSheet({ kind: "rating" }, view) }, "Add something to track")));
  }
  view.replaceChildren(...[head, ...banners, !editing && isToday ? dueCard(view) : null, !editing ? newsCard(view) : null, ...cards, ...extra,
    editing ? null : spotlight(view)].filter(Boolean));
  restoreFocus();
}

/* ---------- desktop: one question at a time, beside Check-in ---------- */

// Shown only on wide screens (CSS): one question that makes sense right now, picked at random.
//
// What counts as a good question, and when:
// - Mood and energy: if not logged in the last 3 hours (they change through the day).
// - Emotions: if not logged in the last 3 hours.
// - Symptoms: once a day, if not answered yet.
// - A good thing: when one is due (Three good things).
// - Habits you can only know at the end of the day (exercise, time outdoors...): from 6pm,
//   if not ticked. Not ones about the night (late screen time) or things HA fills in.
// Never: counts and amounts like alcohol, caffeine or water (logged as they happen, and 0 is a
// real answer), sleep (it has its own place), medicines and notes.
// Once nothing's left, it goes round mood, energy and emotions again: "Anything changed?"
const spot = { id: null, shown: new Set(), day: null };
const RECENT = 3 * 60 * 60 * 1000;

function recentlyLogged(t) {
  const latest = entriesFor(t.id)[0];
  return !!latest && Date.now() - new Date(latest.logged_at).getTime() < RECENT;
}

function spotlightItems() {
  const items = dashboardSections(false).filter((s) => !s.hidden).flatMap((s) => s.items);
  const hour = new Date().getHours();
  const today = state.day === isoDay(new Date());
  const ask = [];
  const again = [];
  for (const t of items) {
    const c = t.config || {};
    if (t.kind === "rating" || t.kind === "tags") {
      const fresh = t.frequency === "daily" ? entriesFor(t.id).length > 0 : recentlyLogged(t);
      (fresh ? again : ask).push(t);
    } else if (t.kind === "symptom") {
      if (!entriesFor(t.id).length) ask.push(t);
    } else if (t.kind === "gratitude") {
      if (today && goodThingsLeft(t) > 0) ask.push(t);
    } else if (t.kind === "factor" && c.mode === "bool" && !c.source) {
      const night = /late|night|bed|screen/i.test(t.name);
      if (!night && (hour >= 18 || !today) && !entriesFor(t.id).length) ask.push(t);
    }
  }
  return { ask, again };
}

function pickSpotlight(skip) {
  const { ask, again } = spotlightItems();
  if (spot.day !== state.day) { spot.day = state.day; spot.shown.clear(); }
  let choices = ask.filter((t) => t.id !== skip);
  if (!choices.length) {
    choices = again.filter((t) => !spot.shown.has(t.id) && t.id !== skip);
    if (!choices.length) { spot.shown.clear(); choices = again.filter((t) => t.id !== skip); }
    if (!choices.length) choices = again;
  }
  if (!choices.length) return null;
  const t = choices[Math.floor(Math.random() * choices.length)];
  spot.shown.add(t.id);
  return t.id;
}

const SPOT_QUESTION = {
  rating: (t) => `How's your ${t.name.toLowerCase()} right now?`,
  tags: () => "How are you feeling right now?",
  symptom: (t) => `Any ${t.name.toLowerCase()} today?`,
  gratitude: () => goodThingPrompt(nowHHMM()),
  factor: (t) => ({ exercise: "Did you exercise today?", outdoors: "Did you get time outdoors today?",
    socialised: "Did you see or talk to people today?", mindful: "Did you take a mindful minute today?" }[t.key] || `${t.name} today?`),
};

// The side question gets its own simple answers, not the Check-in rows: no times, no history,
// no "+" to open a dialog. One tap saves it for right now; then it moves on by itself.
function spotlight(view) {
  if (state.day !== isoDay(new Date())) return null;
  const { ask, again } = spotlightItems();
  if (!ask.length && !again.length) return null;
  let t = state.trackers.find((x) => x.id === spot.id);
  if (!t || spot.day !== state.day) {
    spot.id = pickSpotlight();
    t = state.trackers.find((x) => x.id === spot.id);
  }
  if (!t) return null;
  const next = (delay = 0) => {
    clearTimeout(spot.timer);
    spot.timer = setTimeout(() => { spot.saved = null; spot.id = pickSpotlight(t.id); drawCheckin(view); }, delay);
  };
  const save = async (items, said, advance = true) => {
    const hadFocus = !!(document.activeElement && document.activeElement.closest(".spotlight"));
    try {
      await api("POST", "api/checkin", { logged_at: localISO(new Date()), items });
      spot.saved = { id: t.id, said };
      await refreshCheckin();
      if (hadFocus) document.querySelector(".spotlight .spot-saved")?.focus();
      offerBreathing(items);
      if (advance) next(1400);
    } catch (err) { toast(err.message); }
  };
  const saved = spot.saved && spot.saved.id === t.id ? spot.saved.said : null;
  const nothingLeft = !ask.length;
  const question = nothingLeft && !ask.some((x) => x.id === t.id) && (t.kind === "rating" || t.kind === "tags")
    ? `Anything changed with your ${t.kind === "tags" ? "feelings" : t.name.toLowerCase()}?` : (SPOT_QUESTION[t.kind] || (() => t.name))(t);
  const c = t.config;
  let body;
  if (t.kind === "rating") {
    const values = [];
    for (let v = c.min; v <= c.max; v++) values.push(v);
    body = [el("div", { class: `spot-scale n${values.length}` }, values.map((v) => el("button", {
        type: "button", class: "spot-num", style: `--c:${scaleColor(c, v)}`, title: ratingText(c, v), "aria-label": ratingText(c, v),
        onclick: () => save([{ tracker_id: t.id, value_num: v }], ratingText(c, v)) }, String(v)))),
      (c.labels || []).length ? el("div", { class: "spot-ends" }, el("span", {}, c.labels[0]), el("span", {}, c.labels[c.labels.length - 1])) : null];
  } else if (t.kind === "symptom") {
    body = el("div", { class: "spot-choices" }, state.meta.severity_labels.map((label, i) => el("button", {
      type: "button", class: "spot-choice", style: `--c:${SEVERITY_COLOURS[i]}`,
      onclick: () => save([{ tracker_id: t.id, value_num: i }], label) }, label)));
  } else if (t.kind === "factor") {
    body = el("div", { class: "spot-choices two" },
      el("button", { type: "button", class: "spot-choice", onclick: () => save([{ tracker_id: t.id, value_num: 1 }], "Yes") }, "Yes"),
      el("button", { type: "button", class: "spot-choice", onclick: () => save([{ tracker_id: t.id, value_num: 0 }], "Not today") }, "Not today"));
  } else if (t.kind === "tags") {
    // pick as many as fit, then Done; taps within the hour add to the same answer
    const recent = entriesFor(t.id).find((e) => Date.now() - new Date(e.logged_at).getTime() < 60 * 60 * 1000 && spot.saved && spot.saved.id === t.id);
    const chosen = new Set(recent ? recent.value_json || [] : []);
    const toggle = async (opt) => {
      if (chosen.has(opt)) chosen.delete(opt); else chosen.add(opt);
      try {
        if (recent && chosen.size) await api("PATCH", `api/entries/${recent.id}`, { value_json: [...chosen] });
        else if (recent) await api("DELETE", `api/entries/${recent.id}`);
        else await api("POST", "api/checkin", { logged_at: localISO(new Date()), items: [{ tracker_id: t.id, value_json: [...chosen] }] });
        spot.saved = chosen.size ? { id: t.id, said: [...chosen].join(", "), multi: true } : null;
        await refreshCheckin();
        offerBreathing([{ tracker_id: t.id, value_json: [...chosen] }]);
      } catch (err) { toast(err.message); }
    };
    body = el("div", { class: "bchips spot-tags" }, (c.options || []).map((opt) => el("button", {
      type: "button", class: "chip", "aria-pressed": String(chosen.has(opt)), onclick: () => toggle(opt) }, opt)));
  } else if (t.kind === "gratitude") {
    const input = el("input", { type: "text", maxlength: "280", class: "good-input", placeholder: "A coffee, a kind word, a walk…", "aria-label": "One good thing" });
    const times = c.times || [];
    const written = new Set(entriesFor(t.id).map((e) => e.value_num));
    const slot = times.findIndex((x, i) => x <= nowHHMM() && !written.has(i));
    const go = () => { const v = input.value.trim(); if (v) save([{ tracker_id: t.id, note: v, value_num: slot >= 0 ? slot : null }], "Saved"); else input.focus(); };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); go(); } });
    body = el("div", { class: "good-compose-row" }, input, el("button", { type: "button", class: "secondary small", onclick: go }, "Save"));
  }
  const multiSaved = spot.saved && spot.saved.id === t.id && spot.saved.multi;
  return el("aside", { class: "spotlight card", "aria-label": "One quick question" },
    el("p", { class: "spotlight-kicker" }, t.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, t.emoji) : null, question),
    saved && !multiSaved
      ? el("p", { class: "spot-saved", role: "status", tabindex: "-1" }, svgIcon(ICONS.check), t.kind === "gratitude" ? "Saved. Nice one." : `Saved: ${saved}`)
      : body,
    el("div", { class: "spotlight-foot" },
      multiSaved ? el("button", { type: "button", class: "secondary small", onclick: () => next() }, "Done")
        : saved ? null : el("button", { type: "button", class: "link inline spot-skip", onclick: () => next() }, "Skip")));
}

// Items that count towards "7 of 12 answered": the questions on the screen. Medications, notes and
// yes/no habits aren't counted, because leaving those blank is a normal answer.
function answerable() {
  return dashboardSections(false).filter((s) => !s.hidden)
    .flatMap((s) => s.items)
    .filter((t) => !isMeds(t) && t.kind !== "note" && t.kind !== "gratitude" && !(t.kind === "factor" && t.config.mode === "bool"));
}

function progressLine(isToday) {
  const items = answerable();
  const done = items.filter((t) => entriesFor(t.id).length).length;
  const parts = [];
  if (items.length) parts.push(done === items.length ? `All ${items.length} done. Nice work` : `${done} of ${items.length} answered`);
  // a small moment when the last one's filled in (not when you open the app to find it done)
  const allDone = items.length > 0 && done === items.length;
  if (isToday) {
    const was = state.doneSeen && state.doneSeen.day === state.day ? state.doneSeen.done : null;
    if (was === false && allDone) setTimeout(() => toast("That's everything for today. Nice work."), 300);
    state.doneSeen = { day: state.day, done: allDone };
  }
  if (isToday && state.nextCheckin) parts.push(`next check-in ${niceTime(state.nextCheckin)}`);
  if (!parts.length) return null;
  return el("div", { class: "progress" },
    items.length ? el("div", { class: "progress-bar", role: "progressbar", "aria-label": "Answered today",
      "aria-valuemin": "0", "aria-valuemax": String(items.length), "aria-valuenow": String(done) },
      el("span", { style: `width:${Math.round((done / items.length) * 100)}%` })) : null,
    el("span", { class: "row-sub" }, parts.join(" · ")));
}

/* ---------- notifications inside the app ---------- */

function inboxButton() {
  const n = (state.inbox || []).length;
  return el("button", { type: "button", class: "iconbtn inbox-btn", title: "Notifications",
    "aria-label": n ? `Notifications, ${n} waiting` : "Notifications", onclick: openInbox },
    svgIcon(ICONS.bell), n ? el("span", { class: "badge", "aria-hidden": "true" }, String(n)) : null);
}

async function answerInbox(item, verb, reason) {
  try {
    state.inbox = await api("POST", `api/inbox/${item.id}`, { verb, reason: reason || null });
    toast(verb === "TAKEN" ? "Taken" : verb === "SNOOZE" ? "Snoozed" : verb === "SKIP" ? "Skipped" : "Done");
    await refreshCheckin();
    if (document.getElementById("sheet").open) drawInbox();
  } catch (err) { toast(err.message); }
}

function drawInbox() {
  const sheet = document.getElementById("sheet");
  const items = state.inbox || [];
  const card = (item) => {
    if (item.kind === "supply") {
      const t = state.trackers.find((x) => x.id === item.tracker_id);
      return el("div", { class: "inbox-item" },
        el("div", { class: "inbox-text" }, el("strong", {}, t ? t.name : "Medication"),
          el("span", { class: `callout ${item.level}` }, item.title)),
        t ? el("div", { class: "inbox-actions" }, el("button", { type: "button", class: "secondary small", onclick: () => openMedSheet(t) }, "Open")) : null);
    }
    const buttons = item.actions.map((a, i) => el("button", { type: "button", class: i === 0 ? "primary small" : "secondary small",
      onclick: () => (a.reason ? openSkipSheet({ name: item.title.replace(/^Time for (your )?/, "") }, (r) => answerInbox(item, a.verb, r)) : answerInbox(item, a.verb)) },
      a.label));
    if (item.kind === "checkin") {
      buttons.push(el("button", { type: "button", class: "secondary small", onclick: () => { sheet.close(); window.scrollTo({ top: 0, behavior: motionOK() ? "smooth" : "auto" }); } }, "Check in now"));
    }
    return el("div", { class: "inbox-item" },
      el("div", { class: "inbox-text" },
        el("strong", {}, item.title),
        item.message ? el("span", { class: "inbox-message" }, item.message) : null,
        item.snoozed_until ? el("span", { class: "row-sub" }, `Snoozed until ${niceTime(item.snoozed_until)}`) : null),
      el("div", { class: "inbox-actions" }, buttons));
  };
  sheet.replaceChildren(el("div", { class: "sheet-body" },
    el("div", { class: "med-sheet-head" }, el("h2", {}, "Notifications"),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": "Close", onclick: () => sheet.close() }, svgIcon(ICONS.close))),
    items.length ? el("div", { class: "inbox" }, items.map(card))
      : el("p", { class: "row-sub" }, "You're all caught up. Reminders show here as well as on your phone, and answering in either place clears both.")));
}

async function openInbox() {
  try { state.inbox = await api("GET", "api/inbox"); } catch { /* show what we have */ }
  drawInbox();
  const sheet = document.getElementById("sheet");
  if (!sheet.open) sheet.showModal();
}

// Keep Check-in current while it's open: new reminders appear without a reload.
setInterval(() => {
  const sheet = document.getElementById("sheet");
  if (document.visibilityState === "visible" && currentTab() === "checkin" && !state.editing && sheet && !sheet.open
      && state.day === isoDay(new Date()) && state.me
      && !(document.activeElement && document.activeElement !== document.body && viewEl().contains(document.activeElement))) refreshCheckin().catch(() => {});
}, 60000);

/* ---------- pausing reminders ---------- */

function pausedUntil() {
  const until = state.person && state.person.paused_until;
  if (!until || new Date(until) <= new Date()) return null;
  const d = new Date(until);
  const day = isoDay(d);
  const time = niceTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  return day === isoDay(new Date()) ? time : `${dayLabel(day)} ${time}`;
}

async function setPause(until) {
  try {
    state.person = await api("PUT", "api/reminders/settings", { paused_until: until ? localISO(until) : null });
    toast(until ? "Reminders paused" : "Reminders are back on");
    await redraw();
  } catch (err) { toast(err.message); }
}

function openPauseSheet() {
  const sheet = document.getElementById("sheet");
  const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
  const inHours = (h) => new Date(Date.now() + h * 3600 * 1000);
  const pick = (until) => { sheet.close(); setPause(until); };
  const customDay = el("input", { type: "date", "aria-label": "Pause until, day", min: isoDay(new Date()), value: addDays(isoDay(new Date()), 1) });
  const customTime = el("time-field", { value: "07:00", "aria-label": "Pause until, time" });
  const custom = { get value() {
    if (!customDay.value || !customTime.value) return "";
    return `${customDay.value}T${customTime.value}`;
  } };
  const item = (label, fn) => el("button", { type: "button", class: "menu-item", onclick: fn }, label);
  sheet.replaceChildren(el("div", { class: "sheet-body" },
    el("h2", {}, "Pause reminders"),
    el("p", { class: "row-sub", style: "margin:-8px 0 14px" },
      "No notifications or announcements until then. Doses still show on Check-in, and anything still due comes back afterwards."),
    el("div", { class: "menu" },
      item("For 1 hour", () => pick(inHours(1))),
      item("For 3 hours", () => pick(inHours(3))),
      item("Until tomorrow morning (7am)", () => pick(at(1, 7))),
      item("For 3 days", () => pick(at(3, 7))),
      item("For a week", () => pick(at(7, 7)))),
    field("Or until", el("div", { class: "inline-field" }, customDay, customTime,
      el("button", { type: "button", class: "secondary small", onclick: () => { if (custom.value) pick(new Date(custom.value)); } }, "Pause"))),
    el("div", { class: "actions" },
      pausedUntil() ? el("button", { type: "button", class: "primary", onclick: () => pick(null) }, "Resume now") : null,
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel"))));
  sheet.showModal();
}

/* ---------- swipe between days ---------- */

let swipeStart = null;
function watchSwipe() {
  const view = viewEl();
  view.addEventListener("touchstart", (ev) => {
    const t = ev.touches[0];
    const skip = ev.touches.length > 1 || ev.target.closest("input, textarea, select, .rating-grid, .level-tiles");
    swipeStart = skip ? null : { x: t.clientX, y: t.clientY, at: Date.now() };
  }, { passive: true });
  view.addEventListener("touchend", (ev) => {
    if (!swipeStart || currentTab() !== "checkin" || state.editing) return;
    const t = ev.changedTouches[0];
    const dx = t.clientX - swipeStart.x;
    const dy = t.clientY - swipeStart.y;
    const quick = Date.now() - swipeStart.at < 600;
    swipeStart = null;
    if (quick && Math.abs(dx) > 70 && Math.abs(dy) < 40) changeDay(dx > 0 ? -1 : 1);
  }, { passive: true });
}

async function changeDay(delta) {
  const next = addDays(state.day, delta);
  if (next > isoDay(new Date())) return;
  state.day = next;
  await renderCheckin(viewEl());
}

/* ---------- a section card (accordion) ---------- */

// What's left in a section today: doses still to take, or questions not answered yet.
// null when the section has nothing to count (notes, or medicines with no reminders today).
function sectionLeft(items) {
  if (items.some(isMeds)) {
    const ids = new Set(items.filter(isMeds).map((t) => t.id));
    const today = state.doses.filter((d) => ids.has(d.tracker_id) && d.local_day === state.day && d.status !== "cancelled");
    if (!today.length) return null;
    return today.filter((d) => d.status === "scheduled" || d.status === "due").length;
  }
  const counted = items.filter((t) => t.kind !== "note" && t.kind !== "gratitude" && !(t.kind === "factor" && t.config.mode === "bool"));
  const good = items.filter((t) => t.kind === "gratitude");
  if (!counted.length && !good.length) return null;
  return counted.filter((t) => !entriesFor(t.id).length).length + good.reduce((a, t) => a + goodThingsLeft(t), 0);
}

function sectionCard(s, view) {
  const key = `section:${s.name}`;
  const open = !collapsed.has(key);
  const meds = s.items.some(isMeds);
  const left = sectionLeft(s.items);
  const header = el("div", { class: "card-head" },
    el("h2", { class: "card-h" }, el("button", { type: "button", class: "card-toggle", "aria-expanded": String(open), onclick: () => toggleCollapsed(key) },
      el("span", { class: "card-icon" }, sectionIcon(s.name)),
      el("span", { class: "card-title" }, s.name),
      left == null ? null : left === 0
        ? el("span", { class: "card-done", title: "All done today", "aria-label": "All done today" }, svgIcon(ICONS.check))
        : el("span", { class: "card-left", title: meds ? `${left} still to take today` : `${left} not filled in yet`,
            "aria-label": meds ? `${left} still to take today` : `${left} not filled in yet` }, String(left)),
      el("span", { class: "card-chevron" }, svgIcon(open ? ICONS.up : ICONS.down)))),
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
      meds ? item("Log the same as last time", () => copyLast(s)) : null,
      meds ? item("Create a group to log together", () => openGroupSheet(null, view)) : null,
      meds ? item("Supply and scripts", () => { location.hash = "#/settings"; }) : null,
      meds ? item("Reminders and devices", () => { location.hash = "#/settings"; }) : null,
      !meds ? item("Copy yesterday's answers", () => copyYesterday(s)) : null,
      s.items.some((t) => t.kind === "rating" || t.kind === "tags") ? item("Breathe for a minute", () => openBreathing()) : null,
      item("Hide this section", () => hideSection(s)),
      item("Edit dashboard", () => { state.editing = true; drawCheckin(view); })),
    el("div", { class: "actions" }, el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Close"))));
  sheet.showModal();
}

async function hideSection(s) {
  const all = dashboardSections(true);
  const set = async (hidden) => {
    await saveLayout(all.map((x) => x.name === s.name ? { ...x, hidden } : x));
    drawCheckin(viewEl());
  };
  try {
    await set(true);
    toast(`${s.name} hidden`, "Undo", () => set(false));
  } catch (err) { toast(err.message); }
}

// Fill anything not answered yet in this section with yesterday's answer.
async function copyYesterday(s) {
  const prev = state.prevEntries || [];
  const items = [];
  for (const t of s.items) {
    if (isMeds(t) || t.kind === "note" || entriesFor(t.id).length) continue;
    const e = prev.find((x) => x.tracker_id === t.id);
    if (!e) continue;
    items.push({ tracker_id: t.id, value_num: e.value_num, value_json: e.value_json });
  }
  if (!items.length) {
    toast(prev.some((e) => s.items.some((t) => t.id === e.tracker_id)) ? "Nothing left to copy from yesterday" : "Nothing from yesterday to copy");
    return;
  }
  const res = await quickSave(items);
  if (res) toast(`Copied ${items.length} from yesterday`, "Undo", async () => {
    for (const e of res.saved) await api("DELETE", `api/entries/${e.id}`).catch(() => {});
    await refreshCheckin();
  });
}

/* ---------- drag to reorder ---------- */

ICONS.grip = "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01";

// Drag rows inside `list` by their handle, with a finger or a mouse. The arrow keys on a focused
// handle move it too. onMove(from, to) is called once, when it's dropped somewhere new.
function makeSortable(list, onMove) {
  const rows = () => [...list.children].filter((c) => c.classList.contains("sortable"));
  list.addEventListener("keydown", (ev) => {
    const handle = ev.target.closest(".drag-handle");
    if (!handle || !["ArrowUp", "ArrowDown"].includes(ev.key)) return;
    const row = handle.closest(".sortable");
    if (!row || row.parentElement !== list) return; // a list inside this one handles its own rows
    ev.preventDefault();
    const from = rows().indexOf(row);
    const to = from + (ev.key === "ArrowUp" ? -1 : 1);
    if (to >= 0 && to < rows().length) onMove(from, to, true);
  });
  list.addEventListener("pointerdown", (ev) => {
    const handle = ev.target.closest(".drag-handle");
    if (!handle || ev.button > 0) return;
    const row = handle.closest(".sortable");
    if (!row || row.parentElement !== list) return;
    ev.preventDefault();
    const all = rows();
    const from = all.indexOf(row);
    const rect = row.getBoundingClientRect();
    const startY = ev.clientY;
    const placeholder = el("div", { class: "drag-placeholder", style: `height:${rect.height}px` });
    row.after(placeholder);
    row.classList.add("dragging");
    Object.assign(row.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, zIndex: 50 });
    handle.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const dy = e.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      const mid = rect.top + dy + rect.height / 2;
      const others = rows().filter((r) => r !== row);
      const before = others.find((r) => { const b = r.getBoundingClientRect(); return mid < b.top + b.height / 2; });
      if (before) list.insertBefore(placeholder, before); else (others.length ? others[others.length - 1].after(placeholder) : list.append(placeholder));
      // keep scrolling when dragging near the edge
      if (e.clientY < 60) window.scrollBy(0, -12); else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      placeholder.replaceWith(row);
      row.classList.remove("dragging");
      row.removeAttribute("style");
      const to = rows().indexOf(row);
      if (to !== from) onMove(from, to, false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}

function dragHandle(label) {
  return el("button", { type: "button", class: "iconbtn plain drag-handle", "aria-label": `Drag to move ${label}. Or use the arrow keys`,
    title: "Drag to move" }, svgIcon(ICONS.grip));
}

function moved(list, from, to) {
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
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
    dragHandle(s.name),
    el("span", { class: "card-icon" }, sectionIcon(s.name)),
    el("span", { class: "card-title" }, s.name, s.hidden ? el("span", { class: "muted-tag" }, " Hidden") : null),
    el("div", { class: "edit-tools" },
      el("button", { type: "button", class: "iconbtn plain", "aria-label": `Rename ${s.name}`, onclick: rename }, svgIcon(ICONS.edit)),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": s.hidden ? `Show ${s.name}` : `Hide ${s.name}`,
        title: s.hidden ? "Show section" : "Hide section", onclick: toggleHidden }, svgIcon(s.hidden ? ICONS.eye : ICONS.eyeOff))));

  const meds = s.items.some(isMeds) || /med|supplement/i.test(s.name);
  const rows = s.items.map((t, j) => editItemRow(t, j, s, sections, view));
  const itemList = el("div", { class: "sortable-list" }, rows);
  makeSortable(itemList, async (from, to, keyboard) => {
    // the section's items keep the same places in the overall order, just shuffled among themselves
    const order = state.allTrackers.map((x) => x.id);
    const slots = s.items.map((t) => order.indexOf(t.id)).sort((a, b) => a - b);
    moved(s.items, from, to).forEach((t, k) => { order[slots[k]] = t.id; });
    await api("POST", "api/trackers/order", { ids: order });
    await refreshCheckin();
    if (keyboard) document.querySelector(`.edit-row[data-id="${s.items[from].id}"] .drag-handle`)?.focus();
  });
  const add = el("button", { type: "button", class: "secondary small add-in-section",
    onclick: () => openTrackerSheet(meds ? { kind: "medication", group_name: s.name } : { kind: "rating", group_name: s.name }, view) },
    `+ Add to ${s.name}`);
  const groups = meds && state.person ? el("div", { class: "edit-groups" },
    el("span", { class: "row-sub" }, "Groups"),
    el("div", { class: "bchips small" },
      state.person.med_groups.map((g) => el("button", { type: "button", class: "chip", onclick: () => openGroupSheet(g, view) }, g.name, svgIcon(ICONS.edit))),
      el("button", { type: "button", class: "chip", onclick: () => openGroupSheet(null, view) }, "+ New group"))) : null;
  return el("section", { class: `card editing sortable${s.hidden ? " dim" : ""}`, "data-name": s.name }, header,
    el("div", { class: "card-body" }, rows.length ? itemList : el("p", { class: "row-sub" }, "Nothing here yet."), groups, add));
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
  return el("div", { class: `edit-row sortable${t.hidden ? " dim" : ""}`, "data-id": t.id },
    dragHandle(t.name),
    el("div", { class: "brow-text" }, rowName(t), el("span", { class: "row-sub" }, t.hidden ? "Hidden" : describeTracker(t))),
    el("div", { class: "edit-tools" },
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

// Minutes from now until "HH:MM" today (negative if it's passed).
function minutesUntil(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  return h * 60 + m - (now.getHours() * 60 + now.getMinutes());
}

// Due: doses waiting and other reminders you've been sent (check-in, water), answerable here.
// Coming up: only what's in the next 30 minutes.
function dueCard(view) {
  const due = state.doses.filter((d) => d.status === "due");
  const waiting = (state.inbox || []).filter((x) => x.kind === "checkin" || x.kind === "hydration");
  const soon = state.doses.filter((d) => d.status === "scheduled" && d.local_day === state.day
    && minutesUntil(d.time) >= 0 && minutesUntil(d.time) <= 30);
  const checkinSoon = state.nextCheckin && !waiting.some((x) => x.kind === "checkin")
    && minutesUntil(state.nextCheckin) >= 0 && minutesUntil(state.nextCheckin) <= 30;
  const upFor = (state.wake && state.wake.waiting) || [];
  if (!due.length && !waiting.length && !soon.length && !checkinSoon && !upFor.length) return null;

  const act = async (d, action, reason) => {
    if (action === "skip" && reason === undefined) { openSkipSheet(d, (r) => act(d, "skip", r)); return; }
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
  for (const item of waiting) {
    const buttons = item.actions.map((a, i) => el("button", { type: "button", class: i === 0 ? "primary small" : "secondary small",
      onclick: () => answerInbox(item, a.verb) }, a.label));
    if (item.kind === "checkin") {
      buttons.unshift(el("button", { type: "button", class: "primary small", onclick: () => {
        const first = document.querySelector(".card:not(.due-card) .card-body");
        if (first) { first.scrollIntoView({ behavior: motionOK() ? "smooth" : "auto", block: "start" }); first.closest(".card").querySelector("button")?.focus({ preventScroll: true }); }
      } }, "Check in now"));
      buttons.forEach((b, i) => { if (i) b.className = "secondary small"; });
    }
    rows.push(el("div", { class: "brow" },
      el("div", { class: "brow-text" },
        el("span", { class: "brow-name" }, item.title),
        el("span", { class: "row-sub" }, item.snoozed_until ? `Snoozed until ${niceTime(item.snoozed_until)}`
          : item.since ? `Since ${niceTime(item.since)}` : item.message)),
      el("div", { class: "due-actions" }, buttons)));
  }
  const later = soon.map((d) => ({ time: d.time, text: `${d.name}${d.amount ? " " + d.amount : ""}`,
    open: () => { const t = state.trackers.find((x) => x.id === d.tracker_id); if (t) openDoseDialog(t, null, { quantity: d.quantity }); } }));
  if (checkinSoon) later.push({ time: state.nextCheckin, text: "Check-in" });
  later.sort((a, b) => a.time.localeCompare(b.time));
  const count = due.length + waiting.length;
  // Medications due "when I wake up" that are still waiting for it
  const wakeRow = upFor.length ? el("div", { class: "wake-row" },
    el("span", { class: "card-icon" }, svgIcon(ICONS.sun)),
    el("div", { class: "brow-text" },
      el("span", { class: "brow-name" }, `When you're up: ${joinNames(upFor.map((x) => x.name))}`),
      el("span", { class: "row-sub" }, state.wake.fallback
        ? `Due when you're up (off the charger, or seen by Home Assistant), or at ${niceTime(state.wake.fallback)}.`
        : "Due when you're up (off the charger, or seen by Home Assistant).")),
    el("button", { type: "button", class: "primary small", onclick: async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        state.wake = await api("POST", "api/wake");
        state.doses = await api("GET", "api/doses/today");
        toast("Morning! Your wake-up medications are due now");
        drawCheckin(view);
      } catch (err) { toast(err.message); ev.currentTarget.disabled = false; }
    } }, "I'm up")) : null;
  return el("section", { class: `card due-card${count ? "" : " soon-only"}`, "aria-label": count ? "Due now" : "Coming up" },
    wakeRow,
    count ? [
      el("div", { class: "card-head" },
        el("span", { class: "card-icon" }, svgIcon(ICONS.bell)),
        el("h2", { class: "card-title" }, "Due"),
        el("span", { class: "card-count", "aria-label": `${count} waiting` }, String(count))),
      el("div", { class: "card-body" }, rows),
    ] : null,
    later.length ? el("div", { class: "coming-up" },
      el("span", { class: "coming-up-title" }, count ? "Next 30 minutes" : "Coming up in the next 30 minutes"),
      el("ul", {}, later.map((x) => el("li", {},
        el("span", { class: "why-time" }, niceTime(x.time)),
        el("span", { class: "coming-up-what" }, x.text),
        x.open ? el("button", { type: "button", class: "secondary small", onclick: x.open, "aria-label": `Log ${x.text} now` }, "Log now") : null)))) : null);
}

const SKIP_REASONS = ["Felt fine", "Side effects", "Ran out", "Not needed today", "Forgot, too late now"];

function openSkipSheet(d, done) {
  const sheet = document.getElementById("sheet");
  const other = el("input", { type: "text", maxlength: "200", placeholder: "Something else", "aria-label": "Another reason", style: "flex:1;min-width:0" });
  const go = (r) => { sheet.close(); done(r); };
  sheet.replaceChildren(el("div", { class: "sheet-body" },
    el("h2", {}, `Skip ${d.name}?`),
    el("p", { class: "row-sub", style: "margin:-8px 0 14px" }, "A reason is optional. It's kept with the dose so you can look back on it."),
    el("div", { class: "bchips" }, SKIP_REASONS.map((r) => el("button", { type: "button", class: "chip", onclick: () => go(r) }, r))),
    el("div", { class: "inline-field", style: "margin-top:12px" }, other,
      el("button", { type: "button", class: "secondary small", onclick: () => go(other.value.trim() || null) }, "Skip")),
    el("div", { class: "actions" },
      el("button", { type: "button", class: "primary", onclick: () => go(null) }, "Skip without a reason"),
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel"))));
  sheet.showModal();
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
  return c.dose != null && c.dose !== "" ? `${fmtNum(c.dose)} ${c.unit || ""}`.trim() : (c.unit || "");
}

function medsBody(s, view) {
  const groups = (state.person && state.person.med_groups) || [];
  const groupBlock = groups.length ? el("div", { class: "med-groups" },
    el("span", { class: "row-sub" }, "Log together:"),
    groups.map((g) => el("button", { type: "button", class: "chip", title: `Log everything in ${g.name}`, onclick: () => logGroup(g) }, g.name))) : null;
  const rows = s.items.filter(isMeds).map((t) => medRow(t, view));
  const others = s.items.filter((t) => !isMeds(t)).map((t) => trackerRow(t, view));
  return [groupBlock, ...rows, ...others];
}

function medRow(t, view) {
  const taken = entriesFor(t.id).slice().reverse(); // earliest first
  const c = t.config;
  const planned = state.doses.filter((d) => d.tracker_id === t.id && d.local_day === state.day && d.status !== "cancelled");
  const byId = new Map(taken.map((e) => [e.id, e]));
  const linked = new Set(planned.map((d) => d.entry_id).filter(Boolean));

  // One chip per dose today, in time order: taken (tap to change), due, still to come, skipped.
  const takenChip = (e) => el("button", { type: "button", class: "plan-dose plan-taken",
    "aria-label": `${t.name} ${doseText(t, e)} taken at ${timeOf(e.logged_at)}. Change or delete`,
    onclick: () => openDoseDialog(t, e) }, svgIcon(ICONS.check), `${qtyText(t, e.value_num ?? 1)} · ${timeOf(e.logged_at)}`);
  const chips = [];
  for (const d of planned) {
    const text = `${qtyText(t, d.quantity)} at ${niceTime(d.time)}`;
    const e = d.entry_id && byId.get(d.entry_id);
    if (d.status === "taken" && e) chips.push({ at: e.logged_at, node: takenChip(e) });
    else if (d.status === "scheduled" || d.status === "due") {
      chips.push({ at: d.time, node: el("button", { type: "button", class: `plan-dose plan-${d.status}`,
        "aria-label": `Log ${text}`, title: "Log this dose", onclick: () => openDoseDialog(t, null, { quantity: d.quantity }) },
        d.status === "due" ? `${qtyText(t, d.quantity)} due` : text) });
    } else {
      chips.push({ at: d.time, node: el("span", { class: `plan-dose plan-${d.status}` }, text,
        el("span", { class: "plan-mark" }, d.status === "taken" ? " ✓" : ` (${d.status})`)) });
    }
  }
  for (const e of taken) if (!linked.has(e.id)) chips.push({ at: e.logged_at, node: takenChip(e) });
  const timeKey = (x) => (/T(\d{2}:\d{2})/.exec(x) || [null, x])[1];
  chips.sort((a, b) => timeKey(a.at).localeCompare(timeKey(b.at)));

  const totalQty = taken.reduce((a, e) => a + Number(e.value_num || 1), 0);
  const totalStrength = taken.reduce((a, e) => {
    const strength = e.value_json && e.value_json.dose != null ? e.value_json.dose : c.dose;
    return strength != null && strength !== "" ? a + Number(strength) * Number(e.value_num || 1) : a;
  }, 0);
  const strength = strengthText(t);
  return el("div", { class: "med-row" },
    el("div", { class: "brow-main" },
      el("div", { class: "brow-text" },
        el("button", { type: "button", class: "brow-name name-btn", title: "Supply, reminders and details", onclick: () => openMedSheet(t) },
          t.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, t.emoji) : null, t.name,
          strength ? el("span", { class: "med-strength" }, strength) : null)),
      el("button", { type: "button", class: "secondary small log-dose", "aria-label": `Log ${t.name}`, onclick: () => openDoseDialog(t, null) },
        svgIcon(ICONS.plus), "Log")),
    chips.length ? el("div", { class: "med-plan", role: "group", "aria-label": `${t.name} today` }, chips.map((x) => x.node))
      : el("div", { class: "row-sub" }, `Usually ${usualText(t)}`),
    taken.length > 1 || supplyCallout(t) ? el("div", { class: "med-foot" },
      supplyCallout(t),
      taken.length > 1 ? el("span", { class: "row-sub med-total" },
        `Today ${qtyText(t, totalQty)}${totalStrength ? ` · ${fmtNum(totalStrength)} ${c.unit || ""}`.trimEnd() : ""}`) : null) : null);
}

/* ---------- supply and refills ---------- */

// The one thing that most needs doing, or nothing.
function supplyCallout(t) {
  const sup = state.supply && state.supply.get(t.id);
  const alert = sup && sup.status && sup.status.alerts[0];
  if (!alert) return null;
  const more = sup.status.alerts.length - 1;
  return el("button", { type: "button", class: `callout ${alert.level}`, onclick: () => openMedSheet(t) },
    alert.text, more ? el("span", { class: "callout-more" }, ` · ${more} more`) : null);
}

const plainNum = (n) => fmtNum(n);

// "See your doctor by 22 Oct, for a new Clonidine script." The earliest across every medicine.
function doctorLine(supply, meds) {
  const name = (id) => (meds.find((t) => t.id === id) || {}).name;
  const due = supply.filter((x) => x.status && x.status.script_by)
    .sort((a, b) => a.status.script_by.localeCompare(b.status.script_by));
  if (!due.length) {
    return supply.length ? el("p", { class: "hint doctor-line" }, "Add your repeats or when your script ends to see when you'll need your doctor.") : null;
  }
  const first = due[0].status;
  const same = due.filter((x) => x.status.script_by === first.script_by).map((x) => name(x.tracker_id));
  const later = due.slice(same.length).map((x) => `${name(x.tracker_id)} by ${x.status.script_by_text}`);
  const overdue = first.script_by <= isoDay(new Date());
  return el("div", { class: `doctor-line${overdue ? " danger" : ""}` },
    el("strong", {}, overdue ? "See your doctor now" : `See your doctor by ${first.script_by_text}`),
    el("span", {}, ` for a new ${joinNames(same)} script.`),
    later.length ? el("span", { class: "row-sub" }, ` Then ${joinNames(later)}.`) : null);
}

function supplyLine(st) {
  const parts = [`${plainNum(st.stock)} ${st.word} left`];
  if (st.runs_out_text) parts.push(`runs out around ${st.runs_out_text}`);
  return parts.join(" · ");
}

async function openMedSheet(t) {
  const sheet = document.getElementById("sheet");
  let sup;
  try { sup = await api("GET", `api/trackers/${t.id}/supply`); } catch (err) { toast(err.message); return; }
  const strength = strengthText(t);
  const head = el("div", { class: "med-sheet-head" },
    el("h2", {}, t.name, strength ? el("span", { class: "med-strength" }, ` ${strength}`) : null),
    el("button", { type: "button", class: "iconbtn plain", "aria-label": "Close", onclick: () => sheet.close() }, svgIcon(ICONS.close)));
  const s = sup.settings;
  const st = sup.status;
  let body;
  if (!s.enabled) {
    body = [
      el("p", { class: "row-sub" }, "Know how long your supply will last, when you can refill, and when to see your doctor for a new script."),
      el("div", { class: "actions" },
        el("button", { type: "button", class: "primary", onclick: () => openSupplyEditor(t, sup) }, "Set up"),
        el("button", { type: "button", class: "link", onclick: () => openScheduleSheet(t, viewEl()) }, "Reminders")),
    ];
  } else {
    const full = Math.max(s.pack || 0, st.stock, 1);
    const days = st.days_left;
    const lines = [];
    // "About 6 days left" is already the headline, so only the other warnings are listed.
    for (const a of st.alerts) if (a.kind !== "low") lines.push(el("li", { class: `callout ${a.level}` }, a.text));
    if (st.refill_from_text && st.alerts.some((a) => a.kind === "low")) lines.push(el("li", {}, `Refill from ${st.refill_from_text}`));
    if (st.refill_from_text && !st.alerts.some((a) => a.kind === "low")) lines.push(el("li", {}, `Refill from ${st.refill_from_text}`));
    if (st.repeats != null && st.repeats > 0) lines.push(el("li", {}, st.repeats === 1 ? "1 repeat left" : `${st.repeats} repeats left`));
    if (st.script_by_text && !st.alerts.some((a) => a.kind === "script")) {
      lines.push(el("li", {}, `New script needed by ${st.script_by_text}`));
    }
    const perDay = st.per_day ? `${plainNum(st.per_day)} ${plural(t.config.counted_as || "dose", st.per_day > 1 ? 2 : 1)} a day` : null;
    body = [
      el("div", { class: "supply-big" }, days != null ? (days === 1 ? "About 1 day left" : `About ${days} days left`) : `${plainNum(st.stock)} ${st.word} left`),
      el("div", { class: "supply-bar", role: "img", "aria-label": `${plainNum(st.stock)} of ${plainNum(full)}` },
        el("span", { class: st.alerts.length ? st.alerts[0].level : "", style: `width:${Math.min(100, Math.round((st.stock / full) * 100))}%` })),
      el("p", { class: "row-sub supply-line" }, days != null ? supplyLine(st) : "Add how many you take a day to see when it runs out."),
      lines.length ? el("ul", { class: "supply-lines" }, lines) : null,
      el("div", { class: "supply-actions" },
        el("button", { type: "button", class: "secondary small", onclick: () => openRefillSheet(t, sup) }, svgIcon(ICONS.plus), "Refill"),
        el("button", { type: "button", class: "link", onclick: () => openSupplyEditor(t, sup) }, "Edit")),
      el("details", { class: "more" },
        el("summary", {}, "Script details"),
        el("dl", { class: "facts" },
          perDay ? [el("dt", {}, "Take"), el("dd", {}, perDay)] : null,
          s.pack ? [el("dt", {}, "Each refill"), el("dd", {}, `${plainNum(s.pack)} ${plural(t.config.counted_as || "dose", s.pack)}`)] : null,
          s.last_refill ? [el("dt", {}, "Last refill"), el("dd", {}, shortDate(s.last_refill))] : null,
          s.refill_gap ? [el("dt", {}, "Refill again after"), el("dd", {}, `${s.refill_gap} days`)] : null,
          st.repeats != null ? [el("dt", {}, "Repeats left"), el("dd", {}, String(st.repeats))] : null,
          st.expires_text ? [el("dt", {}, "Script ends"), el("dd", {}, st.expires_text)] : null)),
    ];
  }
  sheet.replaceChildren(el("div", { class: "sheet-body med-sheet" }, head, body));
  if (!sheet.open) sheet.showModal();
}

function openRefillSheet(t, sup) {
  const sheet = document.getElementById("sheet");
  const s = sup.settings;
  const word = t.config.counted_as || "dose";
  const qty = el("input", { type: "number", min: "1", step: "any", inputmode: "decimal", value: s.pack ?? "", required: true, style: "width:7em" });
  const day = el("input", { type: "date", value: isoDay(new Date()), max: isoDay(new Date()) });
  const tracked = s.repeats != null;
  const repeat = switchField("Used a repeat", tracked && s.repeats > 0,
    tracked ? (s.repeats > 0 ? `${s.repeats} left before this one` : "None left on this script") : null);
  const newScript = switchField("From a new script", tracked && s.repeats === 0, "Starts the count of repeats again.");
  const repeats = el("input", { type: "number", min: "0", max: "99", step: "1", inputmode: "numeric", style: "width:5em" });
  const expires = el("input", { type: "date" });
  const scriptPanel = el("div", { class: "subpanel" },
    el("div", { class: "field-pair" }, field("Repeats left", repeats), field("Script ends", expires)));
  const drawScript = () => {
    scriptPanel.hidden = !newScript.input.checked;
    repeat.node.hidden = !tracked || newScript.input.checked;
  };
  newScript.input.addEventListener("change", drawScript);
  drawScript();
  const go = el("button", { type: "submit", class: "primary" });
  const drawGo = () => { const n = Number(qty.value) || 0; go.textContent = n ? `Add ${fmtNum(n)} ${plural(word, n)}` : "Add"; };
  qty.addEventListener("input", drawGo);
  drawGo();
  const err = el("p", { class: "form-error", role: "alert", hidden: true });
  const form = el("form", { method: "dialog", class: "even-pairs" },
    el("h2", {}, `Refill ${t.name}`), err,
    el("div", { class: "field-pair" }, field("How many", qty), field("Collected", day)),
    repeat.node, newScript.node, scriptPanel,
    el("div", { class: "actions" }, go, el("button", { type: "button", class: "link", onclick: () => openMedSheet(t) }, "Cancel")));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = { quantity: Number(qty.value), day: day.value || null, used_repeat: repeat.input.checked && !newScript.input.checked };
    if (newScript.input.checked) body.new_script = { repeats: repeats.value === "" ? null : Number(repeats.value), expires: expires.value || null };
    try {
      const r = await api("POST", `api/trackers/${t.id}/supply/refill`, body);
      sheet.close();
      await redraw();
      toast(`Now ${fmtNum(r.status.stock)} ${r.status.word}`, "Undo", async () => {
        await api("PUT", `api/trackers/${t.id}/supply`, r.previous);
        await redraw();
        toast("Refill undone");
      });
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
  qty.focus();
}

function openSupplyEditor(t, sup) {
  const sheet = document.getElementById("sheet");
  const s = sup.settings;
  const st = sup.status;
  const word = plural(t.config.counted_as || "dose", 2);
  const num = (value, attrs = {}) => el("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: value ?? "", style: "width:6em", ...attrs });
  const enabled = switchField("Keep count", s.enabled || !s.count_at, "Each dose you log comes off what's left.");
  const count = num(st ? st.stock : "", { required: true });
  const guess = sup.guess && sup.guess.per_day;
  const perDay = num(s.per_day ?? guess ?? "");
  const pack = num(s.pack);
  const lastRefill = el("input", { type: "date", value: s.last_refill || "", max: isoDay(new Date()) });
  const gap = num(s.refill_gap, { step: "1", placeholder: "None" });
  const repeats = num(s.repeats, { step: "1", placeholder: "Not tracked" });
  const expires = el("input", { type: "date", value: s.expires || "" });
  const warn = (key, label) => {
    const input = num(s[key], { step: "1", style: "width:4.5em", "aria-label": `Days before ${label}` });
    return { key, input, node: el("label", { class: "warn-row" }, input, el("span", {}, `days before ${label}`)) };
  };
  const warns = [warn("warn_low", "I run out"), warn("warn_script", "I need a new script")];
  const unit = (input, text) => el("div", { class: "inline-field" }, input, el("span", {}, text));
  const body = el("div", {},
    field("How many do you have now?", unit(count, word)),
    field("How many a day?", unit(perDay, `${word} a day`),
      s.per_day == null && guess ? `From your ${sup.guess.source === "reminders" ? "reminders" : "recent doses"}. Change it to match your script.` : "As your script says."),
    field("How many in a refill?", unit(pack, word)),
    el("details", { class: "more", open: !!(s.repeats != null || s.expires || s.refill_gap) },
      el("summary", {}, "Your script"),
      el("p", { class: "hint", style: "margin:0 0 10px" }, "Add these to know when to see your doctor."),
      el("div", { class: "field-pair" }, field("Repeats left", repeats), field("Script ends", expires)),
      el("div", { class: "field-pair" }, field("Last refill", lastRefill), field("Refill again after", unit(gap, "days"))),
      el("p", { class: "hint" }, "Some medicines can't be refilled too soon, for example not within 20 days. Leave it blank if yours can.")),
    el("div", { class: "field" }, el("span", {}, "Warn me"), warns.map((w) => w.node)));
  const drawEnabled = () => body.classList.toggle("dimmed", !enabled.input.checked);
  enabled.input.addEventListener("change", drawEnabled);
  drawEnabled();
  const err = el("p", { class: "form-error", role: "alert", hidden: true });
  const form = el("form", { method: "dialog", class: "even-pairs" },
    el("h2", {}, `${t.name}: supply and script`), err, enabled.node, body,
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, "Save"),
      el("button", { type: "button", class: "link", onclick: () => (s.enabled ? openMedSheet(t) : sheet.close()) }, "Cancel")));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const val = (i) => (i.value === "" ? null : Number(i.value));
    const data = {
      enabled: enabled.input.checked,
      per_day: guess != null && Number(perDay.value) === guess && s.per_day == null ? null : val(perDay),
      pack: val(pack), repeats: val(repeats), expires: expires.value || null,
      last_refill: lastRefill.value || null, refill_gap: val(gap),
    };
    for (const w of warns) data[w.key] = val(w.input);
    if (!st || Number(count.value) !== Number(st.stock)) data.count = val(count);
    try {
      await api("PUT", `api/trackers/${t.id}/supply`, data);
      await redraw();
      if (data.enabled) openMedSheet(t); else { sheet.close(); toast(`Stopped counting ${t.name}`); }
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
}

// The dose dialog: ×N with −1/−0.5/+0.5/+1, strength, time, delete, Confirm.
function openDoseDialog(t, entry, opts = {}) {
  const sheet = document.getElementById("sheet");
  const c = t.config;
  const day = entry ? entry.day : state.day;
  const now = new Date();
  let time = entry ? /T(\d{2}:\d{2})/.exec(entry.logged_at)[1] : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const dueNow = entry ? null : state.doses.find((d) => d.tracker_id === t.id && (d.status === "due" || (d.status === "scheduled" && d.local_day === state.day)));
  let count = entry ? Number(entry.value_num ?? 1) : Number(opts.quantity ?? (dueNow ? dueNow.quantity : c.quantity ?? 1));
  let strength = entry && entry.value_json && entry.value_json.dose != null ? entry.value_json.dose : c.dose;

  const countOut = el("span", { class: "dose-big", "aria-live": "polite" });
  const drawCount = () => { countOut.textContent = `× ${fmtNum(count)}`; };
  drawCount();
  const step = (d) => { count = Math.max(0.25, Math.round((count + d) * 4) / 4); drawCount(); markSheetChanged(); };

  const strengthBtn = el("button", { type: "button", class: "strength-edit" });
  const strengthInput = el("input", { type: "number", min: "0", step: "any", inputmode: "decimal", hidden: true, "aria-label": "Strength", style: "width:6em" });
  const drawStrength = () => strengthBtn.replaceChildren(el("span", {}, strength != null && strength !== "" ? fmtNum(strength) : "Add"), svgIcon(ICONS.edit));
  strengthBtn.addEventListener("click", () => { strengthBtn.hidden = true; strengthInput.hidden = false; strengthInput.value = strength ?? ""; strengthInput.focus(); });
  strengthInput.addEventListener("change", () => { strength = strengthInput.value === "" ? null : Number(strengthInput.value); drawStrength(); strengthInput.hidden = true; strengthBtn.hidden = false; });
  drawStrength();

  const timeBtn = el("button", { type: "button", class: "time-pill" });
  const timeInput = null;
  const drawTime = () => { timeBtn.replaceChildren(niceTime(time)); timeBtn.setAttribute("aria-label", `Taken at ${niceTime(time)}. Change the time`); };
  timeBtn.addEventListener("click", () => openTimePicker({ value: time, label: "Time taken", onSave: (v) => { time = v; drawTime(); markSheetChanged(); timeBtn.focus(); } }));
  drawTime();

  const err = el("p", { class: "form-error", role: "alert", hidden: true });
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
          sheet.close();
          await deleteWithUndo(entry, `${t.name} at ${niceTime(time)}`);
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
  body._save = confirmIt;
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
  const err = el("p", { class: "form-error", role: "alert", hidden: true });
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
      g ? el("button", { type: "button", class: "secondary danger", onclick: async () => {
        const before = state.person.med_groups;
        await save(before.filter((x) => x.id !== g.id));
        toast(`${g.name} group deleted`, "Undo", () => save(before));
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

// "yesterday Good (8)" for an item not answered yet today.
function yesterdayText(t) {
  const e = (state.prevEntries || []).find((x) => x.tracker_id === t.id);
  if (!e) return "";
  const v = formatValue(t, e);
  return v ? `Yesterday: ${t.kind === "rating" ? ratingText(t.config, e.value_num) : v.toLowerCase()}` : "";
}

function trackerRow(t, view) {
  const c = t.config;
  const entries = entriesFor(t.id);
  const latest = entries[0] || null;

  if (t.kind === "rating") {
    const level = latest ? levelLine(ratingText(c, latest.value_num), scaleColor(c, latest.value_num),
      t.frequency === "daily" ? () => removeEntry(latest) : null) : notYet(t);
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
    const level = val != null ? levelLine(labels[val], SEVERITY_COLOURS[val], () => quickSave([{ tracker_id: t.id, clear: true }]))
      : notYet(t);
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
      return brow(t, levelLine(text, current ? "var(--accent)" : "var(--muted)", null, latest && latest.source === "ha" ? "from Home Assistant" : null), stepper);
    }
    const input = el("input", {
      type: "number", inputmode: "decimal", min: "0", step: "any", class: "tile-input",
      value: val ?? "", "aria-label": t.name, placeholder: "0",
      onchange: (ev) => {
        const v = ev.target.value;
        quickSave([v === "" ? { tracker_id: t.id, clear: true } : { tracker_id: t.id, value_num: Number(v) }]);
      },
    });
    return brow(t, levelLine(goalAside(c, val ?? 0), "var(--accent)", null, latest && latest.source === "ha" ? "from Home Assistant" : null),
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
      el("button", { type: "button", class: "tile-num sleep-hours", "aria-label": "Times you slept", title: "Bed, asleep and wake-up times",
        onclick: () => openSleepTimes(state.day, state.sleep && state.sleep.nights.find((x) => x.night === state.day)) },
        hours == null ? "Add" : hmShort(hours * 60)),
      tile(svgIcon(ICONS.plus), { class: "tile tile-square", "aria-label": "More sleep", onclick: () => save(Math.min(24, hours == null ? shownHours : hours + 0.5), quality) }));
    const qualityTiles = el("div", { class: "rating-grid one-row" }, [1, 2, 3, 4, 5].map((v) => el("div", { class: "rating-col", style: `--c:${scaleColor(qcfg, v)}` },
      faceIcon(v - 1),
      tile(String(v), { class: `tile tile-rating${quality === v ? " on" : ""}`, "aria-pressed": String(quality === v),
        "aria-label": `Sleep quality ${qcfg.labels[v - 1]}`, onclick: () => save(hours, quality === v ? null : v) }))));
    const night = state.sleep && state.sleep.nights.find((x) => x.night === state.day);
    const text = quality ? `${qcfg.labels[quality - 1]} sleep` : null;
    const note = latest && latest.source === "ha" && !night ? "from Home Assistant" : null;
    const nightLink = state.sleep && (state.sleep.configured || night)
      ? el("button", { type: "button", class: "night-link", onclick: () => openSleepSheet(state.day) },
          night ? [hypnogram(night, { mini: true }),
              el("span", { class: "night-link-text" }, `${clockOf(night.start)} to ${clockOf(night.end)} · ${hm(night.asleep)} asleep`,
                night.source === "guess" ? el("span", { class: "row-sub" }, " · estimated") : null, svgIcon(ICONS.chevron))]
            : el("span", { class: "night-link-text row-sub" }, "No night recorded for this day. See your sleep", svgIcon(ICONS.chevron)))
      : state.sleep && state.sleep.tracker_id === t.id && state.sleep.suggested && Object.values(state.sleep.suggested).some((v) => v && v.length)
        ? el("button", { type: "button", class: "link inline", onclick: () => openSleepSetup(state.sleep) },
            state.sleep.suggested.tracking ? "Show your nights from Sleep as Android" : "Show your nights from Home Assistant")
        : null;
    return brow(t, text || note ? levelLine(text, quality ? scaleColor(qcfg, quality) : "var(--muted)", latest ? () => removeEntry(latest) : null, note)
      : latest ? null : notYet(t), stepper,
      el("div", { class: "brow-below" }, nightLink, el("span", { class: "row-sub" }, "How well did you sleep?"), qualityTiles));
  }

  if (t.kind === "gratitude") return goodThingsRow(t, view);

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
  const timeInput = null;
  const drawTime = () => { timeBtn.replaceChildren(el("span", {}, niceTime(time)), svgIcon(ICONS.edit)); timeBtn.setAttribute("aria-label", `At ${niceTime(time)}. Change the time`); };
  timeBtn.addEventListener("click", () => openTimePicker({ value: time, label: `${t.name} at`, onSave: (v) => { time = v; drawTime(); timeBtn.focus(); } }));
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
      if (!offerBreathing([{ tracker_id: t.id, value_num: v }])) toast(`${t.name}: ${ratingText(c, v)}`);
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
        sheet.close();
        await deleteWithUndo(entry, `${t.name} at ${timeOf(entry.logged_at)}`);
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

/* ================= sleep: nights from Sleep as Android ================= */

const PHASE_ORDER = ["awake", "rem", "light", "deep"]; // top to bottom, like Sleep as Android
const PHASE_LABEL = { awake: "Awake", rem: "REM", light: "Light", deep: "Deep", asleep: "Asleep" };
// Nights without stages (Android, or estimated) show just awake and asleep.
const phaseOf = (n, p) => (n.has_phases ? p : p === "awake" ? "awake" : "asleep");
const SVGNS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

function hm(minutes) {
  if (minutes == null) return "";
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  return h ? (m % 60 ? `${h} h ${m % 60} min` : `${h} h`) : `${m} min`;
}

// "7h 44m", for tight spaces
function hmShort(minutes) {
  if (minutes == null) return "";
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  return h ? (m % 60 ? `${h}h\u00a0${m % 60}m` : `${h}h`) : `${m}m`;
}

const clockOf = (iso) => niceTime(/T(\d{2}:\d{2})/.exec(iso)[1]);
const msOf = (iso) => new Date(iso).getTime();

// The night graph: a row for each phase, a block for each stretch of time in it.
function hypnogram(n, opts = {}) {
  const W = 340, labelW = opts.mini ? 0 : 46, rowH = opts.mini ? 9 : 26, gap = opts.mini ? 1 : 4;
  const rows = n.has_phases ? PHASE_ORDER : ["awake", "asleep"];
  const H = rows.length * (rowH + gap) + (opts.mini ? 0 : 22);
  const t0 = msOf(n.start), t1 = msOf(n.end), span = Math.max(1, t1 - t0);
  const x = (iso) => labelW + ((msOf(iso) - t0) / span) * (W - labelW);
  const y = (p) => rows.indexOf(p) * (rowH + gap);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: opts.mini ? "hypno mini" : "hypno", role: opts.mini ? "img" : "group",
    "aria-label": `Sleep from ${clockOf(n.start)} to ${clockOf(n.end)}: ${n.has_phases
      ? PHASE_ORDER.map((p) => `${PHASE_LABEL[p]} ${hm(n.totals[p])}`).join(", ") : `${hm(n.asleep)} asleep`}` });
  if (!opts.mini) {
    rows.forEach((p) => {
      svg.append(svgEl("rect", { x: labelW, y: y(p), width: W - labelW, height: rowH, rx: 4, class: "hypno-lane" }));
      svg.append(svgEl("text", { x: 0, y: y(p) + rowH / 2 + 4, class: "hypno-label" }, PHASE_LABEL[p]));
    });
  }
  const caption = opts.caption;
  for (const b of n.phases) {
    const p = phaseOf(n, b.phase);
    const w = Math.max(1.5, x(b.end) - x(b.start) - (opts.mini ? 0 : 1));
    const rect = svgEl("rect", { x: x(b.start), y: y(p), width: w, height: rowH, rx: opts.mini ? 1 : 4,
      class: `ph ph-${p}`, tabindex: opts.mini ? null : 0, role: opts.mini ? null : "button",
      "aria-label": opts.mini ? null : `${PHASE_LABEL[p]}, ${clockOf(b.start)} to ${clockOf(b.end)}` },
      svgEl("title", {}, `${PHASE_LABEL[p]} ${clockOf(b.start)}–${clockOf(b.end)}`));
    if (caption) {
      const show = () => {
        svg.querySelectorAll(".ph.on").forEach((r) => r.classList.remove("on"));
        rect.classList.add("on");
        caption.textContent = `${PHASE_LABEL[p]} · ${clockOf(b.start)} to ${clockOf(b.end)} · ${hm((msOf(b.end) - msOf(b.start)) / 60000)}`;
      };
      rect.addEventListener("pointerenter", show);
      rect.addEventListener("click", show);
      rect.addEventListener("focus", show);
    }
    svg.append(rect);
  }
  if (!opts.mini) {
    // hour marks along the bottom
    const first = new Date(t0); first.setMinutes(0, 0, 0); first.setHours(first.getHours() + 1);
    const hours = Math.round(span / 3600000);
    const every = hours > 8 ? 2 : 1;
    for (let t = first.getTime(); t < t1; t += 3600000) {
      const d = new Date(t);
      if (d.getHours() % every) continue;
      const tx = labelW + ((t - t0) / span) * (W - labelW);
      svg.append(svgEl("line", { x1: tx, x2: tx, y1: 0, y2: rows.length * (rowH + gap) - gap, class: "hypno-hour" }));
      svg.append(svgEl("text", { x: tx, y: H - 4, class: "hypno-tick", "text-anchor": "middle" },
        niceTime(`${pad(d.getHours())}:00`)));
    }
  }
  return svg;
}

// Last 14 nights: deep, light and REM stacked, with the goal as a dashed line.
function sleepTrend(nights, goalH, selected, onPick) {
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(addDays(isoDay(new Date()), -i));
  const byNight = new Map(nights.map((n) => [n.night, n]));
  const W = 340, H = 150, base = 120, top = 8;
  const maxMin = Math.max(goalH * 60, ...nights.map((n) => n.asleep)) * 1.1;
  const yOf = (min) => base - (min / maxMin) * (base - top);
  const bw = W / days.length;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "sleep-trend", role: "group",
    "aria-label": `Sleep over the last 14 nights, against a goal of ${goalH} hours` });
  svg.append(svgEl("line", { x1: 0, x2: W, y1: base, y2: base, class: "trend-base" }));
  days.forEach((day, i) => {
    const n = byNight.get(day);
    const x0 = i * bw + 3, w = bw - 6;
    const g = svgEl("g", { class: `trend-night${n ? "" : " none"}${n && n.night === selected ? " on" : ""}`, tabindex: n ? 0 : null,
      role: n ? "button" : null, "aria-label": n ? `${dayLabel(n.night)}: ${hm(n.asleep)} asleep. Show this night` : null,
      "aria-pressed": n ? String(n.night === selected) : null },
      svgEl("rect", { x: i * bw, y: 0, width: bw, height: H, class: "trend-hit" }));
    if (n) {
      let acc = 0;
      const parts = n.has_phases ? [["deep", n.totals.deep], ["light", n.totals.light], ["rem", n.totals.rem]] : [["asleep", n.asleep]];
      parts.forEach(([p, m], k) => {
        if (!m) return;
        const y0 = yOf(acc), y1 = yOf(acc + m);
        // 2px gap between stacked parts, rounded only at the top of the bar
        g.append(svgEl("rect", { x: x0, y: y1, width: w, height: Math.max(0, y0 - y1 - (k ? 2 : 0)), rx: k === parts.length - 1 ? 3 : 0,
          class: `ph ph-${p}` }));
        acc += m;
      });
      g.append(svgEl("title", {}, `${dayLabel(n.night)}: ${hm(n.asleep)} asleep, ${clockOf(n.start)} to ${clockOf(n.end)}`));
      g.addEventListener("click", () => onPick(n.night));
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onPick(n.night); } });
    }
    const d = dayToDate(day);
    g.append(svgEl("text", { x: i * bw + bw / 2, y: H - 14, class: "trend-tick", "text-anchor": "middle" },
      d.toLocaleDateString(undefined, { weekday: "narrow" })));
    g.append(svgEl("text", { x: i * bw + bw / 2, y: H - 2, class: "trend-tick", "text-anchor": "middle" }, String(d.getDate())));
    svg.append(g);
  });
  const gy = yOf(goalH * 60);
  svg.append(svgEl("line", { x1: 0, x2: W, y1: gy, y2: gy, class: "trend-goal" }));
  svg.append(svgEl("text", { x: W - 2, y: gy - 4, class: "trend-goal-label", "text-anchor": "end" }, `Goal ${goalH} h`));
  return svg;
}

// Average clock time of a set of times around midnight (e.g. bedtimes either side of 12am).
function usualTime(isos) {
  if (!isos.length) return null;
  const mins = isos.map((s) => { const [h, m] = /T(\d{2}):(\d{2})/.exec(s).slice(1).map(Number); return ((h * 60 + m) + 720) % 1440; });
  const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
  const real = (avg + 720) % 1440;
  return niceTime(`${pad(Math.floor(real / 60))}:${pad(real % 60)}`);
}

const SLEEP_SOURCE = {
  sleep_as_android: "Sleep as Android",
  android: "Android's sleep detection",
  home: "Estimated from your bedroom and phone",
  you: "Times you set",
};

async function openSleepSheet(pickNight) {
  const sheet = document.getElementById("sheet");
  let view;
  try { view = await api("GET", "api/sleep?days=30"); } catch (err) { toast(err.message); return; }
  if (!view.tracker_id) { toast("Add a Sleep item first"); return; }
  if (!view.configured && !view.nights.length) { openSleepSetup(view); return; }
  let nights = view.nights;
  // A morning with no night (yet) can still be opened, to add one yourself.
  let current = pickNight || (nights[0] || {}).night || isoDay(new Date());
  const reload = async (fresh) => { view = fresh; nights = view.nights; state.sleep = view; draw(); await redraw(); };
  const draw = () => {
    const i = nights.findIndex((n) => n.night === current);
    const n = nights[i];
    const older = nights.find((x) => x.night < current);
    const newer = [...nights].reverse().find((x) => x.night > current);
    const caption = el("p", { class: "row-sub hypno-caption", "aria-live": "polite" }, "Tap the graph to see each part of the night.");
    const today = isoDay(new Date());
    const recent = nights.filter((x) => x.night > addDays(today, -14));
    const week = nights.filter((x) => x.night > addDays(today, -7));
    const avg = recent.length ? recent.reduce((a, x) => a + x.asleep, 0) / recent.length : null;
    const debt = week.length ? Math.max(0, week.length * view.goal * 60 - week.reduce((a, x) => a + x.asleep, 0)) : null;
    const tiles = n && n.has_phases ? el("div", { class: "phase-tiles" }, ["deep", "light", "rem", "awake"].map((p) =>
      el("div", { class: "phase-tile" },
        el("span", { class: "phase-name" }, el("span", { class: `dot ph-${p}` }), PHASE_LABEL[p]),
        el("strong", {}, hmShort(n.totals[p])),
        el("span", { class: "row-sub" }, n.in_bed ? `${Math.round((n.totals[p] / n.in_bed) * 100)}%` : "")))) : null;
    const why = n && n.why && n.why.length ? el("details", { class: "more why" },
      el("summary", {}, "How this was worked out"),
      el("ul", { class: "why-list" }, n.why.map((w) => el("li", {}, el("span", { class: "why-time" }, clockOf(w.at)), w.what))),
      el("p", { class: "hint" }, "Bedtime is when everything you chose says you're in bed. Short interruptions, like a trip to the bathroom, don't count.")) : null;
    const nightLabel = (day) => `${dayToDate(addDays(day, -1)).toLocaleDateString(undefined, { weekday: "short" })} to ${dayToDate(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
    const actions = el("div", { class: "night-actions" },
      n && n.source === "you"
        ? el("button", { type: "button", class: "link", onclick: async () => reload(await api("POST", `api/sleep/nights/${current}/reset`)) }, "Use Home Assistant's times")
        : null,
      !n || n.source !== "sleep_as_android"
        ? el("button", { type: "button", class: "secondary small", onclick: () => openSleepTimes(current, n, () => openSleepSheet(current)) },
            n ? "Change times" : "Add this night")
        : null,
      n && n.source !== "sleep_as_android"
        ? el("button", { type: "button", class: "link", onclick: async () => {
            const fresh = await api("DELETE", `api/sleep/nights/${current}`);
            current = (fresh.nights[0] || {}).night || current;
            await reload(fresh);
            toast("Night removed", "Undo", async () => reload(await api("POST", `api/sleep/nights/${n.night}/reset`)));
          } }, "Not a night's sleep")
        : null);
    sheet.replaceChildren(el("div", { class: "sheet-body sleep-sheet" },
      el("div", { class: "med-sheet-head" }, el("h2", {}, "Sleep"),
        el("button", { type: "button", class: "iconbtn plain", "aria-label": "Close", onclick: () => sheet.close() }, svgIcon(ICONS.close))),
      el("div", { class: "night-nav" },
        el("button", { type: "button", class: "iconbtn", "aria-label": "Night before", disabled: !older,
          onclick: () => { current = older.night; draw(); } }, svgIcon(ICONS.left)),
        el("span", {}, nightLabel(current)),
        el("button", { type: "button", class: "iconbtn", "aria-label": "Night after", disabled: !newer,
          onclick: () => { current = newer.night; draw(); } }, svgIcon(ICONS.right))),
      n ? [
        el("div", { class: "sleep-hero" },
          el("div", { class: "supply-big" }, `${hm(n.asleep)} asleep`),
          el("p", { class: "row-sub" }, `${clockOf(n.start)} to ${clockOf(n.end)} · in bed ${hm(n.in_bed)}`
            + (n.fell_asleep_after ? ` · asleep after ${hm(n.fell_asleep_after)}` : "")),
          el("p", { class: `sleep-badge${n.estimate ? " estimate" : ""}` }, SLEEP_SOURCE[n.source] || "")),
        hypnogram(n, { caption }), caption, tiles, why,
      ] : el("p", { class: "row-sub" }, "Nothing recorded for this night."),
      actions,
      el("h3", { class: "sleep-h3" }, "Last 14 nights"),
      sleepTrend(nights, view.goal, current, (night) => { current = night; draw(); }),
      el("div", { class: "sleep-legend", "aria-hidden": "true" },
        (nights.some((x) => x.has_phases) ? ["deep", "light", "rem"] : []).concat(nights.some((x) => !x.has_phases) ? ["asleep"] : []).map((p) =>
          el("span", {}, el("span", { class: `dot ph-${p}` }), p === "asleep" ? "Asleep, no stages" : PHASE_LABEL[p]))),
      el("ul", { class: "sleep-facts" },
        avg != null ? el("li", {}, el("strong", {}, `Average ${hm(avg)}`), `, goal ${view.goal} h`) : null,
        debt != null ? el("li", {}, debt ? `${hm(debt)} short of your goal this week` : "On or over your goal all week") : null,
        recent.length ? el("li", {}, `Usually in bed by ${usualTime(recent.map((x) => x.start))}, up at ${usualTime(recent.map((x) => x.end))}`) : null),
      el("p", { class: "row-sub sleep-source" }, "Where your nights come from. ",
        el("button", { type: "button", class: "link inline", onclick: () => openSleepSetup(view) }, "Change"))));
    if (!sheet.open) sheet.showModal();
  };
  draw();
}

// Last night, like Bearable: when you went to bed, fell asleep, woke up and got up, or just the total.
// done(view) is called with the fresh sleep view after saving times, or with nothing after a total.
function openSleepTimes(night, n, done) {
  const sheet = document.getElementById("sheet");
  const hhmm = (iso) => (iso ? /T(\d{2}:\d{2})/.exec(iso)[1] : "");
  const asleepParts = n ? n.phases.filter((p) => p.phase !== "awake") : [];
  const t = state.allTrackers.find((x) => x.kind === "sleep");
  const entry = t ? (state.dayEntries || []).find((e) => e.tracker_id === t.id && e.day === night) : null;
  const was = entry && entry.value_json ? entry.value_json : {};
  const time = (value, label) => el("time-field", { value, "aria-label": label, placeholder: "Choose" });
  const bed = time(n && n.fell_asleep_after != null && n.phases[0] && n.phases[0].phase === "awake" ? hhmm(n.start) : "", "Went to bed");
  const asleep = time(asleepParts.length ? hhmm(asleepParts[0].start) : "", "Fell asleep");
  const woke = time(asleepParts.length ? hhmm(asleepParts[asleepParts.length - 1].end) : "", "Woke up");
  const lastPhase = n && n.phases[n.phases.length - 1];
  const up = time(lastPhase && lastPhase.phase === "awake" ? hhmm(n.end) : "", "Got up");
  const totalH = el("input", { type: "number", min: "0", max: "24", step: "1", inputmode: "numeric", "aria-label": "Hours", style: "width:5em",
    value: was.hours != null ? Math.floor(was.hours) : "" });
  const totalM = el("input", { type: "number", min: "0", max: "59", step: "1", inputmode: "numeric", "aria-label": "Minutes", style: "width:5em",
    value: was.hours != null ? Math.round((was.hours % 1) * 60) : "" });
  const summary = el("p", { class: "sleep-sum", "aria-live": "polite" });
  const err = el("p", { class: "form-error", role: "alert", hidden: true });
  let mode = "times";

  // evening times belong to the night before; morning times to the day you woke
  const at = (v, evening) => {
    if (!v) return null;
    const d = dayToDate(evening && v >= "12:00" ? addDays(night, -1) : night);
    const [h, m] = v.split(":").map(Number);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const mins = (a, b) => (a && b ? Math.round((b - a) / 60000) : null);
  const update = () => {
    const sl = mins(at(asleep.value, true), at(woke.value, false));
    const inBed = mins(at(bed.value || asleep.value, true), at(up.value || woke.value, false));
    summary.replaceChildren(...(sl != null && sl > 0
      ? [el("strong", {}, `${hm(sl)} asleep`), inBed && inBed > sl ? ` · ${hm(inBed)} in bed` : ""]
      : [el("span", { class: "row-sub" }, "Fill in when you fell asleep and woke up.")]));
  };
  [bed, asleep, woke, up].forEach((x) => x.addEventListener("input", update));
  update();

  const pair = (a, aLabel, b, bLabel) => el("div", { class: "sleep-pair" },
    el("label", { class: "sleep-time" }, el("span", {}, aLabel), a),
    el("label", { class: "sleep-time" }, el("span", {}, bLabel), b));
  const timesPart = el("div", { class: "sleep-times" },
    el("div", { class: "sleep-group" }, el("span", { class: "sleep-group-title" }, "Time asleep"),
      pair(asleep, "Fell asleep", woke, "Woke up")),
    el("div", { class: "sleep-group" }, el("span", { class: "sleep-group-title" }, "Time in bed ", el("span", { class: "row-sub" }, "(optional)")),
      pair(bed, "Went to bed", up, "Got up")),
    summary);
  const totalPart = el("div", { class: "sleep-times", hidden: true },
    el("div", { class: "sleep-group" }, el("span", { class: "sleep-group-title" }, "How long you slept"),
      el("div", { class: "sleep-total" }, totalH, el("span", {}, "h"), totalM, el("span", {}, "min"))));
  const switchBtn = el("button", { type: "button", class: "link inline" });
  const drawMode = () => {
    timesPart.hidden = mode !== "times";
    totalPart.hidden = mode !== "total";
    switchBtn.textContent = mode === "times" ? "Or just enter how long you slept" : "Enter times instead";
  };
  switchBtn.addEventListener("click", () => { mode = mode === "times" ? "total" : "times"; drawMode(); markSheetChanged(); });
  drawMode();

  const form = el("form", { method: "dialog", class: "sleep-form", novalidate: true },
    el("h2", {}, night === isoDay(new Date()) ? "Last night's sleep" : `Sleep, night to ${dayLabel(night)}`),
    err, timesPart, totalPart, switchBtn,
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, "Save"),
      entry || (n && n.source === "you") ? el("button", { type: "button", class: "secondary danger", onclick: async () => {
        sheet.close();
        if (n && n.source === "you") await api("POST", `api/sleep/nights/${night}/reset`).catch(() => null);
        if (entry) await removeEntry(entry); else await refreshCheckin();
      } }, "Clear") : null,
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel")));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    try {
      if (mode === "total") {
        const hours = Number(totalH.value || 0) + Number(totalM.value || 0) / 60;
        if (!hours) throw new Error("How long did you sleep?");
        await api("POST", "api/checkin", { logged_at: loggedAtFor(night), items: [{ tracker_id: t.id, value_json: { hours: Math.round(hours * 100) / 100, quality: was.quality ?? null } }] });
        sheet.close();
        await refreshCheckin();
        if (done) done(null);
        return;
      }
      if (!asleep.value || !woke.value) throw new Error("Fill in when you fell asleep and woke up");
      const body = { start: localISO(at(asleep.value, true)), end: localISO(at(woke.value, false)) };
      if (bed.value) body.bed = localISO(at(bed.value, true));
      if (up.value) body.up = localISO(at(up.value, false));
      const fresh = await api("PUT", `api/sleep/nights/${night}`, body);
      state.sleep = { ...(state.sleep || {}), ...fresh };
      sheet.close();
      await refreshCheckin();
      if (done) done(fresh);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
}

async function openSleepSetup(view) {
  const sheet = document.getElementById("sheet");
  let ha;
  try { haOptionsCache = null; ha = await haOptions(); } catch { ha = { events: [], sensors: [], lights: [], binary_sensors: [] }; }
  const tracker = state.allTrackers.find((t) => t.id === view.tracker_id) || (await api("GET", "api/trackers?include_hidden=true")).find((t) => t.id === view.tracker_id);
  const was = view.configured ? view.source : (view.suggested || {});
  const sug = view.suggested || {};
  const opt = (list, icon, filter = () => true) => (list || []).filter((x) => filter(x.entity_id)).map((x) => ({ id: x.entity_id, name: x.name, sub: x.entity_id, icon }));
  const events = opt(ha.events, ICONS.bell);
  const pick = (items, id, label) => entityPicker({ items, selected: id ? [id] : [], addLabel: label, single: true, empty: "Nothing like this in Home Assistant." });
  const tracking = pick(events, was.tracking, "Search events");
  const phases = pick(events, was.phases, "Search events");
  const lights = entityPicker({ items: opt(ha.lights, ICONS.home), selected: was.lights || [], addLabel: "Search lights", empty: "No lights in Home Assistant." });
  const charging = pick(opt(ha.binary_sensors, ICONS.phone, (i) => /charg/.test(i)), was.charging, "Search sensors");
  const inUse = pick(opt(ha.binary_sensors, ICONS.phone, (i) => /interactive|screen|in_use/.test(i)), was.in_use, "Search sensors");
  const segments = pick(opt(ha.sensors, ICONS.phone, (i) => /sleep/.test(i)), was.segments, "Search sensors");
  const confidence = pick(opt(ha.sensors, ICONS.phone, (i) => /sleep/.test(i)), was.confidence, "Search sensors");
  const goal = el("input", { type: "number", min: "4", max: "14", step: "0.5", inputmode: "decimal", value: view.goal || 8, style: "width:6em" });
  const err = el("p", { class: "form-error", role: "alert", hidden: true });
  const group = (title, intro, open, ...fields) => el("details", { class: "source-group", open },
    el("summary", {}, el("span", { class: "source-title" }, title), el("span", { class: "row-sub" }, intro)), ...fields);
  const hasHome = !!(was.lights?.length || was.charging || was.in_use);
  const form = el("form", { method: "dialog" },
    el("h2", {}, "Where your nights come from"),
    el("p", { class: "row-sub", style: "margin:-8px 0 14px" },
      "Use any of these. Each morning shows the best one: Sleep as Android, then an estimate from your bedroom and phone. Sleep hours on Check-in fill in by themselves; anything you enter yourself wins."),
    err,
    group("Sleep as Android", "Deep, light and REM sleep, on nights you track.", !!was.tracking || !hasHome,
      el("div", { class: "field" }, el("span", {}, "Sleep tracking"), tracking.node, el("span", { class: "hint" }, "Marks when each night starts and ends.")),
      el("div", { class: "field" }, el("span", {}, "Sleep phase"), phases.node, el("span", { class: "hint" }, "Deep, light, REM and awake through the night."))),
    group("Your bedroom and phone", "An estimate for every night, without tracking anything.", hasHome || !was.tracking,
      el("div", { class: "field" }, el("span", {}, "Bedroom lights"), lights.node, el("span", { class: "hint" }, "Lights out means you've gone to bed; on again means you're up.")),
      el("div", { class: "field" }, el("span", {}, "Phone charging"), charging.node, el("span", { class: "hint" }, "Most people put their phone on charge at bedtime.")),
      el("div", { class: "field" }, el("span", {}, "Phone in use"), inUse.node,
        el("span", { class: "hint" }, sug.in_use || was.in_use ? "When the screen's on, you're awake."
          : "Optional. Turn on the Interactive sensor in the Home Assistant app: Settings, Companion app, Manage sensors.")),
      el("div", { class: "field" }, el("span", {}, "Sleep confidence"), confidence.node,
        el("span", { class: "hint" }, "From the Home Assistant app. Shows when you actually fell asleep and woke, rather than went to bed."))),
    el("details", { class: "source-group", open: !!was.segments && !was.tracking && !hasHome },
      el("summary", {}, el("span", { class: "source-title" }, "Android's sleep detection"), el("span", { class: "row-sub" }, "When you slept, without stages.")),
      el("div", { class: "field" }, el("span", {}, "Sleep segment"), segments.node,
        el("span", { class: "hint" }, "From the Home Assistant app. Also sharpens the estimate above."))),
    field("Sleep goal", el("div", { class: "inline-field" }, goal, el("span", {}, "hours a night"))),
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, "Save and import"),
      view.configured ? el("button", { type: "button", class: "link", onclick: () => openSleepSheet() }, "Cancel")
        : el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Not now")));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const one = (p) => p.value()[0] || null;
    const nights = { tracking: one(tracking), phases: one(phases), segments: one(segments), confidence: one(confidence),
      lights: lights.value(), charging: one(charging), in_use: one(inUse) };
    try {
      await api("PATCH", `api/trackers/${view.tracker_id}`, { config: { ...(tracker ? tracker.config : {}), nights, goal: Number(goal.value) || 8 } });
      const r = await api("POST", "api/sleep/import");
      toast(r.nights ? `Found ${r.nights === 1 ? "1 night" : r.nights + " nights"} in Home Assistant` : "Saved. Nights appear the morning after");
      await redraw();
      openSleepSheet();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal();
}

/* ================= history ================= */


async function renderHistory(view) {
  view.replaceChildren(el("p", { class: "loading" }, "Loading…"));
  const to = isoDay(new Date());
  const from = addDays(to, -(state.historyDays - 1));
  const entries = await api("GET", `api/entries?from=${from}&to=${to}`);
  const allTrackers = await api("GET", "api/trackers?include_hidden=true");
  await loadEncouragement();
  const byId = new Map(allTrackers.map((t) => [t.id, t]));

  const head = el("header", { class: "head" },
    el("h1", {}, "History"),
    el("p", {}, `Last ${state.historyDays} days. Tap an entry to change or delete it, or a day to open it in Check-in.`),
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
      el("h2", {},
        el("button", { type: "button", class: "day-open", "aria-label": `Open ${longDate(day)} in Check-in`, title: "Open in Check-in",
          onclick: () => { state.day = day; location.hash = "#/checkin"; } }, dayLabel(day), svgIcon(ICONS.edit)),
        daySummary(list, byId)),
      el("div", { class: "panel" }, list.map((e) => entryButton(e, byId.get(e.tracker_id)))),
    ));
  }

  const more = el("button", { type: "button", class: "secondary more", onclick: async () => {
    state.historyDays += 14;
    await renderHistory(view);
  } }, "Show earlier days");

  view.replaceChildren(...[head, weekCard(), ...blocks, more].filter(Boolean));
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
      e.note && t.kind !== "gratitude" ? el("span", { class: "note" }, e.note) : null,
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
    e.note && t.kind !== "gratitude" ? el("p", { style: "white-space:pre-wrap" }, e.note) : null,
    el("div", { class: "actions" },
      el("button", { type: "button", class: "primary", onclick: () => {
        sheet.close();
        state.day = e.day;
        state.loadedDay = null;
        location.hash = "#/checkin";
      } }, "Edit this day"),
      el("button", { type: "button", class: "secondary danger", onclick: async () => {
        sheet.close();
        await deleteWithUndo(e, `${t.name} at ${timeOf(e.logged_at)}`);
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
  gratitude: "Good things (a few words, a few times a day)",
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
    case "gratitude": return `${joinNames((c.times || []).map(niceTime))}${c.remind ? ", with a reminder" : ""}`;
    case "medication": {
      const amount = [c.dose, c.unit].filter(Boolean).join(" ");
      return [amount, t._schedule === undefined ? null : describeSchedule(t._schedule, t)].filter(Boolean).join(". ");
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
  const only = s.only_when ? `, only when ${shortEntityName(s.only_when.entity_id)} is ${typeof s.only_when.at_least === "number" ? s.only_when.at_least : "at your alert level"} or more` : "";
  if (s.mode === "wake") {
    const after = s.wake_after ? `${niceGap(s.wake_after)} after you wake up` : "when you wake up";
    return `Reminds you ${after}${days}${only}`;
  }
  const amounts = s.amounts || {};
  if (t && Object.keys(amounts).length) {
    const usual = t.config.quantity ?? 1;
    return `Reminds you: ${joinNames(s.times.map((x) => `${qtyText(t, amounts[x] ?? usual)} at ${niceTime(x)}`))}${days}${only}`;
  }
  return `Reminds you at ${joinNames(s.times.map(niceTime))}${days}${only}`;
}

// "sensor.home_pollen_types_..._overall_pollen_risk_today" -> "overall pollen risk today", for short sentences
function shortEntityName(id) {
  const hit = ((haOptionsCache && haOptionsCache.sensors) || []).find((x) => x.entity_id === id);
  const name = hit ? hit.name : String(id || "").split(".").pop().replace(/_/g, " ");
  if (/pollen/i.test(name)) return "pollen";
  return name.replace(/^Home - /, "").replace(/\s*\([^)]*\)/g, "").toLowerCase();
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

// A whole row you tap, with what it's set to underneath and a chevron.
function settingRow(title, sub, onclick) {
  return el("button", { type: "button", class: "tracker-row row-button", onclick },
    el("span", { class: "info" }, el("span", { class: "row-name" }, title), sub ? el("span", { class: "row-sub" }, sub) : null),
    el("span", { class: "row-chevron", "aria-hidden": "true" }, svgIcon(ICONS.chevron)));
}

async function renderSettings(view) {
  const restoreFocus = focusSnapshot(view);
  view.replaceChildren(el("p", { class: "loading" }, "Loading…"));
  const all = await api("GET", "api/trackers?include_hidden=true");
  const visible = all.filter((t) => !t.hidden);
  const hidden = all.filter((t) => t.hidden);

  const head = el("header", { class: "head" },
    el("h1", {}, "Settings"),
    el("p", {}, "Your medicines, reminders and what you track. Only you can see this."),
  );

  const meds = visible.filter((t) => t.kind === "medication");
  const others = visible.filter((t) => t.kind !== "medication");
  const [schedules, person] = await Promise.all([
    Promise.all(meds.map((m) => api("GET", `api/trackers/${m.id}/schedule`).catch(() => null))),
    api("GET", "api/reminders/settings").catch(() => null),
  ]);
  meds.forEach((m, i) => { m._schedule = schedules[i]; });
  if (person) state.person = person;
  const paused = pausedUntil();

  const medSection = el("section", { class: "group" },
    el("h2", {}, "Medicines"),
    meds.length
      ? el("div", { class: "panel" }, meds.map((t) => settingsRow(t, all, view)))
      : el("div", { class: "empty", style: "margin-top:0" }, el("p", {}, "No medications yet. Add one to log doses and get reminders.")),
    el("div", { class: "actions", style: "margin-top:12px" },
      el("button", { type: "button", class: "secondary", onclick: () => openTrackerSheet({ kind: "medication" }, view) }, "Add medication")),
  );

  let supply = [];
  try { supply = await api("GET", "api/supply"); } catch { /* not important enough to stop Settings */ }
  const byMed = new Map(supply.map((x) => [x.tracker_id, x]));
  const supplySection = meds.length ? el("section", { class: "group" },
    el("h2", {}, "Supply and scripts"),
    doctorLine(supply, meds),
    el("div", { class: "panel" }, meds.map((t) => {
      const sup = byMed.get(t.id);
      const st = sup && sup.status;
      const alert = st && st.alerts[0];
      return el("button", { type: "button", class: "supply-row", onclick: () => openMedSheet(t) },
        el("span", { class: "row-name" }, t.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, t.emoji) : null, t.name),
        st ? el("span", { class: "row-sub" }, supplyLine(st))
          : el("span", { class: "row-sub" }, "Not counted. Tap to set up"),
        alert ? el("span", { class: `callout ${alert.level}` }, alert.text) : null);
    }))) : null;
  const phones = person ? person.devices.length : 0;
  const ci = person ? person.checkins : null;
  const notifySection = el("section", { class: "group" },
    el("h2", {}, "Reminders"),
    el("div", { class: "panel" },
      settingRow("Today's reminders", "What's due and what's done", () => openTodaySheet(view)),
      settingRow(paused ? "Reminders paused" : "Pause reminders", paused ? `Until ${paused}. Tap to resume or change` : "For a few hours, or while you're away",
        () => openPauseSheet()),
      settingRow("Where reminders go",
        phones ? `${phones === 1 ? "1 device" : phones + " devices"}` : "Only this app so far",
        () => openPersonSheet(view)),
      settingRow("Check-in reminders",
        ci && ci.enabled ? `${joinNames(ci.times.map(niceTime))}, ${describeDays(ci.days)}` : "Off",
        () => openCheckinSheet(view)),
      settingRow("Water reminders",
        person && person.hydration.enabled
          ? `After ${niceGap(person.hydration.every)} without water, ${niceTime(person.hydration.start)} to ${niceTime(person.hydration.end)}`
          : "Off",
        () => openWaterSheet(view))),
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

  // Ordered by how often you'll need each: supply and today's reminders first, setting things up last.
  view.replaceChildren(...[head, supplySection, notifySection, medSection,
    el("h2", { class: "section-title" }, "What you track"),
    el("p", { class: "hint section-hint" }, "Tap one to change it. To reorder or regroup them, tap the pencil on Check-in."),
    ...trackerSections, addRow, hiddenSection,
    el("p", { class: "whoami" }, `Signed in to Home Assistant as ${state.me.display_name || state.me.username}`)].filter(Boolean));
  restoreFocus();
}

// Does a check-in or water "days" setting include today?
function runsToday(d) {
  if (!d || d.mode === "daily") return true;
  const today = dayToDate(isoDay(new Date()));
  if (d.mode === "weekdays") return d.weekdays.includes((today.getDay() + 6) % 7);
  const start = dayToDate(d.start);
  const diff = Math.round((today - start) / 86400000);
  return diff >= 0 && diff % d.every === 0;
}

async function openTodaySheet(view) {
  const sheet = document.getElementById("sheet");
  let doses, person;
  try {
    [doses, person] = await Promise.all([api("GET", "api/doses/today"), api("GET", "api/reminders/settings")]);
  } catch (err) { toast(err.message); return; }
  const today = isoDay(new Date());
  const STATUS = { scheduled: "", due: "Due now", taken: "Taken", skipped: "Skipped", missed: "Missed", cancelled: "Cancelled" };
  const rows = doses.filter((d) => d.local_day === today).map((d) => ({
    time: d.time, name: d.name, sub: [d.amount, STATUS[d.status]].filter(Boolean).join(" · "),
    open: () => { const t = state.trackers.find((x) => x.id === d.tracker_id); if (t) openScheduleSheet(t, view); },
  }));
  if (person.checkins.enabled && runsToday(person.checkins.days)) {
    for (const time of person.checkins.times) rows.push({ time, name: "Check-in", sub: "", open: () => openCheckinSheet(view) });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time));
  const h = person.hydration;
  const water = h.enabled && runsToday(h.days)
    ? `Water: if you haven't had any for ${niceGap(h.every)}, between ${niceTime(h.start)} and ${niceTime(h.end)}.` : null;
  const paused = pausedUntil();
  sheet.replaceChildren(el("div", { class: "sheet-body" },
    el("h2", {}, "Today's reminders"),
    paused ? notice(`Paused until ${paused}. These still show in the app.`) : null,
    rows.length ? el("div", { class: "menu" }, rows.map((r) => el("button", { type: "button", class: "menu-item today-row",
      onclick: () => { sheet.close(); r.open(); } },
      el("span", { class: "today-time" }, niceTime(r.time)),
      el("span", {}, r.name, r.sub ? el("span", { class: "row-sub" }, ` ${r.sub}`) : null))))
      : el("p", { class: "row-sub" }, "No reminders at set times today."),
    water ? el("p", { class: "row-sub" }, water) : null,
    el("div", { class: "actions" }, el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Close"))));
  sheet.showModal();
}

function settingsRow(t, all, view) {
  const main = el("button", { type: "button", class: "row-button-main", onclick: () => openTrackerSheet(t, view) },
    el("span", { class: "info" },
      el("span", { class: "row-name" }, t.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, t.emoji) : null, t.name),
      el("span", { class: "row-sub" }, describeTracker(t))),
    t.hidden ? null : el("span", { class: "row-chevron", "aria-hidden": "true" }, svgIcon(ICONS.chevron)));
  return el("div", { class: "tracker-row with-main" },
    main,
    t.hidden
      ? el("button", { type: "button", class: "secondary small", onclick: async () => {
          await api("PATCH", `api/trackers/${t.id}`, { hidden: false });
          await refreshTrackers();
          await renderSettings(view);
        } }, "Show")
      : null);
}

// A single input, select or text box sits in a <label>. Anything richer (pickers, button rows,
// several inputs) is a labelled group instead: a <label> passes every click inside it on to its
// first control, which would press the wrong button.
let fieldSeq = 0;
function field(label, control, hint) {
  const hintEl = hint ? el("span", { class: "hint" }, hint) : null;
  if (control instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) {
    return el("label", { class: "field" }, el("span", {}, label), control, hintEl);
  }
  const id = `field-${++fieldSeq}`;
  if (hintEl) hintEl.id = `${id}-hint`;
  // controls that relied on the label for their name get it from the field's title instead
  if (control instanceof HTMLElement) {
    for (const c of control.querySelectorAll("input:not([type=hidden]), select, textarea")) {
      if (!c.hasAttribute("aria-label") && !c.hasAttribute("aria-labelledby")) c.setAttribute("aria-labelledby", id);
    }
  }
  return el("div", { class: "field", role: "group", "aria-labelledby": id, "aria-describedby": hint ? `${id}-hint` : null },
    el("span", { id }, label), control, hintEl);
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
    if (e !== current) markSheetChanged();
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

  const kinds = ["rating", "symptom", "factor", "tags", "note", "gratitude", "medication"];
  if (kind === "sleep") kinds.push("sleep");
  const kindSelect = el("select", { name: "kind" }, kinds.map((k) => el("option", { value: k }, KIND_INFO[k])));
  kindSelect.value = kind;
  const logged = t.entry_count || 0;
  const kindHint = !isNew && logged
    ? `Changing the type clears the ${logged === 1 ? "1 thing" : logged + " things"} already logged for it, because they were recorded differently. To keep them, add a new item instead and hide this one.`
    : null;
  const KIND_EXAMPLES = {
    rating: "For example stress, focus, pain or motivation.",
    symptom: "For example headache, nausea or brain fog: none, mild, moderate or severe.",
    factor: "Things you do or that happen: coffee, exercise, work, time outside.",
    tags: "Choose one or more words from your own list, like emotions or weather.",
    note: "A free-text box, like a journal.",
    gratitude: "A few good things through the day. Small things count: a coffee, a kind word, a walk.",
    medication: "Log doses and get reminders.",
    sleep: "Hours slept and how well.",
  };
  const kindExample = el("span", { class: "hint" });
  const drawKindExample = () => { kindExample.textContent = KIND_EXAMPLES[kind] || ""; };
  drawKindExample();

  const extra = el("div", {});
  const err = el("p", { class: "form-error", role: "alert", hidden: true });

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
    } else if (kind === "gratitude") {
      const times = kind === t.kind && c.times ? c.times : ["12:30", "15:30", "21:30"];
      inputs.times = timesEditor(times);
      inputs.remind = switchField("Remind me at these times", kind === t.kind && c.remind,
        "A quiet notification you can answer from your phone. If you've already written one, you won't be asked.");
      extra.append(el("div", { class: "field" }, el("span", {}, "When to ask"), inputs.times.node,
        el("span", { class: "hint" }, "For example after lunch, mid-afternoon and before bed.")), inputs.remind.node);
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
        el("div", { class: "field-pair" }, field("Usually take", inputs.quantity), field("Each one is a", inputs.counted)),
        el("datalist", { id: "counted-as" }, ["dose", "tablet", "capsule", "application", "drop", "puff", "spray", "scoop"].map((u) => el("option", { value: u }))),
        el("p", { class: "hint", style: "margin:-6px 0 14px" }, "For example tablet, puff or drop. Shown as \"1 dose\" or \"2 tablets\". You can change the amount and strength each time you log it."),
        field("Instructions", inputs.notes, "Optional. Shown on the reminder."),
        t.id ? el("div", { class: "actions", style: "margin-top:0" },
          el("button", { type: "button", class: "secondary", onclick: () => openScheduleSheet(t, view) }, "Reminders"),
          el("button", { type: "button", class: "secondary", onclick: () => openMedSheet(t) }, "Supply and refills")) : null,
      ].filter(Boolean));
    }
  }
  // ----- fill in from Home Assistant (counts, amounts and sleep) -----
  const VALUE_CHOICES = [["latest", "The latest reading (weight, last night's sleep)"],
    ["highest", "The highest that day (totals that reset at midnight, like steps)"],
    ["average", "The average that day (heart rate)"]];
  const src = c.source || null;
  let srcPicker = null;
  const srcValue = selectOf(VALUE_CHOICES, src ? src.value : "latest");
  const srcPickerSlot = el("div", {}, el("p", { class: "row-sub" }, "Loading sensors from Home Assistant…"));
  const srcDetails = el("details", { class: "more", open: !!src },
    el("summary", {}, "Fill in from Home Assistant"),
    el("p", { class: "hint", style: "margin:0 0 10px" },
      "Use a sensor you already have, such as steps or sleep from Google Health, weight from your scales, or anything else in Home Assistant. It fills in each day by itself, and anything you enter yourself always wins."),
    el("div", { class: "field" }, el("span", {}, "Sensor"), srcPickerSlot),
    field("Which reading counts for the day", srcValue));
  haOptions().then((ha) => {
    const sensors = (ha.sensors || []).map((x) => ({
      id: x.entity_id, name: x.name, icon: ICONS.home,
      sub: [x.state != null && x.state !== "unknown" ? `${x.state}${x.unit ? " " + x.unit : ""}` : null, x.entity_id].filter(Boolean).join(" · "),
      stateClass: x.state_class }));
    srcPicker = entityPicker({ items: sensors, selected: src ? [src.entity_id] : [], addLabel: "Search sensors", single: true,
      empty: ha.connected ? "No sensors with numbers were found." : "Can't reach Home Assistant right now." });
    srcPickerSlot.replaceChildren(srcPicker.node);
    // guess the right reading when a sensor is picked: running totals use the highest
    srcPicker.node.addEventListener("click", () => setTimeout(() => {
      const id = srcPicker.value()[0];
      const pick = sensors.find((x) => x.id === id);
      if (pick && !src) srcValue.value = pick.stateClass === "total_increasing" || /step/.test(id) ? "highest" : "latest";
    }, 0));
  });
  const readSource = () => {
    const id = srcPicker && srcPicker.value()[0];
    return id ? { entity_id: id, value: srcValue.value } : null;
  };
  const drawSource = () => {
    const mode = inputs.mode ? inputs.mode.value : null;
    srcDetails.hidden = !(kind === "sleep" || (kind === "factor" && mode && mode !== "bool"));
  };

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
    freqFieldNode.hidden = ["sleep", "medication", "gratitude"].includes(kind);
  };
  const kindHintEl = kindHint ? el("span", { class: "hint warn", hidden: true }, kindHint) : null;
  const originalKind = kind;
  if (kindHintEl) kindSelect.addEventListener("change", () => { kindHintEl.hidden = kindSelect.value === originalKind; });
  kindSelect.addEventListener("change", drawKindFields);
  kindSelect.addEventListener("change", drawKindExample);
  kindSelect.addEventListener("change", () => { drawSource(); if (inputs.mode) inputs.mode.addEventListener("change", drawSource); });
  if (inputs.mode) inputs.mode.addEventListener("change", drawSource);
  drawSource();
  drawKindFields();

  function readConfig() {
    if (kind === "rating") {
      const labels = inputs.labels.value.split(",").map((s) => s.trim()).filter(Boolean);
      return { min: 1, max: Number(inputs.scale.value), labels };
    }
    if (kind === "tags") return { options: inputs.options.value.split("\n").map((s) => s.trim()).filter(Boolean) };
    if (kind === "factor") return { mode: inputs.mode.value, unit: inputs.unit.value.trim(), goal: inputs.goal.value === "" ? null : inputs.goal.value,
      source: inputs.mode.value === "bool" ? null : readSource() };
    if (kind === "sleep") return { ...(kind === t.kind ? c : {}), source: readSource() }; // keep nights and goal
    if (kind === "gratitude") return { times: inputs.times.read(), remind: inputs.remind.input.checked };
    if (kind === "medication") return { dose: inputs.dose.value === "" ? null : inputs.dose.value, unit: inputs.unit.value.trim(),
      notes: inputs.notes.value.trim(), quantity: inputs.quantity.value || 1, counted_as: inputs.counted.value.trim() };
    return {};
  }

  const form = el("form", { method: "dialog" },
    el("h2", {}, isNew ? (t.kind === "medication" ? "Add medication" : "Add something to track") : `Edit ${t.name}`),
    err,
    isNew && kind === "medication" ? null : el("label", { class: "field" }, el("span", {}, "What kind?"), kindSelect, kindExample,
      kindHintEl),
    field("Name", name),
    el("div", { class: "field" }, el("span", {}, "Icon"), icon.node),
    groupFieldNode,
    groupList,
    extra,
    srcDetails,
    freqFieldNode,
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, isNew ? "Add" : "Save changes"),
      !isNew ? el("button", { type: "button", class: "secondary", onclick: async () => {
        await api("PATCH", `api/trackers/${t.id}`, { hidden: !t.hidden });
        sheet.close();
        toast(t.hidden ? `${t.name} is back on Check-in` : `${t.name} hidden from Check-in`);
        await redraw();
      } }, t.hidden ? "Show on Check-in" : "Hide") : null,
      !isNew ? el("button", { type: "button", class: "secondary danger", onclick: async () => {
        if (!confirm(`Delete ${t.name} and everything logged for it? To keep its history, hide it instead.`)) return;
        await api("DELETE", `api/trackers/${t.id}`);
        sheet.close();
        toast(`${t.name} deleted`);
        await redraw();
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
      const newSrc = payload.config.source;
      if (newSrc && (!src || src.entity_id !== newSrc.entity_id || src.value !== newSrc.value)) {
        try {
          const r = await api("POST", `api/trackers/${saved.id}/source/fill`, { days: 30 });
          toast(r.days ? `Filled in ${r.days === 1 ? "1 day" : r.days + " days"} from Home Assistant` : "Linked. It fills in as new readings arrive");
        } catch (e) { toast(e.message); }
      }
      await redraw();
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
    const input = el("time-field", { value, class: "time-at", "aria-label": "Time" });
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
    "Nowhere is chosen to send reminders yet, so they only show in this app. ",
    el("button", { type: "button", class: "link inline", onclick: () => openPersonSheet(view) }, "Choose devices"));
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
  const err = el("p", { class: "form-error", role: "alert", hidden: true });

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

  // ----- when I wake up (the wake-up settings are shared by every wake-up reminder) -----
  const w = person.wake || {};
  const wakeAfter = selectOf([[0, "As soon as I'm up"], [15, "15 minutes after"], [30, "30 minutes after"], [60, "1 hour after"],
    [120, "2 hours after"]], s.wake_after || 0);
  // The phone reminders go to first (notify.mobile_app_s26u has binary_sensor.<...>s26u_is_charging),
  // then any phone's "Is charging", then other charging sensors (a doorbell's battery isn't you).
  const slugs = (person.devices || []).map((d) => d.replace(/^notify\./, "").replace(/^mobile_app_/, "")).filter(Boolean);
  const chargerRank = (id) => slugs.some((sl) => id.endsWith(`${sl}_is_charging`)) ? 0 : id.endsWith("_is_charging") ? 1 : 2;
  const chargers = (ha.binary_sensors || []).filter((x) => /charg/.test(x.entity_id))
    .sort((a, b) => chargerRank(a.entity_id) - chargerRank(b.entity_id))
    .map((x) => ({ id: x.entity_id, name: x.name, sub: x.entity_id, icon: ICONS.phone }));
  const otherBinary = (ha.binary_sensors || []).filter((x) => !/charg/.test(x.entity_id))
    .map((x) => ({ id: x.entity_id, name: x.name, sub: x.entity_id, icon: ICONS.phone }));
  const charger = entityPicker({ items: [...chargers, ...otherBinary], selected: w.entity ? [w.entity] : (chargers[0] ? [chargers[0].id] : []),
    addLabel: "Search sensors", single: true, empty: "No sensors found in Home Assistant." });
  const fallbackOn = switchField("Remind me anyway if I'm not seen getting up", !!w.fallback,
    "For mornings the phone wasn't on the charger, or you're away.");
  const fallbackAt = el("time-field", { value: w.fallback || "10:00", "aria-label": "Remind me anyway at" });
  const fallbackPanel = el("div", { class: "subpanel" }, field("At", fallbackAt));
  const drawFallback = () => { fallbackPanel.hidden = !fallbackOn.input.checked; };
  fallbackOn.input.addEventListener("change", drawFallback);
  drawFallback();
  const earliest = el("time-field", { value: w.earliest || "04:00", "aria-label": "Not before" });
  const minHours = selectOf([[1, "1 hour"], [2, "2 hours"], [3, "3 hours"], [4, "4 hours"], [5, "5 hours"]], w.min_hours || 3);
  const wakeBlock = el("div", {},
    field("Remind me", wakeAfter),
    field("How the app knows you're up", charger.node,
      "Your phone's charging sensor from the Home Assistant app. Coming off the charger in the morning counts as getting up."),
    fallbackOn.node, fallbackPanel,
    el("details", { class: "more" }, el("summary", {}, "Fine-tune"),
      field("Not before", earliest, "Unplugging earlier than this (say, in the night) doesn't count."),
      field("After charging for at least", minHours, "So a quick top-up isn't mistaken for a night's charge.")),
    el("p", { class: "row-sub" }, "These wake-up settings are shared by all your \"when I wake up\" reminders. In the app you can also tap I'm up."));

  // ----- only on some days -----
  const ow = s.only_when || {};
  const onlyOn = switchField("Only on some days", !!s.only_when,
    "Add it to the day only when a Home Assistant number is high enough, like an antihistamine when pollen is high.");
  const sensorItems = (ha.sensors || []).map((x) => ({ id: x.entity_id, name: x.name,
    sub: `${x.entity_id}${x.state != null ? ` \u00b7 now ${x.state}${x.unit ? " " + x.unit : ""}` : ""}`, icon: ICONS.home }));
  const onlyEntity = entityPicker({ items: sensorItems, selected: ow.entity_id ? [ow.entity_id] : [],
    addLabel: "Search sensors, e.g. pollen", single: true, empty: "No sensors with numbers were found." });
  const helpers = (ha.sensors || []).filter((x) => /^(input_number|number)\./.test(x.entity_id));
  const limitHelper = selectOf([["", "A number I type"], ...helpers.map((x) => [x.entity_id, `${x.name} (now ${x.state})`])],
    typeof ow.at_least === "string" ? ow.at_least : "");
  const limitNum = el("input", { type: "number", step: "any", inputmode: "decimal", style: "width:6em", "aria-label": "At least",
    value: typeof ow.at_least === "number" ? ow.at_least : 3 });
  const drawLimit = () => { limitNum.hidden = !!limitHelper.value; };
  limitHelper.addEventListener("change", drawLimit);
  drawLimit();
  const onlyPanel = el("div", { class: "subpanel" },
    field("When this", onlyEntity.node, "Pollen sensors that forecast by day use today's forecast, even before their own day rolls over."),
    field("Is at least", el("div", { class: "inline-field" }, limitNum, limitHelper),
      "Following a helper keeps it in step with anything else that uses it, like the Outdoors card."),
    el("p", { class: "row-sub" }, "Checked through the day. Once it's added, it stays for the day, at most once."));
  const drawOnly = () => { onlyPanel.hidden = !onlyOn.input.checked; };
  onlyOn.input.addEventListener("change", drawOnly);
  drawOnly();

  let schedMode = s.mode;
  const timesBlock = el("div", {}, field("Times and amounts", times.node,
    `Set how many to take at each time, for example half at 7pm and one at 10pm. Usually ${usualText(t)}.`));
  const daysBlock = field("Days", days.node);
  const onlyBlock = el("div", {}, onlyOn.node, onlyPanel);
  const whenSeg = el("div", { class: "seg", role: "group", "aria-label": "How to time it" });
  const drawWhen = () => {
    whenSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === schedMode)));
    timesBlock.hidden = schedMode !== "times";
    afterBlock.hidden = schedMode !== "after";
    wakeBlock.hidden = schedMode !== "wake";
    daysBlock.hidden = schedMode === "after";
    onlyBlock.hidden = schedMode === "after";
  };
  [["times", "At set times"], ["wake", "When I wake up"], ["after", "After another dose"]].forEach(([m, label]) =>
    whenSeg.append(el("button", { type: "button", "data-mode": m, onclick: () => { schedMode = m; drawWhen(); markSheetChanged(); } }, label)));
  drawWhen();

  const nag = nagEditor(s);

  // ----- latest time -----
  const latestOn = switchField("Set a latest time", !!s.latest_time,
    "No reminders after this. If it still isn't taken, you get one last question: skip today, or take it anyway?");
  const latestInput = el("time-field", { value: s.latest_time || "11:00", "aria-label": "Latest time" });
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
    ? "Uses the speakers chosen in Devices and alerts."
    : "Choose speakers and a voice in Devices and alerts first.");
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
    wakeBlock,
    afterBlock,
    daysBlock,
    onlyBlock,
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
      sched.enabled ? el("button", { type: "button", class: "secondary", title: "Uses your saved settings", onclick: async () => {
        try {
          const r = await api("POST", `api/trackers/${t.id}/schedule/preview`);
          toast(`Test sent to ${r.sent_to === 1 ? "1 device" : r.sent_to + " devices"}`);
        } catch (e) { toast(e.message); }
      } }, "Send me a test") : null,
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
      wake_after: Number(wakeAfter.value),
      only_when: onlyOn.input.checked && schedMode !== "after"
        ? { entity_id: onlyEntity.value()[0] || "", at_least: limitHelper.value || limitNum.value } : null,
    };
    if (settings.only_when && !settings.only_when.entity_id) {
      err.textContent = "Choose what to check for \"Only on some days\", or turn it off.";
      err.hidden = false; err.scrollIntoView({ block: "nearest" }); return;
    }
    try {
      if (schedMode === "wake") {
        await api("PUT", "api/reminders/settings", { wake: {
          entity: charger.value()[0] || null,
          fallback: fallbackOn.input.checked ? fallbackAt.value : null,
          earliest: earliest.value,
          min_hours: Number(minHours.value),
        } });
      }
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
  const err = el("p", { class: "form-error", role: "alert", hidden: true });

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
  const err = el("p", { class: "form-error", role: "alert", hidden: true });
  const counts = state.trackers.filter((x) => x.kind === "factor" && ["count", "amount"].includes(x.config.mode));
  const waterDefault = counts.find((x) => x.key === "water");

  const enabled = switchField("Remind me to drink water", h.enabled, "A nudge when you haven't logged any water for a while.");
  const tracker = selectOf(counts.map((x) => [x.id, `${x.name}${x.config.unit ? " (" + x.config.unit + ")" : ""}`]),
    h.tracker_id ?? (waterDefault ? waterDefault.id : ""));
  const every = selectOf([[60, "1 hour"], [90, "1.5 hours"], [120, "2 hours"], [180, "3 hours"], [240, "4 hours"]], h.every);
  const start = el("time-field", { value: h.start, "aria-label": "From" });
  const end = el("time-field", { value: h.end, "aria-label": "Until" });
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

/* ---------- Home Assistant-style picker: chosen items as chips, plus a search to add more ---------- */

Object.assign(ICONS, {
  phone: "M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5zM11 18.5h2",
  speaker: "M7 2.5h10a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1zM12 18a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 7h.01",
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  message: "M4 5h16v11H8l-4 4z",
});

// items: [{ id, name, sub, icon }]. Returns { node, value() }.
function entityPicker({ items, selected, addLabel, empty, single = false }) {
  let chosen = selected.filter(Boolean);
  const byId = new Map(items.map((x) => [x.id, x]));
  for (const id of chosen) if (!byId.has(id)) byId.set(id, { id, name: id, sub: "Not found in Home Assistant right now", icon: ICONS.bell, missing: true });
  const chips = el("div", { class: "ha-chips" });
  const input = el("input", { type: "search", class: "ha-search", placeholder: addLabel, "aria-label": addLabel,
    role: "combobox", "aria-expanded": "false", autocomplete: "off" });
  const list = el("div", { class: "ha-list", role: "listbox", hidden: true });
  const searchBox = el("div", { class: "ha-search-box" }, svgIcon(ICONS.search), input);
  let active = -1;

  const changed = () => { markSheetChanged(); drawChips(); drawList(); };
  function drawChips() {
    chips.replaceChildren(...chosen.map((id) => {
      const x = byId.get(id);
      return el("span", { class: `ha-chip${x.missing ? " missing" : ""}`, title: x.sub || "" },
        el("span", { class: "ha-chip-icon" }, svgIcon(x.icon)),
        el("span", { class: "ha-chip-name" }, x.name),
        el("button", { type: "button", class: "ha-chip-remove", "aria-label": `Remove ${x.name}`,
          onclick: () => { chosen = chosen.filter((c) => c !== id); changed(); } }, svgIcon(ICONS.close)));
    }));
    chips.hidden = !chosen.length;
  }
  function options() {
    const q = input.value.trim().toLowerCase();
    return items.filter((x) => !chosen.includes(x.id))
      .filter((x) => !q || `${x.name} ${x.sub || ""} ${x.id}`.toLowerCase().includes(q));
  }
  function drawList() {
    const open = document.activeElement === input || list.contains(document.activeElement);
    const opts = options();
    if (active >= opts.length) active = opts.length - 1;
    list.replaceChildren(...(opts.length ? opts.map((x, i) => el("button", {
      type: "button", role: "option", class: `ha-option${i === active ? " active" : ""}`, "aria-selected": String(i === active),
      onmousedown: (ev) => ev.preventDefault(), // keep focus in the search box
      onclick: () => { if (single) chosen = [x.id]; else chosen.push(x.id); input.value = ""; active = -1; changed(); if (!single) input.focus(); else input.blur(); },
    }, el("span", { class: "ha-option-icon" }, svgIcon(x.icon)),
      el("span", { class: "ha-option-text" }, el("span", {}, x.name), x.sub ? el("span", { class: "row-sub" }, x.sub) : null)))
      : [el("p", { class: "row-sub ha-none" }, input.value ? "No matches" : "Everything available is already added")]));
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
  }
  input.addEventListener("focus", drawList);
  input.addEventListener("input", () => { active = 0; drawList(); });
  input.addEventListener("blur", () => setTimeout(drawList, 120));
  input.addEventListener("keydown", (ev) => {
    const opts = options();
    if (ev.key === "ArrowDown") { ev.preventDefault(); active = Math.min(opts.length - 1, active + 1); drawList(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); active = Math.max(0, active - 1); drawList(); }
    else if (ev.key === "Enter") { ev.preventDefault(); if (opts[active]) { if (single) chosen = [opts[active].id]; else chosen.push(opts[active].id); input.value = ""; changed(); } }
    else if (ev.key === "Escape" && !list.hidden) { ev.preventDefault(); ev.stopPropagation(); input.blur(); }
  });
  drawChips();
  const node = el("div", { class: "ha-picker" }, chips,
    items.length || chosen.length ? searchBox : null, items.length || chosen.length ? list : notice(empty));
  if (single) {
    // With one choice, the search box steps aside once something is chosen; × brings it back.
    const draw = () => { searchBox.hidden = chosen.length > 0; };
    chips.addEventListener("click", () => setTimeout(draw, 0));
    input.addEventListener("blur", () => setTimeout(draw, 150));
    draw();
  }
  return { node, value: () => chosen.slice() };
}

/* ---------- phones and alerts ---------- */

async function openPersonSheet(view) {
  const sheet = document.getElementById("sheet");
  let s, ha;
  try {
    haOptionsCache = null; // phones may have been added since last time
    [s, ha] = await Promise.all([api("GET", "api/reminders/settings"), haOptions()]);
  } catch (err) { toast(err.message); return; }
  const err = el("p", { class: "form-error", role: "alert", hidden: true });

  // Everywhere a reminder can go, straight from Home Assistant each time this opens.
  const SUBS = { phone: "Phone · with Taken, Snooze and Skip", entity: "Notify entity · message only",
    service: "Notify service · message only", ha: "Home Assistant sidebar · message only" };
  const ICON_FOR = { phone: ICONS.phone, entity: ICONS.message, service: ICONS.message, ha: ICONS.home };
  const targets = (ha.targets || ha.phones.map((p) => ({ id: p.service, name: p.name, kind: "phone", buttons: true })))
    .map((x) => ({ id: x.id, name: x.name, sub: SUBS[x.kind] || x.id, icon: ICON_FOR[x.kind] || ICONS.bell }));
  const devicePicker = entityPicker({ items: targets, selected: s.devices, addLabel: "Add a device",
    empty: ha.connected
      ? "Nothing that can receive notifications was found. Install the Home Assistant Companion app on your phone, sign in, then come back."
      : "Can't reach Home Assistant right now, so devices can't be listed." });
  const phones = devicePicker.node;
  const testBtn = el("button", { type: "button", class: "secondary small", onclick: async () => {
    try {
      await saveIt(false);
      const r = await api("POST", "api/reminders/test");
      toast(`Test sent to ${r.sent_to === 1 ? "1 device" : r.sent_to + " devices"}`);
    } catch (e) { toast(e.message); }
  } }, "Send a test");

  const group = switchField("Combine medications due at the same time", s.group_doses, "One notification instead of several.");
  const undo = switchField("Show an Undo button after I answer", s.undo, "Stays for a minute, in case you tapped the wrong thing.");
  const swipe = switchField("Let me swipe medication reminders away", s.swipe_away, "When this is off, they stay until you answer them.");
  const snooze = selectOf([5, 10, 15, 20, 30, 45, 60].map((n) => [n, `${n} minutes`]), s.snooze_minutes);

  const quiet = switchField("Quiet hours", s.quiet.enabled, "No alarm sounds or speaker announcements. Notifications still arrive.");
  const qStart = el("time-field", { value: s.quiet.start, "aria-label": "Quiet hours start" });
  const qEnd = el("time-field", { value: s.quiet.end, "aria-label": "Quiet hours end" });
  const quietPanel = el("div", { class: "subpanel inline-field" }, el("span", {}, "From"), qStart, el("span", {}, "to"), qEnd);
  const drawQuiet = () => { quietPanel.hidden = !quiet.input.checked; };
  quiet.input.addEventListener("change", drawQuiet);
  drawQuiet();

  const speakerPicker = entityPicker({
    items: ha.speakers.map((p) => ({ id: p.entity_id, name: p.name, sub: p.entity_id, icon: ICONS.speaker })),
    selected: s.speakers, addLabel: "Add a speaker", empty: "No speakers found in Home Assistant." });
  const voice = selectOf([["", "Choose a voice"], ...ha.voices.map((v) => [v.entity_id, v.name])], s.tts_entity);
  const onlyHome = switchField("Only when I'm home", s.announce_only_home,
    ha.people.some((p) => p.is_you) ? "Uses your Home Assistant person to tell if you're home." : "Needs a Home Assistant person linked to your user.");
  const speakerDetails = el("details", { class: "more", open: !!s.speakers.length },
    el("summary", {}, "Speaker announcements"),
    el("p", { class: "hint" }, "Used when a medication reminder is set to be announced."),
    el("div", { class: "field", role: "group", "aria-label": "Speakers" }, el("span", {}, "Speakers"), speakerPicker.node),
    field("Voice", voice), onlyHome.node);

  async function saveIt(close = true) {
    const payload = {
      devices: devicePicker.value(),
      group_doses: group.input.checked,
      undo: undo.input.checked,
      swipe_away: swipe.input.checked,
      snooze_minutes: Number(snooze.value),
      quiet: { enabled: quiet.input.checked, start: qStart.value, end: qEnd.value },
      speakers: speakerPicker.value(),
      tts_entity: voice.value || null,
      announce_only_home: onlyHome.input.checked,
    };
    await api("PUT", "api/reminders/settings", payload);
    if (close) {
      sheet.close();
      toast("Devices and alerts saved");
      if (currentTab() === "settings") await renderSettings(view);
    }
  }

  const form = el("form", { method: "dialog" },
    el("h2", {}, "Devices and alerts"),
    err,
    el("div", { class: "field", role: "group", "aria-label": "Send reminders to" }, el("span", {}, "Send reminders to"),
      phones,
      el("span", { class: "hint" }, "Phones with the Home Assistant app get Taken, Snooze and Skip. Everything else gets the message, with \"Open Wellbeing to answer\"."),
      targets.length ? el("div", { style: "margin-top:8px" }, testBtn) : null),
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

/* ---------- don't lose changes by tapping outside ---------- */

// A sheet becomes "changed" when anything in it is typed or picked. Tapping outside it or
// pressing Escape then asks first. Cancel and Save buttons close it straight away, as you'd expect.
let sheetChanged = false;
function markSheetChanged() { sheetChanged = true; }

function askBeforeClosing() {
  const sheet = document.getElementById("sheet");
  if (!sheetChanged) { sheet.close(); return; }
  const ask = document.getElementById("ask") || document.body.appendChild(el("dialog", { id: "ask", class: "sheet center ask" }));
  const form = sheet.querySelector("form");
  const save = form ? () => form.requestSubmit() : sheet.firstElementChild && sheet.firstElementChild._save;
  const done = (fn) => { ask.close(); if (fn) fn(); };
  ask.replaceChildren(el("div", { class: "sheet-body" },
    el("h2", {}, "Save your changes?"),
    el("p", { class: "row-sub", style: "margin:-8px 0 16px" }, "You've changed something that isn't saved yet."),
    el("div", { class: "actions" },
      save ? el("button", { type: "button", class: "primary", onclick: () => done(save) }, "Save") : null,
      el("button", { type: "button", class: "secondary", onclick: () => done(() => { sheetChanged = false; sheet.close(); }) }, "Discard"),
      el("button", { type: "button", class: "link", onclick: () => done() }, "Keep editing"))));
  ask.showModal();
}

async function start() {
  const sheetEl = document.getElementById("sheet");
  new MutationObserver(() => { sheetChanged = false; }).observe(sheetEl, { childList: true });
  sheetEl.addEventListener("input", markSheetChanged);
  sheetEl.addEventListener("change", (ev) => { if (!ev.target.closest(".emoji-panel")) markSheetChanged(); });
  sheetEl.addEventListener("close", () => { sheetChanged = false; });
  sheetEl.addEventListener("cancel", (ev) => { // Escape
    ev.preventDefault();
    if (document.activeElement && document.activeElement.classList.contains("ha-search")) { document.activeElement.blur(); return; }
    askBeforeClosing();
  });
  sheetEl.addEventListener("click", (ev) => {
    if (ev.target.id === "sheet") askBeforeClosing(); // tap outside
  });
  window.addEventListener("beforeunload", (ev) => {
    if (state.pending.size) ev.preventDefault();
  });
  window.addEventListener("hashchange", route);
  try {
    clock24 = detectClock();
    watchSwipe();
    [state.me, state.meta] = await Promise.all([api("GET", "api/me"), api("GET", "api/meta")]);
    await refreshTrackers();
  } catch (err) {
    document.getElementById("view").replaceChildren(
      el("p", { class: "form-error" }, `Couldn't start: ${err.message}`));
    return;
  }
  route();
}



/* ================= three good things ================= */

const nowHHMM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function goodThingPrompt(hhmm) {
  if (hhmm < "14:00") return "What's gone well so far today?";
  if (hhmm < "18:00") return "What's one good thing from this afternoon?";
  return "Before bed: what's one good thing from today?";
}

// Times that have come round today without a good thing written for them.
function goodThingsLeft(t) {
  const times = t.config.times || [];
  const written = entriesFor(t.id);
  if (state.day !== isoDay(new Date())) return written.length ? 0 : 1;
  const open = times.filter((x) => x <= nowHHMM()).length;
  return Math.max(0, open - written.length);
}

function goodThingsRow(t, view) {
  const times = t.config.times || [];
  const today = isoDay(new Date());
  const isToday = state.day === today;
  const written = entriesFor(t.id).slice().reverse(); // earliest first
  const yesterday = addDays(state.day, -1);
  const yesterdayEmpty = !(state.prevEntries || []).some((e) => e.tracker_id === t.id);
  const slotsUsed = new Set(written.map((e) => e.value_num).filter((v) => v != null));
  const now = nowHHMM();
  const openSlot = isToday ? times.findIndex((x, i) => x <= now && !slotsUsed.has(i)) : -1;
  const nextSlot = isToday ? times.findIndex((x, i) => x > now && !slotsUsed.has(i)) : -1;

  const edit = (e) => {
    const sheet = document.getElementById("sheet");
    const input = el("textarea", { maxlength: "280", rows: "3" });
    input.value = e.note || "";
    const form = el("form", { method: "dialog" },
      el("h2", {}, "A good thing"),
      field(`${dayLabel(e.day)}, ${timeOf(e.logged_at)}`, input),
      el("div", { class: "actions" },
        el("button", { type: "submit", class: "primary" }, "Save"),
        el("button", { type: "button", class: "secondary danger", onclick: async () => { sheet.close(); await deleteWithUndo(e, "Good thing"); } }, "Delete"),
        el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel")));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      try { await api("PATCH", `api/entries/${e.id}`, { note: v }); sheet.close(); await refreshCheckin(); }
      catch (err) { toast(err.message); }
    });
    sheet.replaceChildren(form);
    sheet.showModal();
    input.focus();
  };

  // one place to write, asking the right question for the time of day
  let ask = null;
  if (isToday && openSlot >= 0) ask = { prompt: goodThingPrompt(times[openSlot]), slot: openSlot, day: state.day };
  else if (isToday && !written.length && yesterdayEmpty && (!times.length || now < times[0])) {
    ask = { prompt: "What were you grateful for yesterday?", slot: null, day: yesterday, yesterday: true };
  } else if (!isToday) ask = { prompt: written.length ? "Anything else from that day?" : "What went well that day?", slot: null, day: state.day };

  const composer = (a) => {
    const inputId = `good-${t.id}-${a.slot ?? "x"}`;
    const input = el("input", { type: "text", maxlength: "280", id: inputId, class: "good-input", placeholder: "A coffee, a kind word, a walk…" });
    const save = async () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      const res = await quickSave([{ tracker_id: t.id, note: v, value_num: a.slot }], a.day === state.day ? undefined : loggedAtFor(a.day));
      if (res) toast(a.yesterday ? "Saved to yesterday" : written.length + 1 >= times.length && isToday ? "That's three good things today" : "Saved");
    };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); save(); } });
    return el("div", { class: "good-compose" },
      el("label", { for: inputId, class: "good-prompt" }, a.prompt),
      a.yesterday ? el("span", { class: "row-sub" }, "Nothing from yesterday yet. Looking back counts too.") : null,
      el("div", { class: "good-compose-row" }, input, el("button", { type: "button", class: "secondary small", onclick: save }, "Save")));
  };

  let later = null;
  if (!ask && nextSlot >= 0) {
    const holder = el("div", {});
    holder.append(el("p", { class: "row-sub good-next" }, `Next one around ${niceTime(times[nextSlot])}. `,
      el("button", { type: "button", class: "link inline", onclick: () => holder.replaceChildren(composer({ prompt: "One good thing", slot: nextSlot, day: state.day })) }, "Write one now")));
    later = holder;
  } else if (!ask && isToday && written.length >= times.length) {
    const holder = el("div", {});
    holder.append(el("button", { type: "button", class: "link inline good-more", onclick: () => holder.replaceChildren(composer({ prompt: "Another good thing", slot: null, day: state.day })) }, "Add another"));
    later = holder;
  }

  const list = written.length ? el("ul", { class: "good-list" }, written.map((e) => el("li", {},
    el("button", { type: "button", class: "good-item", "aria-label": `${e.note}. Change or delete`, onclick: () => edit(e) },
      el("span", { class: "good-dot", "aria-hidden": "true" }), el("span", { class: "good-text" }, e.note),
      el("span", { class: "good-time" }, timeOf(e.logged_at)))))) : null;
  const dots = isToday && times.length ? el("span", { class: "good-dots", role: "img", "aria-label": `${Math.min(written.length, times.length)} of ${times.length} today` },
    times.map((_, i) => el("span", { class: i < written.length ? "on" : "" }))) : null;
  return el("div", { class: "brow good-row" },
    el("div", { class: "brow-main" }, el("div", { class: "brow-text" }, rowName(t)), dots),
    el("div", { class: "brow-below" }, list, ask ? composer(ask) : null, later));
}

/* ================= a minute to breathe ================= */

const BREATH = { in: 4, out: 6, seconds: 60 };
const BREATH_GAP = 3 * 60 * 60 * 1000; // offered at most every 3 hours

// After a low mood or high anxiety, gently offer a minute to breathe. Returns true if offered.
function offerBreathing(items) {
  if (!items || state.day !== isoDay(new Date())) return false;
  const low = items.some((it) => {
    const t = state.trackers.find((x) => x.id === it.tracker_id);
    if (!t) return false;
    if (t.kind === "rating" && /mood/i.test(t.key || t.name)) {
      const c = t.config;
      return it.value_num != null && it.value_num <= c.min + Math.floor((c.max - c.min) * 0.3);
    }
    if (t.kind === "symptom" && /anx|panic|stress|overwhelm/i.test(t.name)) return it.value_num >= 2;
    if (t.kind === "rating" && /stress|anx/i.test(t.name)) return it.value_num >= t.config.max - Math.floor((t.config.max - t.config.min) * 0.3);
    if (t.kind === "tags") return (it.value_json || []).some((x) => /anxious|overwhelmed|panic|stressed/i.test(x));
    return false;
  });
  if (!low) return false;
  let last = 0;
  try { last = Number(localStorage.getItem("wbt-breathe-offered") || 0); } catch { /* fine */ }
  if (Date.now() - last < BREATH_GAP) return false;
  try { localStorage.setItem("wbt-breathe-offered", String(Date.now())); } catch { /* fine */ }
  toast("A minute to breathe?", "Start", () => openBreathing());
  return true;
}

function openBreathing() {
  const sheet = document.getElementById("sheet");
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cycle = BREATH.in + BREATH.out;
  const circle = el("div", { class: `breath-circle${reduce ? " still" : ""}`, "aria-hidden": "true" });
  const word = el("p", { class: "breath-word", "aria-live": "polite" }, "Get comfortable");
  const count = el("p", { class: "breath-count row-sub" }, `Breathe in for ${BREATH.in}, out for ${BREATH.out}. One minute.`);
  const bar = el("span", {});
  const progress = el("div", { class: "breath-progress", role: "progressbar", "aria-label": "Time left", "aria-valuemin": "0", "aria-valuemax": String(BREATH.seconds) }, bar);
  let timer = null, started = 0;
  const stop = () => { clearInterval(timer); timer = null; };
  const finish = async () => {
    stop();
    circle.className = "breath-circle done";
    word.textContent = "Well done";
    count.textContent = "That was a minute just for you.";
    const t = state.trackers.find((x) => x.key === "mindful");
    if (t && !entriesFor(t.id).some((e) => e.value_num) && state.day === isoDay(new Date())) {
      try { await api("POST", "api/checkin", { logged_at: localISO(new Date()), items: [{ tracker_id: t.id, value_num: 1 }] }); await refreshCheckin(); }
      catch { /* not important */ }
      count.textContent = "That was a minute just for you. Logged as a mindful minute.";
    }
    actions.replaceChildren(el("button", { type: "button", class: "primary", onclick: () => sheet.close() }, "Done"),
      el("button", { type: "button", class: "link", onclick: start }, "Another minute"));
  };
  const step = () => {
    const el_ = (Date.now() - started) / 1000;
    if (el_ >= BREATH.seconds) { finish(); return; }
    const inCycle = el_ % cycle;
    const breathingIn = inCycle < BREATH.in;
    const left = Math.ceil(breathingIn ? BREATH.in - inCycle : cycle - inCycle);
    const label = breathingIn ? "Breathe in" : "Breathe out";
    if (word.textContent !== label) word.textContent = label;
    count.textContent = String(left);
    circle.classList.toggle("in", breathingIn);
    circle.classList.toggle("out", !breathingIn);
    bar.style.width = `${Math.min(100, (el_ / BREATH.seconds) * 100)}%`;
    progress.setAttribute("aria-valuenow", String(Math.round(el_)));
  };
  const start = () => {
    stop();
    started = Date.now();
    circle.className = `breath-circle${reduce ? " still" : ""}`;
    actions.replaceChildren(el("button", { type: "button", class: "secondary", onclick: () => { stop(); sheet.close(); } }, "Stop"));
    step();
    timer = setInterval(step, 250);
  };
  const actions = el("div", { class: "actions breath-actions" },
    el("button", { type: "button", class: "primary", onclick: start }, "Start"),
    el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Not now"));
  sheet.replaceChildren(el("div", { class: "sheet-body breath" },
    el("h2", {}, "A minute to breathe"),
    el("div", { class: "breath-stage" }, circle),
    word, count, progress, actions));
  sheet.addEventListener("close", stop, { once: true });
  if (!sheet.open) sheet.showModal();
}

/* ================= good news ================= */

async function loadEncouragement() {
  try { state.encourage = await api("GET", "api/encouragement"); } catch { state.encourage = null; }
}

function dismissedNews() {
  try { return JSON.parse(localStorage.getItem("wbt-news-seen") || "{}"); } catch { return {}; }
}

// The best bit of good news, once a day, on Check-in. Never anything negative.
function newsCard(view) {
  const news = state.encourage && state.encourage.highlights || [];
  if (!news.length || state.day !== isoDay(new Date())) return null;
  const seen = dismissedNews();
  const fresh = news.filter((h) => seen[h.text] !== isoDay(new Date()) && !(seen[h.text] && seen[h.text] > addDays(isoDay(new Date()), -3)));
  if (!fresh.length) return null;
  const top = fresh.slice(0, 2);
  const dismiss = () => {
    const next = dismissedNews();
    for (const h of top) next[h.text] = isoDay(new Date());
    try { localStorage.setItem("wbt-news-seen", JSON.stringify(next)); } catch { /* fine */ }
    drawCheckin(view);
  };
  return el("section", { class: "card news-card", "aria-label": "Good news" },
    el("div", { class: "news-head" },
      el("span", { class: "news-icon", "aria-hidden": "true" }, svgIcon("M12 3l2.2 5.6L20 9.3l-4.4 3.9 1.3 5.8L12 16l-4.9 3 1.3-5.8L4 9.3l5.8-.7z")),
      el("h2", { class: "card-title" }, "Good news"),
      el("button", { type: "button", class: "iconbtn plain", "aria-label": "Hide for now", title: "Hide for now", onclick: dismiss }, svgIcon(ICONS.close))),
    el("ul", { class: "news-list" }, top.map((h) => el("li", {}, h.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, h.emoji) : null, el("span", {}, h.text)))),
    news.length > top.length ? el("a", { class: "link inline news-more", href: "#/history" }, "More in History") : null);
}

// History: the last seven days in a few facts, and every bit of good news.
function weekCard() {
  const data = state.encourage;
  if (!data) return null;
  const w = data.week;
  const facts = [];
  facts.push(`Checked in on ${w.days_checked_in} of the last 7 days`);
  if (w.good_things) facts.push(`${w.good_things} good ${w.good_things === 1 ? "thing" : "things"} noted`);
  if (w.sleep_average != null) facts.push(`Sleep averaged ${hm(w.sleep_average)}${w.nights_at_goal ? `, ${w.nights_at_goal} ${w.nights_at_goal === 1 ? "night" : "nights"} at your goal` : ""}`);
  if (w.doses_taken) facts.push(`${w.doses_taken} ${w.doses_taken === 1 ? "dose" : "doses"} taken when reminded`);
  if (w.best_day) facts.push(`Best day: ${dayLabel(w.best_day.day)} (${w.best_day.label.toLowerCase()})`);
  return el("section", { class: "card week-card" },
    el("div", { class: "news-head" }, el("h2", { class: "card-title" }, "Your week")),
    el("ul", { class: "week-facts" }, facts.map((f) => el("li", {}, f))),
    data.highlights.length ? [el("h3", { class: "sleep-h3" }, "Going well"),
      el("ul", { class: "news-list" }, data.highlights.map((h) => el("li", {}, h.emoji ? el("span", { class: "emoji", "aria-hidden": "true" }, h.emoji) : null, el("span", {}, h.text))))] : null);
}

/* ================= the clock-face time picker ================= */

// One way to pick a time everywhere, like Android's clock: tap the hour on the dial, then the
// minutes, or type them straight into the big numbers at the top. Follows your 12 or 24-hour
// setting. Keyboard: the numbers at the top take typing; the dial is a slider (arrow keys).
function openTimePicker({ value, label, onSave }) {
  let [h, m] = (value || nowHHMM()).split(":").map(Number);
  let mode = "hour"; // or "minute"
  const dlg = el("dialog", { class: "picker", "aria-label": label || "Choose a time" });
  // Dial mode: the big numbers are buttons that say which part the dial is setting.
  const hourBtn = el("button", { type: "button", class: "picker-num picker-num-btn" });
  const minBtn = el("button", { type: "button", class: "picker-num picker-num-btn" });
  // Keyboard mode: the same numbers as boxes to type into.
  const hourIn = el("input", { type: "text", inputmode: "numeric", maxlength: "2", class: "picker-num picker-num-in", "aria-label": "Hour", autocomplete: "off" });
  const minIn = el("input", { type: "text", inputmode: "numeric", maxlength: "2", class: "picker-num picker-num-in", "aria-label": "Minutes", autocomplete: "off" });
  const am = el("button", { type: "button", class: "picker-ampm" }, "AM");
  const pm = el("button", { type: "button", class: "picker-ampm" }, "PM");
  const hint = el("p", { class: "picker-hint", "aria-live": "polite" });
  const dial = el("div", { class: "picker-dial", role: "slider", tabindex: "0" });
  const SVG = "http://www.w3.org/2000/svg";
  const hand = document.createElementNS(SVG, "svg");
  hand.setAttribute("viewBox", "0 0 256 256");
  hand.setAttribute("class", "picker-hand");
  hand.setAttribute("aria-hidden", "true");
  const faces = el("div", { class: "picker-faces", "aria-hidden": "true" });
  dial.append(hand, faces);
  const R_OUT = 100, R_IN = 66, C = 128;
  const pos = (i, r) => ({ x: C + r * Math.sin((i / 12) * 2 * Math.PI), y: C - r * Math.cos((i / 12) * 2 * Math.PI) });
  const typing = () => dlg.classList.contains("typing");

  const hour12 = () => (h % 12) || 12;
  const hourText = () => (clock24 ? pad(h) : String(hour12()));
  const draw = () => {
    hourBtn.textContent = hourText();
    minBtn.textContent = pad(m);
    hourBtn.setAttribute("aria-label", `Hour, ${hourText()}`);
    minBtn.setAttribute("aria-label", `Minutes, ${pad(m)}`);
    hourBtn.setAttribute("aria-pressed", String(mode === "hour"));
    minBtn.setAttribute("aria-pressed", String(mode === "minute"));
    if (document.activeElement !== hourIn) hourIn.value = hourText();
    if (document.activeElement !== minIn) minIn.value = pad(m);
    for (const n of [hourBtn, hourIn]) n.classList.toggle("on", mode === "hour");
    for (const n of [minBtn, minIn]) n.classList.toggle("on", mode === "minute");
    am.setAttribute("aria-pressed", String(h < 12));
    pm.setAttribute("aria-pressed", String(h >= 12));
    hint.textContent = typing() ? "Type the hour, then the minutes" : mode === "hour" ? "Tap the hour" : "Tap the minutes, or drag for an exact minute";
    // numbers on the face
    faces.replaceChildren();
    const marks = [];
    if (mode === "hour") {
      for (let i = 0; i < 12; i++) marks.push({ i, r: R_OUT, text: String(i === 0 ? 12 : i), v: clock24 ? (i === 0 ? 12 : i) : i });
      if (clock24) for (let i = 0; i < 12; i++) marks.push({ i, r: R_IN, text: i === 0 ? "00" : String(i + 12), v: i === 0 ? 0 : i + 12, inner: true });
    } else {
      for (let i = 0; i < 12; i++) marks.push({ i, r: R_OUT, text: pad(i * 5), v: i * 5 });
    }
    const current = mode === "hour" ? (clock24 ? h : h % 12) : m;
    for (const k of marks) {
      const p = pos(k.i, k.r);
      faces.append(el("span", { class: `picker-mark${k.inner ? " inner" : ""}${k.v === current ? " on" : ""}`,
        style: `left:${(p.x / 256) * 100}%;top:${(p.y / 256) * 100}%` }, k.text));
    }
    // the hand
    const unit = mode === "hour" ? h % 12 : m / 5;
    const r = mode === "hour" && clock24 && (h === 0 || h > 12) ? R_IN : R_OUT;
    const tip = pos(unit, r);
    const mk = (tag, attrs) => { const n = document.createElementNS(SVG, tag); for (const [a, v] of Object.entries(attrs)) n.setAttribute(a, v); return n; };
    hand.replaceChildren(mk("circle", { cx: C, cy: C, r: 4, class: "picker-pivot" }), mk("line", { x1: C, y1: C, x2: tip.x, y2: tip.y, class: "picker-arm" }),
      mk("circle", { cx: tip.x, cy: tip.y, r: 20, class: "picker-tip" }));
    dial.setAttribute("aria-label", mode === "hour" ? "Hour" : "Minutes");
    dial.setAttribute("aria-valuemin", mode === "hour" ? (clock24 ? "0" : "1") : "0");
    dial.setAttribute("aria-valuemax", mode === "hour" ? (clock24 ? "23" : "12") : "59");
    dial.setAttribute("aria-valuenow", String(mode === "hour" ? (clock24 ? h : hour12()) : m));
    dial.setAttribute("aria-valuetext", niceTime(`${pad(h)}:${pad(m)}`));
    dial.classList.toggle("minutes", mode === "minute");
  };
  const setMode = (next) => { mode = next; draw(); };
  hourBtn.addEventListener("click", () => { setMode("hour"); dial.focus(); });
  minBtn.addEventListener("click", () => { setMode("minute"); dial.focus(); });

  // dial: a tap lands on the nearest number (minutes snap to 5); dragging gives exact minutes
  const fromPointer = (ev, exact) => {
    const box = dial.getBoundingClientRect();
    const x = ((ev.clientX - box.left) / box.width) * 256 - C;
    const y = ((ev.clientY - box.top) / box.height) * 256 - C;
    let angle = Math.atan2(x, -y);
    if (angle < 0) angle += 2 * Math.PI;
    const dist = Math.hypot(x, y);
    if (mode === "hour") {
      const i = Math.round((angle / (2 * Math.PI)) * 12) % 12;
      if (clock24) h = dist < (R_IN + R_OUT) / 2 ? (i === 0 ? 0 : i + 12) : (i === 0 ? 12 : i);
      else h = (h >= 12 ? 12 : 0) + i;
    } else {
      const raw = (angle / (2 * Math.PI)) * 60;
      m = exact ? Math.round(raw) % 60 : (Math.round(raw / 5) * 5) % 60;
    }
    draw();
  };
  let dragging = false, moved = false, startX = 0, startY = 0;
  dial.addEventListener("pointerdown", (ev) => {
    dragging = true; moved = false; startX = ev.clientX; startY = ev.clientY;
    dial.setPointerCapture(ev.pointerId); fromPointer(ev, false); ev.preventDefault(); dial.focus();
  });
  dial.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
    moved = true;
    fromPointer(ev, true);
  });
  dial.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    if (mode === "hour") setMode("minute");
  });
  dial.addEventListener("keydown", (ev) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[ev.key];
    if (ev.key === "Enter") { ev.preventDefault(); if (mode === "hour") setMode("minute"); else ok(); return; }
    if (!step) return;
    ev.preventDefault();
    if (mode === "hour") h = (h + step + 24) % 24; else m = (m + step + 60) % 60;
    draw();
  });

  // keyboard mode: type digits; the first replaces what's there and it moves on to the minutes
  const typed = (input, max, apply) => {
    let fresh = true;
    input.addEventListener("focus", () => { fresh = true; setMode(input === hourIn ? "hour" : "minute"); setTimeout(() => input.select(), 0); });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); ok(); return; }
      if (!/^\d$/.test(ev.key)) return;
      ev.preventDefault();
      let v = fresh ? ev.key : (input.value + ev.key).slice(-2);
      if (Number(v) > max) v = ev.key;
      fresh = false;
      input.value = v;
      apply(Number(v));
      draw();
      if (input === hourIn && (v.length === 2 || Number(v) * 10 > max)) minIn.focus();
    });
    input.addEventListener("input", () => { // pasting, or a phone keyboard that skips keydown
      input.value = input.value.replace(/\D/g, "").slice(0, 2);
      const v = Number(input.value);
      if (input.value !== "" && v <= max) apply(v);
      fresh = false;
      draw();
      if (input === hourIn && input.value.length === 2) minIn.focus();
    });
    input.addEventListener("blur", () => draw());
  };
  typed(hourIn, clock24 ? 23 : 12, (v) => {
    if (clock24) h = v;
    else if (v >= 1) h = (h >= 12 ? 12 : 0) + (v % 12);
  });
  typed(minIn, 59, (v) => { m = v; });
  am.addEventListener("click", () => { if (h >= 12) h -= 12; draw(); });
  pm.addEventListener("click", () => { if (h < 12) h += 12; draw(); });

  const close = () => { dlg.close(); dlg.remove(); };
  const ok = () => { close(); onSave(`${pad(h)}:${pad(m)}`); };
  const KEYS = "M3 7h18v10H3zM6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10";
  const CLOCK = "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z";
  const typeMode = el("button", { type: "button", class: "iconbtn plain" });
  const setTyping = (on) => {
    dlg.classList.toggle("typing", on);
    typeMode.setAttribute("aria-label", on ? "Use the clock" : "Type the time instead");
    typeMode.title = on ? "Use the clock" : "Type the time";
    typeMode.replaceChildren(svgIcon(on ? CLOCK : KEYS));
    draw();
  };
  typeMode.addEventListener("click", () => { setTyping(!typing()); (typing() ? hourIn : dial).focus(); });
  dlg.append(
    el("div", { class: "picker-head" },
      el("p", { class: "picker-label" }, label || "Time"),
      el("div", { class: "picker-time" }, hourBtn, hourIn, el("span", { class: "picker-colon", "aria-hidden": "true" }, ":"), minBtn, minIn,
        clock24 ? null : el("div", { class: "picker-ampms", role: "group", "aria-label": "Morning or afternoon" }, am, pm)),
      hint),
    el("div", { class: "picker-body" }, dial),
    el("div", { class: "picker-actions" }, typeMode,
      el("button", { type: "button", class: "link", onclick: () => { const d = new Date(); h = d.getHours(); m = d.getMinutes(); draw(); } }, "Now"),
      el("span", { class: "picker-gap" }),
      el("button", { type: "button", class: "link", onclick: close }, "Cancel"),
      el("button", { type: "button", class: "primary small", onclick: ok }, "OK")));
  // Escape and Cancel close it. A stray tap outside doesn't, so a chosen time isn't lost.
  dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
  document.body.append(dlg);
  setTyping(window.innerHeight < 560); // no room for the dial: type instead
  dlg.showModal();
  (typing() ? hourIn : dial).focus();
}

// <time-field>: a button showing the time, which opens the clock. Has .value ("HH:MM" or "")
// and fires input and change events, so it can stand in for <input type="time">.
class TimeField extends HTMLElement {
  static get observedAttributes() { return ["value", "aria-label", "placeholder"]; }
  constructor() {
    super();
    this._value = "";
    this._btn = document.createElement("button");
    this._btn.type = "button";
    this._btn.className = "time-field-btn";
    this._btn.addEventListener("click", () => openTimePicker({
      value: this._value, label: this.getAttribute("aria-label") || "Time",
      onSave: (v) => {
        this.value = v;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        if (typeof markSheetChanged === "function" && this.closest("#sheet")) markSheetChanged();
        this._btn.focus();
      },
    }));
  }
  connectedCallback() { if (!this._btn.isConnected) this.append(this._btn); this._draw(); }
  attributeChangedCallback(name, _old, v) { if (name === "value") this._value = v || ""; this._draw(); }
  get value() { return this._value; }
  set value(v) { this._value = v || ""; this._draw(); }
  focus() { this._btn.focus(); }
  _draw() {
    const label = this.getAttribute("aria-label") || "Time";
    const shown = this._value ? niceTime(this._value) : (this.getAttribute("placeholder") || "Choose");
    this._btn.replaceChildren(svgIcon("M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"), document.createTextNode(shown));
    this._btn.classList.toggle("empty", !this._value);
    this._btn.setAttribute("aria-label", `${label}: ${this._value ? niceTime(this._value) : "not set"}. Change`);
  }
}
customElements.define("time-field", TimeField);

start();
