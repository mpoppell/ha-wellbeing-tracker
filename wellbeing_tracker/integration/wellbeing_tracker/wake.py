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

Back to sleep (with scripts to start and stop Sleep as Android's tracking)
  - The alarm has been snoozed for a while and tracking has stopped: start it again at once.
  - After the alarm (or tracking stopping) in the morning, the phone is locked, on charge and
    still, with nothing else happening for a while: start tracking again, from when it went quiet.
  - Tracking started again this way doesn't hold back waking up: any sign of being up counts, and
    stops it again. At most MAX_RESTARTS a morning.
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
    "bedtime_after": "20:00",    # the no-tracking bedtime rule applies from this time...
    "bedtime_until": "09:00",    # ...until this time (late nights happen)
    "night_charge_hours": 3,     # a charge this long counts as a night's charge
    "in_use_minutes": 10,        # unlocked this long counts as up
    "quiet_minutes": 30,         # no tracking: quiet this long counts as asleep
    "alarm": None,               # event entity: Sleep as Android's alarm clock
    "start_tracking": None,      # script that starts sleep tracking
    "stop_tracking": None,       # script that stops it
    "restart_quiet_minutes": 15,  # after the alarm: quiet this long counts as back asleep
    "snooze_restart_minutes": 10,  # snoozed this long with tracking stopped: start it again at once
    "back_to_sleep_minutes": 120,  # how long after the alarm going back to sleep is looked for
}

MAX_RESTARTS = 2            # tracking started again at most this often a morning
LATEST_MORNING = time(12, 0)  # an alarm or tracking stopping after this isn't waking up for the day
RESTART_WAIT = timedelta(minutes=10)  # asked to start: tracking should have started within this


def settings(options: dict | None) -> dict[str, Any]:
    s = {**DEFAULTS, **{k: v for k, v in (options or {}).items() if v not in (None, "")}}
    s["lights"] = list(s.get("lights") or [])
    s["signs"] = list(s.get("signs") or [])
    s["keep_awake"] = list(s.get("keep_awake") or [])
    return s


def watched(s: dict) -> list[str]:
    ids = [s[k] for k in ("sleep_tracking", "charging", "phone_locked", "activity", "person", "alarm") if s.get(k)]
    return ids + s["lights"] + s["signs"] + s["keep_awake"]


def is_configured(s: dict) -> bool:
    return bool(watched(s))


def _clock(value: str) -> time:
    h, m = (int(x) for x in str(value).split(":")[:2])
    return time(h, m)


def restarts_tracking(s: dict) -> bool:
    """Going back to sleep starts sleep tracking again: needs tracking and a script to start it."""
    return bool(s.get("sleep_tracking") and s.get("start_tracking"))


@dataclass
class Change:
    awake: bool
    at: datetime
    source: str


