"""Runs the companion integration inside a real Home Assistant test instance.

    pip install pytest-homeassistant-custom-component
    cd integration_tests && python -m pytest -q
"""

import pytest

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield
