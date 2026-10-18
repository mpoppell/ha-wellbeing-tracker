"""Release checks: catch a version bump that missed a file before it reaches Home Assistant."""

import re
from pathlib import Path

from app import __version__

APP_DIR = Path(__file__).resolve().parent.parent


def config_version() -> str:
    text = (APP_DIR / "config.yaml").read_text()
    match = re.search(r'^version:\s*"?([^"\n]+)"?\s*$', text, re.MULTILINE)
    assert match, "config.yaml has no version"
    return match.group(1)


def test_versions_match():
    assert config_version() == __version__, "Bump app/__init__.py and config.yaml together"


def test_changelog_has_current_version():
    changelog = (APP_DIR / "CHANGELOG.md").read_text()
    assert f"## {config_version()}" in changelog, "Add a CHANGELOG.md entry for this version"


def test_store_images_present():
    for name in ("icon.png", "logo.png"):
        assert (APP_DIR / name).exists(), f"{name} missing"


def test_companion_integration_version_matches():
    import json
    manifest = json.loads((APP_DIR / "integration" / "wellbeing_tracker" / "manifest.json").read_text())
    assert manifest["version"] == config_version(), "Bump integration/wellbeing_tracker/manifest.json too"


def test_dashboard_cards_are_ascii():
    # Served without a charset; non-ASCII characters can arrive garbled.
    for js in (APP_DIR / "integration" / "wellbeing_tracker" / "frontend").glob("*.js"):
        js.read_text(encoding="utf-8").encode("ascii")
