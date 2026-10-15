"""Keeps one copy of everyone's Wellbeing data, refreshed every 30 seconds and straight after
any reminder changes."""

from __future__ import annotations

import logging
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import WellbeingApi, WellbeingError
from .const import DOMAIN, SCAN_INTERVAL_SECONDS

_LOGGER = logging.getLogger(__name__)


class WellbeingCoordinator(DataUpdateCoordinator[dict]):
    """data = {"people": {user_id: person}, "panel_path": "/..."}"""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, api: WellbeingApi) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN,
                         update_interval=timedelta(seconds=SCAN_INTERVAL_SECONDS))
        self.api = api

    async def _async_update_data(self) -> dict:
        try:
            data = await self.api.overview()
        except WellbeingError as err:
            raise UpdateFailed(str(err)) from err
        return {"people": {p["user_id"]: p for p in data.get("people", [])},
                "panel_path": data.get("panel_path"), "version": data.get("version")}

    def person(self, user_id: str) -> dict | None:
        return (self.data or {}).get("people", {}).get(user_id)

    def update_person(self, person: dict) -> None:
        """Use the fresh copy the app sends back after an answer, without waiting for the next poll."""
        data = dict(self.data or {"people": {}})
        data["people"] = {**data.get("people", {}), person["user_id"]: person}
        self.async_set_updated_data(data)