@dataclass
class Action:
    """Something to do in Home Assistant: start_tracking, stop_tracking, or back_asleep (tell the
    app that this morning's wake-up doesn't count)."""
    kind: str
    at: datetime
    reason: str
    since: datetime | None = None  # start_tracking: asleep since


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
    locked: bool | None = None              # the phone is locked now
    locked_since: datetime | None = None
    woke_at: datetime | None = None         # this morning's alarm dismissed (or tracking stopped)
    snoozed_at: datetime | None = None      # the alarm is snoozed, since
    stopped_at: datetime | None = None      # sleep tracking last stopped
    restarts: int = 0                       # tracking started again this morning
    restart_day: str | None = None          # ...counted for this day
    restarted: bool = False                 # tracking is running because we started it again
    restart_asked: datetime | None = None   # asked to start tracking, waiting for it
    restart_from: datetime | None = None    # ...asleep since
    pending: list[Change] = field(default_factory=list)
    actions: list[Action] = field(default_factory=list)

    # ----- what's remembered across restarts -----

    MEMORY = ("tracking", "charging_since", "lights_off_since", "last_activity", "woke_at", "snoozed_at",
              "stopped_at", "restarts", "restart_day", "restarted", "restart_asked", "restart_from")
    TIMES = ("charging_since", "lights_off_since", "last_activity", "woke_at", "snoozed_at", "stopped_at",
             "restart_asked", "restart_from")

    def memory(self) -> dict[str, Any]:
        out = {}
        for k in self.MEMORY:
            v = getattr(self, k)
            out[k] = v.isoformat() if isinstance(v, datetime) else v
        return out

    def restore(self, data: dict | None) -> None:
        for k in self.MEMORY:
            v = (data or {}).get(k)
            if k in self.TIMES and v:
                try:
                    v = datetime.fromisoformat(v)
                except (TypeError, ValueError):
                    v = None
            elif k == "restarts":
                v = int(v) if isinstance(v, (int, float)) else 0
            elif k == "restarted":
                v = bool(v)
            setattr(self, k, v)

    # ----- helpers -----

    def _local(self, at: datetime) -> datetime:
        return at.astimezone(self.tz)

    def _earliest_after(self, at: datetime) -> datetime:
        local = self._local(at)
        first = datetime.combine(local.date(), _clock(self.s["earliest"]), self.tz)
        return first if local < first else first + timedelta(days=1)

    def _is_night(self, at: datetime) -> bool:
        """Between bedtime and the earliest wake-up: asleep then isn't a nap."""
        t = self._local(at).time().replace(tzinfo=None)
        return t >= _clock(self.s["bedtime_after"]) or t < _clock(self.s["earliest"])

    def _is_bedtime(self, at: datetime) -> bool:
        """When the no-tracking bedtime rule applies: from bedtime until late morning."""
        t = self._local(at).time().replace(tzinfo=None)
        return t >= _clock(self.s["bedtime_after"]) or t < _clock(self.s["bedtime_until"])

    def _is_morning(self, at: datetime) -> bool:
        """Between the earliest wake-up and late morning: when going back to sleep is looked for."""
        t = self._local(at).time().replace(tzinfo=None)
        return _clock(self.s["earliest"]) <= t < LATEST_MORNING

    def may_wake(self, now: datetime, strong: bool = False) -> bool:
        """Asleep, it's late enough, and (unless strong) sleep tracking isn't still running.
        Tracking we started again doesn't count: going back to sleep is checked, not certain."""
        if self.awake:
            return False
        if not strong and self.s["sleep_tracking"] and self.tracking == "started" and not self.restarted:
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
            change = self._set(True, at, source)
            if change and self.restarted and self.tracking == "started" and self.s["stop_tracking"]:
                self.actions.append(Action("stop_tracking", now, f"up: {source}"))
            return change
        return None

    # ----- what Home Assistant saw -----

    def manual(self, awake: bool, at: datetime) -> Change | None:
        return self._set(awake, at, "manual")

    def tracking_event(self, event_type: str | None, at: datetime) -> Change | None:
        if event_type in ("started", "resumed"):
            self.tracking = "started"
            asked, self.restart_asked = self.restart_asked, None
            self.restarted = bool(asked and timedelta(0) <= at - asked <= RESTART_WAIT)
            if self.restarted:  # back asleep, whatever the switch said in between
                self.actions.append(Action("back_asleep", at, "sleep tracking started again", self.restart_from))
            if self.awake:
                if self.restarted:
                    return self._set(False, self.restart_from or at, "sleep tracking started again")
                return self._set(False, at, "sleep tracking started")
        elif event_type in ("stopped", "paused"):
            self.tracking = "stopped"
            self.stopped_at = at
            self.restarted = False
            self._morning_ends(at)
        return None

    def alarm_event(self, event_type: str | None, at: datetime) -> None:
        """Sleep as Android's alarm clock: snoozed, or dismissed (the morning starts)."""
        if event_type == "snooze_clicked":
            self.snoozed_at = at
        elif event_type in ("alert_dismiss", "snooze_canceled"):
            self.snoozed_at = None
            self._morning_ends(at)

    def _morning_ends(self, at: datetime) -> None:
        """The alarm went off or tracking stopped in the morning: watch for going back to sleep."""
        if not self._is_morning(at):
            return
        self.woke_at = at
        day = self._local(at).date().isoformat()
        if self.restart_day != day:
            self.restart_day, self.restarts = day, 0

    def stop_from_notification(self, now: datetime) -> Change | None:
        """Tapped Stop on the "back to sleep" notification: awake, and no more restarts today."""
        self.restarts = MAX_RESTARTS
        self.restart_day = self._local(now).date().isoformat()
        self.woke_at = self.snoozed_at = self.restart_asked = None
        if self.tracking == "started" and self.s["stop_tracking"]:
            self.actions.append(Action("stop_tracking", now, "stopped from the notification"))
        return self._set(True, now, "stopped sleep tracking")

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
        self.locked = locked
        self.locked_since = at if locked else None
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
        self._back_to_sleep(now)
        return self._fallback_sleep(now)

    def _back_to_sleep(self, now: datetime) -> Action | None:
        """Start sleep tracking again: the alarm's been snoozed a while, or the morning's gone
        quiet again after it."""
        s = self.s
        if not restarts_tracking(s) or self.tracking != "stopped" or self.busy or self.home is False:
            return None
        if self.restart_asked and now - self.restart_asked < RESTART_WAIT:
            return None  # asked already: waiting for tracking to start
        if self.restart_day == self._local(now).date().isoformat() and self.restarts >= MAX_RESTARTS:
            return None
        if s["charging"] and not self.charging_since:
            return None  # off the charger: up
        if s["phone_locked"] and self.locked is False:
            return None  # using the phone
        window = timedelta(minutes=float(s["back_to_sleep_minutes"]))
        snooze = self.snoozed_at
        if snooze and self._is_morning(snooze) and now - snooze <= window and (
                now - snooze >= timedelta(minutes=float(s["snooze_restart_minutes"]))):
            since = self.stopped_at if self.stopped_at and self.stopped_at >= snooze else snooze
            minutes = round((now - snooze).total_seconds() / 60)
            return self._restart(now, since, f"alarm snoozed for {minutes} minutes")
        if not self.woke_at or now - self.woke_at > window:
            return None
        marks = [self.woke_at]
        for t in (self.last_activity, self.locked_since, self.charging_since):
            if t:
                marks.append(t)
        quiet_from = max(marks)
        if now - quiet_from >= timedelta(minutes=float(s["restart_quiet_minutes"])):
            return self._restart(now, quiet_from, f"quiet since {self._local(quiet_from).strftime('%H:%M')}")
        return None

    def _restart(self, now: datetime, since: datetime, reason: str) -> Action:
        day = self._local(now).date().isoformat()
        if self.restart_day != day:
            self.restart_day, self.restarts = day, 0
        self.restarts += 1
        self.restart_asked, self.restart_from = now, since
        self.woke_at = self.snoozed_at = None  # until the next alarm or stop
        action = Action("start_tracking", now, reason, since)
        self.actions.append(action)
        return action

    def _fallback_sleep(self, now: datetime) -> Change | None:
        """No sleep tracking tonight: home, on charge, lights off and quiet for a while."""
        s = self.s
        if not self.awake or not self._is_bedtime(now):
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
