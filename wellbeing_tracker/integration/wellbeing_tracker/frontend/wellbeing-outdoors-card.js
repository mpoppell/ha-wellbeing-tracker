// Outdoors card: what the weather means for today, at a glance.
// A heads-up strip calls out only what needs action (warnings, fire danger, strong UV, rain,
// pollen, cold, heat), then: now and today's range, rain chance for the next 12 hours,
// UV / pollen / fire danger on labelled scales, and the next few days on one shared scale.
// Alert levels can be numbers or helpers (input_number), so automations can share them.
// Added to dashboards automatically by the Wellbeing Tracker integration. ASCII only on purpose.

const SHOW = {
  callouts: "Heads-up",
  now: "Now and today",
  hourly: "Rain, next 12 hours",
  scales: "UV, pollen and fire danger",
  days: "Next days",
};
const DEFAULT_SHOW = Object.keys(SHOW);
const ALERTS = {
  rain_alert: { def: 60, helper: "input_number.outdoors_alert_rain_chance" },
  uv_alert: { def: 8, helper: "input_number.outdoors_alert_uv_index" },
  pollen_alert: { def: 3, helper: "input_number.outdoors_alert_pollen_level" },
  cold_alert: { def: 10, helper: "input_number.outdoors_alert_cold_below" },
  heat_alert: { def: 35, helper: "input_number.outdoors_alert_hot_from" },
};
const EVENING = 18; // from 6pm the heads-up looks at tomorrow
const DEG = "\u00b0";
const DASH = "\u2013";
const DOT = " \u00b7 ";

const CONDITIONS = {
  "clear-night": ["Clear", "mdi:weather-night"],
  cloudy: ["Cloudy", "mdi:weather-cloudy"],
  exceptional: ["Unusual weather", "mdi:alert-circle-outline"],
  fog: ["Fog", "mdi:weather-fog"],
  hail: ["Hail", "mdi:weather-hail"],
  lightning: ["Thunder", "mdi:weather-lightning"],
  "lightning-rainy": ["Storms", "mdi:weather-lightning-rainy"],
  partlycloudy: ["Partly cloudy", "mdi:weather-partly-cloudy"],
  pouring: ["Heavy rain", "mdi:weather-pouring"],
  rainy: ["Showers", "mdi:weather-rainy"],
  snowy: ["Snow", "mdi:weather-snowy"],
  "snowy-rainy": ["Sleet", "mdi:weather-snowy-rainy"],
  sunny: ["Sunny", "mdi:weather-sunny"],
  windy: ["Windy", "mdi:weather-windy"],
  "windy-variant": ["Windy", "mdi:weather-windy-variant"],
};

// One ramp, low to high, used by every risk scale. Text never uses these colours.
const UV_LEVELS = [
  { max: 2, word: "Low" }, { max: 5, word: "Moderate" }, { max: 7, word: "High" },
  { max: 10, word: "Very high" }, { max: Infinity, word: "Extreme" }];
const POLLEN_WORDS = ["None", "Very low", "Low", "Moderate", "High", "Very high"];
// Australian Fire Danger Rating System: rating -> [scale step 1-4, ramp colour, what to do]
const FIRE = {
  "no rating": [0, 0, "No rating today"],
  moderate: [1, 1, "Plan and prepare"],
  high: [2, 3, "Be ready to act"],
  extreme: [3, 4, "Take action now to protect your life and property"],
  catastrophic: [4, 5, "For your survival, leave bush fire risk areas"],
};

