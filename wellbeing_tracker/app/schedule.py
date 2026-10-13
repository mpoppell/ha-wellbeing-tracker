"""Reminder settings: defaults, validation and the rules for when doses are due.

Two kinds of settings, both stored as JSON and always merged over these defaults,
so older saved settings keep working when new options are added:

* Person settings: where reminders go and how they behave for that person.
* Medication schedule: when one medication is due and how hard to nag about it.

Everything beyond "remind me at these times" is optional.
"""

from __future__ import annotations

import re
from copy import deepcopy
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from .trackers import ValidationError

TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

# How hard to nag. 'every' is minutes between repeats, 'repeats' is how many
# repeats after the first reminder (None = keep going until the latest time or end of day).
NAG_PRESETS = {
    "once": {"every": None, "repeats": 0},
    "gently": {"every": 30, "repeats": 4},
    "firmly": {"every": 10, "repeats": 6},
}

PERSON_DEFAULTS = {
    "devices": [],              # notify services, e.g. "mobile_app_s26u"
    "group_doses": True,        # one notification for medications due at the same time
    "undo": True,               # show "Undo" for a minute after answering
    "swipe_away": False,        # False = reminders stay until answered
    "snooze_minutes": 15,
    "quiet": {"enabled": False, "start": "22:00", "end": "07:00"},
    "speakers": [],             # media_player entities for announcements
    "tts_entity": None,         # e.g. tts.home_assistant_cloud
    "announce_only_home": True,
    "person_entity": None,      # None = find the person linked to this HA user
}

SCHEDULE_DEFAULTS = {
    "times": ["08:00"],
    "days": {"mode": "daily", "weekdays": [0, 1, 2, 3, 4, 5, 6], "every": 2, "start": None},
    "nag": "firmly",            # once | gently | firmly | custom
    "nag_every": 10,            # custom only: minutes between repeats
    "nag_repeats": 6,           # custom only: repeats after the first (null = until latest time)
    "hard_to_miss": False,      # escalate after a few unanswered reminders
    "hard_after": 3,            # escalate from this reminder onwards
    "alarm_sound": True,        # escalation rings as an alarm (through Do Not Disturb)
    "announce": False,          # escalation is also announced on speakers
    "latest_time": None,        # after this, stop nagging and ask "skip or take anyway?"
    "early_window": 180,        # a dose logged up to this many minutes early counts
    "linked_entity": None,      # input_boolean kept in sync with "taken"
    "linked_time_entity": None, # input_datetime set to the time it was taken
}


def _merge(defaults: dict, saved: dict | None) -> dict:
    out = deepcopy(defaults)
    for k, v in (saved or {}).items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = {**out[k], **v}
        elif k in out:
            out[k] = v
    return out


def _time(value, label: str) -> str:
    if not isinstance(value, str) or not TIME_RE.match(value):
        raise ValidationError(f"{label} must be a time like 07:30")
    return value


def _entity(value, domain: str, label: str) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not re.match(rf"^{domain}\.[a-z0-9_]+$", value):
        raise ValidationError(f"{label} must be a {domain} entity")
    return value


def person_settings(saved: dict | None) -> dict:
    return _merge(PERSON_DEFAULTS, saved)


def normalise_person_settings(data: dict) -> dict:
    s = person_settings(data)
    devices = s["devices"]
    if not isinstance(devices, list) or not all(
        isinstance(d, str) and re.match(r"^[a-z0-9_]+$", d) for d in devices
    ):
        raise ValidationError("Choose phones from the list")
    s["devices"] = list(dict.fromkeys(devices))
    for key in ("group_doses", "undo", "swipe_away", "announce_only_home"):
        s[key] = bool(s[key])
    try:
        snooze = int(s["snooze_minutes"])
    except (TypeError, ValueError):
        raise ValidationError("Snooze must be a number of minutes") from None
    if not 1 <= snooze <= 240:
        raise ValidationError("Snooze must be 1–240 minutes")
    s["snooze_minutes"] = snooze
    q = s["quiet"]
    s["quiet"] = {
        "enabled": bool(q.get("enabled")),
        "start": _time(q.get("start"), "Quiet hours start"),
        "end": _time(q.get("end"), "Quiet hours end"),
    }
    speakers = s["speakers"]
    if not isinstance(speakers, list):
        raise ValidationError("Choose speakers from the list")
    s["speakers"] = [_entity(x, "media_player", "Speaker") for x in speakers if x]
    s["tts_entity"] = _entity(s["tts_entity"], "tts", "Voice")
    s["person_entity"] = _entity(s["person_entity"], "person", "Person")
    return s


def schedule_settings(saved: dict | None) -> dict:
    return _merge(SCHEDULE_DEFAULTS, saved)


