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
    async def checkin(
        request: Request, payload: dict = Body(...), user: dict = Depends(current_user), d: Database = Depends(db)
    ) -> dict:
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            raise ValidationError("Nothing to save")
        if not all(isinstance(i, dict) for i in items):
            raise ValidationError("Each item must be an object")
        result = d.save_checkin(user["id"], payload.get("logged_at"), items)
        meds = {t["id"] for t in d.list_trackers(user["id"], include_hidden=True) if t["kind"] == "medication"}
        logged = [e for e in result["saved"] if e["tracker_id"] in meds]
        if logged:
            await request.app.state.engine.medication_logged(user["id"], logged)
        return result

    # ----- reminders -----

    def engine(request: Request):
        return request.app.state.engine

    @router.get("/reminders/settings")
    def get_reminder_settings(user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        return e.get_person(user["id"])

    @router.put("/reminders/settings")
    def put_reminder_settings(
        payload: dict = Body(...), user: dict = Depends(current_user), e=Depends(engine)
    ) -> dict:
        return e.save_person(user["id"], payload)

    @router.post("/reminders/test")
    async def test_reminder(user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        sent = await e.send_test(user["id"])
        return {"sent_to": sent}

    @router.get("/trackers/{tracker_id}/schedule")
    def get_schedule(tracker_id: int, user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        return e.get_schedule(user["id"], tracker_id)

    @router.put("/trackers/{tracker_id}/schedule")
    async def put_schedule(
        tracker_id: int, payload: dict = Body(...), user: dict = Depends(current_user), e=Depends(engine)
    ) -> dict:
        settings = payload.get("settings")
        if not isinstance(settings, dict):
            raise ValidationError("settings must be an object")
        return await e.save_schedule(user["id"], tracker_id, bool(payload.get("enabled")), settings)

    @router.get("/doses/today")
    async def doses_today(user: dict = Depends(current_user), e=Depends(engine)) -> list[dict]:
        await e.tick()
        return e.doses_today(user["id"])

    @router.post("/doses/{dose_id}")
    async def answer_dose(
        dose_id: int, payload: dict = Body(...), user: dict = Depends(current_user), e=Depends(engine)
    ) -> list[dict]:
        await e.answer_dose(user["id"], dose_id, str(payload.get("action")), payload.get("reason"))
        await e.tick()
        return e.doses_today(user["id"])

    @router.get("/ha/options")
    async def ha_options(request: Request, user: dict = Depends(current_user)) -> dict:
        """Phones, speakers, voices and helpers to choose from in Settings."""
        ha = request.app.state.ha
        states = await ha.get_states()
        services = await ha.get_services()
        by_id = {s.get("entity_id"): s for s in states}

        def name_of(entity_id: str) -> str:
            s = by_id.get(entity_id) or {}
            return s.get("attributes", {}).get("friendly_name") or entity_id

        def humanise(slug: str) -> str:
            return slug.replace("_", " ").strip().title()

        notify = next((s.get("services", {}) for s in services if s.get("domain") == "notify"), {})
        phones = []
        for svc in sorted(notify):
            if not svc.startswith("mobile_app_"):
                continue
            suffix = svc[len("mobile_app_"):]
            tracker = by_id.get(f"device_tracker.{suffix}")
            label = tracker.get("attributes", {}).get("friendly_name") if tracker else None
            phones.append({"service": svc, "name": label or humanise(suffix)})

        def entities(domain: str) -> list[dict]:
            return sorted(
                ({"entity_id": s["entity_id"], "name": name_of(s["entity_id"])}
                 for s in states if s.get("entity_id", "").startswith(domain + ".")),
                key=lambda x: x["name"].lower(),
            )

        people = []
        for s in states:
            if s.get("entity_id", "").startswith("person."):
                people.append({
                    "entity_id": s["entity_id"],
                    "name": name_of(s["entity_id"]),
                    "is_you": s.get("attributes", {}).get("user_id") == user["id"],
                })
        return {
            "connected": bool(states or services),
            "phones": phones,
            "speakers": entities("media_player"),
            "voices": entities("tts"),
            "toggles": entities("input_boolean"),
            "datetimes": [
                x for x in entities("input_datetime")
                if by_id.get(x["entity_id"], {}).get("attributes", {}).get("has_date")
                and by_id.get(x["entity_id"], {}).get("attributes", {}).get("has_time")
            ],
            "people": people,
        }

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
