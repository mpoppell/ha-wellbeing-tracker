TODAY = "2026-10-13T09:15:00+11:00"
LATER = "2026-10-13T20:30:00+11:00"
TOMORROW = "2026-10-14T08:00:00+11:00"


def trackers_by_key(person, include_hidden=False):
    url = "/api/trackers" + ("?include_hidden=true" if include_hidden else "")
    return {t["key"]: t for t in person.get(url).json()}


def day_entries(person, day="2026-10-13"):
    return person.get(f"/api/entries?from={day}&to={day}").json()


def test_new_person_gets_default_trackers(matt):
    t = trackers_by_key(matt)
    assert t["mood"]["kind"] == "rating"
    assert t["mood"]["frequency"] == "many"
    assert t["headache"]["kind"] == "symptom"
    assert t["headache"]["frequency"] == "daily"
    assert t["caffeine"]["config"] == {"mode": "count", "unit": "cups"}
    assert t["sleep"]["kind"] == "sleep"
    orders = [x["sort_order"] for x in matt.get("/api/trackers").json()]
    assert orders == sorted(orders)


def test_checkin_saves_all_kinds(matt):
    t = trackers_by_key(matt)
    resp = matt.post("/api/checkin", json={
        "logged_at": TODAY,
        "items": [
            {"tracker_id": t["mood"]["id"], "value_num": 4, "note": "Good start"},
            {"tracker_id": t["emotions"]["id"], "value_json": ["Calm", "Motivated"]},
            {"tracker_id": t["headache"]["id"], "value_num": 2},
            {"tracker_id": t["caffeine"]["id"], "value_num": 2},
            {"tracker_id": t["exercise"]["id"], "value_num": 1},
            {"tracker_id": t["sleep"]["id"], "value_json": {"hours": 7.5, "quality": 4}},
            {"tracker_id": t["journal"]["id"], "note": "Slept well."},
        ],
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["day"] == "2026-10-13"
    assert len(body["saved"]) == 7
    entries = day_entries(matt)
    assert len(entries) == 7
    sleep = next(e for e in entries if e["tracker_id"] == t["sleep"]["id"])
    assert sleep["value_json"] == {"hours": 7.5, "quality": 4}


def test_many_adds_but_daily_updates(matt):
    t = trackers_by_key(matt)
    for when, mood, headache in ((TODAY, 3, 1), (LATER, 5, 3)):
        matt.post("/api/checkin", json={"logged_at": when, "items": [
            {"tracker_id": t["mood"]["id"], "value_num": mood},
            {"tracker_id": t["headache"]["id"], "value_num": headache},
        ]})
    entries = day_entries(matt)
    moods = [e for e in entries if e["tracker_id"] == t["mood"]["id"]]
    headaches = [e for e in entries if e["tracker_id"] == t["headache"]["id"]]
    assert sorted(e["value_num"] for e in moods) == [3, 5]
    assert len(headaches) == 1 and headaches[0]["value_num"] == 3


def test_clear_removes_daily_answer(matt):
    t = trackers_by_key(matt)
    matt.post("/api/checkin", json={"logged_at": TODAY, "items": [
        {"tracker_id": t["exercise"]["id"], "value_num": 1}]})
    resp = matt.post("/api/checkin", json={"logged_at": LATER, "items": [
        {"tracker_id": t["exercise"]["id"], "clear": True}]})
    assert resp.json()["cleared_tracker_ids"] == [t["exercise"]["id"]]
    assert day_entries(matt) == []


def test_day_comes_from_logged_offset(matt):
    t = trackers_by_key(matt)
    # 11:30pm Sydney time is still the 13th locally even though it's the 13th 12:30 UTC
    body = matt.post("/api/checkin", json={"logged_at": "2026-10-13T23:30:00+11:00", "items": [
        {"tracker_id": t["mood"]["id"], "value_num": 3}]}).json()
    assert body["day"] == "2026-10-13"
    resp = matt.post("/api/checkin", json={"logged_at": "2026-10-13T23:30:00", "items": [
        {"tracker_id": t["mood"]["id"], "value_num": 3}]})
    assert resp.status_code == 422


def test_validation_errors(matt):
    t = trackers_by_key(matt)
    bad = [
        {"tracker_id": t["mood"]["id"], "value_num": 11},
        {"tracker_id": t["mood"]["id"], "value_num": True},
        {"tracker_id": t["headache"]["id"], "value_num": 4},
        {"tracker_id": t["exercise"]["id"], "value_num": 2},
        {"tracker_id": t["caffeine"]["id"], "value_num": 1.5},
        {"tracker_id": t["emotions"]["id"], "value_json": []},
        {"tracker_id": t["sleep"]["id"], "value_json": {"hours": 30}},
        {"tracker_id": t["journal"]["id"], "note": "   "},
    ]
    for item in bad:
        resp = matt.post("/api/checkin", json={"logged_at": TODAY, "items": [item]})
        assert resp.status_code == 422, item
    assert day_entries(matt) == []


def test_checkin_is_all_or_nothing(matt):
    t = trackers_by_key(matt)
    resp = matt.post("/api/checkin", json={"logged_at": TODAY, "items": [
        {"tracker_id": t["mood"]["id"], "value_num": 4},
        {"tracker_id": t["mood"]["id"], "value_num": 99},
    ]})
    assert resp.status_code == 422
    assert day_entries(matt) == []


def test_people_cannot_see_or_change_each_others_data(matt, kayla):
    mt = trackers_by_key(matt)
    kt = trackers_by_key(kayla)
    assert mt["mood"]["id"] != kt["mood"]["id"]

    saved = matt.post("/api/checkin", json={"logged_at": TODAY, "items": [
        {"tracker_id": mt["mood"]["id"], "value_num": 2}]}).json()["saved"][0]

    assert day_entries(kayla) == []
    # Kayla can't log against, edit, hide or delete Matt's things
    assert kayla.post("/api/checkin", json={"logged_at": TODAY, "items": [
        {"tracker_id": mt["mood"]["id"], "value_num": 5}]}).status_code == 404
    assert kayla.patch(f"/api/entries/{saved['id']}", json={"value_num": 5}).status_code == 404
    assert kayla.delete(f"/api/entries/{saved['id']}").status_code == 404
    assert kayla.patch(f"/api/trackers/{mt['mood']['id']}", json={"hidden": True}).status_code == 404
    assert kayla.delete(f"/api/trackers/{mt['mood']['id']}").status_code == 404
    assert kayla.post("/api/trackers/order", json={"ids": [mt["mood"]["id"]]}).status_code == 404
    assert day_entries(matt)[0]["value_num"] == 2


def test_add_medication_and_log_it(matt):
    resp = matt.post("/api/trackers", json={
        "kind": "medication", "name": "Vyvanse", "emoji": "💊",
        "config": {"dose": "30", "unit": "mg", "notes": "With breakfast"},
    })
    assert resp.status_code == 201, resp.text
    med = resp.json()
    assert med["key"] == "vyvanse"
    assert med["group_name"] == "Medications"
    assert med["frequency"] == "many"
    saved = matt.post("/api/checkin", json={"logged_at": TODAY, "items": [
        {"tracker_id": med["id"]}]}).json()["saved"][0]
    assert saved["value_num"] == 1

    # Same name again gets a unique key
    again = matt.post("/api/trackers", json={"kind": "medication", "name": "Vyvanse"}).json()
    assert again["key"] == "vyvanse_2"

    # Medications are listed first, in the order they were added
    keys = [t["key"] for t in matt.get("/api/trackers").json()]
    assert keys[:3] == ["vyvanse", "vyvanse_2", "mood"]
    later = matt.post("/api/trackers", json={"kind": "factor", "name": "Meditation"}).json()
    assert matt.get("/api/trackers").json()[-1]["id"] == later["id"]


def test_custom_trackers_validate_config(matt):
    ok = matt.post("/api/trackers", json={
        "kind": "rating", "name": "Stress", "config": {"min": 1, "max": 5}})
    assert ok.status_code == 201
    assert matt.post("/api/trackers", json={
        "kind": "rating", "name": "Bad", "config": {"min": 1, "max": 5, "labels": ["a"]}}).status_code == 422
    assert matt.post("/api/trackers", json={"kind": "tags", "name": "Empty", "config": {"options": []}}).status_code == 422
    assert matt.post("/api/trackers", json={"kind": "nope", "name": "X"}).status_code == 422
    assert matt.post("/api/trackers", json={"kind": "factor", "name": ""}).status_code == 422


def test_hide_rename_reorder_delete(matt):
    t = trackers_by_key(matt)
    matt.patch(f"/api/trackers/{t['nausea']['id']}", json={"hidden": True, "name": "Queasy"})
    assert "nausea" not in trackers_by_key(matt)
    hidden = trackers_by_key(matt, include_hidden=True)["nausea"]
    assert hidden["hidden"] is True and hidden["name"] == "Queasy"

    ids = [x["id"] for x in matt.get("/api/trackers?include_hidden=true").json()]
    matt.post("/api/trackers/order", json={"ids": list(reversed(ids))})
    assert [x["id"] for x in matt.get("/api/trackers?include_hidden=true").json()] == list(reversed(ids))

    matt.post("/api/checkin", json={"logged_at": TODAY, "items": [
        {"tracker_id": t["water"]["id"], "value_num": 3}]})
    assert matt.delete(f"/api/trackers/{t['water']['id']}").status_code == 200
    assert day_entries(matt) == []  # its entries go with it


def test_edit_and_delete_entries(matt):
    t = trackers_by_key(matt)
    e = matt.post("/api/checkin", json={"logged_at": TODAY, "items": [
        {"tracker_id": t["mood"]["id"], "value_num": 2}]}).json()["saved"][0]
    edited = matt.patch(f"/api/entries/{e['id']}", json={"value_num": 3, "note": "Better after lunch"}).json()
    assert edited["value_num"] == 3 and edited["note"] == "Better after lunch"
    moved = matt.patch(f"/api/entries/{e['id']}", json={"logged_at": TOMORROW}).json()
    assert moved["day"] == "2026-10-14"
    assert matt.patch(f"/api/entries/{e['id']}", json={"value_num": 0}).status_code == 422
    assert matt.delete(f"/api/entries/{e['id']}").status_code == 200
    assert day_entries(matt, "2026-10-14") == []


def test_daily_entry_cannot_move_onto_taken_day(matt):
    t = trackers_by_key(matt)
    first = matt.post("/api/checkin", json={"logged_at": TODAY, "items": [
        {"tracker_id": t["exercise"]["id"], "value_num": 1}]}).json()["saved"][0]
    matt.post("/api/checkin", json={"logged_at": TOMORROW, "items": [
        {"tracker_id": t["exercise"]["id"], "value_num": 0}]})
    resp = matt.patch(f"/api/entries/{first['id']}", json={"logged_at": TOMORROW})
    assert resp.status_code == 422


def test_entries_range_limits(matt):
    assert matt.get("/api/entries?from=2026-10-14&to=2026-10-13").status_code == 422
    assert matt.get("/api/entries?from=2025-01-01&to=2026-10-13").status_code == 422
    assert matt.get("/api/entries?from=bad&to=2026-10-13").status_code == 422


def test_mood_and_energy_are_one_to_ten(matt):
    t = trackers_by_key(matt)
    assert (t["mood"]["config"]["min"], t["mood"]["config"]["max"]) == (1, 10)
    assert len(t["mood"]["config"]["labels"]) == 10
    assert t["energy"]["config"]["max"] == 10
    assert t["water"]["config"]["goal"] == 8


def test_upgrade_rescales_old_one_to_five_answers(tmp_path):
    import sqlite3

    from fastapi.testclient import TestClient

    from app.db import MIGRATIONS
    from app.main import create_app

    from .conftest import make_settings, user_headers

    db_path = tmp_path / "wellbeing.db"
    conn = sqlite3.connect(db_path)
    for sql in MIGRATIONS[:5]:
        conn.executescript(sql)
    conn.execute("PRAGMA user_version = 5")
    conn.execute("INSERT INTO users VALUES ('old', 'old', 'Old', 'x', 'x', 1)")
    conn.execute("""INSERT INTO trackers (id, user_id, key, kind, name, config, frequency, created_at)
                    VALUES (1, 'old', 'mood', 'rating', 'Mood', '{"min":1,"max":5,"labels":["a","b","c","d","e"]}', 'many', 'x')""")
    conn.execute("""INSERT INTO trackers (id, user_id, key, kind, name, config, frequency, created_at)
                    VALUES (2, 'old', 'water', 'factor', 'Water', '{"mode":"count","unit":"glasses"}', 'daily', 'x')""")
    for i, v in enumerate([1, 2, 3, 4, 5]):
        conn.execute("INSERT INTO entries (user_id, tracker_id, day, logged_at, value_num, created_at, updated_at) "
                     "VALUES ('old', 1, '2026-10-13', ?, ?, 'x', 'x')", (f"2026-10-13T0{i}:00:00+11:00", v))
    conn.commit()
    conn.close()

    app = create_app(make_settings(tmp_path))
    client = TestClient(app, client=("172.30.32.2", 1))
    h = user_headers("old")
    values = sorted(e["value_num"] for e in client.get("/api/entries?from=2026-10-13&to=2026-10-13", headers=h).json())
    assert values == [1, 3, 6, 8, 10]
    trackers = {t["key"]: t for t in client.get("/api/trackers", headers=h).json()}
    assert trackers["mood"]["config"]["max"] == 10
    assert trackers["water"]["config"]["goal"] == 8


def test_changing_a_rating_scale_rescales_answers(matt):
    stress = matt.post("/api/trackers", json={"kind": "rating", "name": "Stress", "config": {"min": 1, "max": 5}}).json()
    for i, v in enumerate([1, 3, 5]):
        matt.post("/api/checkin", json={"logged_at": f"2026-10-13T0{i}:00:00+11:00",
                                        "items": [{"tracker_id": stress["id"], "value_num": v}]})
    r = matt.patch(f"/api/trackers/{stress['id']}", json={"config": {"min": 1, "max": 10}})
    assert r.status_code == 200 and r.json()["config"]["max"] == 10
    values = sorted(e["value_num"] for e in day_entries(matt))
    assert values == [1, 6, 10]


def test_changing_type_starts_afresh(matt):
    t = trackers_by_key(matt)
    matt.post("/api/checkin", json={"logged_at": TODAY, "items": [{"tracker_id": t["headache"]["id"], "value_num": 2}]})
    assert trackers_by_key(matt)["headache"]["entry_count"] == 1
    r = matt.patch(f"/api/trackers/{t['headache']['id']}", json={"kind": "rating", "config": {"min": 1, "max": 10}})
    assert r.status_code == 200
    changed = trackers_by_key(matt)["headache"]
    assert changed["kind"] == "rating" and changed["entry_count"] == 0 and changed["frequency"] == "many"
    assert matt.patch(f"/api/trackers/{t['headache']['id']}", json={"kind": "bogus"}).status_code == 422


def test_medication_dose_and_number_of_doses(matt):
    med = matt.post("/api/trackers", json={"kind": "medication", "name": "Dex", "config": {"dose": "5", "unit": "mg"}}).json()
    assert med["config"] == {"dose": 5, "unit": "mg"}
    usual = matt.post("/api/checkin", json={"logged_at": TODAY, "items": [
        {"tracker_id": med["id"], "value_num": 2, "value_json": {"dose": 5}}]}).json()["saved"][0]
    assert usual["value_num"] == 2 and usual["value_json"] is None
    other = matt.post("/api/checkin", json={"logged_at": LATER, "items": [
        {"tracker_id": med["id"], "value_num": 1, "value_json": {"dose": 10}}]}).json()["saved"][0]
    assert other["value_json"] == {"dose": 10}
    assert matt.post("/api/trackers", json={"kind": "medication", "name": "Bad", "config": {"dose": "lots"}}).status_code == 422
    edited = matt.patch(f"/api/entries/{other['id']}", json={"logged_at": "2026-10-13T19:45:00+11:00", "value_num": 1.5}).json()
    assert edited["logged_at"] == "2026-10-13T19:45:00+11:00" and edited["value_num"] == 1.5


def test_daily_goal_on_counts(matt):
    t = matt.post("/api/trackers", json={"kind": "factor", "name": "Steps walked", "config": {"mode": "count", "goal": "8000"}}).json()
    assert t["config"]["goal"] == 8000
    assert matt.post("/api/trackers", json={"kind": "factor", "name": "X", "config": {"mode": "count", "goal": -1}}).status_code == 422
