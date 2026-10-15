"""Nights of sleep from Home Assistant: when you went to bed, when you woke, and your sleep
phases in between, the way Sleep as Android shows them.

Sources, best first:
* Sleep as Android (its Home Assistant integration): "Sleep tracking" events (started, stopped)
  mark the night, and "Sleep phase" events (deep, light, REM, awake) fill it in.
* Android's own sleep detection (Home Assistant Companion app): the "Sleep segment" sensor
  gives each night's start and end, without phases.
"""

from __future__ import annotations

from datetime import datetime, timedelta

PHASES = ("awake", "rem", "light", "deep")
PHASE_EVENTS = {"awake": "awake", "rem": "rem", "light_sleep": "light", "deep_sleep": "deep", "not_awake": "light"}


def _when(value) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else None


def events(rows: list[dict]) -> list[tuple[datetime, str]]:
    """(time, event type) from an event entity's history. Restarts re-record the last event,
    so the same event can appear more than once: keep each one once."""
    seen: dict[datetime, str] = {}
    for r in rows:
        when = _when(r.get("state"))
        kind = (r.get("attributes") or {}).get("event_type")
        if when and kind:
            seen[when] = kind
    return sorted(seen.items())


def nights_from_sleep_as_android(tracking: list[dict], phases: list[dict]) -> list[dict]:
    """Each finished night: {start, end, phases: [(start, end, phase)]}."""
    marks = events(tracking)
    steps = [(t, PHASE_EVENTS[k]) for t, k in events(phases) if k in PHASE_EVENTS]
    nights = []
    start = None
    for t, kind in marks:
        if kind == "started":
            start = t
        elif kind == "stopped" and start:
            if t - start >= timedelta(minutes=30):
                nights.append(_fill(start, t, steps))
            start = None
    return nights


def _fill(start: datetime, end: datetime, steps: list[tuple[datetime, str]]) -> dict:
    inside = [(t, p) for t, p in steps if start <= t < end]
    blocks = []
    current, since = "awake", start  # until the first phase: still falling asleep
    for t, p in inside:
        if p == current:
            continue
        if t > since:
            blocks.append((since, t, current))
        current, since = p, t
    if end > since:
        blocks.append((since, end, current))
    return {"start": start, "end": end, "phases": blocks, "source": "sleep_as_android"}


def nights_from_segments(rows: list[dict]) -> list[dict]:
    """Android's sleep segments: the attributes hold start and end in milliseconds."""
    seen = {}
    for r in rows:
        a = r.get("attributes") or {}
        if a.get("status") not in (None, "successful") or not a.get("start") or not a.get("end"):
            continue
        try:
            from datetime import timezone
            s = datetime.fromtimestamp(int(a["start"]) / 1000, tz=timezone.utc)
            e = datetime.fromtimestamp(int(a["end"]) / 1000, tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            continue
        if e - s >= timedelta(hours=1):
            seen[s] = e
    return [{"start": s, "end": e, "phases": [(s, e, "light")], "source": "android"} for s, e in sorted(seen.items())]


def summary(night: dict, tz) -> dict:
    """What the sleep screen shows for one night. Minutes throughout."""
    totals = {p: 0.0 for p in PHASES}
    for s, e, p in night["phases"]:
        totals[p] += (e - s).total_seconds() / 60
    in_bed = (night["end"] - night["start"]).total_seconds() / 60
    asleep = in_bed - totals["awake"]
    first = next((s for s, _, p in night["phases"] if p != "awake"), None)
    local = lambda d: d.astimezone(tz)  # noqa: E731
    return {
        "night": local(night["end"]).date().isoformat(),  # the morning you woke up
        "start": local(night["start"]).isoformat(timespec="minutes"),
        "end": local(night["end"]).isoformat(timespec="minutes"),
        "in_bed": round(in_bed),
        "asleep": round(asleep),
        "fell_asleep_after": round((first - night["start"]).total_seconds() / 60) if first else None,
        "totals": {p: round(v) for p, v in totals.items()},
        "has_phases": night.get("source") == "sleep_as_android",
        "phases": [{"start": local(s).isoformat(timespec="minutes"), "end": local(e).isoformat(timespec="minutes"),
                    "phase": p} for s, e, p in night["phases"]],
        "source": night.get("source"),
    }
