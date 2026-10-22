"""Wellbeing Tracker: dashboard card, entities and actions for the Wellbeing Tracker app.

The app does the work (reminders, logging, supply). This integration shows it in Home
Assistant: a sensor set per person and per medication, a dashboard card, and actions to answer
reminders and log doses from automations, scripts and voice.
"""

from __future__ import annotations

import logging
from pathlib import Path

import voluptuous as vol

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError, Unauthorized
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration
from homeassistant.util import dt as dt_util

from .api import WellbeingApi, WellbeingError, read_connection
from .const import CARD_URL, DOMAIN, OUTDOORS_CARD_URL, REMINDER_EVENT
from .coordinator import WellbeingCoordinator

try:
    from homeassistant.components.lovelace.const import LOVELACE_DATA
except ImportError:  # older Home Assistant
    LOVELACE_DATA = "lovelace"

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.BUTTON, Platform.SELECT, Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
HERE = Path(__file__).parent

type WellbeingConfigEntry = ConfigEntry[WellbeingCoordinator]

ANSWER_SCHEMA = vol.Schema({
    vol.Required("reminder_id"): vol.Coerce(int),
    vol.Required("answer"): cv.string,
    vol.Optional("reason"): cv.string,
})
LOG_SCHEMA = vol.Schema({
    vol.Required("item"): cv.string,
    vol.Required("value"): vol.Coerce(float),
    vol.Optional("person"): cv.string,
})
IM_UP_SCHEMA = vol.Schema({
    vol.Optional("person"): cv.string,
    vol.Optional("at"): cv.datetime,
    vol.Optional("source"): cv.string,
})
LOG_DOSE_SCHEMA = vol.Schema({
    vol.Required("medication"): cv.string,
    vol.Optional("quantity"): vol.All(vol.Coerce(float), vol.Range(min=0.01, max=100)),
    vol.Optional("person"): cv.string,
})


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """The dashboard card and the actions, set up once."""
    integration = await async_get_integration(hass, DOMAIN)
    await hass.http.async_register_static_paths([
        StaticPathConfig(CARD_URL, str(HERE / "frontend" / "wellbeing-card.js"), False),
        StaticPathConfig(OUTDOORS_CARD_URL, str(HERE / "frontend" / "wellbeing-outdoors-card.js"), False),
    ])
    # Loaded on every dashboard, so the cards work without adding a resource by hand.
    cards = [CARD_URL, OUTDOORS_CARD_URL]
    if not await _add_dashboard_resources(hass, cards, integration.version):
        for url in cards:
            add_extra_js_url(hass, f"{url}?v={integration.version}")

    def coordinator() -> WellbeingCoordinator:
        entries = hass.config_entries.async_loaded_entries(DOMAIN)
        if not entries:
            raise ServiceValidationError("Wellbeing Tracker isn't set up")
        return entries[0].runtime_data

    async def check_allowed(call: ServiceCall, user_id: str) -> None:
        """People can answer their own reminders. Admins and automations can answer anyone's."""
        if not call.context.user_id or call.context.user_id == user_id:
            return
        user = await hass.auth.async_get_user(call.context.user_id)
        if not user or not user.is_admin:
            raise Unauthorized(context=call.context)

    def find_person(coord: WellbeingCoordinator, call: ServiceCall, wanted: str | None) -> dict:
        people = list((coord.data or {}).get("people", {}).values())
        if wanted:
            match = [p for p in people if wanted in (p["user_id"], p["name"]) or p["name"].lower() == wanted.lower()]
        elif call.context.user_id:
            match = [p for p in people if p["user_id"] == call.context.user_id]
        else:
            match = people if len(people) == 1 else []
        if not match:
            raise ServiceValidationError("Choose which person this is for")
        return match[0]

    async def answer_reminder(call: ServiceCall) -> None:
        coord = coordinator()
        rid = call.data["reminder_id"]
        owner = next((p for p in coord.data.get("people", {}).values()
                      if any(i.get("id") == rid for i in p.get("inbox", []))), None)
        if not owner:
            await coord.async_request_refresh()
            owner = next((p for p in coord.data.get("people", {}).values()
                          if any(i.get("id") == rid for i in p.get("inbox", []))), None)
        if not owner:
            raise ServiceValidationError("That reminder has already been answered")
        await check_allowed(call, owner["user_id"])
        try:
            person = await coord.api.answer(owner["user_id"], rid, call.data["answer"], call.data.get("reason"))
        except WellbeingError as err:
            raise HomeAssistantError(str(err)) from err
        coord.update_person(person)

    async def log_dose(call: ServiceCall) -> None:
        coord = coordinator()
        person = find_person(coord, call, call.data.get("person"))
        await check_allowed(call, person["user_id"])
        try:
            fresh = await coord.api.log_dose(person["user_id"], call.data["medication"], call.data.get("quantity"))
        except WellbeingError as err:
            raise HomeAssistantError(str(err)) from err
        coord.update_person(fresh)

    async def log(call: ServiceCall) -> None:
        coord = coordinator()
        person = find_person(coord, call, call.data.get("person"))
        await check_allowed(call, person["user_id"])
        try:
            fresh = await coord.api.log(person["user_id"], call.data["item"], call.data["value"])
        except WellbeingError as err:
            raise HomeAssistantError(str(err)) from err
        coord.update_person(fresh)

    async def im_up(call: ServiceCall) -> None:
        """Someone's up: medications due "when I wake up" are due now (or from `at`)."""
        coord = coordinator()
        person = find_person(coord, call, call.data.get("person"))
        await check_allowed(call, person["user_id"])
        at = call.data.get("at")
        if at is not None:
            at = dt_util.as_local(at) if at.tzinfo else at.replace(tzinfo=dt_util.get_default_time_zone())
        try:
            fresh = await coord.api.wake(person["user_id"], at.isoformat() if at else None,
                                         call.data.get("source"))
        except WellbeingError as err:
            raise HomeAssistantError(str(err)) from err
        coord.update_person(fresh)

    hass.services.async_register(DOMAIN, "answer_reminder", answer_reminder, schema=ANSWER_SCHEMA)
    hass.services.async_register(DOMAIN, "im_up", im_up, schema=IM_UP_SCHEMA)
    hass.services.async_register(DOMAIN, "log", log, schema=LOG_SCHEMA)
    hass.services.async_register(DOMAIN, "log_dose", log_dose, schema=LOG_DOSE_SCHEMA)
    return True


