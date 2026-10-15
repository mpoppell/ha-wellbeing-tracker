"""Runtime settings for the app.

Inside Home Assistant everything lives under /data and the Supervisor provides
SUPERVISOR_TOKEN. For local development set WELLBEING_DEV=1 and optionally
WELLBEING_DATA_DIR.
"""

from __future__ import annotations

import json
import os
import socket
from dataclasses import dataclass
from pathlib import Path

# The only address Home Assistant ingress proxies requests from.
INGRESS_IP = "172.30.32.2"


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    dev_mode: bool
    log_level: str
    supervisor_token: str | None
    ha_api_url: str
    port: int
    panel_path: str | None = None  # where tapping a reminder opens the app
    ha_config_dir: Path | None = None  # Home Assistant's config folder, to install the companion integration
    hostname: str | None = None        # how Home Assistant reaches this app on the internal network

    @property
    def db_path(self) -> Path:
        return self.data_dir / "wellbeing.db"


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("WELLBEING_DATA_DIR", "/data"))
    options: dict = {}
    options_file = data_dir / "options.json"
    if options_file.exists():
        try:
            options = json.loads(options_file.read_text())
        except (OSError, ValueError):
            options = {}

    # Inside Home Assistant the container hostname is the app slug with dashes,
    # and the sidebar page lives at /<slug>.
    panel_path = os.environ.get("WELLBEING_PANEL_PATH")
    hostname = os.environ.get("HOSTNAME") or socket.gethostname()
    if not panel_path and os.environ.get("SUPERVISOR_TOKEN") and hostname:
        panel_path = "/" + hostname.replace("-", "_")

    return Settings(
        data_dir=data_dir,
        dev_mode=os.environ.get("WELLBEING_DEV") == "1",
        log_level=str(options.get("log_level", "info")).upper(),
        supervisor_token=os.environ.get("SUPERVISOR_TOKEN"),
        ha_api_url=os.environ.get("WELLBEING_HA_API_URL", "http://supervisor/core/api"),
        port=int(os.environ.get("WELLBEING_PORT", "8099")),
        panel_path=panel_path,
        ha_config_dir=Path(os.environ.get("WELLBEING_HA_CONFIG", "/homeassistant")),
        hostname=hostname,
    )
