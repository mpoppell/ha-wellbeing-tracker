"""Tracker kinds, their defaults, and validation of logged values.

A tracker is one thing a person tracks (Mood, Headache, Caffeine...).
An entry is one logged value for a tracker.

Kinds and how values are stored on an entry:
  rating      value_num  integer between config.min and config.max
  tags        value_json list of strings (e.g. emotions)
  symptom     value_num  0 none, 1 mild, 2 moderate, 3 severe
  medication  value_num  number of doses taken (usually 1)
              value_json {"dose": strength} when this dose differed from the usual strength
  factor      value_num  bool (0/1), count (int) or amount (float), per config.mode
  sleep       value_json {"hours": float|None, "quality": 1-5|None}
  note        note       free text
  gratitude   note       one good thing; value_num = which time of day it was asked (0, 1, 2) or None

Frequency:
  many   every check-in adds a new entry (mood through the day)
  daily  one entry per day; saving again updates it (symptoms, sleep, factors)
"""

from __future__ import annotations

import re

from typing import Any

KINDS = ("rating", "tags", "symptom", "medication", "factor", "sleep", "note", "gratitude")
GOOD_THINGS_TIMES = ["12:30", "15:30", "21:30"]  # lunch, afternoon, before bed

MOOD_LABELS = ["Awful", "Very bad", "Bad", "Poor", "Meh", "Okay", "Fine", "Good", "Very good", "Great"]
ENERGY_LABELS = ["Exhausted", "Drained", "Very low", "Low", "Flat", "Okay", "Fair", "Good", "High", "Buzzing"]
FREQUENCIES = ("many", "daily")
FACTOR_MODES = ("bool", "count", "amount")
SEVERITY_LABELS = ["None", "Mild", "Moderate", "Severe"]

DEFAULT_FREQUENCY = {
    "rating": "many",
    "tags": "many",
    "symptom": "daily",
    "medication": "many",
    "factor": "daily",
    "sleep": "daily",
    "note": "daily",
    "gratitude": "many",
}


class ValidationError(ValueError):
    pass


def default_trackers() -> list[dict[str, Any]]:
    """Trackers every new person starts with. They can rename, hide or delete any of them."""
    feel = "How you feel"
    sym = "Symptoms"
    life = "Lifestyle"
    items: list[dict[str, Any]] = [
        dict(key="mood", kind="rating", name="Mood", emoji="🙂", group_name=feel,
             config={"min": 1, "max": 10, "labels": MOOD_LABELS}),
        dict(key="emotions", kind="tags", name="Emotions", emoji="💭", group_name=feel,
             config={"options": ["Happy", "Calm", "Grateful", "Motivated", "Anxious",
                                 "Irritable", "Sad", "Overwhelmed", "Lonely", "Tired"]}),
        dict(key="energy", kind="rating", name="Energy", emoji="⚡", group_name=feel,
             config={"min": 1, "max": 10, "labels": ENERGY_LABELS}),
        dict(key="headache", kind="symptom", name="Headache", emoji="🤕", group_name=sym, config={}),
        dict(key="fatigue", kind="symptom", name="Fatigue", emoji="🥱", group_name=sym, config={}),
        dict(key="brain_fog", kind="symptom", name="Brain fog", emoji="🌫️", group_name=sym, config={}),
        dict(key="anxiety", kind="symptom", name="Anxiety", emoji="😰", group_name=sym, config={}),
        dict(key="nausea", kind="symptom", name="Nausea", emoji="🤢", group_name=sym, config={}),
        dict(key="sleep", kind="sleep", name="Sleep", emoji="😴", group_name="Sleep", config={}),
        dict(key="caffeine", kind="factor", name="Caffeine", emoji="☕", group_name=life,
             config={"mode": "count", "unit": "cups"}),
        dict(key="alcohol", kind="factor", name="Alcohol", emoji="🍷", group_name=life,
             config={"mode": "count", "unit": "drinks"}),
        dict(key="water", kind="factor", name="Water", emoji="💧", group_name=life,
             config={"mode": "count", "unit": "glasses", "goal": 8}),
        dict(key="exercise", kind="factor", name="Exercise", emoji="🏃", group_name=life, config={"mode": "bool"}),
        dict(key="outdoors", kind="factor", name="Time outdoors", emoji="🌳", group_name=life, config={"mode": "bool"}),
        dict(key="socialised", kind="factor", name="Socialised", emoji="👥", group_name=life, config={"mode": "bool"}),
        dict(key="late_screens", kind="factor", name="Late screen time", emoji="📱", group_name=life,
             config={"mode": "bool"}),
        dict(key="journal", kind="note", name="Journal", emoji="📝", group_name="Notes", config={}),
        dict(key="good_things", kind="gratitude", name="Three good things", emoji="🌱", group_name="Reflect",
             config={"times": GOOD_THINGS_TIMES, "remind": False}),
        dict(key="mindful", kind="factor", name="Mindful minute", emoji="🧘", group_name=life, config={"mode": "bool"}),
    ]
    for i, item in enumerate(items):
        item["frequency"] = DEFAULT_FREQUENCY[item["kind"]]
        item["sort_order"] = (i + 1) * 10
    return items


