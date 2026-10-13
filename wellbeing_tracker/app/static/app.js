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
};

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
  state.dayEntries = await api("GET", `api/entries?from=${state.day}&to=${state.day}`);
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
  view.replaceChildren(head, ...sections);
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
    const sub = [dose, c.notes].filter(Boolean).join(". ");
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
    case "medication": return [c.dose, c.unit].filter(Boolean).join(" ") || "Medication";
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

  view.replaceChildren(...[head, medSection, ...trackerSections, addRow, hiddenSection,
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
        el("p", { class: "row-sub" }, "Reminder schedules arrive in the next update."),
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
      if (isNew) await api("POST", "api/trackers", { kind, ...payload });
      else await api("PATCH", `api/trackers/${t.id}`, payload);
      sheet.close();
      toast(isNew ? `${payload.name.trim()} added` : "Changes saved");
      await refreshTrackers();
      await renderSettings(view);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });

  sheet.replaceChildren(form);
  sheet.showModal();
  name.focus();
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
