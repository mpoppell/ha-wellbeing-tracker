"""Nights Sleep as Android tracks in more than one go, its own record of a night from Life
Dashboard, smoothing the live phases, and going back to sleep after getting up."""

import asyncio
from datetime import datetime, timedelta

from app import sleep
from app.db import Database
from app.engine import Engine

from .test_engine import Clock, FakeHA, dose_rows, schedule
from .test_sleep import SYD, ev
from .test_wake import at, tick_at, wenv  # noqa: F401 - the fixture

RECORD = "sensor.life_dashboard_last_sleep_asleep"


def utc(local: str) -> str:
    return datetime.fromisoformat(local).replace(tzinfo=SYD).astimezone().isoformat()


def local(local_time: str) -> datetime:
    return datetime.fromisoformat(local_time).replace(tzinfo=SYD)


def track(*marks):
    """("00:32", "started"), ... on the night of 9-10 Nov, local times."""
    out = []
    for when, kind in marks:
        day = "2026-11-09" if when >= "12:00" else "2026-11-10"
        out.append(ev(utc(f"{day}T{when}"), kind))
    return out


# 9-10 Nov as Home Assistant recorded it: two false starts, then the night from 1:38 to 8:10.
TUESDAY = track(("00:32", "started"), ("00:48", "stopped"), ("01:04", "started"), ("01:12", "stopped"),
                ("01:38", "started"), ("08:10", "stopped"))
TUESDAY_PHASES = track(("00:40", "deep_sleep"), ("01:45", "light_sleep"), ("02:30", "deep_sleep"),
                       ("02:32", "light_sleep"), ("02:33", "deep_sleep"), ("04:00", "rem"), ("04:20", "light_sleep"),
                       ("06:00", "awake"), ("06:02", "light_sleep"), ("07:50", "awake"))


def test_false_starts_are_left_out():
    [night] = sleep.nights_from_sleep_as_android(TUESDAY, TUESDAY_PHASES, SYD)
    info = sleep.summary(night, SYD)
    assert (info["start"], info["end"]) == ("2026-11-10T01:38+11:00", "2026-11-10T08:10+11:00")


def test_live_phases_are_smoothed():
    [night] = sleep.nights_from_sleep_as_android(TUESDAY, TUESDAY_PHASES, SYD)
    info = sleep.summary(night, SYD)
    # the one-minute "light" at 2:32 joins the deep sleep either side of it, and the two-minute
    # "awake" at 6:00 is folded into light sleep; the 20-minute awake before the alarm stays
    assert [(p["start"][11:16], p["phase"]) for p in info["phases"]] == [
        ("01:38", "awake"), ("01:45", "light"), ("02:30", "deep"), ("04:00", "rem"), ("04:20", "light"),
        ("07:50", "awake")]
    assert any("estimated" in w["what"] for w in info["why"])


def test_smooth_folds_the_shortest_first():
    t0 = local("2026-11-10T01:00")
    m = lambda n: t0 + timedelta(minutes=n)  # noqa: E731
    blocks = [(m(0), m(3), "awake"), (m(3), m(30), "light"), (m(30), m(32), "deep"), (m(32), m(33), "light"),
              (m(33), m(60), "deep")]
    # the one-minute light goes first (deep either side joins up), then the three-minute awake
    assert sleep.smooth(blocks) == [(m(0), m(30), "light"), (m(30), m(60), "deep")]
    assert sleep.smooth([(m(0), m(2), "awake")]) == [(m(0), m(2), "awake")]


# 8-9 Nov: tracked 4:58 to 8:19, back to sleep after the alarm, tracking started again at 8:51 by
# Home Assistant and stopped at 9:59.
MONDAY = [ev(utc("2026-11-09T04:58"), "started"), ev(utc("2026-11-09T08:19"), "stopped"),
          ev(utc("2026-11-09T08:51"), "started"), ev(utc("2026-11-09T09:59"), "stopped")]