def normalise_config(kind: str, config: dict | None) -> dict:
    """Check and fill in a tracker's config for its kind."""
    if kind not in KINDS:
        raise ValidationError(f"Unknown tracker kind '{kind}'")
    config = dict(config or {})
    if kind == "rating":
        lo = int(config.get("min", 1))
        hi = int(config.get("max", 5))
        if not 0 <= lo < hi <= 10:
            raise ValidationError("Rating range must be within 0–10")
        labels = config.get("labels") or []
        if labels and len(labels) != hi - lo + 1:
            raise ValidationError("Rating needs one label per point, or none")
        return {"min": lo, "max": hi, "labels": [str(x)[:40] for x in labels]}
    if kind == "tags":
        options = [str(o).strip()[:40] for o in config.get("options", []) if str(o).strip()]
        if not options:
            raise ValidationError("Add at least one option")
        return {"options": list(dict.fromkeys(options))[:50]}
    if kind == "factor":
        mode = config.get("mode", "bool")
        if mode not in FACTOR_MODES:
            raise ValidationError("Factor type must be yes/no, count or amount")
        out = {"mode": mode}
        if mode != "bool" and config.get("unit"):
            out["unit"] = str(config["unit"])[:20]
        if mode != "bool" and config.get("goal") not in (None, "", 0):
            out["goal"] = _positive(config["goal"], "Daily goal")
        if mode != "bool" and config.get("source"):
            out["source"] = normalise_source(config["source"])
        return out
    if kind == "sleep":
        out = {}
        if config.get("source"):
            out["source"] = normalise_source(config["source"])
        if config.get("nights"):
            out["nights"] = normalise_nights(config["nights"])
        if config.get("goal") not in (None, ""):
            goal = _positive(config["goal"], "Sleep goal")
            if goal > 14:
                raise ValidationError("Sleep goal must be 14 hours or less")
            out["goal"] = goal
        return out
    if kind == "gratitude":
        times = config.get("times") or GOOD_THINGS_TIMES
        if not isinstance(times, list) or not 1 <= len(times) <= 5:
            raise ValidationError("Choose 1 to 5 times of day")
        clean = []
        for t in times:
            if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", str(t)):
                raise ValidationError("Times must look like 12:30")
            clean.append(str(t))
        return {"times": sorted(set(clean)), "remind": bool(config.get("remind"))}
    if kind == "medication":
        out = {}
        if config.get("dose") not in (None, ""):
            out["dose"] = _positive(config["dose"], "Dose strength")
        # How many you usually take, and what one is called ("1 dose", "2 tablets", "1 application")
        if config.get("quantity") not in (None, ""):
            q = _positive(config["quantity"], "Usual number")
            if q > 100:
                raise ValidationError("Usual number must be 100 or less")
            out["quantity"] = q
        if config.get("counted_as") not in (None, ""):
            out["counted_as"] = str(config["counted_as"]).strip()[:20]
        for field, limit in (("unit", 20), ("notes", 200)):
            if config.get(field) not in (None, ""):
                out[field] = str(config[field]).strip()[:limit]
        return out
    return {}


SOURCE_VALUES = ("latest", "highest", "average")


def normalise_source(src) -> dict:
    """Fill something in from a Home Assistant sensor. 'value' picks which reading counts for the day."""
    if not isinstance(src, dict):
        raise ValidationError("Choose a Home Assistant sensor")
    entity = str(src.get("entity_id") or "")
    if not re.match(r"^(sensor|input_number|number)\.[a-z0-9_]+$", entity):
        raise ValidationError("Choose a Home Assistant sensor")
    value = src.get("value") or "latest"
    if value not in SOURCE_VALUES:
        raise ValidationError("Choose which reading counts for the day")
    return {"entity_id": entity, "value": value}


def normalise_nights(src) -> dict:
    """Where nights of sleep come from: Sleep as Android's event entities, Android's sleep
    segments and sleep confidence, and things in your home that show when you go to bed."""
    if not isinstance(src, dict):
        raise ValidationError("Choose where your nights come from")
    out = {}
    for key, domains in (("tracking", "event"), ("phases", "event"), ("segments", "sensor"), ("confidence", "sensor"),
                         ("charging", "binary_sensor"), ("in_use", "binary_sensor")):
        value = src.get(key)
        if value in (None, ""):
            continue
        if not re.match(rf"^({domains})\.[a-z0-9_]+$", str(value)):
            raise ValidationError("Choose where your nights come from")
        out[key] = str(value)
    lights = src.get("lights") or []
    if isinstance(lights, str):
        lights = [lights]
    lights = [str(x) for x in lights if x]
    if any(not re.match(r"^(light|switch)\.[a-z0-9_]+$", x) for x in lights) or len(lights) > 10:
        raise ValidationError("Choose up to 10 bedroom lights")
    if lights:
        out["lights"] = lights
    if not any(out.get(k) for k in ("tracking", "segments", "lights", "charging", "in_use")):
        raise ValidationError("Choose at least one way to tell when you sleep")
    return out


