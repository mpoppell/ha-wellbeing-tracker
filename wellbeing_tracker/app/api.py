"""JSON API used by the app's screens. Every route acts as the signed-in person."""

from __future__ import annotations

import re
from datetime import date

from fastapi import APIRouter, Body, Depends, Query, Request

from .db import Database
from .trackers import SEVERITY_LABELS, ValidationError


def _numeric(value) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


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

    @router.post("/sections/rename")
    def rename_section(
        request: Request, payload: dict = Body(...), user: dict = Depends(current_user), d: Database = Depends(db)
    ) -> dict:
        old = str(payload.get("from") or "")
        new = str(payload.get("to") or "").strip()[:40]
        moved = d.rename_group(user["id"], old, new)
        e = request.app.state.engine
        dash = e.get_person(user["id"])["dashboard"]
        sections = [{**sec, "name": new} if sec["name"] == old else sec for sec in dash["sections"]]
        e.save_person(user["id"], {"dashboard": {"sections": sections}})
        return {"moved": moved, "name": new}

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
        await request.app.state.engine.checkin_logged(user["id"])
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

    @router.post("/trackers/{tracker_id}/schedule/preview")
    async def preview_schedule(tracker_id: int, user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        return {"sent_to": await e.send_preview(user["id"], tracker_id)}

    @router.post("/trackers/{tracker_id}/source/fill")
    async def fill_from_ha(tracker_id: int, payload: dict = Body(default={}), user: dict = Depends(current_user),
                           e=Depends(engine), d: Database = Depends(db)) -> dict:
        d.get_tracker(user["id"], tracker_id)  # NotFound if not theirs
        days = max(1, min(90, int(payload.get("days") or 30)))
        return {"days": await e.sync_sources(days=days, user_id=user["id"], tracker_id=tracker_id)}

    @router.get("/sleep")
    async def sleep(request: Request, days: int = 14, user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        view = e.sleep_view(user["id"], max(1, min(120, days)))
        # suggest the right Home Assistant entities, so setting up is one tap
        states = await request.app.state.ha.get_states()
        view["suggested"] = suggest_sleep_sources(states)
        return view

    @router.put("/sleep/nights/{night}")
    def set_night(night: str, payload: dict = Body(...), user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        return e.set_night(user["id"], _day(night), payload.get("start"), payload.get("end"),
                           payload.get("bed"), payload.get("up"))

    @router.delete("/sleep/nights/{night}")
    def remove_night(night: str, user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        return e.remove_night(user["id"], _day(night))

    @router.post("/sleep/nights/{night}/reset")
    def reset_night(night: str, user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        return e.reset_night(user["id"], _day(night))

    @router.post("/sleep/import")
    async def sleep_import(user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        """Fetch everything Home Assistant still has (about ten days)."""
        return {"nights": await e.sync_nights(days=10, user_id=user["id"])}

    @router.get("/encouragement")
    def encouragement(user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        return e.encouragement(user["id"])

    @router.get("/inbox")
    def inbox(user: dict = Depends(current_user), e=Depends(engine)) -> list[dict]:
        return e.inbox(user["id"])

    @router.post("/inbox/{reminder_id}")
    async def answer_inbox(reminder_id: int, payload: dict = Body(...), user: dict = Depends(current_user),
                           e=Depends(engine)) -> list[dict]:
        verb = str(payload.get("verb") or "")
        if not re.match(r"^[A-Z]+(_\d+)?$", verb):
            raise ValidationError("Unknown answer")
        await e.answer_from_app(user["id"], reminder_id, verb, payload.get("reason"))
        await e.tick()
        return e.inbox(user["id"])

    @router.get("/supply")
    def supply_overview(user: dict = Depends(current_user), e=Depends(engine)) -> list[dict]:
        return e.supply_overview(user["id"])

    @router.get("/trackers/{tracker_id}/supply")
    def get_supply(tracker_id: int, user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        return e.get_supply(user["id"], tracker_id)

    @router.put("/trackers/{tracker_id}/supply")
    def put_supply(tracker_id: int, payload: dict = Body(...), user: dict = Depends(current_user),
                   e=Depends(engine)) -> dict:
        return e.save_supply(user["id"], tracker_id, payload)

    @router.post("/trackers/{tracker_id}/supply/refill")
    def refill(tracker_id: int, payload: dict = Body(...), user: dict = Depends(current_user),
               e=Depends(engine)) -> dict:
        return e.refill(user["id"], tracker_id, payload)

    @router.get("/doses/today")
    async def doses_today(user: dict = Depends(current_user), e=Depends(engine)) -> list[dict]:
        await e.tick()
        return e.doses_today(user["id"])

    @router.get("/checkins/next")
    def next_checkin(user: dict = Depends(current_user), e=Depends(engine)) -> dict:
        return {"time": e.next_checkin(user["id"])}

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
        has_bell = any(s.get("domain") == "persistent_notification" for s in services) or "persistent_notification" in notify
        phones, others = [], []
        for svc in sorted(notify):
            if svc.startswith("mobile_app_"):
                suffix = svc[len("mobile_app_"):]
                tracker = by_id.get(f"device_tracker.{suffix}")
                label = tracker.get("attributes", {}).get("friendly_name") if tracker else None
                phones.append({"service": svc, "name": label or humanise(suffix)})
            elif svc not in ("notify", "send_message", "persistent_notification"):
                others.append({"id": svc, "name": humanise(svc), "kind": "service", "buttons": False})
        # Every place a reminder can go. Only Companion app phones can show buttons.
        targets = [{"id": p["service"], "name": p["name"], "kind": "phone", "buttons": True} for p in phones]
        targets += [{"id": s["entity_id"], "name": name_of(s["entity_id"]), "kind": "entity", "buttons": False}
                    for s in sorted(states, key=lambda x: x.get("entity_id", ""))
                    if s.get("entity_id", "").startswith("notify.")]
        targets += others
        if has_bell:
            targets.append({"id": "persistent_notification", "name": "Home Assistant notifications",
                            "kind": "ha", "buttons": False})

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
            "targets": targets,
            "speakers": entities("media_player"),
            "voices": entities("tts"),
            "toggles": entities("input_boolean"),
            "datetimes": [
                x for x in entities("input_datetime")
                if by_id.get(x["entity_id"], {}).get("attributes", {}).get("has_date")
                and by_id.get(x["entity_id"], {}).get("attributes", {}).get("has_time")
            ],
            "people": people,
            "events": entities("event"),
            "lights": entities("light") + entities("switch"),
            "binary_sensors": entities("binary_sensor"),
            # Numbers that can fill in an item: sensors and number helpers with a numeric state or a unit.
            "sensors": sorted(
                ({"entity_id": s["entity_id"], "name": name_of(s["entity_id"]), "state": s.get("state"),
                  "unit": s.get("attributes", {}).get("unit_of_measurement"),
                  "device_class": s.get("attributes", {}).get("device_class"),
                  "state_class": s.get("attributes", {}).get("state_class")}
                 for s in states
                 if s.get("entity_id", "").split(".")[0] in ("sensor", "input_number", "number")
                 and (s.get("attributes", {}).get("unit_of_measurement") or _numeric(s.get("state")))),
                key=lambda x: x["name"].lower()),
        }

    @router.patch("/entries/{entry_id}")
    async def update_entry(
        request: Request, entry_id: int, payload: dict = Body(...), user: dict = Depends(current_user),
        d: Database = Depends(db),
    ) -> dict:
        entry = d.update_entry(user["id"], entry_id, payload)
        if "logged_at" in payload:
            await request.app.state.engine.entry_changed(user["id"], entry_id)
        return entry

    @router.delete("/entries/{entry_id}")
    def delete_entry(entry_id: int, user: dict = Depends(current_user), d: Database = Depends(db)) -> dict:
        d.delete_entry(user["id"], entry_id)
        return {"ok": True}

    return router


def _day(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise ValidationError("Not a date") from None


def suggest_sleep_sources(states: list[dict]) -> dict:
    """The entities most likely to help, from what's in Home Assistant. Phone sensors from the
    same phone as the sleep segment sensor come first."""
    ids = [s.get("entity_id", "") for s in states]
    names = {s.get("entity_id", ""): str((s.get("attributes") or {}).get("friendly_name") or "") for s in states}
    pick = lambda pred, prefer="": next((i for i in sorted(ids, key=lambda x: not x.startswith(prefer)) if pred(i)), None)  # noqa: E731
    segments = pick(lambda i: i.startswith("sensor.") and i.endswith("sleep_segment"))
    phone = segments[len("sensor."):-len("sleep_segment")] if segments else ""
    bedroom = [i for i in ids if i.startswith("light.") and ("bedroom" in i or "bedroom" in names[i].lower())]
    return {
        "tracking": pick(lambda i: i.startswith("event.") and "sleep_tracking" in i),
        "phases": pick(lambda i: i.startswith("event.") and "sleep_phase" in i),
        "segments": segments,
        "confidence": pick(lambda i: i.startswith("sensor.") and i.endswith("sleep_confidence"), "sensor." + phone),
        "charging": pick(lambda i: i.startswith("binary_sensor.") and i.endswith("_is_charging"), "binary_sensor." + phone),
        "in_use": pick(lambda i: i.startswith("binary_sensor.") and i.endswith("_interactive"), "binary_sensor." + phone),
        "lights": bedroom[:1],
    }