MONDAY_PHASES = [ev(utc("2026-11-09T05:13"), "deep_sleep"), ev(utc("2026-11-09T05:18"), "light_sleep"),
                 ev(utc("2026-11-09T08:58"), "light_sleep"), ev(utc("2026-11-09T09:30"), "deep_sleep"),
                 ev(utc("2026-11-09T09:48"), "awake")]


def test_back_to_sleep_after_the_alarm_is_one_night():
    [night] = sleep.nights_from_sleep_as_android(MONDAY, MONDAY_PHASES, SYD)
    info = sleep.summary(night, SYD)
    assert (info["start"], info["end"]) == ("2026-11-09T04:58+11:00", "2026-11-09T09:59+11:00")
    # awake from the alarm until falling asleep again, past the restart at 8:51
    gap = next(p for p in info["phases"] if p["start"].endswith("08:19+11:00"))
    assert gap == {"start": "2026-11-09T08:19+11:00", "end": "2026-11-09T08:58+11:00", "phase": "awake"}
    # 15 min falling asleep, 32 min between the parts, 7 min before sleeping again, 11 min up at the end
    assert info["asleep"] == info["in_bed"] - 15 - 32 - 7 - 11
    assert any("started again" in w["what"] for w in info["why"])


def test_a_short_restart_on_its_own_is_not_a_night():
    lone = [ev(utc("2026-11-09T14:00"), "started"), ev(utc("2026-11-09T14:20"), "stopped")]
    assert sleep.nights_from_sleep_as_android(lone, []) == []


def record_row(start, end, stages, source="com.urbandroid.sleep", hours=6.0):
    return {"state": str(hours), "attributes": {
        "night": end[:10], "start": start, "end": end, "source": source,
        "stages": [{"stage": s, "start": a, "end": b} for s, a, b in stages]}}


MONDAY_RECORD = record_row("2026-11-09T04:58:00+11:00", "2026-11-09T08:19:16+11:00", [
    ("awake", "2026-11-09T04:58:00+11:00", "2026-11-09T05:20:00+11:00"),
    ("light", "2026-11-09T05:20:00+11:00", "2026-11-09T06:10:00+11:00"),
    ("deep", "2026-11-09T06:10:00+11:00", "2026-11-09T07:00:00+11:00"),
    ("rem", "2026-11-09T07:00:00+11:00", "2026-11-09T07:30:00+11:00"),
    # nothing 7:30-7:40: a gap in the record is time awake
    ("light", "2026-11-09T07:40:00+11:00", "2026-11-09T08:19:16+11:00"),
], hours=2.8)


def test_records_from_life_dashboard():
    rows = [MONDAY_RECORD, MONDAY_RECORD,  # the same night again changes nothing
            record_row("2026-11-08T23:00:00+11:00", "2026-11-09T06:00:00+11:00",
                       [("sleeping", "2026-11-08T23:00:00+11:00", "2026-11-09T06:00:00+11:00")],
                       source="com.sec.android.app.shealth"),  # another app's night: not Sleep as Android's
            {"state": "7.0", "attributes": {"start": "2026-11-07T23:00:00+11:00", "end": "2026-11-08T06:00:00+11:00"}}]
    [rec] = sleep.records_from_life_dashboard(rows)
    assert [(s.astimezone(SYD).strftime("%H:%M"), p) for s, _, p in rec["phases"]] == [
        ("04:58", "awake"), ("05:20", "light"), ("06:10", "deep"), ("07:00", "rem"), ("07:30", "awake"), ("07:40", "light")]


