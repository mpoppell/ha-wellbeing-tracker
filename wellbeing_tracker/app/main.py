"""Wellbeing Tracker web server.

Home Assistant ingress proxies every request from 172.30.32.2 and adds headers
identifying the logged-in Home Assistant user. We trust those headers only
when the request really comes from ingress (or in dev mode).
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import build_router
from .db import Database, NotFound
from .ha import HomeAssistant
from .settings import INGRESS_IP, Settings, load_settings
from .trackers import ValidationError

log = logging.getLogger("wellbeing")

STATIC_DIR = Path(__file__).parent / "static"


def create_app(settings: Settings) -> FastAPI:
    db = Database(settings.db_path)
    version = db.migrate()
    log.info("Database ready at %s (schema v%s)", settings.db_path, version)

    ha = HomeAssistant(settings.ha_api_url, settings.supervisor_token)

    app = FastAPI(title="Wellbeing Tracker", version=__version__, docs_url=None, redoc_url=None)
    app.state.db = db
    app.state.ha = ha
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
        }

    @app.exception_handler(ValidationError)
    async def validation_error(_: Request, exc: ValidationError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=422)

    @app.exception_handler(NotFound)
    async def not_found(_: Request, exc: NotFound) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    app.include_router(build_router(current_user))

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def run() -> None:
    import uvicorn

    settings = load_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = create_app(settings)
    uvicorn.run(app, host="0.0.0.0", port=settings.port, log_level=settings.log_level.lower(), proxy_headers=False)


if __name__ == "__main__":
    run()
