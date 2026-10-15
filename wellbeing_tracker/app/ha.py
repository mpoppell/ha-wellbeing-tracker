"""Client for the Home Assistant Core API via the Supervisor proxy.

REST is used to call services (notifications, toggles, speakers) and fire
events. A websocket subscription delivers notification button presses and
state changes back to the app.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Awaitable, Callable

import httpx

log = logging.getLogger(__name__)

EventHandler = Callable[[str, dict], Awaitable[None]]


class HomeAssistant:
    def __init__(self, base_url: str, token: str | None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.connected = False
        self._client: httpx.AsyncClient | None = None

    @property
    def configured(self) -> bool:
        return bool(self.token)

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=10,
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _get(self, path: str):
        if not self.token:
            return None
        try:
            resp = await self._http().get(path)
            if resp.status_code == 200:
                return resp.json()
            log.warning("GET %s returned HTTP %s", path, resp.status_code)
        except httpx.HTTPError as err:
            log.warning("GET %s failed: %s", path, err)
        return None

    async def check(self) -> dict:
        if not self.token:
            return {"connected": False, "detail": "No Supervisor token (running outside Home Assistant?)"}
        data = await self._get("/")
        if data is not None:
            return {"connected": True, "detail": "Connected to Home Assistant"}
        return {"connected": False, "detail": "Could not reach Home Assistant"}

    async def get_config(self) -> dict | None:
        return await self._get("/config")

    async def get_states(self) -> list[dict]:
        return await self._get("/states") or []

    async def get_history(self, entity_id: str, start: str, end: str) -> list[dict]:
        """Every recorded state of one entity between two ISO times, oldest first."""
        if not self.token:
            return []
        try:
            resp = await self._http().get(f"/history/period/{start}", params={
                "filter_entity_id": entity_id, "end_time": end, "minimal_response": "", "no_attributes": ""})
            if resp.status_code == 200:
                data = resp.json()
                return data[0] if data else []
            log.warning("History for %s returned HTTP %s", entity_id, resp.status_code)
        except httpx.HTTPError as err:
            log.warning("History for %s failed: %s", entity_id, err)
        return []

    async def get_services(self) -> list[dict]:
        return await self._get("/services") or []

    async def call_service(self, domain: str, service: str, data: dict) -> bool:
        if not self.token:
            log.info("Would call %s.%s (no Home Assistant connection)", domain, service)
            return False
        try:
            resp = await self._http().post(f"/services/{domain}/{service}", json=data)
            if resp.status_code < 300:
                return True
            log.warning("%s.%s returned HTTP %s: %s", domain, service, resp.status_code, resp.text[:200])
        except httpx.HTTPError as err:
            log.warning("%s.%s failed: %s", domain, service, err)
        return False

    async def fire_event(self, event_type: str, data: dict) -> bool:
        if not self.token:
            return False
        try:
            resp = await self._http().post(f"/events/{event_type}", json=data)
            return resp.status_code < 300
        except httpx.HTTPError as err:
            log.warning("Firing %s failed: %s", event_type, err)
            return False

    # ----- websocket -----

    def _ws_url(self) -> str:
        url = self.base_url
        if url.endswith("/api"):
            url = url[: -len("/api")]
        url = url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{url}/websocket"

    async def listen(self, handler: EventHandler, event_types: list[str]) -> None:
        """Stay subscribed to events, reconnecting with backoff. Runs until cancelled."""
        if not self.token:
            log.info("No Home Assistant connection; notification buttons won't be heard")
            return
        import websockets

        delay = 2
        while True:
            try:
                async with websockets.connect(self._ws_url(), max_size=16 * 1024 * 1024) as ws:
                    msg = json.loads(await ws.recv())
                    if msg.get("type") == "auth_required":
                        await ws.send(json.dumps({"type": "auth", "access_token": self.token}))
                        msg = json.loads(await ws.recv())
                    if msg.get("type") != "auth_ok":
                        raise RuntimeError(f"Websocket auth failed: {msg.get('type')}")
                    for i, event_type in enumerate(event_types, start=1):
                        await ws.send(json.dumps({"id": i, "type": "subscribe_events", "event_type": event_type}))
                    self.connected = True
                    delay = 2
                    log.info("Listening to Home Assistant events: %s", ", ".join(event_types))
                    async for raw in ws:
                        msg = json.loads(raw)
                        if msg.get("type") != "event":
                            continue
                        event = msg.get("event", {})
                        try:
                            await handler(event.get("event_type", ""), event.get("data", {}))
                        except Exception:  # never let one bad event drop the connection
                            log.exception("Error handling %s", event.get("event_type"))
            except asyncio.CancelledError:
                self.connected = False
                raise
            except Exception as err:
                self.connected = False
                log.warning("Home Assistant websocket closed (%s); reconnecting in %ss", err, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60)