def _positive(value, label: str) -> float | int:
    try:
        v = float(str(value).strip())
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a number") from None
    if not 0 < v <= 100000:
        raise ValidationError(f"{label} must be more than 0")
    return int(v) if v == int(v) else round(v, 3)


def validate_value(tracker: dict, item: dict) -> dict:
    """Return the cleaned columns (value_num, value_json, note) for an entry."""
    kind = tracker["kind"]
    cfg = tracker["config"]
    num = item.get("value_num")
    js = item.get("value_json")
    note = item.get("note")
    note = str(note).strip()[:5000] if note not in (None, "") else None

    def need_number() -> float:
        if num is None or isinstance(num, bool):
            raise ValidationError(f"{tracker['name']}: a number is required")
        try:
            return float(num)
        except (TypeError, ValueError):
            raise ValidationError(f"{tracker['name']}: a number is required") from None

    if kind == "rating":
        v = need_number()
        if v != int(v) or not cfg["min"] <= v <= cfg["max"]:
            raise ValidationError(f"{tracker['name']}: pick {cfg['min']}–{cfg['max']}")
        return {"value_num": int(v), "value_json": None, "note": note}
    if kind == "symptom":
        v = need_number()
        if v not in (0, 1, 2, 3):
            raise ValidationError(f"{tracker['name']}: severity must be none, mild, moderate or severe")
        return {"value_num": int(v), "value_json": None, "note": note}
    if kind == "medication":
        v = 1.0 if num is None else need_number()
        if not 0 < v <= 100:
            raise ValidationError(f"{tracker['name']}: number of doses must be more than 0")
        dose = None
        if isinstance(js, dict) and js.get("dose") not in (None, ""):
            dose = _positive(js["dose"], f"{tracker['name']}: dose")
            if dose == cfg.get("dose"):
                dose = None  # the usual strength doesn't need storing
        return {"value_num": v, "value_json": {"dose": dose} if dose is not None else None, "note": note}
    if kind == "factor":
        v = need_number()
        mode = cfg.get("mode", "bool")
        if mode == "bool":
            if v not in (0, 1):
                raise ValidationError(f"{tracker['name']}: must be yes or no")
            v = int(v)
        elif mode == "count":
            if v < 0 or v != int(v) or v > 1000000:
                raise ValidationError(f"{tracker['name']}: must be a whole number")
            v = int(v)
        elif v < 0 or v > 100000:
            raise ValidationError(f"{tracker['name']}: must be 0 or more")
        return {"value_num": v, "value_json": None, "note": note}
    if kind == "tags":
        if not isinstance(js, list) or not all(isinstance(t, str) for t in js):
            raise ValidationError(f"{tracker['name']}: choose from the list")
        tags = list(dict.fromkeys(t.strip()[:40] for t in js if t.strip()))[:30]
        if not tags:
            raise ValidationError(f"{tracker['name']}: choose at least one")
        return {"value_num": None, "value_json": tags, "note": note}
    if kind == "sleep":
        if not isinstance(js, dict):
            raise ValidationError("Sleep: hours or quality is required")
        hours = js.get("hours")
        quality = js.get("quality")
        if hours is not None:
            try:
                hours = round(float(hours), 2)
            except (TypeError, ValueError):
                raise ValidationError("Sleep: hours must be a number") from None
            if not 0 <= hours <= 24:
                raise ValidationError("Sleep: hours must be 0–24")
        if quality is not None:
            if quality not in (1, 2, 3, 4, 5):
                raise ValidationError("Sleep: quality must be 1–5")
        if hours is None and quality is None:
            raise ValidationError("Sleep: hours or quality is required")
        return {"value_num": hours, "value_json": {"hours": hours, "quality": quality}, "note": note}
    if kind == "gratitude":
        if not note:
            raise ValidationError("Write one good thing first")
        slot = None
        if num is not None and not isinstance(num, bool):
            try:
                slot = int(num)
            except (TypeError, ValueError):
                slot = None
            if slot is not None and not 0 <= slot <= 4:
                slot = None
        return {"value_num": slot, "value_json": None, "note": note[:280]}
    if kind == "note":
        if not note:
            raise ValidationError(f"{tracker['name']}: write something first")
        return {"value_num": None, "value_json": None, "note": note}
    raise ValidationError(f"Unknown tracker kind '{kind}'")
