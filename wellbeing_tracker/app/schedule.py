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
    # Reminders to fill in a check-in (mood, symptoms and so on).
    "checkins": {
        "enabled": False,
        "times": ["09:00", "20:00"],
        "days": {"mode": "daily", "weekdays": [0, 1, 2, 3, 4, 5, 6], "every": 2, "start": None},
        "nag": "once",          # once | gently | firmly | custom, as for medications
        "nag_every": 30,
        "nag_repeats": 1,
        "buttons": "mood",      # mood: Good / Okay / Bad log your mood | snooze: Snooze / Not now
        "skip_if_recent": 60,   # no reminder if you checked in within this many minutes
        "expire_after": 180,    # take the reminder away after this many minutes
    },
    "checkins_from": None,      # set by the app when check-in times change
    # Reminders to drink water when none has been logged for a while.
    # The Check-in dashboard: section order and hidden sections.
    "dashboard": {"sections": []},
    # Medication groups you can log in one tap, e.g. Morning: Vyvanse + Magnesium.
    "med_groups": [],
    "hydration": {
        "enabled": False,
        "tracker_id": None,     # None = the tracker called Water
        "every": 120,           # remind if nothing logged for this many minutes
        "start": "09:00",
        "end": "21:00",
        "days": {"mode": "daily", "weekdays": [0, 1, 2, 3, 4, 5, 6], "every": 2, "start": None},
        "amount": 250,          # for trackers measured as an amount (ml): how much one tap adds
    },
}

SCHEDULE_DEFAULTS = {
    "mode": "times",            # times: at set clock times | after: timed from another dose being taken
    "times": ["08:00"],
    # How many to take at each time, when it isn't the usual number, e.g. {"19:00": 0.5}.
    "amounts": {},
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
    # mode "after": each rule says "remind me <minutes> after I take <tracker_id>".
    # The tracker can be this medication itself, which makes a chain (Dex every 3 hours).
    "after": [],
    "max_per_day": 3,           # mode "after": stop the chain after this many reminders a day (null = no limit)
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
    s["checkins"] = normalise_checkins(s["checkins"])
    s["hydration"] = normalise_hydration(s["hydration"])
    s["dashboard"] = normalise_dashboard(s["dashboard"])
    s["med_groups"] = normalise_med_groups(s["med_groups"])
    return s


def schedule_settings(saved: dict | None) -> dict:
    return _merge(SCHEDULE_DEFAULTS, saved)


def _days(d) -> dict:
    if not isinstance(d, dict):
        raise ValidationError("Choose which days")
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
    return {
        "mode": mode,
        "weekdays": sorted(set(weekdays)) if weekdays else [0, 1, 2, 3, 4, 5, 6],
        "every": int(every),
        "start": start,
    }


def _times(times) -> list[str]:
    if not isinstance(times, list) or not times:
        raise ValidationError("Add at least one time")
    out = sorted(set(_time(t, "Reminder time") for t in times))
    if len(out) > 12:
        raise ValidationError("Up to 12 times a day")
    return out


def _nag(s: dict) -> None:
    if s["nag"] not in ("once", "gently", "firmly", "custom"):
        raise ValidationError("Choose what happens if you don't answer")
    try:
        s["nag_every"] = int(s["nag_every"])
    except (TypeError, ValueError):
        raise ValidationError("Remind again every how many minutes?") from None
    if not 1 <= s["nag_every"] <= 240:
        raise ValidationError("Remind again every 1–240 minutes")
    if s["nag_repeats"] not in (None, ""):
        try:
            s["nag_repeats"] = int(s["nag_repeats"])
        except (TypeError, ValueError):
            raise ValidationError("How many more times?") from None
        if not 0 <= s["nag_repeats"] <= 50:
            raise ValidationError("Up to 50 more times")
    else:
        s["nag_repeats"] = None


def normalise_checkins(data: dict | None) -> dict:
    s = {**PERSON_DEFAULTS["checkins"], **(data or {})}
    s["enabled"] = bool(s["enabled"])
    s["times"] = _times(s["times"])
    s["days"] = _days({**PERSON_DEFAULTS["checkins"]["days"], **(s["days"] or {})})
    _nag(s)
    if s["buttons"] not in ("mood", "snooze"):
        raise ValidationError("Choose which buttons to show")
    for key, lo, hi, label in (("skip_if_recent", 0, 720, "Skip if checked in within"),
                               ("expire_after", 15, 1440, "Remove the reminder after")):
        try:
            s[key] = int(s[key])
        except (TypeError, ValueError):
            raise ValidationError(f"{label}: choose a number of minutes") from None
        if not lo <= s[key] <= hi:
            raise ValidationError(f"{label}: {lo}–{hi} minutes")
    return {k: s[k] for k in PERSON_DEFAULTS["checkins"]}


def normalise_hydration(data: dict | None) -> dict:
    s = {**PERSON_DEFAULTS["hydration"], **(data or {})}
    s["enabled"] = bool(s["enabled"])
    if s["tracker_id"] in (None, ""):
        s["tracker_id"] = None
    else:
        try:
            s["tracker_id"] = int(s["tracker_id"])
        except (TypeError, ValueError):
            raise ValidationError("Choose what to count as water") from None
    try:
        s["every"] = int(s["every"])
    except (TypeError, ValueError):
        raise ValidationError("Remind after how long?") from None
    if not 15 <= s["every"] <= 720:
        raise ValidationError("Remind after 15 minutes to 12 hours")
    s["start"] = _time(s["start"], "Start time")
    s["end"] = _time(s["end"], "End time")
    if s["end"] <= s["start"]:
        raise ValidationError("The end time must be after the start time")
    s["days"] = _days({**PERSON_DEFAULTS["hydration"]["days"], **(s["days"] or {})})
    try:
        s["amount"] = int(s["amount"])
    except (TypeError, ValueError):
        raise ValidationError("How much is one drink?") from None
    if not 1 <= s["amount"] <= 5000:
        raise ValidationError("One drink must be 1–5000")
    return {k: s[k] for k in PERSON_DEFAULTS["hydration"]}


def normalise_dashboard(data) -> dict:
    sections = (data or {}).get("sections") if isinstance(data, dict) else None
    out, seen = [], set()
    for sec in sections or []:
        if not isinstance(sec, dict):
            raise ValidationError("Sections must be objects")
        name = str(sec.get("name") or "").strip()[:40]
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "hidden": bool(sec.get("hidden"))})
    if len(out) > 50:
        raise ValidationError("Up to 50 sections")
    return {"sections": out}


