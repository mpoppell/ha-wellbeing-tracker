"""Talks to the Wellbeing Tracker app over Home Assistant's internal network."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import aiohttp

from .const import ADDON_FILE


class WellbeingError(Exception):
    """The app couldn't be reached or said no."""


def read_connection(folder: Path) -> dict[str, str] | None:
    """The address and key the app wrote next to this integration."""
    try:
        data = json.loads((folder / ADDON_FILE).read_text())
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and data.get("url") and data.get("token"):
        return {"url": str(data["url"]).rstrip("/"), "token": str(data["token"])}
    return None


class WellbeingApi:
    def __init__(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        self._session = session
        self._url = url.rstrip("/")
        self._token = token

    async def _request(self, method: str, path: str, body: dict | None = None) -> Any:
        try:
            async with self._session.request(
                method, f"{self._url}/api/integration/{path}", json=body,
                headers={"Authorization": f"Bearer {self._token}"}, timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                data = await resp.json(content_type=None)
                if resp.status >= 400:
                    detail = data.get("detail") if isinstance(data, dict) else None
                    raise WellbeingError(detail or f"The Wellbeing app said {resp.status}")
                return data
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise WellbeingError(f"Can't reach the Wellbeing Tracker app: {err}") from err

    async def overview(self) -> dict:
        return await self._request("GET", "overview")

    async def answer(self, user_id: str, reminder_id: int, answer: str, reason: str | None = None) -> dict:
        return await self._request("POST", "answer", {"user_id": user_id, "reminder_id": reminder_id,
                                                       "answer": answer, "reason": reason})

    async def log(self, user_id: str, item: str, value: float) -> dict:
        return await self._request("POST", "log", {"user_id": user_id, "item": item, "value": value})

    async def wake(self, user_id: str, at: str | None = None, source: str | None = None) -> dict:
        return await self._request("POST", "wake", {"user_id": user_id, "at": at, "source": source})

    async def log_dose(self, user_id: str, medication: str, quantity: float | None = None) -> dict:
        return await self._request("POST", "log_dose", {"user_id": user_id, "medication": medication,
                                                         "quantity": quantity})
