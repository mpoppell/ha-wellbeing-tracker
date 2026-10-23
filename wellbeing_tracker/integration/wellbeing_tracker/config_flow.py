"""One-click setup: the Wellbeing Tracker app has already written its address and key."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import WellbeingApi, WellbeingError, read_connection
from .const import DOMAIN
from .wake import DEFAULTS

HERE = Path(__file__).parent


class WellbeingConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return WellbeingOptionsFlow()

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        connection = await self.hass.async_add_executor_job(read_connection, HERE)
        if not connection:
            return self.async_abort(reason="no_app")
        errors: dict[str, str] = {}
        if user_input is not None:
            api = WellbeingApi(async_get_clientsession(self.hass), connection["url"], connection["token"])
            try:
                await api.overview()
            except WellbeingError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(title="Wellbeing Tracker", data=connection)
        return self.async_show_form(step_id="user", errors=errors)


def _guess(hass: HomeAssistant, person: dict, user_id: str) -> dict:
    """Sensible starting points: the phone reminders go to, Sleep as Android, the bedroom light."""
    ids = sorted(hass.states.async_entity_ids())
    slugs = [d.removeprefix("notify.").removeprefix("mobile_app_")
             for d in ((person.get("delivery") or {}).get("devices") or [])]
    slugs = [x for x in slugs if x]

    def phone(domain: str, suffix: str) -> str | None:
        for slug in slugs:
            hit = next((i for i in ids if i.startswith(f"{domain}.") and i.endswith(f"{slug}_{suffix}")), None)
            if hit:
                return hit
        return next((i for i in ids if i.startswith(f"{domain}.") and i.endswith(f"_{suffix}")), None)

    me = next((i for i in ids if i.startswith("person.")
               and (hass.states.get(i).attributes.get("user_id") == user_id)), None)
    bedroom = [i for i in ids if i.startswith("light.") and ("bedroom" in i or "bedroom" in str(
        hass.states.get(i).attributes.get("friendly_name", "")).lower())]
    return {
        "sleep_tracking": next((i for i in ids if i.startswith("event.") and "sleep_tracking" in i), None),
        "charging": phone("binary_sensor", "is_charging"),
        "phone_locked": phone("binary_sensor", "device_locked"),
        "activity": phone("sensor", "detected_activity"),
        "person": me,
        "lights": bedroom[:1],
    }


class WellbeingOptionsFlow(OptionsFlow):
    """Configure → Awake and asleep: which signals decide each person's Awake switch."""

    def __init__(self) -> None:
        self.user_id: str | None = None

    def _people(self) -> dict:
        coordinator = getattr(self.config_entry, "runtime_data", None)
        return ((coordinator.data if coordinator else None) or {}).get("people", {})

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        people = self._people()
        if not people:
            return self.async_abort(reason="no_people")
        if len(people) == 1:
            self.user_id = next(iter(people))
            return await self.async_step_person()
        if user_input is not None:
            self.user_id = user_input["person"]
            return await self.async_step_person()
        options = [selector.SelectOptionDict(value=uid, label=p.get("name") or uid) for uid, p in people.items()]
        return self.async_show_form(step_id="init", data_schema=vol.Schema({
            vol.Required("person"): selector.SelectSelector(selector.SelectSelectorConfig(options=options)),
        }))

    async def async_step_person(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        uid = self.user_id
        people_opts = dict((self.config_entry.options or {}).get("people") or {})
        if user_input is not None:
            clean = {k: v for k, v in user_input.items() if v not in (None, "", [])}
            people_opts[uid] = clean
            return self.async_create_entry(data={**(self.config_entry.options or {}), "people": people_opts})
        current = people_opts.get(uid)
        if current is None:  # first time: suggest what's likely
            current = {k: v for k, v in _guess(self.hass, self._people().get(uid, {}), uid).items() if v}
        current = {**{k: v for k, v in DEFAULTS.items() if not isinstance(v, (list, type(None)))}, **current}

        def ent(key: str, domain: str | list[str] | None = None, multiple: bool = False) -> tuple:
            cfg = selector.EntitySelectorConfig(multiple=multiple, **({"domain": domain} if domain else {}))
            return (vol.Optional(key, description={"suggested_value": current.get(key)}),
                    selector.EntitySelector(cfg))

        def num(key: str, lo: float, hi: float, step: float, unit: str) -> tuple:
            return (vol.Optional(key, default=current.get(key, DEFAULTS[key])),
                    selector.NumberSelector(selector.NumberSelectorConfig(
                        min=lo, max=hi, step=step, unit_of_measurement=unit, mode=selector.NumberSelectorMode.BOX)))

        def clock(key: str) -> tuple:
            return (vol.Optional(key, default=str(current.get(key, DEFAULTS[key]))[:5] + ":00"),
                    selector.TimeSelector())

        fields = [
            ent("sleep_tracking", "event"),
            ent("charging", "binary_sensor"),
            ent("phone_locked", "binary_sensor"),
            ent("activity", "sensor"),
            ent("person", "person"),
            ent("lights", "light", multiple=True),
            ent("signs", multiple=True),
            ent("keep_awake", multiple=True),
            clock("earliest"),
            clock("bedtime_after"),
            num("night_charge_hours", 0.5, 12, 0.5, "h"),
            num("in_use_minutes", 1, 60, 1, "min"),
            num("quiet_minutes", 5, 180, 5, "min"),
        ]
        name = self._people().get(uid, {}).get("name") or "you"
        return self.async_show_form(step_id="person", data_schema=vol.Schema(dict(fields)),
                                    description_placeholders={"name": name})