def normalise_schedule(data: dict) -> dict:
    s = schedule_settings(data)
    times = s["times"]
    if not isinstance(times, list) or not times:
        raise ValidationError("Add at least one time")
    s["times"] = sorted(set(_time(t, "Reminder time") for t in times))
    if len(s["times"]) > 12:
        raise ValidationError("Up to 12 times a day")

    d = s["days"]
    mode = d.get("mode")
    if mode not in ("daily", "weekdays", "interval"):
        raise ValidationError("Choose which days")
    weekdays = d.get("weekdays") or []
    if mode == "weekdays":
        if not weekdays or not all(isinstance(w, int) and 0 <= w <= 6 for w in weekdays):
            raise ValidationError("Choose at least one day")
    every = d.get("every") or 2
    start = d.get("start")
    if mode == "interval":
        try:
            every = int(every)
        except (TypeError, ValueError):
            raise ValidationError("Every how many days?") from None
        if not 2 <= every <= 60:
            raise ValidationError("Every 2–60 days")
        try:
            start = date.fromisoformat(start).isoformat()
        except (TypeError, ValueError):
            raise ValidationError("Choose the first day") from None
    s["days"] = {
        "mode": mode,
        "weekdays": sorted(set(weekdays)) if weekdays else [0, 1, 2, 3, 4, 5, 6],
        "every": int(every),
        "start": start,
    }

    if s["nag"] not in ("once", "gently", "firmly", "custom"):
        raise ValidationError("Choose how often to remind")
    try:
        s["nag_every"] = int(s["nag_every"])
    except (TypeError, ValueError):
        raise ValidationError("Repeat every how many minutes?") from None
    if not 1 <= s["nag_every"] <= 240:
        raise ValidationError("Repeat every 1–240 minutes")
    if s["nag_repeats"] is not None:
        try:
            s["nag_repeats"] = int(s["nag_repeats"])
        except (TypeError, ValueError):
            raise ValidationError("How many repeats?") from None
        if not 0 <= s["nag_repeats"] <= 50:
            raise ValidationError("Up to 50 repeats")

    for key in ("hard_to_miss", "alarm_sound", "announce"):
        s[key] = bool(s[key])
    try:
        s["hard_after"] = int(s["hard_after"])
    except (TypeError, ValueError):
        raise ValidationError("Escalate after how many reminders?") from None
    if not 1 <= s["hard_after"] <= 20:
        raise ValidationError("Escalate after 1–20 reminders")

    s["latest_time"] = _time(s["latest_time"], "Latest time") if s["latest_time"] else None
    if s["latest_time"] and s["latest_time"] <= s["times"][0]:
        raise ValidationError("The latest time must be after the first reminder")
    try:
        s["early_window"] = int(s["early_window"])
    except (TypeError, ValueError):
        raise ValidationError("Early window must be minutes") from None
    if not 0 <= s["early_window"] <= 720:
        raise ValidationError("Early window must be 0–720 minutes")
    s["linked_entity"] = _entity(s["linked_entity"], "input_boolean", "Linked toggle")
    s["linked_time_entity"] = _entity(s["linked_time_entity"], "input_datetime", "Linked time")
    return s


def nag_params(s: dict) -> tuple[int | None, int | None]:
    """(minutes between repeats, number of repeats) for a schedule."""
    if s["nag"] == "custom":
        return s["nag_every"], s["nag_repeats"]
    p = NAG_PRESETS[s["nag"]]
    return p["every"], p["repeats"]


def runs_on(s: dict, day: date) -> bool:
    d = s["days"]
    if d["mode"] == "daily":
        return True
    if d["mode"] == "weekdays":
        return day.weekday() in d["weekdays"]
    start = date.fromisoformat(d["start"])
    return day >= start and (day - start).days % d["every"] == 0


def due_times(s: dict, day: date, tz: ZoneInfo) -> list[tuple[str, datetime, datetime | None]]:
    """(local "HH:MM", due datetime, latest datetime or None) for each dose on a day."""
    if not runs_on(s, day):
        return []
    out = []
    latest = None
    if s["latest_time"]:
        h, m = map(int, s["latest_time"].split(":"))
        latest = datetime.combine(day, time(h, m), tz)
    for t in s["times"]:
        h, m = map(int, t.split(":"))
        due = datetime.combine(day, time(h, m), tz)
        out.append((t, due, latest if latest and latest > due else None))
    return out


def in_quiet_hours(settings: dict, local_now: datetime) -> bool:
    q = settings["quiet"]
    if not q["enabled"]:
        return False
    now = local_now.strftime("%H:%M")
    start, end = q["start"], q["end"]
    if start == end:
        return False
    if start < end:
        return start <= now < end
    return now >= start or now < end  # crosses midnight


def describe_time(hhmm: str) -> str:
    h, m = map(int, hhmm.split(":"))
    suffix = "am" if h < 12 else "pm"
    return f"{h % 12 or 12}:{m:02d}{suffix}" if m else f"{h % 12 or 12}{suffix}"


def add_minutes(dt: datetime, minutes: int) -> datetime:
    return dt + timedelta(minutes=minutes)
