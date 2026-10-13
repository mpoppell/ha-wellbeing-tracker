from fastapi.testclient import TestClient

from app.main import create_app

from .conftest import make_settings, user_headers


def test_rejects_requests_not_from_ingress(tmp_path):
    app = create_app(make_settings(tmp_path))
    client = TestClient(app, client=("192.168.68.50", 50000))
    assert client.get("/").status_code == 403
    assert client.get("/api/me", headers=user_headers("abc")).status_code == 403


def test_index_and_static_served(ingress_client):
    resp = ingress_client.get("/")
    assert resp.status_code == 200
    assert "static/app.js" in resp.text
    assert ingress_client.get("/static/app.css").status_code == 200


def test_requires_user_header(ingress_client):
    assert ingress_client.get("/api/me").status_code == 401
    assert ingress_client.get("/api/trackers").status_code == 401


def test_users_are_created_and_kept_separate(ingress_client):
    me = ingress_client.get("/api/me", headers=user_headers("user-1")).json()
    assert me["id"] == "user-1"
    assert me["display_name"] == "Matthew Poppell"

    ingress_client.get("/api/me", headers=user_headers("user-2", "kayla", "Kayla"))
    ingress_client.get("/api/me", headers=user_headers("user-1"))  # repeat visit

    status = ingress_client.get("/api/status", headers=user_headers("user-1")).json()
    assert status["people"] == 2
    assert status["schema_version"] == 2
    assert status["home_assistant"]["connected"] is False


def test_migrations_are_idempotent(tmp_path):
    create_app(make_settings(tmp_path))
    app = create_app(make_settings(tmp_path))
    assert app.state.db.schema_version() == 2


def test_upgrade_from_v1_seeds_existing_users(tmp_path):
    """A person created by 0.1.0 gets default trackers on their next visit."""
    import sqlite3

    from app.db import MIGRATIONS

    db_path = tmp_path / "wellbeing.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(MIGRATIONS[0])
    conn.execute("PRAGMA user_version = 1")
    conn.execute("INSERT INTO users VALUES ('old', 'old', 'Old', '2026-10-13', '2026-10-13')")
    conn.commit()
    conn.close()

    app = create_app(make_settings(tmp_path))
    client = TestClient(app, client=("172.30.32.2", 1))
    trackers = client.get("/api/trackers", headers=user_headers("old")).json()
    assert any(t["key"] == "mood" for t in trackers)


def test_dev_mode_allows_local_access(tmp_path):
    app = create_app(make_settings(tmp_path, dev=True))
    client = TestClient(app)
    me = client.get("/api/me").json()
    assert me["id"] == "dev-user"
