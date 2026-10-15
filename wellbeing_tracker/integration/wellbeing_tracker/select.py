"""Today's mood as a select: choosing an option logs it. Works with Bubble Card's select card."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import WellbeingConfigEntry
from .api import WellbeingError
from .coordinator import WellbeingCoordinator
from .entity import person_device


async def async_setup_entry(hass: HomeAssistant, entry: WellbeingConfigEntry,
                            async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def add_new() -> None:
        new = []
        for uid, person in (coordinator.data or {}).get("people", {}).items():
            if person.get("mood_scale") and uid not in known:
                known.add(uid)
                new.append(MoodSelect(coordinator, uid))
        if new:
            async_add_entities(new)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


def option_text(value: int, scale: dict) -> str:
    labels = scale.get("labels") or []
    label = labels[value - scale["min"]] if len(labels) > value - scale["min"] >= 0 else None
    return f"{value} {label}" if label else str(value)


class MoodSelect(CoordinatorEntity[WellbeingCoordinator], SelectEntity):
    _attr_has_entity_name = True
    _attr_name = "Mood"
    _attr_icon = "mdi:emoticon-outline"

    def __init__(self, coordinator: WellbeingCoordinator, user_id: str) -> None:
        super().__init__(coordinator)
        self.user_id = user_id
        self._attr_unique_id = f"{user_id}_mood_select"
        self._attr_device_info = person_device(coordinator, user_id)

    @property
    def scale(self) -> dict:
        return (self.coordinator.person(self.user_id) or {}).get("mood_scale") or {"min": 1, "max": 10, "labels": []}

    @property
    def options(self) -> list[str]:
        s = self.scale
        return [option_text(v, s) for v in range(s["max"], s["min"] - 1, -1)]  # best first

    @property
    def current_option(self) -> str | None:
        mood = (self.coordinator.person(self.user_id) or {}).get("mood")
        return option_text(mood["value"], self.scale) if mood else None

    @property
    def available(self) -> bool:
        return super().available and bool((self.coordinator.person(self.user_id) or {}).get("mood_scale"))

    async def async_select_option(self, option: str) -> None:
        if option not in self.options:
            raise ServiceValidationError(f"{option} isn't a mood option")
        value = int(option.split(" ", 1)[0])
        try:
            fresh = await self.coordinator.api.log(self.user_id, "mood", value)
        except WellbeingError as err:
            raise HomeAssistantError(str(err)) from err
        self.coordinator.update_person(fresh)
