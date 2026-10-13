from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings


def make_settings(tmp_path: Path, dev: bool) -> Settings:
    return Settings(
        data_dir=tmp_path,
        dev_mode=dev,
        log_level="INFO",
        supervisor_token=None,
        ha_api_url="http://localhost:1/api",
        port=8099,
    )


@pytest.fixture
def ingress_client(tmp_path):
    """Client whose requests appear to come from HA ingress."""
    app = create_app(make_settings(tmp_path, dev=False))
    return TestClient(app, client=("172.30.32.2", 50000))


def headers(uid, name="matt", display="Matthew Poppell"):
    return {
        "X-Remote-User-Id": uid,
        "X-Remote-User-Name": name,
        "X-Remote-User-Display-Name": display,
    }


def test_rejects_requests_not_from_ingress(tmp_path):
    app = create_app(make_settings(tmp_path, dev=False))
    client = TestClient(app, client=("192.168.68.50", 50000))
    assert client.get("/").status_code == 403
    assert client.get("/api/me", headers=headers("abc")).status_code == 403


def test_index_and_static_served(ingress_client):
    resp = ingress_client.get("/")
    assert resp.status_code == 200
    assert "static/app.js" in resp.text
    assert ingress_client.get("/static/app.css").status_code == 200


def test_requires_user_header(ingress_client):
    assert ingress_client.get("/api/me").status_code == 401


def test_users_are_created_and_kept_separate(ingress_client):
    me = ingress_client.get("/api/me", headers=headers("user-1")).json()
    assert me["id"] == "user-1"
    assert me["display_name"] == "Matthew Poppell"

    ingress_client.get("/api/me", headers=headers("user-2", "kayla", "Kayla"))
    ingress_client.get("/api/me", headers=headers("user-1"))  # repeat visit

    status = ingress_client.get("/api/status", headers=headers("user-1")).json()
    assert status["people"] == 2
    assert status["schema_version"] == 1
    assert status["home_assistant"]["connected"] is False


def test_migrations_are_idempotent(tmp_path):
    create_app(make_settings(tmp_path, dev=False))
    app = create_app(make_settings(tmp_path, dev=False))
    assert app.state.db.schema_version() == 1


def test_dev_mode_allows_local_access(tmp_path):
    app = create_app(make_settings(tmp_path, dev=True))
    client = TestClient(app)
    me = client.get("/api/me").json()
    assert me["id"] == "dev-user"
