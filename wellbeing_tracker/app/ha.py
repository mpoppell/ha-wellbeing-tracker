"""Small client for the Home Assistant Core API via the Supervisor proxy."""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)


class HomeAssistant:
    def __init__(self, base_url: str, token: str | None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    @property
    def configured(self) -> bool:
        return bool(self.token)

    async def check(self) -> dict:
        """Return whether the Core API is reachable with our token."""
        if not self.token:
            return {"connected": False, "detail": "No Supervisor token (running outside Home Assistant?)"}
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(
                    f"{self.base_url}/",
                    headers={"Authorization": f"Bearer {self.token}"},
                )
            if resp.status_code == 200:
                return {"connected": True, "detail": "Connected to Home Assistant"}
            return {"connected": False, "detail": f"Home Assistant returned HTTP {resp.status_code}"}
        except httpx.HTTPError as err:
            log.warning("Home Assistant API check failed: %s", err)
            return {"connected": False, "detail": "Could not reach Home Assistant"}