def normalise_med_groups(groups) -> list[dict]:
    import uuid

    if not isinstance(groups, list):
        raise ValidationError("Groups must be a list")
    if len(groups) > 20:
        raise ValidationError("Up to 20 groups")
    out = []
    for g in groups:
        if not isinstance(g, dict):
            raise ValidationError("Each group must be an object")
        name = str(g.get("name") or "").strip()[:30]
        if not name:
            raise ValidationError("Give the group a name")
        items = []
        for it in g.get("items") or []:
            try:
                tid = int(it.get("tracker_id"))
                qty = float(it.get("quantity", 1))
            except (TypeError, ValueError, AttributeError):
                raise ValidationError(f"{name}: choose medications and amounts") from None
            if not 0 < qty <= 100:
                raise ValidationError(f"{name}: amounts must be more than 0")
            items.append({"tracker_id": tid, "quantity": int(qty) if qty == int(qty) else qty})
        if not items:
            raise ValidationError(f"{name}: add at least one medication")
        gid = str(g.get("id") or uuid.uuid4().hex[:8])[:16]
        out.append({"id": gid, "name": name, "items": items})
    return out


def _amount(value, label: str) -> float | int:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{label}: how many to take must be a number") from None
    if not 0 < v <= 100:
        raise ValidationError(f"{label}: how many to take must be more than 0")
    v = round(v, 3)
    return int(v) if v == int(v) else v


def _split_times(times, amounts) -> tuple[list, dict]:
    """Times may be "19:00" or {"time": "19:00", "quantity": 0.5}; amounts may also come separately."""
    if not isinstance(amounts, dict):
        raise ValidationError("Amounts must be an object")
    amounts = dict(amounts)
    plain = []
    if isinstance(times, list):
        for t in times:
            if isinstance(t, dict):
                plain.append(t.get("time"))
                if t.get("quantity") not in (None, ""):
                    amounts[t.get("time")] = t["quantity"]
            else:
                plain.append(t)
    else:
        plain = times
    return plain, amounts


def normalise_schedule(data: dict) -> dict:
    s = schedule_settings(data)
    if s["mode"] not in ("times", "after"):
        raise ValidationError("Choose set times or after another dose")
    times, amounts = _split_times(s["times"], s["amounts"] or {})
    if s["mode"] == "times":
        if isinstance(times, list) and len(set(times)) != len(times):
            raise ValidationError("Each time can only be used once")
        s["times"] = _times(times)
    elif not isinstance(times, list) or not all(isinstance(t, str) and TIME_RE.match(t) for t in times):
        s["times"] = list(SCHEDULE_DEFAULTS["times"])
    else:
        s["times"] = sorted(set(times))
    s["amounts"] = {
        t: _amount(q, describe_time(t)) for t, q in amounts.items() if t in s["times"] and q not in (None, "")
    }

    rules = s["after"]
    if not isinstance(rules, list):
        raise ValidationError("Add when to remind you")
    clean_rules = []
    for r in rules:
        if not isinstance(r, dict):
            raise ValidationError("Add when to remind you")
        try:
            tid = int(r.get("tracker_id"))
            minutes = int(r.get("minutes"))
        except (TypeError, ValueError):
            raise ValidationError("Each rule needs a medication and a number of hours") from None
        if not 1 <= minutes <= 24 * 60:
            raise ValidationError("Choose between a few minutes and 24 hours")
        if any(c["tracker_id"] == tid for c in clean_rules):
            raise ValidationError("Each medication can only be used once")
        clean_rules.append({"tracker_id": tid, "minutes": minutes})
    if s["mode"] == "after" and not clean_rules:
        raise ValidationError("Add at least one medication to time it from")
    if len(clean_rules) > 5:
        raise ValidationError("Up to 5 rules")
    s["after"] = clean_rules
    if s["max_per_day"] not in (None, ""):
        try:
            s["max_per_day"] = int(s["max_per_day"])
        except (TypeError, ValueError):
            raise ValidationError("At most how many a day?") from None
        if not 1 <= s["max_per_day"] <= 24:
            raise ValidationError("At most 1–24 a day")
    else:
        s["max_per_day"] = None

    s["days"] = _days(s["days"])

    _nag(s)

    for key in ("hard_to_miss", "alarm_sound", "announce"):
        s[key] = bool(s[key])
    try:
        s["hard_after"] = int(s["hard_after"])
    except (TypeError, ValueError):
        raise ValidationError("Escalate after how many reminders?") from None
    if not 1 <= s["hard_after"] <= 20:
        raise ValidationError("Escalate after 1–20 reminders")

    s["latest_time"] = _time(s["latest_time"], "Latest time") if s["latest_time"] else None
    if s["mode"] == "times" and s["latest_time"] and s["latest_time"] <= s["times"][0]:
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


def amount_at(s: dict, hhmm: str):
    """How many to take at this time, or None for the medication's usual number."""
    return (s.get("amounts") or {}).get(hhmm)


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