def test_sleep_as_androids_own_record_replaces_the_estimate():
    records = sleep.records_from_life_dashboard([MONDAY_RECORD])
    [night] = sleep.nights_from_sleep_as_android(MONDAY, MONDAY_PHASES, SYD, records=records)
    info = sleep.summary(night, SYD)
    assert info["start"] == "2026-11-09T04:58+11:00" and info["end"] == "2026-11-09T09:59+11:00"
    first = [(p["start"][11:16], p["phase"]) for p in info["phases"]][:6]
    assert first == [("04:58", "awake"), ("05:20", "light"), ("06:10", "deep"), ("07:00", "rem"),
                     ("07:30", "awake"), ("07:40", "light")]
    # the part after the alarm has no record yet: still estimated, and the night says so
    assert night["estimated"] is True
    alone = sleep.nights_from_sleep_as_android(MONDAY[:2], MONDAY_PHASES, SYD, records=records)
    assert alone[0]["estimated"] is False and not any("estimated" in w["what"] for w in alone[0].get("why", []))


def test_a_record_without_tracking_events_is_still_a_night():
    """Home Assistant missed the night's events altogether; Life Dashboard still has the record."""
    records = sleep.records_from_life_dashboard([MONDAY_RECORD])
    [night] = sleep.nights_from_sleep_as_android([], [], SYD, records=records)
    assert sleep.summary(night, SYD)["asleep"] == 50 + 50 + 30 + 39


def test_engine_finds_life_dashboard_and_uses_the_record(tmp_path):
    db = Database(tmp_path / "w.db")
    db.migrate()
    db.touch_user("u1", "matt", "Matthew")
    ha = FakeHA()
    ha.states.append({"entity_id": RECORD, "state": "unknown", "attributes": {"unit_of_measurement": "h"}})
    history = {"event.sleep_as_android_sleep_tracking_2": MONDAY[:2], "event.sleep_as_android_sleep_phase_2": MONDAY_PHASES}

    async def get_history(entity_id, start, end, attributes=False):
        return history.get(entity_id, [])
    ha.get_history = get_history
    engine = Engine(db, ha, tz=SYD, clock=Clock("2026-11-09T12:00"))
    tracker = next(t for t in db.list_trackers("u1") if t["kind"] == "sleep")
    db.update_tracker("u1", tracker["id"], {"config": {"nights": {
        "tracking": "event.sleep_as_android_sleep_tracking_2", "phases": "event.sleep_as_android_sleep_phase_2"}}})
    asyncio.run(engine.sync_nights())
    [before] = engine.sleep_view("u1")["nights"]
    assert any("estimated" in w["what"] for w in before["why"])
    # Life Dashboard has it now. Its stages are only in the current state, never in history.
    ha.states[-1] = {"entity_id": RECORD, **MONDAY_RECORD}
    asyncio.run(engine.sync_nights())
    [after] = engine.sleep_view("u1")["nights"]
    assert after["night"] == "2026-11-09" and after["totals"]["deep"] == 50
    assert not any("estimated" in w["what"] for w in after["why"])
    [entry] = db.list_entries("u1", "2026-11-09", "2026-11-09")
    assert entry["value_json"]["hours"] == round((50 + 50 + 30 + 39) / 60, 2)
    # the next night replaces it in Home Assistant; the app still has Monday's record
    ha.states[-1] = {"entity_id": RECORD, **record_row("2026-11-09T23:30:00+11:00", "2026-11-10T07:00:00+11:00",
                                                       [("light", "2026-11-09T23:30:00+11:00", "2026-11-10T07:00:00+11:00")])}
    asyncio.run(engine.sync_nights())
    monday = next(n for n in engine.sleep_view("u1")["nights"] if n["night"] == "2026-11-09")
    assert monday["totals"]["deep"] == 50


# ----- back to sleep after getting up -----

