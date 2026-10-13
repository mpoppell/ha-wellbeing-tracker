"""Wellbeing Tracker web server.

Home Assistant ingress proxies every request from 172.30.32.2 and adds headers
identifying the logged-in Home Assistant user. We trust those headers only
when the request really comes from ingress (or in dev mode).
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
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
    uvicorn.run(app, host="0.0.0.0", port=settings.port, log_level=settings.log_level.lower(), proxy_headers=False)


if __name__ == "__main__":
    run()