const STYLE = `
  :host { display: block; --wb-risk-1: #43a047; --wb-risk-2: #c0ca33; --wb-risk-3: #fdd835; --wb-risk-4: #fb8c00; --wb-risk-5: #e53935; }
  :host([hidden]) { display: none; }
  ha-card { padding: 16px; }
  .body { display: flex; flex-direction: column; gap: 20px; }
  ha-card.plain { background: none; border: none; box-shadow: none; padding: 0; }
  .title { font-size: var(--ha-card-header-font-size, 1.25rem); font-weight: 500; line-height: 1.3; color: var(--ha-card-header-color, var(--primary-text-color)); margin: 0; }
  .label { font-size: 0.8rem; font-weight: 500; letter-spacing: 0.02em; color: var(--secondary-text-color); margin: 0 0 8px; }
  .muted { color: var(--secondary-text-color); font-size: 0.9rem; margin: 0; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  ha-icon { --mdc-icon-size: 22px; color: var(--secondary-text-color); flex: none; }

  /* heads-up */
  .callouts { display: flex; flex-direction: column; gap: 8px; }
  .callout { display: flex; gap: 12px; align-items: flex-start; text-align: start; width: 100%; font: inherit; color: var(--primary-text-color);
    padding: 10px 12px; border-radius: 12px; border: 0; border-inline-start: 4px solid var(--info-color, #039be5);
    background: rgba(var(--rgb-info-color, 3, 155, 229), 0.12); }
  button.callout { cursor: pointer; }
  button.callout:focus-visible, button.chip:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .callout.warn { border-inline-start-color: var(--warning-color, #ffa600); background: rgba(var(--rgb-warning-color, 255, 166, 0), 0.16); }
  .callout.danger { border-inline-start-color: var(--error-color, #db4437); background: rgba(var(--rgb-error-color, 219, 68, 55), 0.14); }
  .callout ha-icon { color: var(--info-color, #039be5); margin-top: 1px; }
  .callout.warn ha-icon { color: var(--warning-color, #ffa600); }
  .callout.danger ha-icon { color: var(--error-color, #db4437); }
  .c-title { font-weight: 600; line-height: 1.3; }
  .c-detail { font-size: 0.875rem; color: var(--primary-text-color); margin-top: 2px; line-height: 1.35; }
  .ahead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .ahead .label { margin: 0 4px 0 0; }
  .chip { font: inherit; font-size: 0.8rem; min-height: 28px; padding: 0 10px; border-radius: 14px; border: 1px solid var(--divider-color);
    background: none; color: var(--primary-text-color); display: inline-flex; align-items: center; gap: 6px; }
  button.chip { cursor: pointer; }
  .chip ha-icon { --mdc-icon-size: 16px; }
  .quiet { display: flex; gap: 8px; align-items: center; }
  .quiet ha-icon { color: var(--success-color, #43a047); }

  /* now */
  .now { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; align-items: center; }
  .now > ha-icon { --mdc-icon-size: 44px; color: var(--primary-text-color); grid-row: span 2; }
  .temp { font-size: 2.25rem; font-weight: 400; line-height: 1; color: var(--primary-text-color); }
  .temp small { font-size: 0.9rem; color: var(--secondary-text-color); margin-inline-start: 8px; font-weight: 400; }
  .cond { color: var(--secondary-text-color); font-size: 0.9rem; }
  .range { grid-column: 1 / -1; display: grid; grid-template-columns: 3ch 1fr 3ch; gap: 8px; align-items: center; margin-top: 8px; }
  .range .lo, .range .hi { font-variant-numeric: tabular-nums; color: var(--primary-text-color); font-size: 0.9rem; }
  .range .hi { text-align: end; }
  .track { position: relative; height: 8px; border-radius: 4px; background: var(--secondary-background-color); }
  .fill { position: absolute; top: 0; bottom: 0; border-radius: 4px; }
  .mark { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
    background: var(--primary-text-color); box-shadow: 0 0 0 2px var(--card-background-color, #fff); }
  .range-note { grid-column: 1 / -1; font-size: 0.8rem; color: var(--secondary-text-color); }

  /* rain next 12 hours */
  .bars { position: relative; margin-top: 22px; display: flex; align-items: flex-end; gap: 2px; height: 64px; border-bottom: 1px solid var(--divider-color); }
  .bars .col { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; position: relative; }
  .bars .bar { width: 100%; max-width: 22px; border-radius: 4px 4px 0 0; box-sizing: border-box; border: 1.5px solid var(--info-color, #039be5); border-bottom: 0; background: rgba(var(--rgb-info-color, 3, 155, 229), 0.15); }
  .bars .bar.wet { background: var(--info-color, #039be5); }
  .bars .val { position: absolute; font-size: 0.75rem; font-weight: 600; color: var(--primary-text-color); transform: translateY(-100%); padding-bottom: 2px; }
  .bars .line { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--secondary-text-color); pointer-events: none; }
  .hours { display: flex; gap: 2px; margin-top: 4px; }
  .hours span { flex: 1; font-size: 0.75rem; color: var(--secondary-text-color); text-align: center; white-space: nowrap; }
  .chart-note { font-size: 0.75rem; color: var(--secondary-text-color); margin-top: 6px; }

  /* scales */
  .scales { display: grid; grid-template-columns: auto 1fr; gap: 10px 12px; align-items: center; }
  .scale-name { display: flex; align-items: center; gap: 6px; font-size: 0.9rem; color: var(--primary-text-color); }
  .scale-name ha-icon { --mdc-icon-size: 18px; }
  .steps { display: flex; gap: 2px; margin-bottom: 4px; }
  .steps i { flex: 1; height: 8px; background: var(--secondary-background-color); }
  .steps i:first-child { border-radius: 4px 0 0 4px; }
  .steps i:last-child { border-radius: 0 4px 4px 0; }
  .s-text { font-size: 0.875rem; color: var(--primary-text-color); }
  .s-text b { font-weight: 600; }
  .s-text span { color: var(--secondary-text-color); }

  /* days */
  .days { list-style: none; margin: 0; padding: 0; }
  .day { display: grid; grid-template-columns: 5.5em 24px 3.6em 1fr; gap: 8px; align-items: center; padding: 6px 0; }
  .day + .day { border-top: 1px solid var(--divider-color); }
  .day .name { font-size: 0.9rem; color: var(--primary-text-color); }
  .day ha-icon { --mdc-icon-size: 22px; }
  .rain { font-size: 0.8rem; color: var(--secondary-text-color); line-height: 1.15; font-variant-numeric: tabular-nums; }
  .rain.wet { color: var(--primary-text-color); font-weight: 600; }
  .rain .mm { display: block; font-weight: 400; color: var(--secondary-text-color); }
  .day .range { margin: 0; grid-column: auto; grid-template-columns: 3ch 1fr 3ch; }
  .day .hot { font-weight: 600; }
  .day .cold { font-weight: 600; }
  @media (forced-colors: active) { .fill, .bars .bar, .steps i.on { background: CanvasText !important; } .callout { border: 1px solid CanvasText; } }
`;

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
const icon = (name) => h("ha-icon", { icon: name, "aria-hidden": "true" });
const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const round = (v) => (v == null ? null : Math.round(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Cool blue to hot red by temperature, for range bars. Numbers always sit beside the bars.
const TEMP_STOPS = [[-5, [79, 195, 247]], [8, [77, 182, 172]], [16, [174, 213, 129]], [22, [255, 213, 79]],
  [28, [255, 183, 77]], [34, [255, 112, 67]], [42, [229, 57, 53]]];
function tempColour(t) {
  if (t == null) return "var(--secondary-text-color)";
  const s = TEMP_STOPS;
  if (t <= s[0][0]) return `rgb(${s[0][1]})`;
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i][0]) {
      const f = (t - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      return `rgb(${s[i - 1][1].map((c, j) => Math.round(c + (s[i][1][j] - c) * f)).join(",")})`;
    }
  }
  return `rgb(${s[s.length - 1][1]})`;
}

function stepsBar(on, total, colourFor) {
  return h("div", { class: "steps", "aria-hidden": "true" },
    Array.from({ length: total }, (_, i) => h("i", { class: i < on ? "on" : null, style: i < on ? `background:${colourFor(i)}` : null })));
}

