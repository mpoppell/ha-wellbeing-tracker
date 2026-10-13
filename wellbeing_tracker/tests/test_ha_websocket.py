"""The websocket listener against a small stand-in for Home Assistant's websocket API."""

import asyncio
import json

import websockets

from app.ha import HomeAssistant


def test_listener_authenticates_subscribes_and_delivers_events():
    received = []
    subscribed = []

    async def fake_ha(ws):
        await ws.send(json.dumps({"type": "auth_required"}))
        auth = json.loads(await ws.recv())
        if auth.get("access_token") != "secret":
            await ws.send(json.dumps({"type": "auth_invalid"}))
            return
        await ws.send(json.dumps({"type": "auth_ok"}))
        for _ in range(2):
            msg = json.loads(await ws.recv())
            subscribed.append(msg["event_type"])
            await ws.send(json.dumps({"id": msg["id"], "type": "result", "success": True}))
        await ws.send(json.dumps({"id": 1, "type": "event", "event": {
            "event_type": "mobile_app_notification_action", "data": {"action": "WBT_TAKEN_5"}}}))
        await asyncio.sleep(1)

    async def main():
        async with websockets.serve(fake_ha, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            ha = HomeAssistant(f"http://127.0.0.1:{port}/api", "secret")
            done = asyncio.Event()

            async def handler(event_type, data):
                received.append((event_type, data))
                done.set()

            task = asyncio.create_task(ha.listen(handler, ["mobile_app_notification_action", "state_changed"]))
            await asyncio.wait_for(done.wait(), 5)
            assert ha.connected
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(main())
    assert subscribed == ["mobile_app_notification_action", "state_changed"]
    assert received == [("mobile_app_notification_action", {"action": "WBT_TAKEN_5"})]


def test_websocket_url_from_api_url():
    assert HomeAssistant("http://supervisor/core/api", "t")._ws_url() == "ws://supervisor/core/websocket"
