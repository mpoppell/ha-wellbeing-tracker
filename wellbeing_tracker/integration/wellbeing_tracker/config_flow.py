"""One-click setup: the Wellbeing Tracker app has already written its address and key."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import WellbeingApi, WellbeingError, read_connection
from .const import DOMAIN

HERE = Path(__file__).parent


class WellbeingConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

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