// Fill in anything the config leaves out from what this Home Assistant has.
function detect(hass, cfg) {
  const c = { ...cfg };
  const states = (hass && hass.states) || {};
  const ids = Object.keys(states);
  const find = (re, pred) => ids.find((id) => re.test(id) && (!pred || pred(states[id])));
  const sibling = (id, from, to) => {
    if (!id || !from.test(id)) return undefined;
    const s = id.replace(from, to);
    return states[s] ? s : undefined;
  };
  if (!c.entity) c.entity = find(/^weather\./, (s) => !/hourly/.test(s.entity_id)) || find(/^weather\./);
  if (!c.hourly_entity && c.entity) {
    const feat = Number((states[c.entity] && states[c.entity].attributes.supported_features) || 0);
    c.hourly_entity = states[`${c.entity}_hourly`] ? `${c.entity}_hourly` : (feat & 2 ? c.entity : find(/^weather\..*hourly/));
  }
  if (!c.uv_entity) c.uv_entity = find(/^sensor\..*uv_max_index_0$/);
  if (!c.uv_start_entity) c.uv_start_entity = sibling(c.uv_entity, /uv_max_index_0$/, "uv_start_time_0");
  if (!c.uv_end_entity) c.uv_end_entity = sibling(c.uv_entity, /uv_max_index_0$/, "uv_end_time_0");
  if (!c.fire_entity) c.fire_entity = find(/^sensor\..*fire_danger_0$/);
  if (!c.warnings_entity) c.warnings_entity = find(/^sensor\..*_warnings$/, (s) => Array.isArray(s.attributes.warnings));
  if (!c.pollen_entity) c.pollen_entity = find(/^sensor\..*pollen.*overall.*today$/) || find(/^sensor\..*pollen.*overall/);
  for (const [key, a] of Object.entries(ALERTS)) if (c[key] == null && states[a.helper]) c[key] = a.helper;
  return c;
}

function normalise(config) {
  const c = { style: "default", days: 6, hide_when_quiet: false, ...(config || {}) };
  if (!Array.isArray(c.show) || !c.show.length) c.show = DEFAULT_SHOW.slice();
  c.show = c.show.filter((s) => SHOW[s]);
  c.days = clamp(Number(c.days) || 6, 2, 7);
  return c;
}