async def _add_dashboard_resources(hass: HomeAssistant, cards: list[str], version: str) -> bool:
    """Add the cards as dashboard resources, the way HACS cards are added.

    The phone apps don't always load scripts added with add_extra_js_url, which left the
    cards as "Configuration error" there; dashboard resources load everywhere. Keeps one
    entry per card on the current version. False when resources are managed in YAML, so the
    caller falls back to add_extra_js_url.
    """
    lovelace = hass.data.get(LOVELACE_DATA)
    resources = lovelace.get("resources") if isinstance(lovelace, dict) else getattr(lovelace, "resources", None)
    if resources is None or not hasattr(resources, "async_create_item"):
        return False
    try:
        if not resources.loaded:
            await resources.async_load()
            resources.loaded = True
        items = list(resources.async_items())
        for base in cards:
            wanted = f"{base}?v={version}"
            ours = [item for item in items if str(item.get("url", "")).split("?")[0] == base]
            if not ours:
                await resources.async_create_item({"res_type": "module", "url": wanted})
                continue
            if ours[0].get("url") != wanted or ours[0].get("type") != "module":
                await resources.async_update_item(ours[0]["id"], {"res_type": "module", "url": wanted})
            for extra in ours[1:]:
                await resources.async_delete_item(extra["id"])
    except Exception:  # noqa: BLE001 - never let this stop the integration loading
        _LOGGER.warning("Couldn't add the Wellbeing cards as dashboard resources; loading them another way",
                        exc_info=True)
        return False
    return True


async def async_setup_entry(hass: HomeAssistant, entry: WellbeingConfigEntry) -> bool:
    # The app may have moved or changed its key; it always writes the current ones next to us.
    latest = await hass.async_add_executor_job(read_connection, HERE)
    if latest and latest != {"url": entry.data.get("url"), "token": entry.data.get("token")}:
        hass.config_entries.async_update_entry(entry, data={**entry.data, **latest})
    api = WellbeingApi(async_get_clientsession(hass), entry.data["url"], entry.data["token"])
    coordinator = WellbeingCoordinator(hass, entry, api)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator

    async def on_reminder(_event) -> None:
        await coordinator.async_request_refresh()

    entry.async_on_unload(hass.bus.async_listen(REMINDER_EVENT, on_reminder))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: WellbeingConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
