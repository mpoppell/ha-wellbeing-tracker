from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

from .conftest import As, make_settings
from .test_engine import Clock, FakeHA

SYD = ZoneInfo("Australia/Sydney")


@pytest.fixture
def setup(tmp_path):
    app = create_app(make_settings(tmp_path))
    ha = FakeHA()
    ha.states += [
        {"entity_id": "device_tracker.s26u", "state": "home", "attributes": {"friendly_name": "S26 Ultra"}},
        {"entity_id": "media_player.echo_show", "state": "idle", "attributes": {"friendly_name": "echo show"}},
        {"entity_id": "tts.piper", "state": "unknown", "attributes": {"friendly_name": "piper"}},
        {"entity_id": "input_boolean.vyvanse_taken", "state": "off", "attributes": {"friendly_name": "Vyvanse - Taken"}},
        {"entity_id": "input_datetime.vyvanse_taken_time", "state": "x",
         "attributes": {"friendly_name": "Vyvanse - Taken time", "has_date": True, "has_time": True}},
        {"entity_id": "input_datetime.alarm", "state": "x", "attributes": {"has_date": False, "has_time": True}},
    ]
    ha.services = [{"domain": "notify", "services": {
        "mobile_app_s26u": {}, "mobile_app_pixel_tablet": {}, "notify": {}, "persistent_notification": {}}}]

    async def get_services():
        return ha.services
    ha.get_services = get_services

    clock = Clock("2026-10-14T06:00")
    app.state.ha = ha
    app.state.engine.ha = ha
    app.state.engine.clock = clock
    app.state.engine.tz = SYD
    client = TestClient(app, client=("172.30.32.2", 1))
    return As(client, "u1", "Matthew Poppell"), As(client, "u2", "Kayla"), ha, clock


def add_med(person, name="Vyvanse"):
    return person.post("/api/trackers", json={"kind": "medication", "name": name,
                                              "config": {"dose": "30", "unit": "mg"}}).json()


def test_ha_options(setup):
    matt, _, ha, _ = setup
    opts = matt.get("/api/ha/options").json()
    assert opts["phones"] == [
        {"service": "mobile_app_pixel_tablet", "name": "Pixel Tablet"},
        {"service": "mobile_app_s26u", "name": "S26 Ultra"},
    ]
    assert [s["entity_id"] for s in opts["speakers"]] == ["media_player.echo_show"]
    assert [v["entity_id"] for v in opts["voices"]] == ["tts.piper"]
    assert [t["entity_id"] for t in opts["toggles"]] == ["input_boolean.vyvanse_taken"]
    assert [t["entity_id"] for t in opts["datetimes"]] == ["input_datetime.vyvanse_taken_time"]
    assert opts["people"] == [{"entity_id": "person.pops", "name": "person.pops", "is_you": True}]


def test_person_settings_defaults_and_save(setup):
    matt, _, _, _ = setup
    s = matt.get("/api/reminders/settings").json()
    assert s["devices"] == [] and s["group_doses"] is True and s["undo"] is True
    saved = matt.put("/api/reminders/settings", json={**s, "devices": ["mobile_app_s26u"], "snooze_minutes": 10})
    assert saved.status_code == 200
    assert matt.get("/api/reminders/settings").json()["snooze_minutes"] == 10
    bad = matt.put("/api/reminders/settings", json={**s, "snooze_minutes": 0})
    assert bad.status_code == 422


def test_test_notification(setup):
    matt, _, ha, _ = setup
    assert matt.post("/api/reminders/test").status_code == 422  # no phone chosen yet
    matt.put("/api/reminders/settings", json={"devices": ["mobile_app_s26u"]})
    assert matt.post("/api/reminders/test").json() == {"sent_to": 1}
    assert ha.notifications()[0]["title"] == "Wellbeing reminders are working"


def test_schedule_roundtrip_and_due_card(setup):
    matt, _, ha, clock = setup
    matt.put("/api/reminders/settings", json={"devices": ["mobile_app_s26u"]})
    med = add_med(matt)
    default = matt.get(f"/api/trackers/{med['id']}/schedule").json()
    assert default["enabled"] is False and default["settings"]["nag"] == "firmly"

    resp = matt.put(f"/api/trackers/{med['id']}/schedule",
                    json={"enabled": True, "settings": {**default["settings"], "times": ["07:00"]}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["settings"]["times"] == ["07:00"]

    clock.set("2026-10-14T07:00")
    today = matt.get("/api/doses/today").json()
    assert today[0]["status"] == "due" and today[0]["name"] == "Vyvanse"
    assert len(ha.notifications()) == 1

    after = matt.post(f"/api/doses/{today[0]['dose_id']}",
                      json={"action": "taken"}).json()
    assert after[0]["status"] == "taken"
    assert len(ha.clears()) == 1


def test_checkin_screen_answers_due_dose(setup):
    matt, _, ha, clock = setup
    matt.put("/api/reminders/settings", json={"devices": ["mobile_app_s26u"]})
    med = add_med(matt)
    matt.put(f"/api/trackers/{med['id']}/schedule", json={"enabled": True, "settings": {"times": ["07:00"]}})
    clock.set("2026-10-14T07:00")
    matt.get("/api/doses/today")
    matt.post("/api/checkin", json={"logged_at": "2026-10-14T07:05:00+11:00", "items": [{"tracker_id": med["id"]}]})
    today = matt.get("/api/doses/today").json()
    assert today[0]["status"] == "taken"
    assert len(matt.get("/api/entries?from=2026-10-14&to=2026-10-14").json()) == 1


def test_people_cannot_touch_each_others_reminders(setup):
    matt, kayla, _, clock = setup
    med = add_med(matt)
    assert kayla.get(f"/api/trackers/{med['id']}/schedule").status_code == 404
    assert kayla.put(f"/api/trackers/{med['id']}/schedule",
                     json={"enabled": True, "settings": {"times": ["07:00"]}}).status_code == 404
    matt.put(f"/api/trackers/{med['id']}/schedule", json={"enabled": True, "settings": {"times": ["07:00"]}})
    clock.set("2026-10-14T07:00")
    dose = matt.get("/api/doses/today").json()[0]
    assert kayla.get("/api/doses/today").json() == []
    assert kayla.post(f"/api/doses/{dose['dose_id']}", json={"action": "taken"}).status_code == 404
    assert kayla.get("/api/reminders/settings").json()["devices"] == []


def test_schedule_only_for_medications(setup):
    matt, _, _, _ = setup
    mood = [t for t in matt.get("/api/trackers").json() if t["key"] == "mood"][0]
    assert matt.get(f"/api/trackers/{mood['id']}/schedule").status_code == 422
