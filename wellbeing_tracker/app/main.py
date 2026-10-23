"""Wellbeing Tracker web server.

Home Assistant ingress proxies every request from 172.30.32.2 and adds headers
identifying the logged-in Home Assistant user. We trust those headers only
when the request really comes from ingress (or in dev mode).
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from datetime import datetime

from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from . import companion
from .api import build_router
from .db import Database, NotFound
from .engine import Engine
from .ha import HomeAssistant
from .settings import INGRESS_IP, Settings, load_settings
from .trackers import ValidationError

log = logging.getLogger("wellbeing")

STATIC_DIR = Path(__file__).parent / "static"


def _zone(name: str | None) -> ZoneInfo | None:
    try:
        return ZoneInfo(name) if name else None
    except (ZoneInfoNotFoundError, ValueError):
        return None


def create_app(settings: Settings, background: bool = False) -> FastAPI:
    db = Database(settings.db_path)
    version = db.migrate()
    log.info("Database ready at %s (schema v%s)", settings.db_path, version)

    ha = HomeAssistant(settings.ha_api_url, settings.supervisor_token)
    token = companion.integration_token(settings.data_dir)
    engine = Engine(db, ha, tz=_zone(os.environ.get("TZ")), panel_path=settings.panel_path)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        tasks = []
        if background:
            config = await ha.get_config()
            tz = _zone((config or {}).get("time_zone"))
            if tz:
                engine.tz = tz
            log.info("Reminders use time zone %s", engine.tz.key)
            if settings.hostname and settings.supervisor_token:
                state = companion.install(settings.ha_config_dir, f"http://{settings.hostname}:{settings.port}", token)
                if state in ("installed", "updated"):
                    await ha.call_service("persistent_notification", "create", {
                        "notification_id": "wellbeing_tracker_companion",
                        "title": "Wellbeing Tracker",
                        "message": ("The Wellbeing dashboard card and entities are ready. Restart Home Assistant, then add "
                                    "**Wellbeing Tracker** in Settings → Devices & services."
                                    if state == "installed" else
                                    "The Wellbeing integration was updated. Restart Home Assistant to use the new version."),
                    })
            tasks.append(asyncio.create_task(engine.run()))
            tasks.append(asyncio.create_task(
                ha.listen(engine.handle_event, ["mobile_app_notification_action", "state_changed"])))
        yield
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await ha.close()

    app = FastAPI(title="Wellbeing Tracker", version=__version__, docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.db = db
    app.state.ha = ha
    app.state.engine = engine
    app.state.settings = settings

    @app.middleware("http")
    async def only_from_ingress(request: Request, call_next):
        client_ip = request.client.host if request.client else None
        # The companion integration talks to /api/integration/* with its own key, from Home Assistant itself.
        if request.url.path.startswith("/api/integration/"):
            if secrets.compare_digest(request.headers.get("Authorization", ""), f"Bearer {token}"):
                return await call_next(request)
            return JSONResponse({"detail": "Wrong or missing key"}, status_code=401)
        if not settings.dev_mode and client_ip != INGRESS_IP:
            log.warning("Rejected request from %s (not Home Assistant ingress)", client_ip)
            return JSONResponse({"detail": "Access only through Home Assistant"}, status_code=403)
        return await call_next(request)

    def current_user(request: Request) -> dict:
        user_id = request.headers.get("X-Remote-User-Id")
        if not user_id and settings.dev_mode:
            user_id = request.headers.get("X-Dev-User", "dev-user")
        if not user_id:
            raise HTTPException(status_code=401, detail="No Home Assistant user on this request")
        return db.touch_user(
            user_id,
            request.headers.get("X-Remote-User-Name"),
            request.headers.get("X-Remote-User-Display-Name")
            or request.headers.get("X-Remote-User-Name")
            or ("Developer" if settings.dev_mode else None),
        )

    @app.get("/api/me")
    def me(user: dict = Depends(current_user)) -> dict:
        return {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "first_seen": user["first_seen"],
        }

    @app.get("/api/status")
    async def status(user: dict = Depends(current_user)) -> dict:
        return {
            "version": __version__,
            "schema_version": db.schema_version(),
            "people": db.user_count(),
            "home_assistant": await ha.check(),
            "listening": ha.connected,
            "time_zone": engine.tz.key,
        }

    @app.exception_handler(ValidationError)
    async def validation_error(_: Request, exc: ValidationError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=422)

    @app.exception_handler(NotFound)
    async def not_found(_: Request, exc: NotFound) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    app.include_router(build_router(current_user))

    # ----- for the companion Home Assistant integration (key-protected, see the middleware) -----

    @app.get("/api/integration/overview")
    async def integration_overview() -> dict:
        await engine.tick()
        return {"version": __version__, "panel_path": settings.panel_path,
                "people": [engine.person_overview(u) for u in db.active_users()]}

    def _person(user_id: str) -> dict:
        user = next((u for u in db.list_users() if u["id"] == user_id), None)
        if not user:
            raise NotFound("No such person in Wellbeing")
        return user

    @app.post("/api/integration/answer")
    async def integration_answer(payload: dict = Body(...)) -> dict:
        user = _person(str(payload.get("user_id") or ""))
        verb = str(payload.get("answer") or "").upper()
        verb = {"TAKE": "TAKEN", "DONE": "TAKEN", "NOT_NOW": "SKIP"}.get(verb, verb)
        try:
            rid = int(payload.get("reminder_id"))
        except (TypeError, ValueError):
            raise ValidationError("reminder_id must be a number") from None
        await engine.answer_from_app(user["id"], rid, verb, payload.get("reason"))
        await engine.tick()
        return engine.person_overview(user)

    @app.post("/api/integration/log")
    async def integration_log(payload: dict = Body(...)) -> dict:
        """Log a rating such as Mood from Home Assistant (a dashboard button or a select)."""
        user = _person(str(payload.get("user_id") or ""))
        want = str(payload.get("item") or "").strip().lower()
        items = [t for t in db.list_trackers(user["id"]) if t["kind"] == "rating"]
        item = next((t for t in items if want in (str(t["id"]), (t.get("key") or "").lower(), t["name"].lower())), None)
        if not item:
            raise NotFound(f"No rating called {payload.get('item')!r}")
        db.save_checkin(user["id"], datetime.now(engine.tz).isoformat(timespec="seconds"),
                        [{"tracker_id": item["id"], "value_num": payload.get("value")}], source="homeassistant")
        await engine.checkin_logged(user["id"])
        return engine.person_overview(user)

    @app.post("/api/integration/log_dose")
    async def integration_log_dose(payload: dict = Body(...)) -> dict:
        user = _person(str(payload.get("user_id") or ""))
        meds = [t for t in db.list_trackers(user["id"]) if t["kind"] == "medication"]
        want = str(payload.get("medication") or "").strip().lower()
        med = next((t for t in meds if str(t["id"]) == want or t["name"].lower() == want), None)
        if not med:
            raise NotFound(f"No medication called {payload.get('medication')!r}")
        qty = payload.get("quantity") or med["config"].get("quantity") or 1
        result = db.save_checkin(user["id"], datetime.now(engine.tz).isoformat(timespec="seconds"),
                                 [{"tracker_id": med["id"], "value_num": qty}], source="homeassistant")
        await engine.medication_logged(user["id"], result["saved"])
        return engine.person_overview(user)

    @app.post("/api/integration/wake_source")
    async def integration_wake_source(payload: dict = Body(...)) -> dict:
        """The integration's Awake switch decides when this person is up (or, with no entity_id,
        no longer does and the app goes back to watching the charger)."""
        user = _person(str(payload.get("user_id") or ""))
        entity_id = payload.get("entity_id")
        if entity_id is not None and not (isinstance(entity_id, str) and entity_id.startswith("switch.")):
            raise ValidationError("entity_id must be a switch")
        engine.set_wake_source(user["id"], entity_id)
        return engine.person_overview(user)

    @app.post("/api/integration/wake")
    async def integration_wake(payload: dict = Body(...)) -> dict:
        """'I'm up' from Home Assistant, e.g. an automation that saw you get up. `at` (optional,
        ISO time) is when; it has to be today and not in the future. The first wake-up of the
        day counts; later ones change nothing."""
        user = _person(str(payload.get("user_id") or ""))
        now = engine.clock()
        at = now
        if payload.get("at"):
            try:
                at = datetime.fromisoformat(str(payload["at"]))
            except ValueError:
                raise ValidationError("at must be a date and time") from None
            if at.tzinfo is None:
                at = at.replace(tzinfo=engine.tz)
            if at > now:
                at = now
            if at.astimezone(engine.tz).date() != now.astimezone(engine.tz).date():
                raise ValidationError("at must be today")
        source = str(payload.get("source") or "home assistant").strip()[:40] or "home assistant"
        engine.mark_awake(user["id"], at, source)
        await engine.tick()
        return engine.person_overview(user)

    index_html = (STATIC_DIR / "index.html").read_text().replace("{{v}}", __version__)

    @app.get("/", include_in_schema=False)
    def index() -> HTMLResponse:
        # ?v= on asset URLs makes phones fetch new scripts after an update
        return HTMLResponse(index_html, headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def run() -> None:
    import uvicorn

    settings = load_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per HA call is too chatty
    app = create_app(settings, background=True)
    # The dashboard card asks for an update every 30 seconds; logging each one buries everything else.
    class _QuietPolls(logging.Filter):
        def filter(self, record: logging.LogRecord) -> bool:
            return "/api/integration/overview" not in record.getMessage()
    logging.getLogger("uvicorn.access").addFilter(_QuietPolls())
    uvicorn.run(app, host="0.0.0.0", port=settings.port, log_level=settings.log_level.lower(), proxy_headers=False)


if __name__ == "__main__":
    run()
