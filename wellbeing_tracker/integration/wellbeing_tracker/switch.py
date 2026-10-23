"""Awake: one switch per person, on while they're up and off while they're asleep.

It follows the signals chosen under Configure (see wake.py for the rules) and can always be
flipped by hand. Use it in automations for "when I wake up" and "when I fall asleep". Waking up
also tells the Wellbeing app, for medications due when you're up.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from homeassistant.helpers.restore_state import ExtraStoredData, RestoredExtraData, RestoreEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from . import WellbeingConfigEntry
from .api import WellbeingError
from .coordinator import WellbeingCoordinator
from .entity import person_device
from .wake import Change, Rules, counts_as_sign, is_configured, settings, watched

_LOGGER = logging.getLogger(__name__)

GONE = (STATE_UNAVAILABLE, STATE_UNKNOWN, None)
IDLE = {"off", "standby", "idle", "closed", "locked", "not_home", "unavailable", "unknown"}
SETTLE = timedelta(minutes=2)  # after a restart, entities replay their states: don't read those as news


async def async_setup_entry(hass: HomeAssistant, entry: WellbeingConfigEntry,
                            async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def add_new() -> None:
        new = []
        for uid in (coordinator.data or {}).get("people", {}):
            if uid not in known:
                known.add(uid)
                new.append(AwakeSwitch(coordinator, entry, uid))
        if new:
            async_add_entities(new)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class AwakeSwitch(CoordinatorEntity[WellbeingCoordinator], SwitchEntity, RestoreEntity):
    _attr_has_entity_name = True
    _attr_name = "Awake"

    def __init__(self, coordinator: WellbeingCoordinator, entry: WellbeingConfigEntry, user_id: str) -> None:
        super().__init__(coordinator)
        self.user_id = user_id
        self.entry = entry
        self._attr_unique_id = f"{user_id}_awake"
        self._attr_device_info = person_device(coordinator, user_id)
        self.s = settings(((entry.options or {}).get("people") or {}).get(user_id))
        self.rules = Rules(self.s, dt_util.get_default_time_zone())
        self._started = dt_util.utcnow()

    # ----- state -----

    @property
    def is_on(self) -> bool:
        return self.rules.awake

    @property
    def icon(self) -> str:
        return "mdi:weather-sunny" if self.rules.awake else "mdi:sleep"

    @property
    def available(self) -> bool:
        return True  # works even while the app is restarting

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"since": self.rules.since.isoformat() if self.rules.since else None,
                "how": self.rules.source, "automatic": is_configured(self.s)}

    @property
    def extra_restore_state_data(self) -> ExtraStoredData:
        return RestoredExtraData(self.rules.memory())

    # ----- start and stop -----

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_state()
        if last is not None:
            self.rules.awake = last.state != "off"
            since = last.attributes.get("since")
            self.rules.since = dt_util.parse_datetime(since) if since else None
            self.rules.source = last.attributes.get("how")
        extra = await self.async_get_last_extra_data()
        self.rules.restore(extra.as_dict() if extra else None)
        self._read_current()
        ids = watched(self.s)
        if ids:
            self.async_on_remove(async_track_state_change_event(self.hass, ids, self._changed))
            self.async_on_remove(async_track_time_interval(self.hass, self._tick, timedelta(minutes=1)))
        await self._tell_app_who_decides()

    @callback
    def _read_current(self) -> None:
        """Pick up where things are now, keeping what was remembered from before a restart."""
        s, r, now = self.s, self.rules, dt_util.utcnow()
        if s["charging"]:
            st = self.hass.states.get(s["charging"])
            if st is None or st.state != "on":
                r.charging_since = None
            elif not r.charging_since:
                r.charging_since = st.last_changed
        if s["sleep_tracking"] and not r.tracking:
            st = self.hass.states.get(s["sleep_tracking"])
            event_type = st.attributes.get("event_type") if st else None
            r.tracking = "started" if event_type in ("started", "resumed") else "stopped" if event_type else None
        if s["person"]:
            st = self.hass.states.get(s["person"])
            r.home = None if st is None or st.state in GONE else st.state == "home"
        if s["lights"]:
            self._lights(now, remember=True)
        if s["keep_awake"]:
            r.busy = self._busy()

    # ----- what changed -----

    @callback
    def _changed(self, event: Event[EventStateChangedData]) -> None:
        eid = event.data["entity_id"]
        old: State | None = event.data["old_state"]
        new: State | None = event.data["new_state"]
        if new is None:
            return
        s, r, now = self.s, self.rules, dt_util.utcnow()
        at = new.last_changed
        settling = now - self._started < SETTLE
        if eid == s["sleep_tracking"]:
            # An event entity's state is the time of its last event: a new time is a new event.
            if old is not None and old.state not in GONE and new.state not in GONE and new.state != old.state:
                r.tracking_event(new.attributes.get("event_type"), at)
        elif eid == s["charging"]:
            if new.state in ("on", "off") and (old is None or old.state != new.state) and not (
                    settling and old is not None and old.state in GONE):
                r.charging_changed(new.state == "on", at, now)
        elif eid == s["phone_locked"]:
            if old is not None and old.state in ("on", "off") and new.state in ("on", "off") and old.state != new.state:
                r.lock_changed(new.state == "on", at)
        elif eid == s["activity"]:
            if new.state not in GONE and (old is None or old.state != new.state):
                r.activity_changed(new.state, at, now)
        elif eid == s["person"]:
            if new.state not in GONE:
                r.home_changed(new.state == "home", at, now)
        if eid in s["lights"]:
            self._lights(at)
        if eid in s["keep_awake"]:
            r.busy_changed(self._busy(), at)
        if eid in s["signs"] and not settling and not self._blip(old, at):
            if counts_as_sign(new.state, new.attributes.get("unit_of_measurement"),
                              old.state if old is not None else None):
                unit = new.attributes.get("unit_of_measurement")
                r.sign(f"{new.name}: {new.state}" if not unit else f"{new.name}: {new.state} {unit}", at, now)
        self._apply()

    @callback
    def _tick(self, now: datetime) -> None:
        self.rules.tick(dt_util.utcnow())
        self._apply()

    @callback
    def _lights(self, at: datetime, remember: bool = False) -> None:
        states = [self.hass.states.get(e) for e in self.s["lights"]]
        known = [st for st in states if st is not None and st.state not in GONE]
        if not known:
            return
        all_off = all(st.state == "off" for st in known)
        if remember and all_off and not self.rules.lights_off_since:
            at = max(st.last_changed for st in known)
        self.rules.lights_changed(all_off, at)

    @staticmethod
    def _blip(old: State | None, at: datetime) -> bool:
        """Unavailable for a moment and back (a reconnect), rather than really off and back on."""
        return old is not None and old.state in GONE and at - old.last_changed < timedelta(seconds=60)

    def _busy(self) -> bool:
        for e in self.s["keep_awake"]:
            st = self.hass.states.get(e)
            if st is not None and st.state.lower() not in IDLE:
                return True
        return False

    @callback
    def _apply(self) -> None:
        changes, self.rules.pending = self.rules.pending, []
        self.async_write_ha_state()  # also saves what the rules remember
        for change in changes:
            _LOGGER.info("%s is %s (%s, %s)", self.user_id, "awake" if change.awake else "asleep",
                         dt_util.as_local(change.at).strftime("%H:%M"), change.source)
            if change.awake:
                self.hass.async_create_task(self._tell_app_awake(change))

    # ----- by hand -----

    async def async_turn_on(self, **kwargs: Any) -> None:
        self.rules.manual(True, dt_util.utcnow())
        self._apply()

    async def async_turn_off(self, **kwargs: Any) -> None:
        self.rules.manual(False, dt_util.utcnow())
        self._apply()

    # ----- the Wellbeing app -----

    async def _tell_app_awake(self, change: Change) -> None:
        try:
            person = await self.coordinator.api.wake(self.user_id, change.at.isoformat(), change.source)
        except WellbeingError as err:
            _LOGGER.warning("Couldn't tell Wellbeing that %s is up: %s", self.user_id, err)
            return
        self.coordinator.update_person(person)

    async def _tell_app_who_decides(self) -> None:
        """With signals chosen here, the app leaves waking up to this switch (and links to it)."""
        try:
            await self.coordinator.api.wake_source(self.user_id, self.entity_id if is_configured(self.s) else None)
        except WellbeingError as err:
            _LOGGER.debug("Couldn't tell Wellbeing about %s: %s", self.entity_id, err)
