"""The key-protected API used by the companion Home Assistant integration, and its installer."""

import json

from fastapi.testclient import TestClient

from app import companion
from app.main import create_app

from .conftest import make_settings, user_headers


def setup(tmp_path):
    app = create_app(make_settings(tmp_path))
    token = (tmp_path / "integration_token").read_text()
    ingress = TestClient(app, client=("172.30.32.2", 1))
    core = TestClient(app, client=("172.30.32.1", 1))  # Home Assistant itself
    return app, token, ingress, core


def test_needs_the_key(tmp_path):
    _, token, ingress, core = setup(tmp_path)
    assert core.get("/api/integration/overview").status_code == 401
    assert core.get("/api/integration/overview", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert ingress.get("/api/integration/overview").status_code == 401  # even through ingress
    assert core.get("/api/integration/overview", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    # the key opens nothing else
    assert core.get("/api/trackers", headers={"Authorization": f"Bearer {token}"}).status_code == 403


def test_overview_and_logging_a_dose(tmp_path):
    _, token, ingress, core = setup(tmp_path)
    auth = {"Authorization": f"Bearer {token}"}
    me = user_headers("u1")
    ingress.get("/api/me", headers=me)
    med = ingress.post("/api/trackers", headers=me, json={"kind": "medication", "name": "Clonidine",
                                                          "config": {"dose": 100, "unit": "mcg"}}).json()
    ingress.put(f"/api/trackers/{med['id']}/supply", headers=me, json={"enabled": True, "count": 30, "per_day": 2,
                                                                       "repeats": 0})
    [person] = core.get("/api/integration/overview", headers=auth).json()["people"]
    assert person["user_id"] == "u1" and person["name"] == "Matthew Poppell"
    assert person["medications"] == [{"id": med["id"], "name": "Clonidine", "emoji": None, "usual": 1}]
    assert person["supply"][0]["name"] == "Clonidine" and person["supply"][0]["days_left"] == 15
    assert person["doctor"]["names"] == ["Clonidine"]
    after = core.post("/api/integration/log_dose", headers=auth, json={"user_id": "u1", "medication": "clonidine"}).json()
    assert after["supply"][0]["stock"] == 29
    assert core.post("/api/integration/log_dose", headers=auth, json={"user_id": "u1", "medication": "x"}).status_code == 404
    assert core.post("/api/integration/answer", headers=auth,
                     json={"user_id": "nobody", "reminder_id": 1, "answer": "taken"}).status_code == 404


def test_installer_copies_once_and_writes_the_connection(tmp_path):
    source = tmp_path / "src"
    source.mkdir()
    (source / "manifest.json").write_text(json.dumps({"domain": "wellbeing_tracker", "version": "1.0.0"}))
    (source / "__init__.py").write_text("")
    config = tmp_path / "config"
    config.mkdir()
    assert companion.install(config, "http://app:8099", "key", source) == "installed"
    target = config / "custom_components" / "wellbeing_tracker"
    assert json.loads((target / "addon.json").read_text()) == {"url": "http://app:8099", "token": "key"}
    assert companion.install(config, "http://app:8099", "key", source) == "unchanged"
    (source / "manifest.json").write_text(json.dumps({"domain": "wellbeing_tracker", "version": "1.1.0"}))
    assert companion.install(config, "http://app:8099", "key", source) == "updated"
    assert (target / "addon.json").exists()  # the connection survives an update
    assert companion.install(tmp_path / "missing", "u", "k", source) == "unavailable"


def test_logging_mood(tmp_path):
    _, token, ingress, core = setup(tmp_path)
    auth = {"Authorization": f"Bearer {token}"}
    ingress.get("/api/me", headers=user_headers("u1"))
    after = core.post("/api/integration/log", headers=auth, json={"user_id": "u1", "item": "mood", "value": 8}).json()
    assert after["mood"]["value"] == 8 and after["mood"]["label"] == "Good"
    assert after["mood_scale"]["max"] == 10 and len(after["mood_scale"]["labels"]) == 10
    bad = core.post("/api/integration/log", headers=auth, json={"user_id": "u1", "item": "mood", "value": 11})
    assert bad.status_code == 422
