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

// The sky in a few kinds, for marking big changes on today's chart. rank: how far from a clear day.
// [rank, word by day, word at night, icon by day, icon at night]
const SKY = {
  clear: [0, "Sunny", "Clear", "mdi:weather-sunny", "mdi:weather-night"],
  partly: [1, "Partly cloudy", "Partly cloudy", "mdi:weather-partly-cloudy", "mdi:weather-night-partly-cloudy"],
  windy: [1, "Windy", "Windy", "mdi:weather-windy", "mdi:weather-windy"],
  cloudy: [2, "Cloudy", "Cloudy", "mdi:weather-cloudy", "mdi:weather-cloudy"],
  fog: [2, "Fog", "Fog", "mdi:weather-fog", "mdi:weather-fog"],
  other: [2, "Changeable", "Changeable", "mdi:weather-cloudy-alert", "mdi:weather-cloudy-alert"],
  rain: [3, "Showers", "Showers", "mdi:weather-rainy", "mdi:weather-rainy"],
  heavy: [4, "Heavy rain", "Heavy rain", "mdi:weather-pouring", "mdi:weather-pouring"],
  snow: [4, "Snow", "Snow", "mdi:weather-snowy", "mdi:weather-snowy"],
  storm: [5, "Storms", "Storms", "mdi:weather-lightning-rainy", "mdi:weather-lightning-rainy"],
  hail: [5, "Hail", "Hail", "mdi:weather-hail", "mdi:weather-hail"],
};
const WET = new Set(["rain", "heavy", "snow", "storm", "hail"]);
const MAX_MARKS = 6; // sunrise, sunset and the biggest changes, no more
const MARK_GAP = 10; // least room between marker icons, in percent of the chart's width, so labels don't overlap

