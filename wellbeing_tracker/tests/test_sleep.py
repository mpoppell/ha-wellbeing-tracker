"""Nights of sleep from Sleep as Android and Android's sleep detection."""

import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

from app import sleep
from app.db import Database
from app.engine import Engine

from .test_engine import Clock, FakeHA

SYD = ZoneInfo("Australia/Sydney")


def ev(when_utc, kind, recorded=None):
    return {"state": when_utc, "attributes": {"event_type": kind}, "last_changed": recorded or when_utc}


# Matthew's night of 13-14 Oct 2026, as Home Assistant recorded it (times UTC)
TRACKING = [
    ev("2026-10-05T21:00:31.208+00:00", "stopped"),                                 # an older night
    ev("2026-10-05T21:00:31.208+00:00", "stopped", "2026-10-13T04:22:40+00:00"),    # re-recorded on restart
    ev("2026-10-13T14:51:03.779+00:00", "started"),
    ev("2026-10-13T19:03:50.168+00:00", "stopped"),
    ev("2026-10-13T19:03:50.168+00:00", "stopped", "2026-10-13T21:40:25+00:00"),
]
PHASES = [
    ev("2026-10-05T20:40:36.402+00:00", "rem"),
    ev("2026-10-13T14:56:13.393+00:00", "deep_sleep"),
    ev("2026-10-13T15:38:23.663+00:00", "light_sleep"),
    ev("2026-10-13T15:43:33.519+00:00", "deep_sleep"),
    ev("2026-10-13T16:08:53.962+00:00", "rem"),
    ev("2026-10-13T16:15:03.692+00:00", "deep_sleep"),
    ev("2026-10-13T17:35:34.419+00:00", "light_sleep"),
    ev("2026-10-13T18:30:00.000+00:00", "awake"),
    ev("2026-10-13T18:40:00.000+00:00", "light_sleep"),
    ev("2026-10-13T19:03:43.925+00:00", "light_sleep"),
    ev("2026-10-13T19:03:43.925+00:00", "light_sleep", "2026-10-14T23:46:02+00:00"),
]


def test_a_night_from_sleep_as_android():
    [night] = sleep.nights_from_sleep_as_android(TRACKING, PHASES)
    info = sleep.summary(night, SYD)
    assert info["night"] == "2026-10-14"
    assert (info["start"], info["end"]) == ("2026-10-14T01:51+11:00", "2026-10-14T06:03+11:00")
    assert info["in_bed"] == 253 and info["fell_asleep_after"] == 5
    assert info["totals"] == {"awake": 15, "rem": 6, "light": 83, "deep": 148}
    assert info["asleep"] == 238
    assert [p["phase"] for p in info["phases"]][:4] == ["awake", "deep", "light", "deep"]


def test_unfinished_night_waits_until_it_ends():
    assert sleep.nights_from_sleep_as_android(TRACKING[:3], PHASES) == []


def test_nights_from_android_sleep_segments():
    rows = [{"state": "17640000.0", "attributes": {"start": 1791991724896, "end": 1792009364896, "status": "successful"}}] * 2
    [night] = sleep.nights_from_segments(rows)
    info = sleep.summary(night, SYD)
    assert info["in_bed"] == 294 and info["asleep"] == 294 and info["has_phases"] is False


def test_engine_saves_nights_and_fills_in_sleep(tmp_path):
    db = Database(tmp_path / "w.db")
    db.migrate()
    db.touch_user("u1", "matt", "Matthew")
    ha = FakeHA()

    async def get_history(entity_id, start, end, attributes=False):
        return TRACKING if "tracking" in entity_id else PHASES
    ha.get_history = get_history
    clock = Clock("2026-10-14T09:00")
    engine = Engine(db, ha, tz=SYD, clock=clock)
    tracker = next(t for t in db.list_trackers("u1") if t["kind"] == "sleep")
    db.update_tracker("u1", tracker["id"], {"config": {"goal": 7.5, "nights": {
        "tracking": "event.sleep_as_android_sleep_tracking_2", "phases": "event.sleep_as_android_sleep_phase_2"}}})
    assert asyncio.run(engine.sync_nights()) == 1
    assert asyncio.run(engine.sync_nights()) == 0  # nothing new
    view = engine.sleep_view("u1")
    assert view["configured"] and view["goal"] == 7.5
    assert [n["night"] for n in view["nights"]] == ["2026-10-14"]
    [entry] = db.list_entries("u1", "2026-10-14", "2026-10-14")
    assert entry["value_json"]["hours"] == 3.97 and entry["source"] == "ha"


# ----- Home Assistant's Awake switch -----

def sw(state, recorded, since=None, how=None):
    return {"state": state, "last_changed": recorded, "attributes": {"since": since, "how": how}}


