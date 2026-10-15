"""Estimating nights from the home, using four real nights from a Home Assistant install."""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app import sleep

TZ = ZoneInfo("Australia/Sydney")

LIGHT = [  # light.bedroom_light_ceiling (unavailable/unknown blips included, as HA records them)
    ("2026-10-11T17:00:00+11:00", "on"), ("2026-10-12T02:08:14+11:00", "off"), ("2026-10-12T02:24:35+11:00", "on"),
    ("2026-10-12T02:26:01+11:00", "off"), ("2026-10-12T08:30:01+11:00", "on"), ("2026-10-12T15:01:08+11:00", "off"),
    ("2026-10-12T15:05:07+11:00", "on"), ("2026-10-13T15:22:40+11:00", "unavailable"), ("2026-10-13T15:22:40+11:00", "unknown"),
    ("2026-10-13T15:23:47+11:00", "on"), ("2026-10-13T23:17:25+11:00", "unavailable"), ("2026-10-13T23:18:36+11:00", "on"),
    ("2026-10-14T01:15:26+11:00", "off"), ("2026-10-14T01:17:02+11:00", "on"), ("2026-10-14T01:26:09+11:00", "off"),
    ("2026-10-14T01:30:32+11:00", "on"), ("2026-10-14T01:31:19+11:00", "off"), ("2026-10-14T02:01:32+11:00", "unavailable"),
    ("2026-10-14T02:07:36+11:00", "off"), ("2026-10-14T05:32:34+11:00", "on"), ("2026-10-14T05:33:29+11:00", "off"),
    ("2026-10-14T06:46:27+11:00", "on"), ("2026-10-14T23:08:10+11:00", "unavailable"), ("2026-10-14T23:08:46+11:00", "on"),
    ("2026-10-15T02:15:37+11:00", "off"), ("2026-10-15T07:30:44+11:00", "on"), ("2026-10-15T10:41:38+11:00", "off"),
]
CHARGING = [  # binary_sensor.my_phone_is_charging
    ("2026-10-11T17:00:00+11:00", "off"), ("2026-10-12T01:57:04+11:00", "on"), ("2026-10-12T15:01:51+11:00", "off"),
    ("2026-10-13T02:16:40+11:00", "on"), ("2026-10-13T02:16:59+11:00", "off"), ("2026-10-13T02:17:16+11:00", "on"),
    ("2026-10-13T10:46:54+11:00", "off"), ("2026-10-14T01:17:38+11:00", "on"), ("2026-10-14T06:48:10+11:00", "off"),
    ("2026-10-15T02:15:17+11:00", "on"), ("2026-10-15T09:47:21+11:00", "off"),
]
SEGMENTS = [  # Android sleep segments (start, end in ms)
    (1791733604896, 1791753764896), (1791819644896, 1791841604896),
    (1791903524896, 1791919724896), (1791991724896, 1792009364896),
]


def rows(pairs):
    return [{"state": s, "last_changed": t} for t, s in pairs]


def seg_nights():
    return sleep.nights_from_segments([{"state": "1", "attributes": {"start": s, "end": e, "status": "successful"}} for s, e in SEGMENTS])


def guess(**kw):
    now = datetime(2026, 10, 15, 15, 0, tzinfo=TZ).astimezone(timezone.utc)
    nights = sleep.nights_from_home({"lights": [rows(LIGHT)], "charging": rows(CHARGING)}, TZ, now, 4, **kw)
    return {sleep.summary(n, TZ)["night"]: sleep.summary(n, TZ) for n in nights}


def hhmm(iso):
    return iso[11:16]


def test_lights_and_charging_mark_bed_and_up():
    nights = guess()
    assert set(nights) == {"2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"}
    n = nights["2026-10-12"]
    assert (hhmm(n["start"]), hhmm(n["end"])) == ("02:08", "08:30")  # a light on for a minute at 2:24am doesn't count
    n = nights["2026-10-14"]
    assert (hhmm(n["start"]), hhmm(n["end"])) == ("01:17", "06:46")  # in bed once the phone's on charge; 5:32am light is too short to count
    n = nights["2026-10-15"]
    assert (hhmm(n["start"]), hhmm(n["end"])) == ("02:15", "07:30")


def test_a_light_left_on_all_night_is_ignored():
    # 13 Oct: the light stayed on all night, so the phone on charge decides
    n = guess()["2026-10-13"]
    assert hhmm(n["start"]) == "02:16"
    assert [w["what"] for w in n["why"]][0] == "Phone on charge"


def test_android_says_when_you_were_asleep():
    nights = guess(segments=seg_nights())
    n = nights["2026-10-15"]
    assert n["fell_asleep_after"] == 13  # in bed 2:15, asleep 2:28
    assert n["asleep"] == 294  # 2:28 to 7:22
    assert n["totals"]["awake"] == 13 + 8
    # 13 Oct: only the charger, left in till 10:46; up within an hour of waking at 8:46
    n = nights["2026-10-13"]
    assert hhmm(n["end"]) == "09:46"
    assert [w["what"] for w in n["why"]] == ["Phone on charge", "Asleep", "Awake"]


