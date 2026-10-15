"""Shared device details, so every entity for a person or a medication lands on the same device."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo

from .const import DOMAIN
from .coordinator import WellbeingCoordinator


def person_device(coordinator: WellbeingCoordinator, user_id: str) -> DeviceInfo:
    name = (coordinator.person(user_id) or {}).get("name", "Someone")
    panel = (coordinator.data or {}).get("panel_path")
    return DeviceInfo(
        identifiers={(DOMAIN, f"person_{user_id}")}, name=f"Wellbeing {name}",
        manufacturer="Wellbeing Tracker", entry_type=DeviceEntryType.SERVICE,
        # "Visit" on the device page opens the Wellbeing app inside Home Assistant
        configuration_url=f"homeassistant:/{panel}" if panel else None)


def medication_device(user_id: str, tracker_id: int, name: str) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, f"med_{tracker_id}")}, name=name,
        manufacturer="Wellbeing Tracker", model="Medication", entry_type=DeviceEntryType.SERVICE,
        via_device=(DOMAIN, f"person_{user_id}"))
