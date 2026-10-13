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

// Blends smoothly between the five colours, so 1–5 and 1–10 scales both run dusk to sun.
function scaleColor(cfg, value) {
  const span = cfg.max - cfg.min;
  const pos = span === 0 ? 0.5 : Math.max(0, Math.min(1, (value - cfg.min) / span));
  const x = pos * 4;
  const i = Math.min(3, Math.floor(x));
  const f = Math.round((x - i) * 100);
  if (f === 0) return `var(${SCALE_VARS[i]})`;
  if (f === 100) return `var(${SCALE_VARS[i + 1]})`;
  return `color-mix(in oklab, var(${SCALE_VARS[i + 1]}) ${f}%, var(${SCALE_VARS[i]}))`;
}

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
  state.nextCheckin = isToday ? (await api("GET", "api/checkins/next").catch(() => ({}))).time : null;
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
    isToday && state.nextCheckin ? el("p", { class: "row-sub" }, `Next check-in reminder at ${niceTime(state.nextCheckin)}`) : null,
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
      el("a", { class: "primary", href: "#/settings", style: "display:inline-block;text-decoration:none" }, "Choose what to track"),
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
        el("button", { type: "button", class: "primary small", onclick: () => act(d, "taken") }, "Taken now"),
        el("button", { type: "button", class: "secondary small", onclick: () => {
          const t = state.trackers.find((x) => x.id === d.tracker_id);
          if (t) openDoseSheet(t, view);
        } }, "Taken at…"),
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

function goalAside(c, current) {
  if (!c.goal) return null;
  const done = Number(current) >= Number(c.goal);
  return el("span", { class: `row-aside${done ? " set" : ""}` },
    `${fmtNum(current)} of ${fmtNum(c.goal)}${c.unit ? " " + c.unit : ""}${done ? " ✓" : ""}`);
}

async function takenNow(t, view) {
  const recent = entriesFor(t.id).find((e) => Date.now() - new Date(e.logged_at).getTime() < 60 * 60 * 1000);
  if (recent && !confirm(`${t.name} was logged at ${timeOf(recent.logged_at)}. Log another dose now?`)) return;
  try {
    await api("POST", "api/checkin", { logged_at: localISO(new Date()), items: [{ tracker_id: t.id, value_num: 1 }] });
    await loadDay();
    toast(`${t.name} logged at ${timeOf(localISO(new Date()))}`);
    drawCheckin(view);
  } catch (err) { toast(err.message); }
}

