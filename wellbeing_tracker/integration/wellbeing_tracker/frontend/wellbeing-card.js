// Wellbeing dashboard card: reminders waiting (with the same buttons as the phone), today's
// medications, supply warnings and when to see the doctor. Added to dashboards automatically by
// the Wellbeing Tracker integration. Plain web component, styled with Home Assistant's theme.

const SKIP_REASONS = ["Felt fine", "Side effects", "Ran out", "Not needed today"];

const STYLE = `
  :host { display: block; }
  ha-card { padding: 16px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .title { font-size: var(--ha-card-header-font-size, 1.25rem); font-weight: 500; line-height: 1.3; color: var(--ha-card-header-color, var(--primary-text-color)); }
  .who { font-size: 0.875rem; color: var(--secondary-text-color); }
  .open { border: 0; background: none; color: var(--primary-color); cursor: pointer; padding: 6px; border-radius: 50%; display: inline-grid; place-items: center; }
  .open:hover { background: var(--secondary-background-color); }
  .open svg { width: 22px; height: 22px; fill: currentColor; }
  section + section { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--divider-color); }
  .label { font-size: 0.8rem; font-weight: 500; letter-spacing: 0.02em; color: var(--secondary-text-color); margin-bottom: 8px; }
  .item { padding: 10px 12px; border-radius: 12px; background: var(--secondary-background-color); }
  .item + .item { margin-top: 8px; }
  .item-title { font-weight: 500; color: var(--primary-text-color); }
  .item-msg { white-space: pre-wrap; color: var(--secondary-text-color); font-size: 0.9rem; margin-top: 2px; }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  button.b { font: inherit; font-size: 0.875rem; font-weight: 500; height: 36px; padding: 0 16px; border-radius: 18px; cursor: pointer;
    border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-color); }
  button.b.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  button.b:disabled { opacity: 0.5; cursor: default; }
  .med { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .med + .med { margin-top: 10px; }
  .med-name { font-weight: 500; color: var(--primary-text-color); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .chip { font: inherit; font-size: 0.8rem; height: 28px; padding: 0 10px; border-radius: 14px; border: 1px dashed var(--divider-color);
    background: none; color: var(--primary-text-color); display: inline-flex; align-items: center; gap: 4px; }
  button.chip { cursor: pointer; }
  button.chip:hover { border-color: var(--primary-color); color: var(--primary-color); }
  .chip.taken { border-style: solid; border-color: transparent; background: var(--secondary-background-color); }
  .chip.due { border-style: solid; border-color: var(--primary-color); color: var(--primary-color); font-weight: 500; }
  .chip.skipped, .chip.missed { text-decoration: line-through; color: var(--secondary-text-color); }
  .warn { display: inline-block; font-size: 0.8rem; font-weight: 500; padding: 3px 10px; border-radius: 12px; margin-top: 4px;
    background: rgba(var(--rgb-warning-color, 255, 166, 0), 0.18); color: var(--primary-text-color); }
  .warn.danger { background: rgba(var(--rgb-error-color, 219, 68, 55), 0.16); color: var(--error-color); }
  .doctor { color: var(--primary-text-color); margin-bottom: 8px; }
  .doctor strong { font-weight: 500; }
  .muted { color: var(--secondary-text-color); font-size: 0.9rem; }
  .mood { display: flex; align-items: baseline; gap: 6px; color: var(--primary-text-color); }
  .mood b { font-weight: 500; }
`;

const OPEN_ICON = "M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z";

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

function niceTime(hhmm, hass) {
  if (!hhmm) return "";
  const [hr, mi] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(hr, mi, 0, 0);
  const lang = (hass && hass.locale && hass.locale.language) || undefined;
  const fmt = hass && hass.locale && hass.locale.time_format;
  const opts = { hour: "numeric", minute: "2-digit" };
  if (fmt === "12") opts.hour12 = true;
  if (fmt === "24") opts.hour12 = false;
  return d.toLocaleTimeString(lang, opts).replace(":00", "").replace(" ", "").toLowerCase();
}

