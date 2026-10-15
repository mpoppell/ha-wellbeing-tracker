"""A "Log dose" button for each medication: one press logs it, as taken now.

Works with any card that presses buttons, including Bubble Card buttons.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import WellbeingConfigEntry
from .api import WellbeingError
from .coordinator import WellbeingCoordinator
from .entity import medication_device


async def async_setup_entry(hass: HomeAssistant, entry: WellbeingConfigEntry,
                            async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    coordinator = entry.runtime_data
    known: set[int] = set()

    @callback
    def add_new() -> None:
        new = []
        for uid, person in (coordinator.data or {}).get("people", {}).items():
            for med in person.get("medications", []):
                if med["id"] not in known:
                    known.add(med["id"])
                    new.append(LogDoseButton(coordinator, uid, med["id"]))
        if new:
            async_add_entities(new)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class LogDoseButton(CoordinatorEntity[WellbeingCoordinator], ButtonEntity):
    _attr_has_entity_name = True
    _attr_name = "Log dose"
    _attr_icon = "mdi:pill"

    def __init__(self, coordinator: WellbeingCoordinator, user_id: str, tracker_id: int) -> None:
        super().__init__(coordinator)
        self.user_id = user_id
        self.tracker_id = tracker_id
        self._attr_unique_id = f"med_{tracker_id}_log"
        self._attr_device_info = medication_device(user_id, tracker_id, (self.med or {}).get("name", "Medication"))

    @property
    def med(self) -> dict | None:
        person = self.coordinator.person(self.user_id) or {}
        return next((m for m in person.get("medications", []) if m["id"] == self.tracker_id), None)

    @property
    def due(self) -> dict | None:
        """The dose that's due, or the next one today: pressing logs that amount."""
        person = self.coordinator.person(self.user_id) or {}
        doses = [d for d in person.get("doses", []) if d["tracker_id"] == self.tracker_id
                 and d["status"] in ("due", "scheduled")]
        doses.sort(key=lambda d: (d["status"] != "due", d["time"]))
        return doses[0] if doses else None

    @property
    def available(self) -> bool:
        return super().available and self.med is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        due = self.due
        return {"user_id": self.user_id, "tracker_id": self.tracker_id, "medication": (self.med or {}).get("name"),
                "due": bool(due and due["status"] == "due"), "next_amount": due["amount"] if due else None,
                "next_time": due["time"] if due else None}

    async def async_press(self) -> None:
        due = self.due
        try:
            fresh = await self.coordinator.api.log_dose(
                self.user_id, str(self.tracker_id), due["quantity"] if due else None)
        except WellbeingError as err:
            raise HomeAssistantError(str(err)) from err
        self.coordinator.update_person(fresh)
