"""Entities: one device per person, and one per medication whose supply is being counted."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import WellbeingConfigEntry
from .coordinator import WellbeingCoordinator
from .entity import medication_device, person_device

# The card reads these. They change often and say little on their own, so they aren't recorded.
CARD_ATTRIBUTES = frozenset({"inbox", "doses", "supply", "doctor", "medications", "mood", "mood_scale",
                             "next_dose", "panel_path"})


async def async_setup_entry(hass: HomeAssistant, entry: WellbeingConfigEntry,
                            async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def add_new() -> None:
        new: list[SensorEntity] = []
        for uid, person in (coordinator.data or {}).get("people", {}).items():
            for cls in (RemindersSensor, NextDoseSensor, MoodSensor, DoctorSensor):
                key = f"{uid}_{cls.key}"
                if key not in known:
                    known.add(key)
                    new.append(cls(coordinator, uid))
            for med in person.get("supply", []):
                for cls in (SupplyDaysSensor, ScriptBySensor):
                    key = f"med_{med['tracker_id']}_{cls.key}"
                    if key not in known:
                        known.add(key)
                        new.append(cls(coordinator, uid, med["tracker_id"]))
        if new:
            async_add_entities(new)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class PersonEntity(CoordinatorEntity[WellbeingCoordinator], SensorEntity):
    _attr_has_entity_name = True
    key = ""

    def __init__(self, coordinator: WellbeingCoordinator, user_id: str) -> None:
        super().__init__(coordinator)
        self.user_id = user_id
        self._attr_unique_id = f"{user_id}_{self.key}"
        self._attr_device_info = person_device(coordinator, user_id)

    @property
    def person(self) -> dict:
        return self.coordinator.person(self.user_id) or {}

    @property
    def available(self) -> bool:
        return super().available and bool(self.coordinator.person(self.user_id))


class RemindersSensor(PersonEntity):
    """How many reminders are waiting. Also carries everything the dashboard card shows."""

    key = "reminders"
    _attr_name = "Reminders waiting"
    _attr_icon = "mdi:bell-ring-outline"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _unrecorded_attributes = CARD_ATTRIBUTES

    @property
    def native_value(self) -> int:
        return len(self.person.get("inbox", []))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        p = self.person
        return {
            "wellbeing_card": True,
            "user_id": self.user_id,
            "person": p.get("name"),
            "panel_path": (self.coordinator.data or {}).get("panel_path"),
            **{k: p.get(k) for k in ("inbox", "doses", "next_dose", "supply", "doctor", "medications", "mood",
                                     "mood_scale")},
        }


class NextDoseSensor(PersonEntity):
    key = "next_dose"
    _attr_name = "Next dose"
    _attr_icon = "mdi:pill"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    @property
    def native_value(self) -> datetime | None:
        nxt = self.person.get("next_dose")
        return datetime.fromisoformat(nxt["at"]) if nxt else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        nxt = self.person.get("next_dose") or {}
        return {"medication": nxt.get("name"), "amount": nxt.get("amount"), "due": nxt.get("status") == "due"}


class MoodSensor(PersonEntity):
    key = "mood"
    _attr_name = "Mood today"
    _attr_icon = "mdi:emoticon-outline"
    _attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def native_value(self) -> int | None:
        mood = self.person.get("mood")
        return mood["value"] if mood else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        mood = self.person.get("mood") or {}
        return {"label": mood.get("label"), "out_of": mood.get("max")}


class DoctorSensor(PersonEntity):
    """The next date a new script is needed: when to see the doctor."""

    key = "doctor"
    _attr_name = "See the doctor by"
    _attr_icon = "mdi:doctor"
    _attr_device_class = SensorDeviceClass.DATE

    @property
    def native_value(self) -> date | None:
        doc = self.person.get("doctor")
        return date.fromisoformat(doc["by"]) if doc else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        doc = self.person.get("doctor") or {}
        return {"medications": doc.get("names", [])}


class MedicationEntity(CoordinatorEntity[WellbeingCoordinator], SensorEntity):
    _attr_has_entity_name = True
    key = ""

    def __init__(self, coordinator: WellbeingCoordinator, user_id: str, tracker_id: int) -> None:
        super().__init__(coordinator)
        self.user_id = user_id
        self.tracker_id = tracker_id
        self._attr_unique_id = f"med_{tracker_id}_{self.key}"
        self._attr_device_info = medication_device(user_id, tracker_id, (self.med or {}).get("name", "Medication"))

    @property
    def med(self) -> dict | None:
        person = self.coordinator.person(self.user_id) or {}
        return next((m for m in person.get("supply", []) if m["tracker_id"] == self.tracker_id), None)

    @property
    def available(self) -> bool:
        return super().available and self.med is not None


class SupplyDaysSensor(MedicationEntity):
    key = "supply_days"
    _attr_name = "Supply left"
    _attr_icon = "mdi:pill-multiple"
    _attr_device_class = SensorDeviceClass.DURATION
    _attr_native_unit_of_measurement = "d"
    _attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def native_value(self) -> int | None:
        return (self.med or {}).get("days_left")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        m = self.med or {}
        return {"left": m.get("stock"), "unit": m.get("word"), "runs_out": m.get("runs_out"),
                "refill_from": m.get("refill_from"), "repeats_left": m.get("repeats"),
                "warnings": [a["text"] for a in m.get("alerts", [])]}


class ScriptBySensor(MedicationEntity):
    key = "script_by"
    _attr_name = "New script needed by"
    _attr_icon = "mdi:file-document-alert-outline"
    _attr_device_class = SensorDeviceClass.DATE

    @property
    def native_value(self) -> date | None:
        by = (self.med or {}).get("script_by")
        return date.fromisoformat(by) if by else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"reason": (self.med or {}).get("script_reason")}
