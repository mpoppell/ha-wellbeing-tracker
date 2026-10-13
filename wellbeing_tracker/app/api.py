"""JSON API used by the app's screens. Every route acts as the signed-in person."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Body, Depends, Query, Request

from .db import Database
from .trackers import SEVERITY_LABELS, ValidationError


def build_router(current_user) -> APIRouter:
    router = APIRouter(prefix="/api")

    def db(request: Request) -> Database:
        return request.app.state.db

    @router.get("/meta")
    def meta() -> dict:
        return {"severity_labels": SEVERITY_LABELS}

    # ----- trackers -----

    @router.get("/trackers")
    def list_trackers(
        include_hidden: bool = False, user: dict = Depends(current_user), d: Database = Depends(db)
    ) -> list[dict]:
        return d.list_trackers(user["id"], include_hidden)

    @router.post("/trackers", status_code=201)
    def create_tracker(
        payload: dict = Body(...), user: dict = Depends(current_user), d: Database = Depends(db)
    ) -> dict:
        return d.create_tracker(user["id"], payload)

    @router.patch("/trackers/{tracker_id}")
    def update_tracker(
        tracker_id: int,
        payload: dict = Body(...),
        user: dict = Depends(current_user),
        d: Database = Depends(db),
    ) -> dict:
        return d.update_tracker(user["id"], tracker_id, payload)

    @router.post("/trackers/order")
    def reorder(payload: dict = Body(...), user: dict = Depends(current_user), d: Database = Depends(db)) -> dict:
        ids = payload.get("ids")
        if not isinstance(ids, list) or not all(isinstance(i, int) for i in ids):
            raise ValidationError("ids must be a list of tracker ids")
        d.reorder_trackers(user["id"], ids)
        return {"ok": True}

    @router.delete("/trackers/{tracker_id}")
    def delete_tracker(tracker_id: int, user: dict = Depends(current_user), d: Database = Depends(db)) -> dict:
        d.delete_tracker(user["id"], tracker_id)
        return {"ok": True}

    # ----- entries -----

    @router.get("/entries")
    def list_entries(
        from_: str = Query(..., alias="from"),
        to: str = Query(...),
        user: dict = Depends(current_user),
        d: Database = Depends(db),
    ) -> list[dict]:
        try:
            start, end = date.fromisoformat(from_), date.fromisoformat(to)
        except ValueError:
            raise ValidationError("from and to must be dates (YYYY-MM-DD)") from None
        if end < start or (end - start).days > 400:
            raise ValidationError("Date range must be 0–400 days")
        return d.list_entries(user["id"], start.isoformat(), end.isoformat())

    @router.post("/checkin")
    def checkin(payload: dict = Body(...), user: dict = Depends(current_user), d: Database = Depends(db)) -> dict:
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            raise ValidationError("Nothing to save")
        if not all(isinstance(i, dict) for i in items):
            raise ValidationError("Each item must be an object")
        return d.save_checkin(user["id"], payload.get("logged_at"), items)

    @router.patch("/entries/{entry_id}")
    def update_entry(
        entry_id: int, payload: dict = Body(...), user: dict = Depends(current_user), d: Database = Depends(db)
    ) -> dict:
        return d.update_entry(user["id"], entry_id, payload)

    @router.delete("/entries/{entry_id}")
    def delete_entry(entry_id: int, user: dict = Depends(current_user), d: Database = Depends(db)) -> dict:
        d.delete_entry(user["id"], entry_id)
        return {"ok": True}

    return router
