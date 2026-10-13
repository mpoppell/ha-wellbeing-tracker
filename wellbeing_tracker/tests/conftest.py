from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings


def make_settings(tmp_path: Path, dev: bool = False) -> Settings:
    return Settings(
        data_dir=tmp_path,
        dev_mode=dev,
        log_level="INFO",
        supervisor_token=None,
        ha_api_url="http://localhost:1/api",
        port=8099,
    )


def user_headers(uid: str, name: str = "matt", display: str = "Matthew Poppell") -> dict:
    return {
        "X-Remote-User-Id": uid,
        "X-Remote-User-Name": name,
        "X-Remote-User-Display-Name": display,
    }


@pytest.fixture
def ingress_client(tmp_path):
    """Client whose requests appear to come from HA ingress."""
    app = create_app(make_settings(tmp_path))
    return TestClient(app, client=("172.30.32.2", 50000))


class As:
    """Make requests as a given HA user."""

    def __init__(self, client: TestClient, uid: str, display: str = "Person") -> None:
        self.client = client
        self.headers = user_headers(uid, uid, display)

    def get(self, url, **kw):
        return self.client.get(url, headers=self.headers, **kw)

    def post(self, url, json=None):
        return self.client.post(url, headers=self.headers, json=json)

    def put(self, url, json=None):
        return self.client.put(url, headers=self.headers, json=json)

    def patch(self, url, json=None):
        return self.client.patch(url, headers=self.headers, json=json)

    def delete(self, url):
        return self.client.delete(url, headers=self.headers)


@pytest.fixture
def matt(ingress_client):
    return As(ingress_client, "user-matt", "Matthew Poppell")


@pytest.fixture
def kayla(ingress_client):
    return As(ingress_client, "user-kayla", "Kayla")
