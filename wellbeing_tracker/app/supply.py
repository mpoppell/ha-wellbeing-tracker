"""Medication supply: how many are left, when they'll run out, and when to warn.

Everything here is optional and per medication. Counts are in the medication's own unit
("tablets", or whatever "Each one is a" says), the same unit doses are logged in, so each
logged dose takes its amount off what's left.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta

from .trackers import ValidationError

SUPPLY_DEFAULTS = {
    "enabled": False,
    "count": None,         # how many you had at count_at
    "count_at": None,      # ISO date-time the count was taken (or the last refill added)
    "per_day": None,       # how many a day; None = worked out from reminders, then from what you log
    "pack": None,          # usual refill size, e.g. 100
    "last_refill": None,   # date of the last refill (for the early supply rule)
    "refill_gap": None,    # days: can't refill again sooner than this (early supply rule)
    "repeats": None,       # repeats left on the script; None = not tracked
    "expires": None,       # date the script is valid until
    "warn_low": 10,        # warn me this many days before I run out
    "warn_script": 21,     # ... before I need a new script (repeats used up, or the script ends)
    "warn_expiry": 30,     # no longer used: script expiry is part of warn_script
}


def supply_settings(saved: dict | None) -> dict:
    out = deepcopy(SUPPLY_DEFAULTS)
    out.update({k: v for k, v in (saved or {}).items() if k in SUPPLY_DEFAULTS})
    return out


def _num(value, label: str, lo: float, hi: float, whole: bool = False):
    if value in (None, ""):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a number") from None
    if not lo <= v <= hi:
        raise ValidationError(f"{label} must be {lo:g} to {hi:g}")
    if whole:
        return int(round(v))
    v = round(v, 3)
    return int(v) if v == int(v) else v


def _day(value, label: str):
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError:
        raise ValidationError(f"{label} must be a date") from None


def normalise_supply(data: dict) -> dict:
    s = supply_settings(data)
    s["enabled"] = bool(s["enabled"])
    s["count"] = _num(s["count"], "How many you have", 0, 100000)
    if s["count_at"] not in (None, ""):
        try:
            when = datetime.fromisoformat(str(s["count_at"]))
        except ValueError:
            raise ValidationError("count_at must be a date and time") from None
        if when.tzinfo is None:
            raise ValidationError("count_at must include a UTC offset")
        s["count_at"] = when.isoformat(timespec="seconds")
    else:
        s["count_at"] = None
    s["per_day"] = _num(s["per_day"], "How many a day", 0.01, 100)
    s["pack"] = _num(s["pack"], "Usual refill", 1, 10000)
    s["last_refill"] = _day(s["last_refill"], "Last refill")
    s["refill_gap"] = _num(s["refill_gap"], "Days between refills", 1, 365, whole=True)
    s["repeats"] = _num(s["repeats"], "Repeats left", 0, 99, whole=True)
    s["expires"] = _day(s["expires"], "Script valid until")
    for key, label in (("warn_low", "Days before you run out"), ("warn_script", "Days before you need a new script"),
                       ("warn_expiry", "Days before the script ends")):
        s[key] = _num(s[key], label, 0, 365, whole=True)
        if s[key] is None:
            s[key] = SUPPLY_DEFAULTS[key]
    if s["enabled"] and s["count"] is None:
        raise ValidationError("How many do you have now?")
    return s


def nice_date(d: date, today: date) -> str:
    text = f"{d.day} {d.strftime('%b')}"
    return text if d.year == today.year else f"{text} {d.year}"


def _days(n: int) -> str:
    return "1 day" if n == 1 else f"{n} days"


def plural(word: str, n: float) -> str:
    if n == 1 or 0 < n < 1:
        return word
    return word + ("es" if word.endswith(("s", "x", "ch", "sh")) else "s")


def status(s: dict, used_since: float, per_day_guess: tuple[float | None, str | None], word: str,
           today: date) -> dict:
    """What's left and what needs attention. used_since = amount logged since count_at."""
    stock = max(0.0, float(s["count"] or 0) - used_since)
    stock = round(stock, 2)
    per_day, source = (s["per_day"], "set") if s["per_day"] else per_day_guess
    days_left = runs_out = None
    if per_day:
        days_left = int(stock // per_day)
        runs_out = today + timedelta(days=days_left)
    refill_from = None
    if s["last_refill"] and s["refill_gap"]:
        allowed = date.fromisoformat(s["last_refill"]) + timedelta(days=s["refill_gap"])
        if allowed > today:
            refill_from = allowed
    expires = date.fromisoformat(s["expires"]) if s["expires"] else None

    # When you'll need a new script: when the script ends, or when this supply plus the
    # repeats left would run out, whichever comes first. This is when to see the doctor.
    script_by = reason = None
    if s["repeats"] is not None and per_day and (s["repeats"] == 0 or s["pack"]):
        total = stock + s["repeats"] * float(s["pack"] or 0)
        script_by = today + timedelta(days=int(total // per_day))
        reason = "last repeat" if s["repeats"] == 0 else "repeats run out"
    if expires and (script_by is None or expires < script_by):
        script_by, reason = expires, "script ends"

    alerts = []
    if stock <= 0:
        alerts.append({"kind": "out", "level": "danger", "text": "None left"})
    elif days_left is not None and days_left <= s["warn_low"]:
        text = f"{_days(days_left)} left" if days_left else "Less than a day left"
        if refill_from:
            text += f". Refill from {nice_date(refill_from, today)}"
        alerts.append({"kind": "low", "level": "danger" if days_left <= 3 else "warning", "text": text})
    if script_by and script_by <= today:
        alerts.append({"kind": "script", "level": "danger",
                       "text": "Script expired. See your doctor" if reason == "script ends" else "New script needed now"})
    elif script_by and (script_by - today).days <= s["warn_script"]:
        alerts.append({"kind": "script", "level": "warning", "text": f"New script needed by {nice_date(script_by, today)}"})
    alerts.sort(key=lambda a: 0 if a["level"] == "danger" else 1)

    return {
        "stock": int(stock) if stock == int(stock) else stock,
        "word": plural(word, stock),
        "per_day": per_day,
        "per_day_source": source,
        "days_left": days_left,
        "runs_out": runs_out.isoformat() if runs_out else None,
        "runs_out_text": nice_date(runs_out, today) if runs_out else None,
        "refill_from": refill_from.isoformat() if refill_from else None,
        "refill_from_text": nice_date(refill_from, today) if refill_from else None,
        "repeats": s["repeats"],
        "expires": s["expires"],
        "expires_text": nice_date(expires, today) if expires else None,
        "script_by": script_by.isoformat() if script_by else None,
        "script_by_text": nice_date(script_by, today) if script_by else None,
        "script_reason": reason,
        "alerts": alerts,
    }
