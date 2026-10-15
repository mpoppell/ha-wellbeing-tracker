"""The companion Home Assistant integration: dashboard card, entities and actions.

The integration's files ship inside this app. On start the app copies them into Home
Assistant's custom_components folder (only when they've changed) together with the address
and key the integration uses to talk to the app. Home Assistant picks them up after a restart.
"""

from __future__ import annotations

import json
import logging
import secrets
import shutil
from pathlib import Path

log = logging.getLogger(__name__)

BUNDLED = Path(__file__).resolve().parent.parent / "integration" / "wellbeing_tracker"
DOMAIN = "wellbeing_tracker"


def integration_token(data_dir: Path) -> str:
    """A random key the integration sends with every request. Kept in the app's own data."""
    path = data_dir / "integration_token"
    if path.exists():
        token = path.read_text().strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    data_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(token)
    path.chmod(0o600)
    return token


def _version(folder: Path) -> str | None:
    try:
        return json.loads((folder / "manifest.json").read_text()).get("version")
    except (OSError, ValueError):
        return None


def install(config_dir: Path | None, url: str, token: str, source: Path = BUNDLED) -> str:
    """Copy the integration into Home Assistant. Returns installed, updated, unchanged or unavailable."""
    if not config_dir or not config_dir.is_dir() or not source.is_dir():
        return "unavailable"
    target = config_dir / "custom_components" / DOMAIN
    before = _version(target)
    wanted = _version(source)
    connection = {"url": url, "token": token}
    state = "unchanged"
    if before != wanted:
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "addon.json"))
        state = "updated" if before else "installed"
        log.info("Companion integration %s (%s)", state, wanted)
    addon = target / "addon.json"
    try:
        current = json.loads(addon.read_text()) if addon.exists() else None
    except ValueError:
        current = None
    if current != connection:
        addon.write_text(json.dumps(connection))
        addon.chmod(0o600)
    return state