function qty(q) {
  const v = Number(q);
  const whole = Math.trunc(v);
  const sym = { 0.25: "\u00bc", 0.5: "\u00bd", 0.75: "\u00be" }[Math.round((v - whole) * 100) / 100];
  return sym ? (whole ? whole : "") + sym : String(Math.round(v * 100) / 100);
}

class WellbeingCard extends HTMLElement {
  static getConfigForm() {
    return {
      schema: [
        { name: "entity", selector: { entity: { filter: { integration: "wellbeing_tracker", domain: "sensor" } } } },
        { name: "title", selector: { text: {} } },
        { type: "grid", name: "", schema: [
          { name: "show_doses", selector: { boolean: {} } },
          { name: "show_supply", selector: { boolean: {} } },
          { name: "show_mood", selector: { boolean: {} } },
        ] },
      ],
      computeLabel: (s) => ({
        entity: "Person (leave empty for whoever is signed in)",
        title: "Title",
        show_doses: "Today's medications",
        show_supply: "Supply and doctor",
        show_mood: "Mood",
      })[s.name],
      computeHelper: (s) => (s.name === "entity" ? "Choose someone's \"Reminders waiting\" sensor to always show them." : undefined),
    };
  }

  static getStubConfig() {
    return { show_doses: true, show_supply: true, show_mood: true };
  }

  setConfig(config) {
    this._config = { show_doses: true, show_supply: true, show_mood: true, ...(config || {}) };
    this._skipFor = null;
    this._render(true);
  }

  set hass(hass) {
    this._hass = hass;
    const id = this._entityId();
    const st = id ? hass.states[id] : null;
    if (st !== this._lastState) {
      this._lastState = st;
      this._render();
    }
  }