class WellbeingOutdoorsCard extends HTMLElement {
  static getConfigForm() {
    const ent = (domain) => ({ entity: { filter: { domain } } });
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "entity", selector: ent("weather") },
        { name: "show", selector: { select: { multiple: true, reorder: true,
          options: Object.entries(SHOW).map(([value, label]) => ({ value, label })) } } },
        { type: "grid", name: "", schema: [
          { name: "days", selector: { number: { min: 2, max: 7, mode: "box" } } },
          { name: "style", selector: { select: { mode: "dropdown", options: [
            { value: "default", label: "Home Assistant" },
            { value: "plain", label: "No background (inside pop-ups and stacks)" }] } } },
        ] },
        { name: "hide_when_quiet", selector: { boolean: {} } },
        { type: "expandable", name: "", flatten: true, title: "Alert levels", icon: "mdi:bell-alert-outline", schema: [
          { name: "rain_alert", selector: ent(["input_number", "number"]) },
          { name: "uv_alert", selector: ent(["input_number", "number"]) },
          { name: "pollen_alert", selector: ent(["input_number", "number"]) },
          { name: "cold_alert", selector: ent(["input_number", "number"]) },
          { name: "heat_alert", selector: ent(["input_number", "number"]) },
        ] },
        { type: "expandable", name: "", flatten: true, title: "Where the information comes from", icon: "mdi:database-outline", schema: [
          { name: "hourly_entity", selector: ent("weather") },
          { name: "temperature_entity", selector: ent("sensor") },
          { name: "uv_entity", selector: ent("sensor") },
          { name: "uv_start_entity", selector: ent("sensor") },
          { name: "uv_end_entity", selector: ent("sensor") },
          { name: "pollen_entity", selector: ent("sensor") },
          { name: "fire_entity", selector: ent("sensor") },
          { name: "warnings_entity", selector: ent("sensor") },
        ] },
      ],
      computeLabel: (s) => ({
        title: "Title",
        entity: "Weather",
        show: "What to show, in order",
        days: "Days ahead",
        style: "Style",
        hide_when_quiet: "Hide the card on quiet days",
        rain_alert: "Rain chance",
        uv_alert: "UV index",
        pollen_alert: "Pollen level (0 to 5)",
        cold_alert: "Cold below",
        heat_alert: "Hot from",
        hourly_entity: "Hourly forecast",
        temperature_entity: "Current temperature",
        uv_entity: "Today's highest UV",
        uv_start_entity: "Sun protection from",
        uv_end_entity: "Sun protection until",
        pollen_entity: "Pollen today",
        fire_entity: "Fire danger today",
        warnings_entity: "Weather warnings",
      })[s.name],
      computeHelper: (s) => ({
        entity: "Leave empty to use the first weather in Home Assistant.",
        show: "Drag to reorder. Leave empty for all of them.",
        hide_when_quiet: "Use with only Heads-up shown, at the top of a dashboard.",
        rain_alert: `Call it out at or above this. Choose a helper, or leave empty for ${ALERTS.rain_alert.def}%.`,
        uv_alert: `Leave empty for ${ALERTS.uv_alert.def} (very high).`,
        pollen_alert: `Leave empty for ${ALERTS.pollen_alert.def} (moderate).`,
        cold_alert: `Leave empty for ${ALERTS.cold_alert.def}${DEG}.`,
        heat_alert: `Leave empty for ${ALERTS.heat_alert.def}${DEG}.`,
        hourly_entity: "Leave these empty to find them automatically.",
        temperature_entity: "A nearby thermometer. Otherwise the weather's own.",
      })[s.name],
    };
  }

  static getStubConfig(hass) {
    const found = detect(hass, {});
    return found.entity ? { entity: found.entity } : {};
  }

  constructor() {
    super();
    this._fc = { daily: null, hourly: null };
    this._subs = [];
  }

  setConfig(config) {
    this._raw = normalise(config);
    this._config = null;
    this._subKey = null;
    this._built = false;
    if (this._hass) this.hass = this._hass;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._raw) return;
    if (!this._config) this._config = detect(hass, this._raw);
    this._subscribe();
    const watched = this._watched().map((id) => hass.states[id]);
    if (!this._lastStates || watched.some((s, i) => s !== this._lastStates[i])) {
      this._lastStates = watched;
      this._render();
    }
  }

  set preview(v) { this._preview = !!v; this._render(); }
  set editMode(v) { this._editMode = !!v; this._render(); }

  getCardSize() { return 2 + this._raw.show.length * 2; }
  getGridOptions() { return { columns: 12, min_columns: 6, rows: "auto" }; }

  connectedCallback() {
    this._subscribe();
    this._tick = setInterval(() => this._render(), 5 * 60 * 1000);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    this._unsubscribe();
  }

  _watched() {
    const c = this._config || {};
    const ids = [c.entity, c.temperature_entity, c.uv_entity, c.uv_start_entity, c.uv_end_entity, c.pollen_entity,
      c.fire_entity, c.warnings_entity];
    for (const k of Object.keys(ALERTS)) if (typeof c[k] === "string") ids.push(c[k]);
    for (let i = 1; i < 7; i++) ids.push(this._fireId(i));
    return ids.filter(Boolean);
  }

  _fireId(i) {
    const f = this._config && this._config.fire_entity;
    return f && /_0$/.test(f) ? f.replace(/_0$/, `_${i}`) : null;
  }

  _unsubscribe() {
    for (const p of this._subs) p.then((un) => un && un()).catch(() => {});
    this._subs = [];
    this._subKey = null;
  }

  _subscribe() {
    const hass = this._hass;
    const c = this._config;
    if (!hass || !c || !this.isConnected || !hass.connection) return;
    const want = [["daily", c.entity], ["hourly", c.hourly_entity]].filter(([, id]) => id && hass.states[id]);
    const key = JSON.stringify(want);
    if (key === this._subKey) return;
    this._unsubscribe();
    this._subKey = key;
    this._fc = { daily: null, hourly: null };
    for (const [type, entity] of want) {
      const p = hass.connection.subscribeMessage((msg) => {
        this._fc[type] = (msg && msg.forecast) || [];
        this._render();
      }, { type: "weather/subscribe_forecast", forecast_type: type, entity_id: entity });
      p.catch(() => { this._fc[type] = []; this._render(); });
      this._subs.push(p);
    }
  }

  // ----- time, in Home Assistant's time zone when the profile asks for it -----
  _tz() {
    const hs = this._hass;
    return hs && hs.locale && hs.locale.time_zone === "server" && hs.config ? hs.config.time_zone : undefined;
  }
  _lang() { return (this._hass && this._hass.locale && this._hass.locale.language) || undefined; }
  _dayKey(d) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this._tz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  _hour(d) {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: this._tz(), hour: "2-digit", hourCycle: "h23" }).format(d));
  }
  _time(d, short) {
    const fmt = this._hass && this._hass.locale && this._hass.locale.time_format;
    const opts = { hour: "numeric", minute: "2-digit", timeZone: this._tz() };
    if (fmt === "12") opts.hour12 = true;
    if (fmt === "24") opts.hour12 = false;
    let s = d.toLocaleTimeString(this._lang(), opts).replace(/\s/g, "").toLowerCase();
    if (short) s = s.replace(":00", "");
    return s;
  }
  _weekday(d, long) { return d.toLocaleDateString(this._lang(), { weekday: long ? "long" : "short", timeZone: this._tz() }); }

  _alert(key) {
    const v = this._config[key];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const st = this._hass.states[v];
      const n = st ? num(st.state) : num(v);
      if (n != null) return n;
    }
    return ALERTS[key].def;
  }

  _condition(state) {
    const known = CONDITIONS[state];
    const loc = this._hass && this._hass.localize && this._hass.localize(`component.weather.entity_component._.state.${state}`);
    return { word: loc || (known ? known[0] : state || ""), icon: known ? known[1] : "mdi:weather-cloudy" };
  }

  _more(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  // ----- reading the sources -----
  _model() {
    const hass = this._hass;
    const c = this._config;
    const now = new Date();
    const today = this._dayKey(now);
    const w = hass.states[c.entity];
    const days = (this._fc.daily || [])
      .map((f) => ({ ...f, date: new Date(f.datetime) }))
      .filter((f) => num(f.temperature) != null) // BOM pads the end with half-empty days
      .map((f) => ({ ...f, key: this._dayKey(f.date), high: num(f.temperature), low: num(f.templow),
        rain: num(f.precipitation_probability), mm: num(f.precipitation) }))
      .filter((f) => f.key >= today);
    const hours = (this._fc.hourly || [])
      .map((f) => ({ ...f, date: new Date(f.datetime) }))
      .filter((f) => f.date.getTime() > now.getTime() - 60 * 60 * 1000)
      .map((f) => ({ ...f, key: this._dayKey(f.date), rain: num(f.precipitation_probability), uv: num(f.uv_index), t: num(f.temperature) }));
    const t = c.temperature_entity && hass.states[c.temperature_entity] ? num(hass.states[c.temperature_entity].state)
      : w ? num(w.attributes.temperature) : null;
    const todayFc = days.find((d) => d.key === today) || null;
    const todayHours = hours.filter((x) => x.key === today);

    // highs and lows: hourly fills gaps once part of the day has gone
    let high = todayFc ? todayFc.high : null;
    let low = todayFc ? todayFc.low : null;
    const temps = todayHours.map((x) => x.t).filter((v) => v != null);
    if (t != null) temps.push(t);
    if (high == null && temps.length) high = Math.max(...temps);
    if (low == null && temps.length) low = Math.min(...temps);
    const peak = todayHours.filter((x) => x.t != null && x.date > now).sort((a, b) => b.t - a.t)[0];

    return { now, today, w, days, hours, t, todayFc, todayHours, high, low, peak,
      uv: this._uv(now, today, todayHours), pollen: (key) => this._pollen(key, today), fire: (i) => this._fire(i) };
  }

  _uv(now, today, todayHours) {
    const hass = this._hass;
    const c = this._config;
    const st = c.uv_entity && hass.states[c.uv_entity];
    const fresh = (s) => s && (!s.attributes.date || this._dayKey(new Date(s.attributes.date)) === today);
    let max = fresh(st) ? num(st.state) : null;
    const hourly = todayHours.filter((x) => x.uv != null);
    if (max == null && hourly.length) max = Math.max(...hourly.map((x) => x.uv));
    if (max == null) return null;
    const time = (id) => {
      const s = id && hass.states[id];
      if (!fresh(s)) return null;
      const d = new Date(s.state);
      return isNaN(d) ? null : d;
    };
    let from = time(c.uv_start_entity);
    let until = time(c.uv_end_entity);
    if ((!from || !until) && hourly.length) {
      const strong = hourly.filter((x) => x.uv >= 3);
      if (strong.length) {
        from = from || strong[0].date;
        until = until || new Date(strong[strong.length - 1].date.getTime() + 60 * 60 * 1000);
      }
    }
    const level = UV_LEVELS.findIndex((l) => max <= l.max) + 1;
    return { max, level, word: UV_LEVELS[level - 1].word, from, until, entity: st ? c.uv_entity : null };
  }

  // Google's "today" can lag a day overnight; its forecast list has the right date.
  _pollen(key, today) {
    const c = this._config;
    const st = c.pollen_entity && this._hass.states[c.pollen_entity];
    if (!st) return null;
    const a = st.attributes;
    const fc = (a.forecast || []).find((f) => f.date === key);
    const pick = fc ? { value: num(fc.value), category: fc.category, names: fc.top_pollen_names || [] }
      : key === today ? { value: num(st.state), category: a.category, names: a.top_pollen_names || [] } : null;
    if (!pick || pick.value == null) return null;
    pick.word = pick.category || POLLEN_WORDS[clamp(Math.round(pick.value), 0, 5)];
    return pick;
  }

  _fire(i) {
    const id = i === 0 ? this._config.fire_entity : this._fireId(i);
    const st = id && this._hass.states[id];
    if (!st || !st.state || ["unknown", "unavailable"].includes(st.state)) return null;
    const f = FIRE[st.state.toLowerCase()];
    if (!f) return null;
    return { rating: st.state, step: f[0], ramp: f[1], action: f[2], entity: id };
  }

  // ----- heads-up: only what needs doing something -----
  _headsUp(m) {
    const c = this._config;
    const rainAt = this._alert("rain_alert");
    const uvAt = this._alert("uv_alert");
    const pollenAt = this._alert("pollen_alert");
    const coldAt = this._alert("cold_alert");
    const hotAt = this._alert("heat_alert");
    const hour = this._hour(m.now);
    const evening = hour >= EVENING;
    const callouts = [];
    const add = (o) => callouts.push(o);

    // Bureau warnings first: they're the most serious and come with their own advice
    const ws = c.warnings_entity && this._hass.states[c.warnings_entity];
    for (const w of (ws && ws.attributes.warnings) || []) {
      if (/cancel/i.test(w.phase || "") || (w.expiry_time && new Date(w.expiry_time) < m.now)) continue;
      add({ level: w.warning_group_type === "major" ? "danger" : "warn", icon: "mdi:alert", entity: c.warnings_entity,
        title: w.title || w.short_title || w.type || "Weather warning",
        detail: w.expiry_time ? `Until ${this._time(new Date(w.expiry_time), true)}. Check the Bureau for what to do.` : "Check the Bureau for what to do." });
    }

    const fire0 = m.fire(0);
    if (fire0 && fire0.step >= 2 && !evening) {
      add({ level: fire0.step >= 3 ? "danger" : "warn", icon: "mdi:fire-alert", entity: fire0.entity,
        title: `${fire0.rating} fire danger today`, detail: `${fire0.action}.` });
    }

    // rain: soon beats later today
    const soon = m.hours.filter((x) => x.date > new Date(m.now.getTime() - 30 * 60 * 1000) && x.date <= new Date(m.now.getTime() + 3 * 60 * 60 * 1000));
    const wet = soon.find((x) => x.rain != null && x.rain >= rainAt);
    const mm = m.todayFc && m.todayFc.mm ? `, up to ${m.todayFc.mm} mm today` : "";
    if (wet) {
      const startsNow = wet.date <= new Date(m.now.getTime() + 30 * 60 * 1000);
      add({ level: "info", icon: "mdi:umbrella", entity: c.entity,
        title: startsNow ? "Rain likely now" : `Rain likely from ${this._time(wet.date, true)}`,
        detail: `${Math.max(...soon.map((x) => x.rain || 0))}% chance${mm}. Take an umbrella.` });
    } else if (!evening && m.todayFc && m.todayFc.rain != null && m.todayFc.rain >= rainAt) {
      const later = m.todayHours.find((x) => x.date > m.now && x.rain != null && x.rain >= rainAt);
      if (later || !m.todayHours.length) {
        add({ level: "info", icon: "mdi:umbrella", entity: c.entity,
          title: later ? `Rain likely from ${this._time(later.date, true)}` : "Rain likely today",
          detail: `${m.todayFc.rain}% chance${mm}. Take an umbrella.` });
      }
    }

    const uv = m.uv;
    if (uv && uv.max >= uvAt && !evening && (!uv.until || m.now < uv.until)) {
      const window = uv.from && uv.until
        ? (m.now >= uv.from ? `until ${this._time(uv.until, true)}` : `${this._time(uv.from, true)} to ${this._time(uv.until, true)}`)
        : "today";
      add({ level: uv.level >= 5 ? "danger" : "warn", icon: "mdi:weather-sunny-alert", entity: uv.entity,
        title: `${uv.word} UV ${DASH} ${round(uv.max)} at its peak`,
        detail: `Sun protection ${window}: hat, sunscreen and shade.` });
    }

    const p0 = m.pollen(m.today);
    if (p0 && p0.value >= pollenAt && !evening) {
      add({ level: p0.value >= 5 ? "danger" : "warn", icon: "mdi:flower-pollen", entity: c.pollen_entity,
        title: `${p0.word} pollen today${p0.names.length ? ` ${DASH} ${p0.names.join(" and ").toLowerCase()}` : ""}`,
        detail: "Consider an antihistamine before going out." });
    }

    if (m.high != null && m.high >= hotAt && !evening) {
      add({ level: m.high >= hotAt + 5 ? "danger" : "warn", icon: "mdi:thermometer-high", entity: c.entity,
        title: `Hot ${DASH} up to ${round(m.high)}${DEG}${m.peak && m.peak.t >= hotAt ? ` around ${this._time(m.peak.date, true)}` : ""}`,
        detail: "Drink water, find shade and check on others." });
    }
    if (m.low != null && m.low < coldAt && hour < 11) {
      add({ level: "info", icon: "mdi:snowflake-thermometer", entity: c.entity,
        title: `Cold morning ${DASH} low of ${round(m.low)}${DEG}`,
        detail: m.high != null ? `Up to ${round(m.high)}${DEG} later. Dress in layers.` : "Dress in layers." });
    }

    // In the evening, tomorrow's needs become today's heads-up (lay things out tonight)
    const tomorrow = m.days.find((d) => d.key > m.today);
    if (evening && tomorrow) {
      const f1 = m.fire(1);
      if (f1 && f1.step >= 2) add({ level: f1.step >= 3 ? "danger" : "warn", icon: "mdi:fire-alert", entity: f1.entity,
        title: `${f1.rating} fire danger tomorrow`, detail: `${f1.action}.` });
      if (tomorrow.rain != null && tomorrow.rain >= rainAt) add({ level: "info", icon: "mdi:umbrella", entity: c.entity,
        title: "Rain likely tomorrow", detail: `${tomorrow.rain}% chance${tomorrow.mm ? `, up to ${tomorrow.mm} mm` : ""}. Leave an umbrella by the door.` });
      if (tomorrow.high != null && tomorrow.high >= hotAt) add({ level: tomorrow.high >= hotAt + 5 ? "danger" : "warn", icon: "mdi:thermometer-high", entity: c.entity,
        title: `Hot tomorrow ${DASH} up to ${round(tomorrow.high)}${DEG}`, detail: "Plan to stay cool and keep water handy." });
      if (tomorrow.low != null && tomorrow.low < coldAt) add({ level: "info", icon: "mdi:snowflake-thermometer", entity: c.entity,
        title: `Cold start tomorrow ${DASH} low of ${round(tomorrow.low)}${DEG}`, detail: "Lay out warm layers tonight." });
      const p1 = m.pollen(tomorrow.key);
      if (p1 && p1.value >= pollenAt) add({ level: "warn", icon: "mdi:flower-pollen", entity: c.pollen_entity,
        title: `${p1.word} pollen tomorrow`, detail: "Take an antihistamine in the morning if it helps you." });
    }

    const rank = { danger: 0, warn: 1, info: 2 };
    callouts.sort((a, b) => rank[a.level] - rank[b.level]);
    const more = callouts.splice(3);

    // Plan ahead: one chip per kind, earliest day first, at most three
    const chips = [];
    const seen = new Set(callouts.concat(more).map((x) => x.icon));
    const later = m.days.filter((d) => d.key > m.today).slice(evening ? 1 : 0, 5);
    later.forEach((d) => {
      const i = m.days.indexOf(d);
      const label = i === 1 ? "Tomorrow" : this._weekday(d.date);
      const fire = m.fire(i);
      const pol = m.pollen(d.key);
      const opts = [
        fire && fire.step >= 2 && ["mdi:fire-alert", `${label}${DOT}Fire danger ${fire.rating.toLowerCase()}`, fire.entity],
        d.rain != null && d.rain >= rainAt && ["mdi:umbrella", `${label}${DOT}Rain ${d.rain}%`, c.entity],
        d.high != null && d.high >= hotAt && ["mdi:thermometer-high", `${label}${DOT}Hot ${round(d.high)}${DEG}`, c.entity],
        d.low != null && d.low < coldAt && ["mdi:snowflake-thermometer", `${label}${DOT}Cold ${round(d.low)}${DEG}`, c.entity],
        pol && pol.value >= pollenAt && ["mdi:flower-pollen", `${label}${DOT}Pollen ${pol.word.toLowerCase()}`, c.pollen_entity],
      ];
      for (const o of opts) {
        if (o && !seen.has(o[0]) && chips.length < 3) { seen.add(o[0]); chips.push({ icon: o[0], text: o[1], entity: o[2] }); }
      }
    });
    return { callouts, more, chips };
  }

  // ----- sections -----
  _sectionCallouts(m, hu) {
    const box = h("div", { class: "callouts", role: "region", "aria-label": "Heads-up" });
    if (!hu.callouts.length) {
      box.append(h("div", { class: "quiet" }, icon("mdi:check-circle-outline"),
        h("p", { class: "muted" }, this._hour(m.now) >= EVENING ? "Nothing to plan for tomorrow." : "Nothing to watch for today.")));
    }
    for (const co of hu.callouts) {
      const body = [icon(co.icon), h("div", {}, h("div", { class: "c-title" }, co.title), h("div", { class: "c-detail" }, co.detail))];
      const levelWord = h("span", { class: "sr" }, co.level === "danger" ? "Warning: " : co.level === "warn" ? "Take care: " : "Heads-up: ");
      box.append(co.entity
        ? h("button", { class: `callout ${co.level}`, type: "button", onclick: () => this._more(co.entity) }, levelWord, ...body)
        : h("div", { class: `callout ${co.level}` }, levelWord, ...body));
    }
    if (hu.more.length) {
      box.append(h("div", { class: "ahead" }, h("p", { class: "label" }, "Also"),
        hu.more.map((co) => h("button", { class: "chip", type: "button", onclick: () => this._more(co.entity) }, icon(co.icon), co.title))));
    }
    if (hu.chips.length) {
      box.append(h("div", { class: "ahead" }, h("p", { class: "label" }, "Coming up"),
        hu.chips.map((ch) => h("button", { class: "chip", type: "button", onclick: () => this._more(ch.entity) }, icon(ch.icon), ch.text))));
    }
    return box;
  }

  _rangeBar(low, high, lo, hi, mark) {
    const pos = (v) => ((v - lo) / (hi - lo || 1)) * 100;
    const a = clamp(pos(low), 0, 100);
    const b = clamp(pos(high), 0, 100);
    return h("div", { class: "track", "aria-hidden": "true" },
      h("div", { class: "fill", style: `left:${a}%;width:${Math.max(b - a, 2)}%;background:linear-gradient(to right, ${tempColour(low)}, ${tempColour(high)})` }),
      mark != null ? h("div", { class: "mark", style: `left:${clamp(pos(mark), 0, 100)}%` }) : null);
  }

  _sectionNow(m) {
    const cond = this._condition(m.w && m.w.state);
    const rows = [icon(cond.icon),
      h("div", { class: "temp" }, m.t != null ? `${round(m.t)}${DEG}` : DASH),
      h("div", { class: "cond" }, cond.word)];
    if (m.low != null && m.high != null) {
      const lo = Math.min(m.low, m.t != null ? m.t : m.low);
      const hi = Math.max(m.high, m.t != null ? m.t : m.high);
      const warm = m.peak && m.peak.t >= m.high - 1 ? `Warmest around ${this._time(m.peak.date, true)}` : "";
      rows.push(h("div", { class: "range" },
        h("span", { class: "lo" }, `${round(lo)}${DEG}`), this._rangeBar(m.low, m.high, lo, hi, m.t), h("span", { class: "hi" }, `${round(hi)}${DEG}`)),
      h("div", { class: "range-note" }, h("span", { class: "sr" }, `Today ${round(m.low)} to ${round(m.high)} degrees. `), warm));
    }
    return h("div", { class: "now" }, ...rows);
  }

  _sectionHourly(m) {
    const rainAt = this._alert("rain_alert");
    const start = m.hours.filter((x) => x.date > new Date(m.now.getTime() - 60 * 60 * 1000)).slice(0, 12);
    if (!start.length || start.every((x) => x.rain == null)) return null;
    const peak = start.reduce((a, b) => ((b.rain || 0) > (a.rain || 0) ? b : a), start[0]);
    const wrap = h("div", {}, h("p", { class: "label" }, SHOW.hourly));
    if ((peak.rain || 0) < 10) {
      wrap.append(h("p", { class: "muted" }, "No rain expected."));
      return wrap;
    }
    const bars = h("div", { class: "bars", "aria-hidden": "true" },
      h("div", { class: "line", style: `bottom:${rainAt}%` }),
      start.map((x) => h("div", { class: "col", title: `${this._time(x.date, true)}: ${x.rain || 0}%` },
        x === peak ? h("span", { class: "val", style: `bottom:${Math.max(x.rain, 4)}%` }, `${x.rain}%`) : null,
        h("div", { class: `bar${(x.rain || 0) >= rainAt ? " wet" : ""}`, style: `height:max(${x.rain || 0}%, 2px)` }))));
    const labels = h("div", { class: "hours", "aria-hidden": "true" },
      start.map((x, i) => h("span", {}, i % 3 === 0 ? this._time(x.date, true) : "")));
    const wetHours = start.filter((x) => (x.rain || 0) >= rainAt);
    const summary = wetHours.length
      ? `Rain likely from ${this._time(wetHours[0].date, true)}. Highest chance ${peak.rain}% at ${this._time(peak.date, true)}.`
      : `Highest chance ${peak.rain}% at ${this._time(peak.date, true)}.`;
    wrap.append(h("p", { class: "sr" }, summary), bars, labels,
      h("p", { class: "chart-note", "aria-hidden": "true" }, `Filled bars reach your rain alert (${rainAt}%), the dashed line.`));
    return wrap;
  }

  _sectionScales(m) {
    const ramp = (i) => `var(--wb-risk-${i})`;
    const rows = [];
    const uv = m.uv;
    if (uv) {
      const evening = uv.until && m.now >= uv.until;
      const note = uv.level >= 2 && uv.from && uv.until
        ? (evening ? "Protection no longer needed today" : `Protect ${this._time(uv.from, true)} to ${this._time(uv.until, true)}`)
        : uv.level < 2 ? "No protection needed" : "";
      rows.push(h("div", { class: "scale-name" }, icon("mdi:weather-sunny"), "UV"),
        h("div", {}, stepsBar(uv.level, 5, (i) => ramp(i + 1)),
          h("div", { class: "s-text" }, h("b", {}, uv.word), ` ${round(uv.max)}`, note ? h("span", {}, `${DOT}${note}`) : null)));
    }
    const p = m.pollen(m.today);
    if (p) {
      const tomorrow = m.days.find((d) => d.key > m.today);
      const next = tomorrow ? m.pollen(tomorrow.key) : null;
      const trend = next && next.value > p.value ? "rising tomorrow" : next && next.value < p.value ? "easing tomorrow" : "";
      const bits = [p.names.join(", "), trend].filter(Boolean).join(", ");
      rows.push(h("div", { class: "scale-name" }, icon("mdi:flower-pollen"), "Pollen"),
        h("div", {}, stepsBar(clamp(Math.round(p.value), 0, 5), 5, (i) => ramp(i + 1)),
          h("div", { class: "s-text" }, h("b", {}, p.word), bits ? h("span", {}, `${DOT}${bits}`) : null)));
    }
    const f = m.fire(0);
    if (f) {
      const colours = [1, 3, 4, 5];
      rows.push(h("div", { class: "scale-name" }, icon("mdi:fire"), "Fire"),
        h("div", {}, stepsBar(f.step, 4, (i) => ramp(colours[i])),
          h("div", { class: "s-text" }, h("b", {}, f.rating), f.step ? h("span", {}, `${DOT}${f.action}`) : null)));
    }
    if (!rows.length) return null;
    return h("div", {}, h("p", { class: "label" }, "Today's risks"), h("div", { class: "scales" }, ...rows));
  }

  _sectionDays(m) {
    const days = m.days.slice(0, this._raw.days);
    if (!days.length) return null;
    const rainAt = this._alert("rain_alert");
    const hotAt = this._alert("heat_alert");
    const coldAt = this._alert("cold_alert");
    const temps = days.flatMap((d) => [d.low, d.high]).filter((v) => v != null);
    const lo = Math.floor(Math.min(...temps)) - 1;
    const hi = Math.ceil(Math.max(...temps)) + 1;
    const list = h("ul", { class: "days" });
    days.forEach((d, i) => {
      const cond = this._condition(d.condition);
      const name = i === 0 && d.key === m.today ? "Today" : i <= 1 && d.key > m.today && m.days[0].key === m.today ? "Tomorrow" : this._weekday(d.date);
      const longName = name === "Today" || name === "Tomorrow" ? name : this._weekday(d.date, true);
      const wet = d.rain != null && d.rain >= rainAt;
      const low = d.low != null ? d.low : d.high;
      const high = d.high != null ? d.high : d.low;
      const sr = [`${longName}: ${cond.word}`,
        d.rain != null ? `${wet ? "rain likely, " : ""}${d.rain}% chance of rain${d.mm ? `, up to ${d.mm} mm` : ""}` : null,
        `${d.low != null ? `${round(d.low)} to ` : ""}${round(high)} degrees`].filter(Boolean).join(", ");
      list.append(h("li", { class: "day", title: sr },
        h("span", { class: "sr" }, sr),
        h("span", { class: "name", "aria-hidden": "true" }, name),
        h("span", { "aria-hidden": "true", style: "display:contents" }, icon(cond.icon)),
        h("span", { class: `rain${wet ? " wet" : ""}`, "aria-hidden": "true" },
          d.rain != null ? `${d.rain}%` : "", d.mm ? h("span", { class: "mm" }, `${d.mm} mm`) : null),
        h("div", { class: "range", "aria-hidden": "true" },
          h("span", { class: `lo${d.low != null && d.low < coldAt ? " cold" : ""}` }, d.low != null ? `${round(d.low)}${DEG}` : ""),
          this._rangeBar(low, high, lo, hi, i === 0 && d.key === m.today ? m.t : null),
          h("span", { class: `hi${high >= hotAt ? " hot" : ""}` }, `${round(high)}${DEG}`))));
    });
    return h("div", {}, h("p", { class: "label" }, `Next ${days.length} days`), list);
  }

  _render() {
    if (!this._raw || !this._hass || !this._config) return;
    if (!this._built) {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this.shadowRoot.replaceChildren(h("style", {}, STYLE), h("ha-card", {}));
      this._built = true;
    }
    const cfg = this._raw;
    const card = this.shadowRoot.querySelector("ha-card");
    card.className = cfg.style === "plain" ? "plain" : "";
    const parts = [];
    if (cfg.title) parts.push(h("h2", { class: "title" }, cfg.title));
    const w = this._hass.states[this._config.entity];
    if (!w) {
      this.hidden = false;
      card.replaceChildren(...parts, h("p", { class: "muted" }, "Choose a weather entity in the card's settings."));
      return;
    }
    if (this._fc.daily === null) {
      this.hidden = false;
      card.replaceChildren(...parts, h("p", { class: "muted" }, "Getting the forecast\u2026"));
      return;
    }
    const m = this._model();
    const hu = this._headsUp(m);
    const quiet = !hu.callouts.length; // plan-ahead chips alone don't need the space
    const editing = this._preview || this._editMode;
    this.hidden = !!(cfg.hide_when_quiet && quiet && !editing);
    for (const s of cfg.show) {
      const el = s === "callouts" ? this._sectionCallouts(m, hu)
        : s === "now" ? this._sectionNow(m)
        : s === "hourly" ? this._sectionHourly(m)
        : s === "scales" ? this._sectionScales(m)
        : this._sectionDays(m);
      if (el) parts.push(el);
    }
    if (cfg.hide_when_quiet && quiet && editing) parts.push(h("p", { class: "muted" }, "Hidden on the dashboard until there's something to watch for."));
    card.replaceChildren(h("div", { class: "body" }, ...parts));
  }
}

if (!customElements.get("wellbeing-outdoors-card")) {
  customElements.define("wellbeing-outdoors-card", WellbeingOutdoorsCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "wellbeing-outdoors-card",
    name: "Outdoors",
    description: "What the weather means today: calls out rain, strong UV, pollen, fire danger, heat and cold when they matter, with the next few days at a glance.",
    preview: true,
    documentationURL: "https://github.com/mpoppell/ha-wellbeing-tracker",
  });
}
