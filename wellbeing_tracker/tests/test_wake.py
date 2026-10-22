"""Medications due when you wake up, and only on days when a sensor is high enough."""

import logging
from datetime import date, datetime

import pytest

from app.db import Database
from app.engine import Engine
from app.schedule import first_unplug, normalise_only_when, normalise_wake, number_for_day
from app.trackers import ValidationError

from .test_engine import SYD, Clock, FakeHA, dose_rows, run, schedule

CHARGER = "binary_sensor.my_phone_s26u_is_charging"
POLLEN = "sensor.home_pollen_overall_pollen_risk_today"
POLLEN_ALERT = "input_number.outdoors_alert_pollen_level"


def at(local: str) -> str:
    return datetime.fromisoformat(local).replace(tzinfo=SYD).isoformat()


class WakeHA(FakeHA):
    """A phone that charges overnight, and a pollen sensor."""

    def __init__(self):
        super().__init__()
        self.history = []
        self.set_charger("on", "2026-10-13T23:10")
        self.set_pollen(2, today_value=None)
        self.states.append({"entity_id": POLLEN_ALERT, "state": "3.0", "attributes": {}})

    def _put(self, entity_id, state, attributes=None, last_changed=None):
        self.states = [s for s in self.states if s["entity_id"] != entity_id]
        self.states.append({"entity_id": entity_id, "state": state, "attributes": attributes or {},
                            "last_changed": last_changed})

    def set_charger(self, state, local):
        self.history.append({"state": state, "last_changed": at(local)})
        self._put(CHARGER, state, last_changed=at(local))

    def set_pollen(self, value, today_value=None):
        forecast = [{"date": "2026-10-14", "value": today_value, "category": "Moderate"}] if today_value is not None else []
        forecast.append({"date": "2026-10-15", "value": 1})
        self._put(POLLEN, str(value), {"forecast": forecast})

    async def get_history(self, entity_id, start, end, attributes=False):
        return list(self.history) if entity_id == CHARGER else []


@pytest.fixture
def wenv(tmp_path):
    db = Database(tmp_path / "w.db")
    db.migrate()
    db.touch_user("u1", "matt", "Matthew Poppell")
    ha = WakeHA()
    clock = Clock("2026-10-13T21:00")  # set up the night before
    engine = Engine(db, ha, tz=SYD, panel_path="/x", clock=clock)
    engine.save_person("u1", {"devices": ["mobile_app_s26u"], "wake": {"entity": CHARGER}})

    def med(name, **cfg):
        return db.create_tracker("u1", {"kind": "medication", "name": name, "config": cfg})

    return db, ha, clock, engine, med


def tick_at(engine, clock, local):
    clock.set(local)
    engine._conditions_at = None
    run(engine.tick())


# ----- the pure rules -----

def test_first_unplug_needs_a_real_night_on_charge():
    earliest = datetime(2026, 10, 14, 4, 0, tzinfo=SYD)
    hist = [
        {"state": "on", "last_changed": at("2026-10-13T23:10")},
        {"state": "off", "last_changed": at("2026-10-14T02:00")},   # too early: before 4am
        {"state": "on", "last_changed": at("2026-10-14T02:05")},
        {"state": "unavailable", "last_changed": at("2026-10-14T03:00")},  # a blip doesn't count
        {"state": "on", "last_changed": at("2026-10-14T03:01")},
        {"state": "off", "last_changed": at("2026-10-14T06:42")},   # up
        {"state": "on", "last_changed": at("2026-10-14T07:00")},
        {"state": "off", "last_changed": at("2026-10-14T07:30")},
    ]
    assert first_unplug(hist, earliest, 3) == datetime.fromisoformat(at("2026-10-14T06:42"))
    # a 30-minute top-up in the morning isn't waking up
    top_up = [{"state": "on", "last_changed": at("2026-10-14T05:00")}, {"state": "off", "last_changed": at("2026-10-14T05:30")}]
    assert first_unplug(top_up, earliest, 3) is None