AWAKE_SWITCH = [
    sw("on", "2026-10-13T08:00:00+00:00"),
    # the night of 13-14 Oct, again: asleep when tracking started, awake when the phone came off charge
    sw("off", "2026-10-13T14:51:05+00:00", "2026-10-13T14:51:03+00:00", "sleep tracking started"),
    sw("on", "2026-10-13T19:20:00+00:00", "2026-10-13T19:20:00+00:00", "phone off charger"),
    # 14-15 Oct, not tracked: decided half an hour after the lights went off, dated back to them
    sw("off", "2026-10-14T13:30:00+00:00", "2026-10-14T13:00:00+00:00", "phone on charge and lights off"),
    sw("off", "2026-10-14T16:00:00+00:00", "2026-10-14T13:00:00+00:00", "phone on charge and lights off"),  # restart
    sw("on", "2026-10-14T16:20:00+00:00", "2026-10-14T16:20:00+00:00", "manual"),      # up at 3:20am for a bit
    sw("off", "2026-10-14T16:50:00+00:00", "2026-10-14T16:45:00+00:00", "manual"),
    sw("on", "2026-10-14T20:05:00+00:00", "2026-10-14T19:55:00+00:00", "phone in use"),
    # an afternoon nap is not a night
    sw("off", "2026-10-15T04:00:00+00:00", "2026-10-15T04:00:00+00:00", "sleep tracking started"),
    sw("on", "2026-10-15T07:30:00+00:00", "2026-10-15T07:30:00+00:00", "walking"),
    # still asleep: not a night yet
    sw("off", "2026-10-15T12:00:00+00:00", "2026-10-15T12:00:00+00:00", "sleep tracking started"),
]


def test_nights_from_the_awake_switch():
    nights = sleep.nights_from_awake_switch(AWAKE_SWITCH, SYD, datetime(2026, 10, 15, 14, 0, tzinfo=SYD))
    info = [sleep.summary(n, SYD) for n in nights]
    assert [(i["night"], i["start"], i["end"]) for i in info] == [
        ("2026-10-14", "2026-10-14T01:51+11:00", "2026-10-14T06:20+11:00"),
        ("2026-10-15", "2026-10-15T00:00+11:00", "2026-10-15T06:55+11:00"),  # the 3:20am wake-up doesn't split it
    ]
    assert all(i["source"] == "awake_switch" and not i["has_phases"] for i in info)
    assert [w["what"] for w in info[1]["why"]] == ["Asleep: phone on charge and lights off", "Awake: phone in use"]


def test_sleep_as_android_wins_over_the_awake_switch(tmp_path):
    db = Database(tmp_path / "w.db")
    db.migrate()
    db.touch_user("u1", "matt", "Matthew")
    ha = FakeHA()

    async def get_history(entity_id, start, end, attributes=False):
        if entity_id.startswith("switch."):
            return AWAKE_SWITCH
        return TRACKING if "tracking" in entity_id else PHASES
    ha.get_history = get_history
    clock = Clock("2026-10-15T14:00")
    engine = Engine(db, ha, tz=SYD, clock=clock)
    engine.set_wake_source("u1", "switch.wellbeing_pops_awake")
    tracker = next(t for t in db.list_trackers("u1") if t["kind"] == "sleep")
    db.update_tracker("u1", tracker["id"], {"config": {"nights": {
        "tracking": "event.sleep_as_android_sleep_tracking_2", "phases": "event.sleep_as_android_sleep_phase_2"}}})
    asyncio.run(engine.sync_nights(days=3))
    nights = {n["night"]: n for n in engine.sleep_view("u1")["nights"]}
    assert nights["2026-10-14"]["source"] == "sleep_as_android"  # tracked that night: its data, with phases
    assert nights["2026-10-15"]["source"] == "awake_switch"      # not tracked: the switch
    assert nights["2026-10-15"]["estimate"] is True


def test_the_awake_switch_alone_is_enough(tmp_path):
    db = Database(tmp_path / "w.db")
    db.migrate()
    db.touch_user("u1", "matt", "Matthew")
    ha = FakeHA()

    async def get_history(entity_id, start, end, attributes=False):
        return AWAKE_SWITCH
    ha.get_history = get_history
    engine = Engine(db, ha, tz=SYD, clock=Clock("2026-10-15T14:00"))
    engine.set_wake_source("u1", "switch.wellbeing_pops_awake")
    asyncio.run(engine.sync_nights(days=3))
    view = engine.sleep_view("u1")
    assert view["configured"] and view["awake_switch"] == "switch.wellbeing_pops_awake"
    assert [n["source"] for n in view["nights"]] == ["awake_switch", "awake_switch"]


# ----- what Home Assistant actually recorded, 22-29 Oct 2026 (times UTC) -----

def test_a_second_start_mid_night_keeps_the_first():
    # 28-29 Oct: tracking started at 11:25pm; Sleep as Android sent "started" again at 12:54am
    # while still tracking (phases kept coming), then stopped at 5:50am.
    tracking = [ev("2026-10-28T12:25:48.178+00:00", "started"), ev("2026-10-28T13:54:30.019+00:00", "started"),
                ev("2026-10-28T18:50:34.304+00:00", "stopped"),
                ev("2026-10-28T18:50:34.304+00:00", "stopped", "2026-10-28T19:55:09+00:00")]
    phases = [ev("2026-10-28T12:30:57.645+00:00", "deep_sleep"), ev("2026-10-28T13:26:18.520+00:00", "deep_sleep"),
              ev("2026-10-28T13:59:39.970+00:00", "deep_sleep"), ev("2026-10-28T18:49:11.784+00:00", "light_sleep")]
    [night] = sleep.nights_from_sleep_as_android(tracking, phases, SYD)
    info = sleep.summary(night, SYD)
    assert (info["start"], info["end"]) == ("2026-10-28T23:25+11:00", "2026-10-29T05:50+11:00")
    assert info["in_bed"] == 385