def test_back_to_sleep_waits_for_the_next_wake_up(wenv):  # noqa: F811
    db, ha, clock, engine, med = wenv
    v = med("Vyvanse")
    schedule(engine, v["id"], mode="wake", wake_after=60)
    engine.set_wake_source("u1", "switch.wellbeing_pops_awake")
    clock.set("2026-10-14T08:30")
    engine.mark_awake("u1", datetime.fromisoformat(at("2026-10-14T08:19")), "phone in use")
    tick_at(engine, clock, "2026-10-14T08:30")
    [d] = dose_rows(db, v["id"])
    assert d["local_time"] == "09:19" and d["status"] == "scheduled"
    clock.set("2026-10-14T08:51")
    status = engine.back_to_sleep("u1", datetime.fromisoformat(at("2026-10-14T08:35")))
    assert status["woke_at"] is None
    assert dose_rows(db, v["id"]) == []  # not sent yet: waits for the real wake-up
    clock.set("2026-10-14T09:59")
    engine.mark_awake("u1", datetime.fromisoformat(at("2026-10-14T09:48")), "phone in use")
    tick_at(engine, clock, "2026-10-14T09:59")
    [d] = dose_rows(db, v["id"])
    assert d["local_time"] == "10:48"
    assert engine.wake_status("u1")["woke_at"] == "09:48"


def test_a_dose_already_sent_stays(wenv):  # noqa: F811
    db, ha, clock, engine, med = wenv
    v = med("Vyvanse")
    schedule(engine, v["id"], mode="wake")
    engine.set_wake_source("u1", "switch.wellbeing_pops_awake")
    clock.set("2026-10-14T08:30")
    engine.mark_awake("u1", datetime.fromisoformat(at("2026-10-14T08:19")), "phone in use")
    tick_at(engine, clock, "2026-10-14T08:30")
    assert [d["status"] for d in dose_rows(db, v["id"])] == ["due"]
    engine.back_to_sleep("u1", datetime.fromisoformat(at("2026-10-14T08:35")))
    assert [d["status"] for d in dose_rows(db, v["id"])] == ["due"]


def test_asleep_from_home_assistant(tmp_path):
    from .test_integration_api import setup
    from .conftest import user_headers
    _, token, ingress, core = setup(tmp_path)
    auth = {"Authorization": f"Bearer {token}"}
    ingress.get("/api/me", headers=user_headers("u1"))
    up = core.post("/api/integration/wake", headers=auth, json={"user_id": "u1"}).json()
    assert up["wake"]["woke_at"] is not None
    back = core.post("/api/integration/asleep", headers=auth, json={"user_id": "u1"}).json()
    assert back["wake"]["woke_at"] is None
    again = core.post("/api/integration/wake", headers=auth, json={"user_id": "u1", "source": "phone in use"}).json()
    assert again["wake"]["source"] == "phone in use"
    assert core.post("/api/integration/asleep", headers=auth, json={"user_id": "u1", "at": "nope"}).status_code == 422
    assert core.post("/api/integration/asleep", headers=auth, json={"user_id": "nobody"}).status_code == 404


# ----- trimming a tracked night -----

def trim_env(tmp_path):
    db = Database(tmp_path / "w.db")
    db.migrate()
    db.touch_user("u1", "matt", "Matthew")
    ha = FakeHA()
    ha.states.append({"entity_id": RECORD, **MONDAY_RECORD})
    history = {"event.sleep_as_android_sleep_tracking_2": MONDAY, "event.sleep_as_android_sleep_phase_2": MONDAY_PHASES}

    async def get_history(entity_id, start, end, attributes=False):
        return history.get(entity_id, [])
    ha.get_history = get_history
    engine = Engine(db, ha, tz=SYD, clock=Clock("2026-11-09T12:00"))
    tracker = next(t for t in db.list_trackers("u1") if t["kind"] == "sleep")
    db.update_tracker("u1", tracker["id"], {"config": {"nights": {
        "tracking": "event.sleep_as_android_sleep_tracking_2", "phases": "event.sleep_as_android_sleep_phase_2"}}})
    asyncio.run(engine.sync_nights())
    return db, engine


def hours(db):
    [entry] = db.list_entries("u1", "2026-11-09", "2026-11-09")
    return entry["value_json"]["hours"]