  getCardSize() {
    const a = (this._lastState && this._lastState.attributes) || {};
    return 2 + (a.inbox || []).length * 2 + (a.doses ? 1 : 0);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  _entityId() {
    if (!this._hass) return null;
    if (this._config && this._config.entity) return this._config.entity;
    const cards = Object.values(this._hass.states).filter((s) => s.attributes && s.attributes.wellbeing_card);
    const mine = cards.find((s) => this._hass.user && s.attributes.user_id === this._hass.user.id);
    return (mine || cards[0] || {}).entity_id || null;
  }

  async _call(service, data, busyEl) {
    if (busyEl) busyEl.disabled = true;
    try {
      await this._hass.callService("wellbeing_tracker", service, data);
    } catch (err) {
      this.dispatchEvent(new CustomEvent("hass-notification", { bubbles: true, composed: true,
        detail: { message: err.message || "Couldn't do that" } }));
      if (busyEl) busyEl.disabled = false;
    }
  }

  _open(path) {
    if (!path) return;
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  _render(force) {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" }).append(h("style", {}, STYLE), h("ha-card"));
    }
    const card = this.shadowRoot.querySelector("ha-card");
    if (!this._hass && !force) return;
    const st = this._lastState;
    const cfg = this._config || {};
    if (!st) {
      card.replaceChildren(h("div", { class: "title" }, cfg.title || "Wellbeing"),
        h("p", { class: "muted" }, "Nothing to show yet. Open the Wellbeing app once, and check the Wellbeing Tracker integration is set up."));
      return;
    }
    const a = st.attributes;
    const parts = [];

    parts.push(h("div", { class: "head" },
      h("div", {}, h("div", { class: "title" }, cfg.title || "Wellbeing"),
        cfg.entity || (this._hass.user && a.user_id !== this._hass.user.id) ? h("div", { class: "who" }, a.person) : null),
      a.panel_path ? h("button", { class: "open", title: "Open Wellbeing", "aria-label": "Open Wellbeing", onclick: () => this._open(a.panel_path) },
        (() => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24");
          const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", OPEN_ICON); s.append(p); return s; })()) : null));

    // ----- waiting for an answer -----
    const waiting = (a.inbox || []).filter((i) => i.kind !== "supply");
    if (waiting.length) {
      parts.push(h("section", {}, h("div", { class: "label" }, "Waiting for you"),
        waiting.map((item) => {
          const skipping = this._skipFor === item.id;
          const buttons = skipping
            ? [...SKIP_REASONS.map((r) => h("button", { class: "b", onclick: (ev) => { this._skipFor = null; this._call("answer_reminder", { reminder_id: item.id, answer: "SKIP", reason: r }, ev.currentTarget); } }, r)),
               h("button", { class: "b", onclick: (ev) => { this._skipFor = null; this._call("answer_reminder", { reminder_id: item.id, answer: "SKIP" }, ev.currentTarget); } }, "No reason"),
               h("button", { class: "b", onclick: () => { this._skipFor = null; this._render(); } }, "Back")]
            : item.actions.map((act, i) => h("button", { class: i === 0 ? "b primary" : "b",
                onclick: (ev) => {
                  if (act.reason) { this._skipFor = item.id; this._render(); return; }
                  this._call("answer_reminder", { reminder_id: item.id, answer: act.verb }, ev.currentTarget);
                } }, act.label));
          return h("div", { class: "item" },
            h("div", { class: "item-title" }, item.title),
            item.message ? h("div", { class: "item-msg" }, item.message) : null,
            item.snoozed_until ? h("div", { class: "item-msg" }, `Snoozed until ${niceTime(item.snoozed_until, this._hass)}`) : null,
            h("div", { class: "buttons" }, buttons));
        })));
    }

    // ----- today's medications -----
    if (cfg.show_doses && (a.doses || []).length) {
      const byMed = new Map();
      for (const d of a.doses) {
        if (!byMed.has(d.tracker_id)) byMed.set(d.tracker_id, { name: d.name, doses: [] });
        byMed.get(d.tracker_id).doses.push(d);
      }
      parts.push(h("section", {}, h("div", { class: "label" }, "Today's medications"),
        [...byMed.values()].map((m) => h("div", { class: "med" },
          h("div", {}, h("div", { class: "med-name" }, m.name),
            h("div", { class: "chips" }, m.doses.map((d) => {
              const text = `${qty(d.quantity)} at ${niceTime(d.time, this._hass)}`;
              if (d.status === "scheduled" || d.status === "due") {
                return h("button", { class: `chip ${d.status}`, title: "Log this dose now",
                  onclick: (ev) => this._call("log_dose", { medication: m.name, quantity: d.quantity, person: a.user_id }, ev.currentTarget) }, text);
              }
              return h("span", { class: `chip ${d.status}` }, text, d.status === "taken" ? " \u2713" : "");
            })))))));
    }

    // ----- supply and doctor -----
    if (cfg.show_supply && ((a.supply || []).length || a.doctor)) {
      const warned = (a.supply || []).filter((s) => (s.alerts || []).length);
      parts.push(h("section", {}, h("div", { class: "label" }, "Supply"),
        a.doctor ? h("div", { class: "doctor" }, h("strong", {}, `See your doctor by ${a.doctor.by_text}`),
          ` for a new ${a.doctor.names.join(" and ")} script.`) : null,
        warned.map((s) => h("div", { class: "med" }, h("div", {}, h("div", { class: "med-name" }, s.name),
          s.alerts.map((al) => h("span", { class: `warn ${al.level}` }, al.text))))),
        !warned.length && !a.doctor ? h("div", { class: "muted" }, "Nothing running low.") : null));
    }

    // ----- mood -----
    if (cfg.show_mood && a.mood) {
      parts.push(h("section", {}, h("div", { class: "mood" }, "Mood today",
        h("b", {}, a.mood.label ? `${a.mood.label} (${a.mood.value})` : `${a.mood.value} of ${a.mood.max}`))));
    }

    if (parts.length === 1) parts.push(h("p", { class: "muted" }, "All done for now."));
    card.replaceChildren(...parts);
  }
}

if (!customElements.get("wellbeing-card")) {
  customElements.define("wellbeing-card", WellbeingCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "wellbeing-card",
    name: "Wellbeing",
    description: "Reminders waiting, today's medications, supply and when to see the doctor.",
    preview: true,
    documentationURL: "https://github.com/mpoppell/ha-wellbeing-tracker",
  });
}