def test_number_for_day_prefers_the_dated_forecast_entry():
    stale = {"state": "2", "attributes": {"forecast": [{"date": "2026-10-14", "value": 3}]}}
    assert number_for_day(stale, date(2026, 10, 14)) == 3
    assert number_for_day({"state": "4", "attributes": {"forecast": [{"date": "2026-10-15", "value": 1}]}}, date(2026, 10, 14)) == 4
    assert number_for_day({"state": "unknown", "attributes": {}}, date(2026, 10, 14)) is None
    assert number_for_day(None, date(2026, 10, 14)) is None


def test_settings_are_checked():
    assert normalise_wake({"entity": CHARGER})["fallback"] == "10:00"
    assert normalise_wake({"fallback": None})["fallback"] is None
    with pytest.raises(ValidationError):
        normalise_wake({"entity": "sensor.not_a_binary"})
    with pytest.raises(ValidationError):
        normalise_wake({"earliest": "11:00", "fallback": "10:00"})
    assert normalise_only_when({"entity_id": POLLEN, "at_least": POLLEN_ALERT}) == {"entity_id": POLLEN, "at_least": POLLEN_ALERT}
    assert normalise_only_when({"entity_id": POLLEN, "at_least": "3"}) == {"entity_id": POLLEN, "at_least": 3}
    assert normalise_only_when({"entity_id": ""}) is None
    with pytest.raises(ValidationError):
        normalise_only_when({"entity_id": POLLEN, "at_least": "lots"})


# ----- the engine -----

def test_due_when_the_phone_comes_off_the_charger(wenv):
    db, ha, clock, engine, med = wenv
    v = med("Vyvanse", dose="30", unit="mg")
    schedule(engine, v["id"], mode="wake")
    tick_at(engine, clock, "2026-10-14T06:30")
    assert dose_rows(db, v["id"]) == []
    assert engine.wake_status("u1")["waiting"] == [{"tracker_id": v["id"], "name": "Vyvanse", "conditional": False}]
    ha.set_charger("off", "2026-10-14T06:42")
    tick_at(engine, clock, "2026-10-14T06:43")
    [d] = dose_rows(db, v["id"])
    assert d["local_time"] == "06:42" and d["status"] == "due"
    assert len(ha.notifications()) == 1
    assert engine.wake_status("u1")["woke_at"] == "06:42"
    # plugging back in and out again later doesn't add a second dose
    ha.set_charger("on", "2026-10-14T07:00")
    ha.set_charger("off", "2026-10-14T11:00")
    tick_at(engine, clock, "2026-10-14T11:01")
    assert len(dose_rows(db, v["id"])) == 1


def test_fallback_time_when_no_wake_up_is_seen(wenv):
    db, ha, clock, engine, med = wenv
    v = med("Vyvanse")
    schedule(engine, v["id"], mode="wake")
    tick_at(engine, clock, "2026-10-14T09:59")
    assert dose_rows(db, v["id"]) == []
    tick_at(engine, clock, "2026-10-14T10:00")
    [d] = dose_rows(db, v["id"])
    assert d["local_time"] == "10:00"


def test_im_up_button(wenv):
    db, ha, clock, engine, med = wenv
    v = med("Vyvanse")
    schedule(engine, v["id"], mode="wake")
    clock.set("2026-10-14T07:15")
    engine.mark_awake("u1", clock(), "you")
    tick_at(engine, clock, "2026-10-14T07:15")
    [d] = dose_rows(db, v["id"])
    assert d["local_time"] == "07:15"
    assert engine.wake_status("u1")["source"] == "you"


def test_set_up_after_waking_starts_tomorrow(wenv):
    db, ha, clock, engine, med = wenv
    ha.set_charger("off", "2026-10-14T06:42")
    tick_at(engine, clock, "2026-10-14T06:43")  # nothing scheduled yet, so nothing noticed
    v = med("Vyvanse")
    clock.set("2026-10-14T11:00")
    engine.mark_awake("u1", datetime.fromisoformat(at("2026-10-14T06:42")), "charger")
    schedule(engine, v["id"], mode="wake")
    assert dose_rows(db, v["id"]) == []