def test_a_restart_straight_away_counts_from_the_restart():
    # started, then started again before any sleep was recorded: the first was a false start
    tracking = [ev("2026-10-28T12:00:00+00:00", "started"), ev("2026-10-28T12:10:00+00:00", "started"),
                ev("2026-10-28T19:00:00+00:00", "stopped")]
    phases = [ev("2026-10-28T12:20:00+00:00", "light_sleep")]
    [night] = sleep.nights_from_sleep_as_android(tracking, phases, SYD)
    assert sleep.summary(night, SYD)["start"] == "2026-10-28T23:10+11:00"


def test_a_missed_start_begins_at_the_first_phase():
    # 23-24 Oct: Home Assistant was restarting when tracking began, so it only saw the stop
    tracking = [ev("2026-10-22T13:19:10.109+00:00", "started"), ev("2026-10-22T18:30:41.703+00:00", "stopped"),
                ev("2026-10-22T18:30:41.703+00:00", "stopped", "2026-10-23T16:40:49+00:00"),  # re-recorded on restart
                ev("2026-10-24T01:00:32.781+00:00", "stopped")]
    phases = [ev("2026-10-22T13:30:00+00:00", "deep_sleep"), ev("2026-10-22T18:00:00+00:00", "light_sleep"),
              ev("2026-10-23T16:44:50.593+00:00", "light_sleep"), ev("2026-10-23T17:29:31.566+00:00", "deep_sleep"),
              ev("2026-10-24T00:45:54.347+00:00", "awake")]
    first, second = sleep.nights_from_sleep_as_android(tracking, phases, SYD)
    assert sleep.summary(first, SYD)["start"] == "2026-10-23T00:19+11:00"
    info = sleep.summary(second, SYD)
    assert (info["night"], info["start"], info["end"]) == ("2026-10-24", "2026-10-24T03:44+11:00", "2026-10-24T12:00+11:00")
    assert info["why"][0]["at"] == "2026-10-24T03:44+11:00"


def test_a_night_cut_off_by_the_start_of_the_history_is_not_guessed():
    # the first thing in view is a stop: its start is before the history began, so leave it
    tracking = [ev("2026-10-24T01:00:32.781+00:00", "stopped")]
    phases = [ev("2026-10-23T22:00:00+00:00", "light_sleep"), ev("2026-10-24T00:45:54+00:00", "awake")]
    assert sleep.nights_from_sleep_as_android(tracking, phases, SYD) == []


def test_a_corrected_night_replaces_the_old_one(tmp_path):
    db = Database(tmp_path / "w.db")
    db.migrate()
    db.touch_user("u1", "matt", "Matthew")
    ha = FakeHA()
    tracking = [ev("2026-10-28T12:25:48+00:00", "started"), ev("2026-10-28T13:54:30+00:00", "started"),
                ev("2026-10-28T18:50:34+00:00", "stopped")]
    phases = [ev("2026-10-28T12:30:57+00:00", "deep_sleep"), ev("2026-10-28T13:59:39+00:00", "deep_sleep")]

    async def get_history(entity_id, start, end, attributes=False):
        return tracking if "tracking" in entity_id else phases
    ha.get_history = get_history
    engine = Engine(db, ha, tz=SYD, clock=Clock("2026-10-29T08:00"))
    tracker = next(t for t in db.list_trackers("u1") if t["kind"] == "sleep")
    db.update_tracker("u1", tracker["id"], {"config": {"nights": {
        "tracking": "event.sleep_as_android_sleep_tracking_2", "phases": "event.sleep_as_android_sleep_phase_2"}}})
    # what an earlier version saved: the night from the second start
    with db.connect() as conn:
        conn.execute("INSERT INTO sleep_nights (user_id, tracker_id, night, start_at, end_at, phases, source, updated_at) "
                     "VALUES ('u1', ?, '2026-10-29', '2026-10-28T13:54:30+00:00', '2026-10-28T18:50:34+00:00', '[]', "
                     "'sleep_as_android', '2026-10-29T06:00:00+00:00')", (tracker["id"],))
    asyncio.run(engine.sync_nights())
    with db.connect() as conn:
        rows = conn.execute("SELECT start_at FROM sleep_nights WHERE source = 'sleep_as_android'").fetchall()
    assert [r[0] for r in rows] == ["2026-10-28T12:25:48+00:00"]
    [night] = engine.sleep_view("u1")["nights"]
    assert night["start"].startswith("2026-10-28T23:25")