def test_trim_counts_only_the_part_you_choose(tmp_path):
    db, engine = trim_env(tmp_path)
    [whole] = engine.sleep_view("u1")["nights"]
    assert (whole["start"], whole["end"]) == ("2026-11-09T04:58+11:00", "2026-11-09T09:59+11:00")
    view = engine.trim_night("u1", "2026-11-09", local("2026-11-09T05:20").isoformat(), local("2026-11-09T09:48").isoformat())
    [n] = view["nights"]
    assert (n["start"], n["end"]) == ("2026-11-09T05:20+11:00", "2026-11-09T09:48+11:00")
    assert n["trimmed"]["tracked_start"] == "2026-11-09T04:58+11:00" and n["trimmed"]["tracked_end"] == "2026-11-09T09:59+11:00"
    # the phases inside are Sleep as Android's, untouched; only the ends are cut
    assert [(p["start"][11:16], p["end"][11:16], p["phase"]) for p in n["phases"]][:3] == [
        ("05:20", "06:10", "light"), ("06:10", "07:00", "deep"), ("07:00", "07:30", "rem")]
    assert n["totals"]["deep"] == whole["totals"]["deep"] and n["asleep"] == whole["asleep"]  # only awake time left out
    assert n["in_bed"] == whole["in_bed"] - 22 - 11
    assert any("Trimmed by you" in w["what"] for w in n["why"])
    assert hours(db) == round(n["asleep"] / 60, 2)


def test_trimming_into_sleep_reduces_it(tmp_path):
    db, engine = trim_env(tmp_path)
    [whole] = engine.sleep_view("u1")["nights"]
    [n] = engine.trim_night("u1", "2026-11-09", local("2026-11-09T04:58").isoformat(),
                            local("2026-11-09T06:40").isoformat())["nights"]
    assert n["totals"]["deep"] == 30 and n["asleep"] == 50 + 30
    assert hours(db) == round(80 / 60, 2)
    [back] = engine.untrim_night("u1", "2026-11-09")["nights"]
    assert back["asleep"] == whole["asleep"] and "trimmed" not in back
    assert hours(db) == round(whole["asleep"] / 60, 2)


def test_a_trim_can_only_shorten_and_survives_updates(tmp_path):
    import pytest
    from app.trackers import ValidationError
    db, engine = trim_env(tmp_path)
    with pytest.raises(ValidationError, match="only shorten"):
        engine.trim_night("u1", "2026-11-09", local("2026-11-09T04:00").isoformat(), local("2026-11-09T09:00").isoformat())
    with pytest.raises(ValidationError, match="30 minutes"):
        engine.trim_night("u1", "2026-11-09", local("2026-11-09T06:00").isoformat(), local("2026-11-09T06:20").isoformat())
    with pytest.raises(ValidationError, match="before it stops"):
        engine.trim_night("u1", "2026-11-09", local("2026-11-09T07:00").isoformat(), local("2026-11-09T06:00").isoformat())
    engine.trim_night("u1", "2026-11-09", local("2026-11-09T05:20").isoformat(), local("2026-11-09T09:48").isoformat())
    asyncio.run(engine.sync_nights())  # Home Assistant updating the night keeps your trim
    [n] = engine.sleep_view("u1")["nights"]
    assert (n["start"], n["end"]) == ("2026-11-09T05:20+11:00", "2026-11-09T09:48+11:00")
    [reset] = engine.reset_night("u1", "2026-11-09")["nights"]  # "use Home Assistant's times" undoes it
    assert reset["start"] == "2026-11-09T04:58+11:00" and "trimmed" not in reset


def test_trim_through_the_api(matt):
    assert matt.put("/api/sleep/nights/2026-11-09/trim", json={"start": "2026-11-09T05:00:00+11:00",
                                                               "end": "2026-11-09T08:00:00+11:00"}).status_code == 422
    assert matt.delete("/api/sleep/nights/2026-11-09/trim").status_code == 200