// Log a dose at a chosen time, or change or delete one already logged.
function openDoseSheet(t, view, entry = null) {
  const sheet = document.getElementById("sheet");
  const c = t.config;
  const day = entry ? entry.day : state.day;
  const now = new Date();
  const startTime = entry ? /T(\d{2}:\d{2})/.exec(entry.logged_at)[1] : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const timeInput = el("input", { type: "time", value: startTime, required: true, "aria-label": "Time taken" });
  let count = entry ? entry.value_num : 1;
  const countOut = el("output", { "aria-live": "polite" }, fmtNum(count));
  const stepCount = (d) => { count = Math.max(0.5, Math.round((count + d) * 2) / 2); countOut.textContent = fmtNum(count); drawTotal(); };
  const strength = el("input", { type: "number", min: "0", step: "any", inputmode: "decimal",
    value: entry && entry.value_json && entry.value_json.dose != null ? entry.value_json.dose : (c.dose ?? ""),
    "aria-label": "Dose", style: "width:7em", placeholder: "30" });
  const total = el("p", { class: "hint" });
  const drawTotal = () => {
    const sv = Number(strength.value);
    total.textContent = strength.value !== "" && sv > 0 && count !== 1
      ? `Total ${fmtNum(count * sv)} ${c.unit || ""}`.trim() : "";
  };
  strength.addEventListener("input", drawTotal);
  drawTotal();
  const note = el("input", { type: "text", maxlength: "500", value: entry && entry.note ? entry.note : "", placeholder: "Optional" });
  const err = el("p", { class: "form-error", hidden: true });

  const form = el("form", { method: "dialog" },
    el("h2", {}, entry ? `Change ${t.name} dose` : `Log ${t.name}`),
    el("p", { class: "row-sub", style: "margin:-8px 0 14px" }, longDate(day)),
    err,
    field("Time taken", timeInput),
    el("div", { class: "field" }, el("span", {}, "Number of doses"),
      el("div", { class: "stepper" },
        el("button", { type: "button", class: "iconbtn", "aria-label": "Fewer doses", onclick: () => stepCount(-0.5) }, svgIcon(ICONS.minus)),
        countOut,
        el("button", { type: "button", class: "iconbtn", "aria-label": "More doses", onclick: () => stepCount(0.5) }, svgIcon(ICONS.plus))),
      el("span", { class: "hint" }, "For example 2 tablets, or half a tablet.")),
    el("div", { class: "field" }, el("span", {}, "Dose"),
      el("div", { class: "inline-field" }, strength, el("span", {}, c.unit || "")),
      el("span", { class: "hint" }, "Change it if this dose was a different strength."), total),
    field("Note", note),
    el("div", { class: "actions" },
      el("button", { type: "submit", class: "primary" }, entry ? "Save changes" : "Log it"),
      entry ? el("button", { type: "button", class: "secondary danger", onclick: async () => {
        if (!confirm(`Delete the ${t.name} dose at ${timeOf(entry.logged_at)}?`)) return;
        try {
          await api("DELETE", `api/entries/${entry.id}`);
          sheet.close();
          await loadDay();
          toast("Dose deleted");
          drawCheckin(view);
        } catch (e) { toast(e.message); }
      } }, "Delete") : null,
      el("button", { type: "button", class: "link", onclick: () => sheet.close() }, "Cancel")));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const [h, m] = timeInput.value.split(":").map(Number);
    const when = dayToDate(day);
    when.setHours(h, m, 0, 0);
    if (when > new Date()) { err.textContent = "That time hasn't happened yet."; err.hidden = false; return; }
    const value_json = strength.value !== "" ? { dose: Number(strength.value) } : null;
    try {
      if (entry) {
        await api("PATCH", `api/entries/${entry.id}`, { logged_at: localISO(when), value_num: count, value_json, note: note.value });
      } else {
        await api("POST", "api/checkin", { logged_at: localISO(when),
          items: [{ tracker_id: t.id, value_num: count, value_json, note: note.value || null }] });
      }
      sheet.close();
      await loadDay();
      toast(entry ? "Dose changed" : `${t.name} logged at ${niceTime(timeInput.value)}`);
      if (currentTab() === "checkin") drawCheckin(view);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });

  sheet.replaceChildren(form);
  sheet.showModal();
}

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
    const cols = n > 7 ? Math.ceil(n / 2) : n;
    return rowShell(t, aside, el("div", { class: "scale", style: `--n:${cols}` }, buttons),
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
        el("output", { "aria-live": "polite" }, fmtNum(current)),
        el("button", { type: "button", class: "iconbtn", "aria-label": `More ${t.name}`, onclick: () => step(1) }, svgIcon(ICONS.plus)),
        c.unit ? el("span", { class: "row-sub" }, c.unit) : null,
      );
      return rowShell(t, goalAside(c, current), stepper);
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
    return rowShell(t, goalAside(c, val ?? 0), el("div", { class: "inline-field" }, input, c.unit ? el("span", {}, c.unit) : null));
  }

  if (t.kind === "medication") {
    const taken = entriesFor(t.id).slice().reverse(); // earliest first
    const usual = c.dose != null && c.dose !== "" ? `Usual dose ${fmtNum(c.dose)} ${c.unit || ""}`.trim() : null;
    const nextDose = state.doses.find((d) => d.tracker_id === t.id && d.status === "scheduled" && d.local_day === state.day);
    const sub = [usual, c.notes, nextDose ? `Next reminder ${niceTime(nextDose.time)}` : null].filter(Boolean).join(". ");
    const isToday = state.day === isoDay(new Date());
    const asideText = taken.length ? (taken.length === 1 ? "Taken once" : `Taken ${taken.length} times`) : "Not taken yet";
    const chips = taken.length ? el("div", { class: "dose-chips" }, taken.map((e) => el("button", {
      type: "button", class: "dose-chip", "aria-label": `${t.name} at ${timeOf(e.logged_at)}, ${doseText(t, e)}. Change or delete`,
      onclick: () => openDoseSheet(t, view, e),
    }, el("strong", {}, timeOf(e.logged_at)), el("span", {}, doseText(t, e))))) : null;
    const actions = el("div", { class: "due-actions" },
      isToday ? el("button", { type: "button", class: "med-taken", onclick: () => takenNow(t, view) }, "Taken now") : null,
      el("button", { type: "button", class: "secondary small", onclick: () => openDoseSheet(t, view) }, isToday ? "Taken at…" : "Log a dose…"));
    return rowShell(t, el("span", { class: "row-aside" }, asideText),
      el("div", { class: "med-controls" }, chips, chips ? el("p", { class: "hint" }, "Tap a time to change or delete it.") : null, actions),
      sub || null);
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
    toast("Check-in saved");
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
      return [amount, describeSchedule(t._schedule)].filter(Boolean).join(". ");
    }
    default: return often;
  }
}