// Which kind of sky. Cloud cover, when the forecast has it, beats the condition word:
// providers often say "partly cloudy" at 98% cover.
function skyOf(cond, cloud) {
  switch (cond) {
    case "lightning": case "lightning-rainy": return "storm";
    case "hail": return "hail";
    case "pouring": return "heavy";
    case "rainy": return "rain";
    case "snowy": case "snowy-rainy": return "snow";
    case "fog": return "fog";
    default: break;
  }
  const c = num(cloud);
  if (c != null) return c < 25 ? "clear" : c <= 75 ? "partly" : "cloudy";
  if (cond === "sunny" || cond === "clear-night") return "clear";
  if (cond === "partlycloudy") return "partly";
  if (cond === "cloudy") return "cloudy";
  if (cond === "windy" || cond === "windy-variant") return "windy";
  return cond ? "other" : null;
}

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

  /* today's temperature */
  .chartwrap { position: relative; }
  .daychart { display: block; width: 100%; height: auto; overflow: visible; touch-action: pan-y; }
  .daychart .seen, .daychart .ahead { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .daychart .ahead { stroke-dasharray: 5 5; }
  .daychart .guide { stroke: var(--divider-color); stroke-width: 1; }
  .daychart .axis { stroke: var(--divider-color); stroke-width: 1; }
  .daychart .nowline { stroke: var(--secondary-text-color); stroke-width: 1; stroke-dasharray: 2 3; }
  .daychart .nowdot { fill: var(--primary-text-color); stroke: var(--card-background-color, #fff); stroke-width: 2; }
  .daychart .cross { stroke: var(--secondary-text-color); stroke-width: 1; }
  .daychart .ring { fill: var(--card-background-color, #fff); stroke: var(--primary-text-color); stroke-width: 2; }
  .daychart .lbl { font-size: 11px; font-weight: 600; fill: var(--primary-text-color); }
  .daychart .tick { font-size: 10px; fill: var(--secondary-text-color); }
  .tip { position: absolute; top: -6px; transform: translate(-50%, -100%); padding: 3px 8px; border-radius: 8px; font-size: 0.8rem; white-space: nowrap;
    background: var(--primary-text-color); color: var(--card-background-color, #fff); pointer-events: none; }
  .chart-key { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: 0.8rem; color: var(--secondary-text-color); }
  .chart-key span { display: inline-flex; align-items: center; gap: 6px; }
  .chart-key i { display: inline-block; width: 18px; border-top: 2.5px solid var(--secondary-text-color); }
  .chart-key i.k-ahead { border-top-style: dashed; }
  .chart-key .k-note { margin-inline-start: auto; }
  .today { margin-top: 12px; }
  .marks { position: relative; height: 42px; }
  .marks .leads { position: absolute; left: 0; bottom: 0; width: 100%; height: 10px; overflow: visible; }
  .marks .leads line { stroke: var(--divider-color); stroke-width: 1; stroke-dasharray: 1 3; vector-effect: non-scaling-stroke; }
  .mk { position: absolute; top: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;
    font-size: 10px; line-height: 1.15; color: var(--secondary-text-color); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .mk ha-icon { --mdc-icon-size: 18px; }
  .mk.sun ha-icon { color: var(--warning-color, #ffa600); }
  .mk.wet ha-icon { color: var(--info-color, #039be5); }
  .daychart .mkline { stroke: var(--divider-color); stroke-width: 1; stroke-dasharray: 1 3; }

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
  if (!c.temperature_entity) {
    // a Bureau observation station near the forecast location, e.g. sensor.viewbank_temp
    c.temperature_entity = find(/^sensor\..*_temp$/, (s) => s.attributes.device_class === "temperature"
      && /Bureau of Meteorology/i.test(s.attributes.attribution || ""));
  }
  if (!c.uv_entity) c.uv_entity = find(/^sensor\..*uv_max_index_0$/);
  if (!c.uv_start_entity) c.uv_start_entity = sibling(c.uv_entity, /uv_max_index_0$/, "uv_start_time_0");
  if (!c.uv_end_entity) c.uv_end_entity = sibling(c.uv_entity, /uv_max_index_0$/, "uv_end_time_0");
  if (!c.fire_entity) c.fire_entity = find(/^sensor\..*fire_danger_0$/);
  if (!c.warnings_entity) c.warnings_entity = find(/^sensor\..*_warnings$/, (s) => Array.isArray(s.attributes.warnings));
  if (!c.pollen_entity) c.pollen_entity = find(/^sensor\..*pollen.*overall.*today$/) || find(/^sensor\..*pollen.*overall/);
  if (!c.sun_entity && states["sun.sun"]) c.sun_entity = "sun.sun";
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
          { name: "sun_entity", selector: ent("sun") },
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
        sun_entity: "Sunrise and sunset",
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

  // Everything found is written into the config, so the editor shows exactly what the card uses.
  static getStubConfig(hass) {
    const found = detect(hass, {});
    const out = {};
    for (const [k, v] of Object.entries(found)) if (v != null && v !== "") out[k] = v;
    return out;
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
    this._histKey = null;
    this._built = false;
    if (this._hass) this.hass = this._hass;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._raw) return;
    if (!this._config) this._config = detect(hass, this._raw);
    this._subscribe();
    if (!this._histKey) this._loadHistory();
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
    this._loadHistory();
    this._tick = setInterval(() => { this._loadHistory(); this._render(); }, 5 * 60 * 1000);
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

    // Today's range: the forecast, widened by what the thermometer has actually measured today.
    // By evening the Bureau drops today's low (it's in the past), so measured readings fill it in.
    const dayStart = this._startOfDay(now);
    const measured = (this._hist || []).filter((p) => p.date >= dayStart).map((p) => p.t);
    const temps = todayHours.map((x) => x.t).concat(measured).filter((v) => v != null);
    if (t != null) temps.push(t);
    let high = todayFc ? todayFc.high : null;
    let low = todayFc ? todayFc.low : null;
    if (temps.length) {
      high = high == null ? Math.max(...temps) : Math.max(high, ...temps);
      low = low == null ? Math.min(...temps) : Math.min(low, ...temps);
    }
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
    return h("div", {},
      h("div", { class: "now" }, icon(cond.icon),
        h("div", { class: "temp" }, m.t != null ? `${round(m.t)}${DEG}` : DASH),
        h("div", { class: "cond" }, cond.word)),
      this._dayChart(m));
  }

  // Today's temperature: measured so far (solid), forecast for the rest of the day (dashed).
  _dayChart(m) {
    const dayStart = this._startOfDay(m.now);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600e3);
    const seen = (this._hist || []).filter((p) => p.date >= dayStart && p.date <= m.now);
    if (m.t != null) seen.push({ date: m.now, t: m.t });
    const lastSeen = seen.length ? seen[seen.length - 1].date : null;
    const ahead = ((this._fc.hourly) || [])
      .map((f) => ({ date: new Date(f.datetime), t: num(f.temperature) }))
      .filter((p) => p.t != null && p.date < dayEnd && p.date >= (lastSeen || dayStart));
    if (lastSeen && ahead.length) ahead.unshift(seen[seen.length - 1]);
    const all = seen.concat(ahead);
    if (all.length < 2) return null;
    const temps = all.map((p) => p.t);
    const tMin = Math.min(...temps);
    const tMax = Math.max(...temps);
    const lo = Math.floor(tMin) - 2;
    const hi = Math.ceil(tMax) + 2;
    const W = 320, H = 112, L = 6, R = 6, T = 20, B = 20;
    const x = (d) => L + ((d - dayStart) / (dayEnd - dayStart)) * (W - L - R);
    const y = (t) => T + (1 - (t - lo) / (hi - lo || 1)) * (H - T - B);
    const NS = "http://www.w3.org/2000/svg";
    const s = (tag, attrs, ...kids) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
      for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
      return n;
    };
    const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.t).toFixed(1)}`).join("");
    const gid = `wb-t-${Math.random().toString(36).slice(2, 8)}`;
    const grad = s("linearGradient", { id: gid, gradientUnits: "userSpaceOnUse", x1: 0, y1: y(lo), x2: 0, y2: y(hi) },
      ...[0, 0.25, 0.5, 0.75, 1].map((f) => s("stop", { offset: f, "stop-color": tempColour(lo + (hi - lo) * f) })));
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "daychart", "aria-hidden": "true" }, s("defs", {}, grad));
    // recessive guides: 6am, noon, 6pm
    for (const hr of [6, 12, 18]) {
      const gx = x(new Date(dayStart.getTime() + hr * 3600e3));
      svg.append(s("line", { x1: gx, x2: gx, y1: T - 6, y2: H - B, class: "guide" }));
    }
    // sunrise, sunset and big changes in the sky: an icon above the chart, a faint line down to the axis
    const marks = this._dayMarks(m, dayStart, dayEnd, (d) => (x(d) / W) * 100);
    for (const mk of marks) svg.append(s("line", { x1: x(mk.date), x2: x(mk.date), y1: 0, y2: H - B, class: "mkline" }));
    // short leads from each icon to its exact time, for icons nudged aside to make room
    const leads = s("svg", { viewBox: "0 0 100 10", preserveAspectRatio: "none", class: "leads" },
      ...marks.map((mk) => s("line", { x1: mk.pos.toFixed(2), y1: 0, x2: ((x(mk.date) / W) * 100).toFixed(2), y2: 10 })));
    const strip = marks.length ? h("div", { class: "marks", "aria-hidden": "true" }, marks.map((mk) =>
      h("div", { class: `mk ${mk.kind}`, style: `left:${mk.pos.toFixed(1)}%`, title: mk.title },
        icon(mk.icon), h("span", {}, this._time(mk.date, true)))), leads) : null;
    svg.append(s("line", { x1: L, x2: W - R, y1: H - B, y2: H - B, class: "axis" }));
    if (seen.length > 1) svg.append(s("path", { d: path(seen), class: "seen", stroke: `url(#${gid})` }));
    if (ahead.length > 1) svg.append(s("path", { d: path(ahead), class: "ahead", stroke: `url(#${gid})` }));
    // labels: only the high, the low, and now
    const labels = [];
    const label = (p, text, below) => {
      const lx = clamp(x(p.date), L + 14, W - R - 14);
      const ly = below ? y(p.t) + 14 : y(p.t) - 7;
      if (labels.some((o) => Math.abs(o.x - lx) < 30 && Math.abs(o.y - ly) < 12)) return;
      labels.push({ x: lx, y: ly });
      svg.append(s("text", { x: lx, y: ly, class: "lbl", "text-anchor": "middle" }, text));
    };
    const top = all.reduce((a, b) => (b.t > a.t ? b : a));
    const bottom = all.reduce((a, b) => (b.t < a.t ? b : a));
    if (m.t != null) {
      svg.append(s("line", { x1: x(m.now), x2: x(m.now), y1: T - 6, y2: H - B, class: "nowline" }));
      svg.append(s("circle", { cx: x(m.now), cy: y(m.t), r: 4.5, class: "nowdot" }));
      labels.push({ x: x(m.now), y: y(m.t) });
    }
    label(top, `${round(top.t)}${DEG}`, false);
    label(bottom, `${round(bottom.t)}${DEG}`, true);
    for (const [hr, txt] of [[6, "6am"], [12, "12pm"], [18, "6pm"]]) {
      svg.append(s("text", { x: x(new Date(dayStart.getTime() + hr * 3600e3)), y: H - 5, class: "tick", "text-anchor": "middle" }, this._time(new Date(dayStart.getTime() + hr * 3600e3), true)));
    }
    // hover / tap: nearest reading
    const tip = h("div", { class: "tip", hidden: true });
    const cross = s("line", { y1: T - 6, y2: H - B, class: "cross", visibility: "hidden" });
    const ring = s("circle", { r: 4, class: "ring", visibility: "hidden" });
    svg.append(cross, ring);
    const wrap = h("div", { class: "chartwrap" }, strip, svg, tip);
    const show = (ev) => {
      const box = svg.getBoundingClientRect();
      const px = ((ev.clientX - box.left) / box.width) * W;
      const p = all.reduce((a, b) => (Math.abs(x(b.date) - px) < Math.abs(x(a.date) - px) ? b : a));
      cross.setAttribute("x1", x(p.date)); cross.setAttribute("x2", x(p.date)); cross.setAttribute("visibility", "visible");
      ring.setAttribute("cx", x(p.date)); ring.setAttribute("cy", y(p.t)); ring.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.textContent = `${this._time(p.date, true)} \u00b7 ${round(p.t)}${DEG}${p.date > m.now ? " forecast" : ""}`;
      tip.style.left = `${clamp((x(p.date) / W) * 100, 12, 88)}%`;
    };
    const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); ring.setAttribute("visibility", "hidden"); };
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", show);
    svg.addEventListener("pointerleave", hide);
    const peakAhead = ahead.length > 1 && top.date > m.now ? `, warmest around ${this._time(top.date, true)}` : "";
    const summary = `Today's temperature: low ${round(bottom.t)}, high ${round(top.t)} degrees${peakAhead}.${m.t != null ? ` Now ${round(m.t)}.` : ""}`
      + (marks.length ? ` ${marks.map((mk) => mk.title).join(". ")}.` : "");
    const key = h("div", { class: "chart-key", "aria-hidden": "true" },
      seen.length > 1 ? h("span", {}, h("i", { class: "k-seen" }), "So far") : null,
      ahead.length > 1 ? h("span", {}, h("i", { class: "k-ahead" }), "Forecast") : null,
      peakAhead ? h("span", { class: "k-note" }, `Warmest around ${this._time(top.date, true)}`) : null);
    return h("div", { class: "today" }, h("p", { class: "label" }, "Today's temperature"), h("p", { class: "sr" }, summary), wrap, key);
  }

  // Markers above today's chart: sunrise, sunset and the biggest changes in the sky, at most MAX_MARKS.
  // pct: where a time sits across the chart, 0 to 100.
  _dayMarks(m, dayStart, dayEnd, pct) {
    const c = this._config;
    const HOUR = 3600e3;

    // The sun entity only knows the next sunrise and sunset; one already past is a day earlier (a minute or two off).
    const sun = [];
    const st = c.sun_entity && this._hass.states[c.sun_entity];
    if (st) {
      for (const [attr, kind] of [["next_rising", "rise"], ["next_setting", "set"]]) {
        let d = new Date(st.attributes[attr]);
        if (isNaN(d)) continue;
        while (d >= dayEnd) d = new Date(d.getTime() - 24 * HOUR);
        if (d >= dayStart) sun.push({ date: d, kind });
      }
    }
    const rise = (sun.find((x) => x.kind === "rise") || {}).date;
    const set = (sun.find((x) => x.kind === "set") || {}).date;
    const night = (d) => !!((rise && d < rise) || (set && d >= set));

    // Hour by hour: the sky so far today from the weather's history, then the hourly forecast.
    const nowHour = new Date(dayStart.getTime() + Math.floor((m.now - dayStart) / HOUR) * HOUR);
    const series = [];
    const hist = this._skyHist || [];
    for (let t = dayStart.getTime(); t < nowHour.getTime(); t += HOUR) {
      let state = null;
      for (const p of hist) { if (p.date.getTime() <= t + HOUR / 2) state = p.state; else break; }
      const sky = skyOf(state);
      if (sky) series.push({ date: new Date(t), sky });
    }
    for (const f of this._fc.hourly || []) {
      const d = new Date(f.datetime);
      if (isNaN(d) || d < nowHour || d >= dayEnd) continue;
      const sky = skyOf(f.condition, f.cloud_coverage);
      if (sky) series.push({ date: d, sky });
    }

    // Runs of the same sky. A dry one-hour blip folds into the run before it, so a single sunny hour
    // between cloudy ones isn't a change; a single wet hour is kept, because a shower is worth knowing.
    const runs = [];
    for (const p of series) {
      const prev = runs[runs.length - 1];
      if (prev && prev.sky === p.sky) prev.n += 1;
      else runs.push({ sky: p.sky, date: p.date, n: 1 });
    }
    const calm = [];
    runs.forEach((r) => {
      const prev = calm[calm.length - 1];
      const blip = r.n === 1 && !WET.has(r.sky);
      if (prev && (prev.sky === r.sky || blip)) prev.n += r.n;
      else calm.push({ ...r });
    });

    // How big each change is: steps between kinds of sky, plus extra for rain starting or stopping.
    const changes = [];
    for (let i = 1; i < calm.length; i++) {
      const a = calm[i - 1];
      const b = calm[i];
      const score = Math.abs(SKY[b.sky][0] - SKY[a.sky][0]) + (WET.has(a.sky) !== WET.has(b.sky) ? 2 : 0);
      if (score > 0) changes.push({ date: b.date, sky: b.sky, from: a.sky, score });
    }

    // Sunrise and sunset always; then the biggest changes, the rest of today before what's already happened.
    const marks = sun.map((x) => ({ date: x.date, kind: "sun",
      icon: x.kind === "rise" ? "mdi:weather-sunset-up" : "mdi:weather-sunset-down",
      title: `${x.kind === "rise" ? "Sunrise" : "Sunset"} ${this._time(x.date)}` }));
    const past = (d) => (d < nowHour ? 1 : 0);
    changes.sort((a, b) => b.score - a.score || past(a.date) - past(b.date) || a.date - b.date);
    for (const ch of changes.slice(0, Math.max(0, MAX_MARKS - marks.length))) {
      const n = night(ch.date) ? 1 : 0;
      const k = SKY[ch.sky];
      const clears = WET.has(ch.from) && !WET.has(ch.sky);
      const eases = WET.has(ch.from) && WET.has(ch.sky) && k[0] < SKY[ch.from][0];
      const word = clears ? "Rain clears by" : eases ? `Easing to ${k[1 + n].toLowerCase()} from` : `${k[1 + n]} from`;
      marks.push({ date: ch.date, kind: WET.has(ch.sky) ? "wet" : "sky", icon: k[3 + n],
        title: `${word} ${this._time(ch.date, true)}` });
    }
    marks.sort((a, b) => a.date - b.date);

    // Lay the icons out left to right: each sits over its time, nudged just enough not to overlap its
    // neighbour (the label always says the exact time; a faint line marks the true spot on the chart).
    const lo = 5;
    const hi = 95;
    marks.forEach((mk, i) => { mk.pos = Math.max(clamp(pct(mk.date), lo, hi), i ? marks[i - 1].pos + MARK_GAP : lo); });
    for (let i = marks.length - 1; i >= 0; i--) {
      marks[i].pos = Math.min(marks[i].pos, i < marks.length - 1 ? marks[i + 1].pos - MARK_GAP : hi);
    }
    return marks;
  }

  _startOfDay(d) {
    // midnight in the display time zone
    const key = this._dayKey(d);
    let t = new Date(d.getTime() - this._hour(d) * 3600e3 - d.getMinutes() * 60e3 - d.getSeconds() * 1e3 - d.getMilliseconds());
    if (this._dayKey(t) !== key) t = new Date(t.getTime() + 3600e3); // daylight saving edge
    return t;
  }

  async _loadHistory() {
    const hass = this._hass;
    const c = this._config;
    if (!hass || !c || !hass.callWS || !this._raw.show.some((x) => x === "now" || x === "days")) return;
    const id = c.temperature_entity || c.entity;
    if (!id || !hass.states[id]) return;
    const now = new Date();
    const key = `${id}|${this._dayKey(now)}`;
    if (this._histKey === key && this._histAt && now - this._histAt < 10 * 60e3) return;
    this._histKey = key;
    this._histAt = now;
    try {
      const useAttr = !c.temperature_entity;
      // the weather's own state is its condition, so today's sky so far comes along with the temperature
      const ids = [id, c.entity].filter((e, i, a) => e && hass.states[e] && a.indexOf(e) === i);
      const res = await hass.callWS({ type: "history/history_during_period", start_time: this._startOfDay(now).toISOString(),
        end_time: now.toISOString(), entity_ids: ids, minimal_response: !useAttr, no_attributes: !useAttr, significant_changes_only: false });
      this._skyHist = ((res && res[c.entity]) || [])
        .map((r) => ({ date: new Date((r.lu || r.lc || 0) * 1000), state: r.s }))
        .filter((p) => p.state && !isNaN(p.date) && !["unknown", "unavailable"].includes(p.state));
      const rows = (res && res[id]) || [];
      const pts = rows.map((r) => ({ date: new Date((r.lu || r.lc || 0) * 1000), t: useAttr ? num(r.a && r.a.temperature) : num(r.s) }))
        .filter((p) => p.t != null && !isNaN(p.date));
      // one point per 15 minutes keeps the line calm
      const buckets = new Map();
      for (const p of pts) {
        const b = Math.floor(p.date.getTime() / 900e3);
        const o = buckets.get(b) || { sum: 0, n: 0, date: p.date };
        o.sum += p.t; o.n += 1; buckets.set(b, o);
      }
      this._hist = [...buckets.values()].map((o) => ({ date: o.date, t: o.sum / o.n }));
      this._render();
    } catch (err) {
      this._hist = [];
      this._skyHist = [];
    }
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
    // today's row uses the measured-and-forecast range (see _model), not the Bureau's alone
    days.forEach((d, i) => { if (i === 0 && d.key === m.today) days[0] = { ...d, low: m.low, high: m.high }; });
    const temps = days.flatMap((d) => [d.low, d.high]).filter((v) => v != null);
    const lo = Math.floor(Math.min(...temps)) - 1;
    const hi = Math.ceil(Math.max(...temps)) + 1;
    const list = h("ul", { class: "days" });
    days.forEach((d, i) => {
      // a day row describes the whole day, so the Bureau's evening "clear night" for today shows as sunny
      const cond = this._condition(d.condition === "clear-night" ? "sunny" : d.condition);
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
