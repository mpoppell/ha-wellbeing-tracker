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