function describeSchedule(sch) {
  if (!sch || !sch.enabled) return "No reminders";
  const s = sch.settings;
  if (s.mode === "after") {
    const name = (id) => (state.trackers.find((x) => x.id === id) || {}).name || "another medication";
    let text = `Reminds you ${joinNames(s.after.map((r) => `${niceGap(r.minutes)} after ${name(r.tracker_id)}`))}`;
    if (s.max_per_day) text += `, up to ${s.max_per_day} a day`;
    return text;
  }
  return `Reminds you at ${joinNames(s.times.map(niceTime))}${describeDays(s.days) ? ", " + describeDays(s.days) : ""}`;
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
    el("h2", {}, "Medications"),
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
      extra.append(...[
        el("div", { class: "field-pair" }, field("Usual dose", inputs.dose), field("Measured in", inputs.unit)),
        el("datalist", { id: "dose-units" }, ["mg", "mcg", "g", "ml", "IU", "tablets", "capsules", "drops", "puffs"].map((u) => el("option", { value: u }))),
        el("p", { class: "hint", style: "margin:-6px 0 14px" }, "When you log a dose you can change the number of doses and the strength."),
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
    if (kind === "medication") return { dose: inputs.dose.value === "" ? null : inputs.dose.value, unit: inputs.unit.value.trim(), notes: inputs.notes.value.trim() };
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
    if (!["sleep", "medication"].includes(kind)) payload.frequency = freq.value;
    if (!isNew && kind !== t.kind) {
      if (logged && !confirm(`Change ${t.name} to ${KIND_INFO[kind].toLowerCase()}? This clears the ${logged === 1 ? "1 thing" : logged + " things"} already logged for it.`)) return;
      payload.kind = kind;
      if (kind === "medication") payload.group_name = "Medications";
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
function timesEditor(times) {
  const list = el("div", { class: "time-list" });
  const add = (value) => {
    const input = el("input", { type: "time", value, required: true, "aria-label": "Time" });
    const row = el("div", { class: "time-row" }, input,
      el("button", { type: "button", class: "iconbtn", "aria-label": "Remove this time", onclick: () => {
        if (list.children.length > 1) row.remove();
      } }, svgIcon(ICONS.close)));
    list.append(row);
  };
  times.forEach(add);
  const node = el("div", {}, list,
    el("button", { type: "button", class: "secondary small", onclick: () => add("12:00") }, "Add a time"));
  return { node, read: () => [...list.querySelectorAll("input")].map((i) => i.value).filter(Boolean) };
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

  const times = timesEditor(s.times);
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
  const timesBlock = el("div", {}, field("Times", times.node), field("Days", days.node));
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