def test_sleep_confidence_when_no_segments():
    conf = [("2026-10-15T02:20:00+11:00", "40"), ("2026-10-15T02:40:00+11:00", "85"), ("2026-10-15T02:46:00+11:00", "90"),
            ("2026-10-15T06:50:00+11:00", "92"), ("2026-10-15T07:10:00+11:00", "20")]
    n = guess(confidence=rows(conf))["2026-10-15"]
    assert n["fell_asleep_after"] == 24
    assert hhmm(n["end"]) == "07:30"
    assert n["asleep"] == 270  # 2:40 to 7:10


def test_no_night_while_still_in_bed():
    now = datetime(2026, 10, 15, 6, 0, tzinfo=TZ)
    nights = sleep.nights_from_home({"lights": [rows(LIGHT)], "charging": rows(CHARGING)}, TZ, now, 1)
    assert all(sleep.summary(n, TZ)["night"] != "2026-10-15" for n in nights)


def test_engine_estimates_lets_you_adjust_and_prefers_sleep_as_android(tmp_path):
    import asyncio

    from app.db import Database
    from app.engine import Engine

    from .test_engine import Clock, FakeHA

    db = Database(tmp_path / "w.db")
    db.migrate()
    db.touch_user("u1", "matt", "Matthew")
    ha = FakeHA()

    async def get_history(entity_id, start, end, attributes=False):
        if entity_id.startswith("light."):
            return rows(LIGHT)
        if entity_id.endswith("is_charging"):
            return rows(CHARGING)
        if entity_id.endswith("sleep_segment"):
            return [{"state": "1", "attributes": {"start": s, "end": e, "status": "successful"}} for s, e in SEGMENTS]
        return []
    ha.get_history = get_history
    engine = Engine(db, ha, tz=TZ, clock=Clock("2026-10-15T15:00"))
    tracker = next(t for t in db.list_trackers("u1") if t["kind"] == "sleep")
    db.update_tracker("u1", tracker["id"], {"config": {"nights": {
        "lights": ["light.bedroom_light_ceiling"], "charging": "binary_sensor.my_phone_is_charging",
        "segments": "sensor.my_phone_sleep_segment"}}})
    asyncio.run(engine.sync_nights(days=4))
    asyncio.run(engine.sync_nights(days=4))  # again: estimates are replaced, not doubled
    view = engine.sleep_view("u1")
    by = {n["night"]: n for n in view["nights"]}
    assert set(by) == {"2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"}
    assert by["2026-10-15"]["source"] == "home" and by["2026-10-15"]["estimate"]
    assert by["2026-10-15"]["why"][0]["what"] in ("Lights out", "Phone on charge")
    [entry] = db.list_entries("u1", "2026-10-15", "2026-10-15")
    assert entry["value_json"]["hours"] == 4.9 and entry["source"] == "ha"

    # your own times win, and fill in Sleep hours
    engine.set_night("u1", "2026-10-15", "2026-10-15T01:30:00+11:00", "2026-10-15T08:00:00+11:00")
    asyncio.run(engine.sync_nights(days=4))
    n = {x["night"]: x for x in engine.sleep_view("u1")["nights"]}["2026-10-15"]
    assert n["source"] == "you" and n["asleep"] == 390
    assert db.list_entries("u1", "2026-10-15", "2026-10-15")[0]["value_json"]["hours"] == 6.5

    # not a night: the morning is left empty, and so are its Sleep hours
    engine.remove_night("u1", "2026-10-14")
    assert "2026-10-14" not in {x["night"] for x in engine.sleep_view("u1")["nights"]}
    assert db.list_entries("u1", "2026-10-14", "2026-10-14") == []
    engine.reset_night("u1", "2026-10-14")
    assert "2026-10-14" in {x["night"] for x in engine.sleep_view("u1")["nights"]}
    assert db.list_entries("u1", "2026-10-14", "2026-10-14")[0]["source"] == "ha"


def test_suggested_sources():
    from app.api import suggest_sleep_sources
    states = [{"entity_id": e, "attributes": {"friendly_name": n}} for e, n in [
        ("sensor.old_phone_sleep_confidence", "Old"), ("sensor.my_phone_sleep_confidence", "Mine"),
        ("sensor.my_phone_sleep_segment", "Seg"), ("binary_sensor.my_phone_is_charging", "Charging"),
        ("light.kitchen", "Kitchen"), ("light.ceiling_2", "Bedroom Light"), ("event.x_sleep_tracking_2", "T")]]
    s = suggest_sleep_sources(states)
    assert s["confidence"] == "sensor.my_phone_sleep_confidence"
    assert s["charging"] == "binary_sensor.my_phone_is_charging"
    assert s["lights"] == ["light.ceiling_2"] and s["in_use"] is None and s["tracking"] == "event.x_sleep_tracking_2"
