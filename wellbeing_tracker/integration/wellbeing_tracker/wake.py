"""Awake or asleep: the rules, kept apart from Home Assistant so they can be tested on their own.

The switch entity (switch.py) feeds these rules what it sees in Home Assistant and asks them,
once a minute, whether anything has changed. Every decision says when it happened (which can be
earlier than now, e.g. "asleep since the light went off") and how it was worked out.

Asleep
  - Sleep tracking starts (e.g. Sleep as Android), at any time of day.
  - Or, at night, with no sleep tracking: home, phone on charge and the bedroom lights off, with
    nothing else happening for a while. Dated to when things went quiet.

Awake (only after the earliest wake-up time, and only once sleep tracking has stopped)
  - The phone comes off charge after a night on it.
  - The phone is unlocked, freshly, and stays unlocked for a few minutes.
  - The phone notices walking, or any of the "signs you're up" happens.
  - Leaving home. This and the charger count even if sleep tracking was left running.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Any

# A "sign you're up" counts when its entity changes to one of these, or (a power sensor) rises
# above SIGN_POWER_W.
SIGN_STATES = {"on", "open", "opening", "unlocked", "unlocking", "playing", "sessionunlock", "detected"}
SIGN_POWER_W = 20.0
WALKING = {"walking", "running", "on_foot"}

DEFAULTS: dict[str, Any] = {
    "sleep_tracking": None,      # event entity: started / stopped
    "charging": None,            # binary_sensor, on while charging
    "phone_locked": None,        # binary_sensor, on while locked
    "activity": None,            # sensor: still / walking / ...
    "person": None,              # person entity
    "lights": [],                # bedroom lights
    "signs": [],                 # anything that only happens once you're up
    "keep_awake": [],            # not asleep while any of these is on (a computer, the TV)
    "earliest": "04:00",         # no waking up before this
    "bedtime_after": "20:00",    # the no-tracking bedtime rule only applies from this time
    "night_charge_hours": 3,     # a charge this long counts as a night's charge
    "in_use_minutes": 10,        # unlocked this long counts as up
    "quiet_minutes": 30,         # no tracking: quiet this long counts as asleep
}


def settings(options: dict | None) -> dict[str, Any]:
    s = {**DEFAULTS, **{k: v for k, v in (options or {}).items() if v not in (None, "")}}
    s["lights"] = list(s.get("lights") or [])
    s["signs"] = list(s.get("signs") or [])
    s["keep_awake"] = list(s.get("keep_awake") or [])
    return s


def watched(s: dict) -> list[str]:
    ids = [s[k] for k in ("sleep_tracking", "charging", "phone_locked", "activity", "person") if s.get(k)]
    return ids + s["lights"] + s["signs"] + s["keep_awake"]


def is_configured(s: dict) -> bool:
    return bool(watched(s))


def _clock(value: str) -> time:
    h, m = (int(x) for x in str(value).split(":")[:2])
    return time(h, m)


@dataclass
class Change:
    awake: bool
    at: datetime
    source: str


@dataclass
class Rules:
    """The current state plus what the rules remember. `tz` is Home Assistant's time zone."""

    s: dict[str, Any]
    tz: Any
    awake: bool = True
    since: datetime | None = None
    source: str | None = None
    tracking: str | None = None             # "started" or "stopped", from the last tracking event
    charging_since: datetime | None = None  # on charge since
    unlocked_at: datetime | None = None     # a fresh unlock, still unlocked
    lights_off_since: datetime | None = None
    last_activity: datetime | None = None   # signs, unlocks, walking
    home: bool | None = None
    busy: bool = False                      # something in keep_awake is on
    pending: list[Change] = field(default_factory=list)

    # ----- what's remembered across restarts -----

    MEMORY = ("tracking", "charging_since", "lights_off_since", "last_activity")

    def memory(self) -> dict[str, Any]:
        out = {}
        for k in self.MEMORY:
            v = getattr(self, k)
            out[k] = v.isoformat() if isinstance(v, datetime) else v
        return out

    def restore(self, data: dict | None) -> None:
        for k in self.MEMORY:
            v = (data or {}).get(k)
            if v and k != "tracking":
                try:
                    v = datetime.fromisoformat(v)
                except (TypeError, ValueError):
                    v = None
            setattr(self, k, v)

    # ----- helpers -----

    def _local(self, at: datetime) -> datetime:
        return at.astimezone(self.tz)

    def _earliest_after(self, at: datetime) -> datetime:
        local = self._local(at)
        first = datetime.combine(local.date(), _clock(self.s["earliest"]), self.tz)
        return first if local < first else first + timedelta(days=1)

    def _is_night(self, at: datetime) -> bool:
        t = self._local(at).time().replace(tzinfo=None)
        return t >= _clock(self.s["bedtime_after"]) or t < _clock(self.s["earliest"])

    def may_wake(self, now: datetime, strong: bool = False) -> bool:
        """Asleep, it's late enough, and (unless strong) sleep tracking isn't still running."""
        if self.awake:
            return False
        if not strong and self.s["sleep_tracking"] and self.tracking == "started":
            return False
        since = self.since or now
        if not self._is_night(since):
            return True  # a daytime nap: any sign of life ends it
        return now >= self._earliest_after(since)

    def _set(self, awake: bool, at: datetime, source: str) -> Change | None:
        if awake == self.awake:
            return None
        self.awake, self.since, self.source = awake, at, source
        if not awake:
            self.unlocked_at = None
        change = Change(awake, at, source)
        self.pending.append(change)
        return change

    def _wake(self, now: datetime, at: datetime, source: str, strong: bool = False) -> Change | None:
        if self.may_wake(now, strong):
            return self._set(True, at, source)
        return None

    # ----- what Home Assistant saw -----

    def manual(self, awake: bool, at: datetime) -> Change | None:
        return self._set(awake, at, "manual")

    def tracking_event(self, event_type: str | None, at: datetime) -> Change | None:
        if event_type in ("started", "resumed"):
            self.tracking = "started"
            if self.awake:
                return self._set(False, at, "sleep tracking started")
        elif event_type in ("stopped", "paused"):
            self.tracking = "stopped"
        return None

    def charging_changed(self, on: bool, at: datetime, now: datetime) -> Change | None:
        if on:
            self.charging_since = self.charging_since or at
            return None
        started, self.charging_since = self.charging_since, None
        if started and at - started >= timedelta(hours=float(self.s["night_charge_hours"])):
            return self._wake(now, at, "phone off charger", strong=True)
        return None

    def lock_changed(self, locked: bool, at: datetime) -> None:
        """Only a change counts: a phone can say "unlocked" all night without being touched."""
        if locked:
            self.unlocked_at = None
        else:
            self.unlocked_at = at
            self.last_activity = at

    def activity_changed(self, value: str | None, at: datetime, now: datetime) -> Change | None:
        if (value or "").lower() in WALKING:
            self.last_activity = at
            return self._wake(now, at, "walking")
        return None

    def sign(self, label: str, at: datetime, now: datetime) -> Change | None:
        self.last_activity = at
        return self._wake(now, at, label)

    def home_changed(self, home: bool, at: datetime, now: datetime) -> Change | None:
        was, self.home = self.home, home
        if was and not home:
            return self._wake(now, at, "left home", strong=True)
        return None

    def busy_changed(self, busy: bool, at: datetime) -> None:
        if self.busy and not busy:
            self.last_activity = at  # quiet starts when the computer goes off, not before
        self.busy = busy

    def lights_changed(self, all_off: bool, at: datetime) -> None:
        if all_off:
            self.lights_off_since = self.lights_off_since or at
        else:
            self.lights_off_since = None

    # ----- once a minute -----

    def tick(self, now: datetime) -> Change | None:
        # Unlocked and kept unlocked: up, from when it was unlocked (but not before the earliest
        # wake-up). Used once either way, so a phone left "unlocked" overnight never counts.
        if self.unlocked_at and now - self.unlocked_at >= timedelta(minutes=float(self.s["in_use_minutes"])):
            at, self.unlocked_at = self.unlocked_at, None
            if not self.awake and self.since and self._is_night(self.since):
                at = max(at, self._earliest_after(self.since))
            change = self._wake(now, at, "phone in use")
            if change:
                return change
        return self._fallback_sleep(now)

    def _fallback_sleep(self, now: datetime) -> Change | None:
        """No sleep tracking tonight: home, on charge, lights off and quiet for a while."""
        s = self.s
        if not self.awake or not self._is_night(now):
            return None
        if s["sleep_tracking"] and self.tracking == "started":
            return None  # tracking would have said so
        if not (s["charging"] or s["lights"]) or self.busy:
            return None
        if s["person"] and self.home is False:
            return None
        marks = []
        if s["charging"]:
            if not self.charging_since:
                return None
            marks.append(self.charging_since)
        if s["lights"]:
            if not self.lights_off_since:
                return None
            marks.append(self.lights_off_since)
        if self.last_activity:
            marks.append(self.last_activity)
        if self.since and self.awake:
            marks.append(self.since)  # not straight back to sleep after being woken
        quiet_from = max(marks)
        if now - quiet_from >= timedelta(minutes=float(s["quiet_minutes"])):
            return self._set(False, quiet_from, "phone on charge and lights off")
        return None


def counts_as_sign(new_state: str | None, unit: str | None, old_state: str | None) -> bool:
    """Whether a "sign you're up" entity's change means someone's up."""
    if new_state in (None, "unavailable", "unknown"):
        return False
    if old_state in ("unavailable", "unknown"):
        old_state = None  # back from being off or asleep: compare with nothing
    if unit and unit.lower() in ("w", "kw"):
        try:
            watts = float(new_state) * (1000 if unit.lower() == "kw" else 1)
            before = float(old_state) * (1000 if unit.lower() == "kw" else 1) if old_state is not None else 0.0
        except (TypeError, ValueError):
            return False
        return watts > SIGN_POWER_W >= before
    return new_state.lower() in SIGN_STATES and (old_state or "").lower() not in SIGN_STATES