def test_antihistamine_only_on_high_pollen_days(wenv):
    db, ha, clock, engine, med = wenv
    f = med("Fexofenadine", dose="180", unit="mg")
    schedule(engine, f["id"], mode="wake", only_when={"entity_id": POLLEN, "at_least": POLLEN_ALERT})
    # Google's "today" still shows yesterday's 2, but the forecast entry for today says 3
    ha.set_pollen(2, today_value=3)
    ha.set_charger("off", "2026-10-14T06:42")
    tick_at(engine, clock, "2026-10-14T06:43")
    [d] = dose_rows(db, f["id"])
    assert d["local_time"] == "06:42"


def test_no_antihistamine_on_a_low_pollen_day(wenv):
    db, ha, clock, engine, med = wenv
    f = med("Fexofenadine")
    v = med("Vyvanse")
    schedule(engine, f["id"], mode="wake", only_when={"entity_id": POLLEN, "at_least": POLLEN_ALERT})
    schedule(engine, v["id"], mode="wake")
    ha.set_pollen(2, today_value=2)
    ha.set_charger("off", "2026-10-14T06:42")
    tick_at(engine, clock, "2026-10-14T06:43")
    assert dose_rows(db, f["id"]) == []
    assert len(dose_rows(db, v["id"])) == 1
    # the pollen rises at lunchtime: it's added then, once
    ha.set_pollen(4, today_value=4)
    tick_at(engine, clock, "2026-10-14T12:30")
    [d] = dose_rows(db, f["id"])
    assert d["status"] == "due"


def test_set_times_with_a_condition(wenv):
    db, ha, clock, engine, med = wenv
    f = med("Fexofenadine")
    schedule(engine, f["id"], times=["08:00"], only_when={"entity_id": POLLEN, "at_least": 3})
    ha.set_pollen(1)
    tick_at(engine, clock, "2026-10-14T07:00")
    assert dose_rows(db, f["id"]) == []  # and nothing for tomorrow until tomorrow's number is in
    ha.set_pollen(3)
    tick_at(engine, clock, "2026-10-14T07:01")
    assert [d["local_time"] for d in dose_rows(db, f["id"])] == ["08:00"]


# ----- finding the charger, and Home Assistant saying you're up -----

def test_the_phones_charger_is_found_when_none_is_set(wenv, caplog):
    db, ha, clock, engine, med = wenv
    engine.save_person("u1", {"devices": ["mobile_app_s26u"], "wake": {"entity": None}})
    ha.states.append({"entity_id": "binary_sensor.old_phone_is_charging", "state": "off", "attributes": {}})
    v = med("Vyvanse")
    schedule(engine, v["id"], mode="wake")
    ha.set_charger("off", "2026-10-14T05:47")
    tick_at(engine, clock, "2026-10-14T05:48")
    [d] = dose_rows(db, v["id"])
    assert d["local_time"] == "05:47"
    assert engine.wake_status("u1")["entity"] == CHARGER


def test_no_charger_at_all_is_said_once_a_day(wenv, caplog):
    db, ha, clock, engine, med = wenv
    engine.save_person("u1", {"devices": ["mobile_app_pixel"], "wake": {"entity": None}})
    v = med("Vyvanse")
    schedule(engine, v["id"], mode="wake")
    caplog.clear()
    tick_at(engine, clock, "2026-10-14T05:48")
    tick_at(engine, clock, "2026-10-14T05:49")
    assert [r.getMessage() for r in caplog.records].count(
        "Can't tell when u1 gets up: no phone charging sensor is set (Settings, When I wake up) "
        "and none was found for their phone") == 1


def test_only_the_first_wake_up_counts(wenv, caplog):
    db, ha, clock, engine, med = wenv
    caplog.set_level(logging.INFO)
    clock.set("2026-10-14T07:00")
    engine.mark_awake("u1", datetime.fromisoformat(at("2026-10-14T05:47")), "home assistant")
    engine.mark_awake("u1", clock(), "you")
    status = engine.wake_status("u1")
    assert status["woke_at"] == "05:47" and status["source"] == "home assistant"
    assert sum("is up" in r.getMessage() for r in caplog.records) == 1
