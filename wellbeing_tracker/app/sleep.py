"""Nights of sleep from Home Assistant: when you went to bed, when you woke, and your sleep
phases in between, the way Sleep as Android shows them.

Sources, best first:
* Sleep as Android (its Home Assistant integration): "Sleep tracking" events (started, stopped)
  mark the night, and "Sleep phase" events (deep, light, REM, awake) fill it in.
* Android's own sleep detection (Home Assistant Companion app): the "Sleep segment" sensor
  gives each night's start and end, without phases.
* Home Assistant's Awake switch (the Wellbeing Tracker integration): off while you're asleep.
  Used for nights Sleep as Android didn't track.
* Your home: the bedroom light going off, your phone going on charge and being put down mark
  bedtime; the opposite marks getting up. Android's sleep detection (sleep segments, or the
  "Sleep confidence" sensor) then says when you were actually asleep in between. These nights
  are estimates, and you can adjust them.
"""

from __future__ import annotations

from datetime import datetime, timedelta

PHASES = ("awake", "rem", "light", "deep")
ASLEEP = "asleep"  # asleep, stage unknown (Android, or an estimate)
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
    return [{"start": s, "end": e, "phases": [(s, e, ASLEEP)], "source": "android"} for s, e in sorted(seen.items())]


def summary(night: dict, tz) -> dict:
    """What the sleep screen shows for one night. Minutes throughout."""
    totals = {p: 0.0 for p in (*PHASES, ASLEEP)}
    for s, e, p in night["phases"]:
        totals[p if p in totals else ASLEEP] += (e - s).total_seconds() / 60
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
        "totals": {p: round(v) for p, v in totals.items() if p in PHASES or v},
        "has_phases": night.get("source") == "sleep_as_android",
        "phases": [{"start": local(s).isoformat(timespec="minutes"), "end": local(e).isoformat(timespec="minutes"),
                    "phase": p} for s, e, p in night["phases"]],
        "source": night.get("source"),
        "why": night.get("why") or [],
    }


# ---------------- estimating a night from your home ----------------

QUIET_GAP = timedelta(minutes=15)    # a short trip to the bathroom doesn't end the night
SHORTEST_NIGHT = timedelta(hours=3)
LONGEST_LIE_IN = timedelta(hours=1)  # up within an hour of waking, if the phone stays on charge
ASLEEP_CONFIDENCE = 75


def _changes(rows: list[dict]) -> list[tuple[datetime, str]]:
    """(time, state) from a history list, skipping unavailable and unknown (keep the last real state)."""
    out = []
    for r in rows:
        st = str(r.get("state", ""))
        when = _when(r.get("last_changed") or r.get("last_updated"))
        if when is None or st in ("unavailable", "unknown", ""):
            continue
        if not out or out[-1][1] != st:
            out.append((when, st))
    return out


def _steps(rows: list[dict], sleepy) -> list[tuple[datetime, bool]]:
    return [(t, bool(sleepy(st))) for t, st in _changes(rows)]


def _value_at(steps: list[tuple[datetime, bool]], t: datetime):
    value = None
    for when, v in steps:
        if when > t:
            break
        value = v
    return value


def _all_lights(lights: list[list[dict]]) -> list[tuple[datetime, bool]]:
    """Dark (True) when every chosen light is off."""
    per = [_steps(rows, lambda s: s == "off") for rows in lights]
    per = [p for p in per if p]
    if not per:
        return []
    times = sorted({t for p in per for t, _ in p})
    out = []
    for t in times:
        vals = [_value_at(p, t) for p in per]
        dark = all(v is not False for v in vals)
        if not out or out[-1][1] != dark:
            out.append((t, dark))
    return out


def _runs(steps: list[tuple[datetime, bool]], start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
    """The stretches between start and end when the signal was sleepy."""
    runs = []
    on = _value_at(steps, start)
    since = start if on else None
    for t, v in steps:
        if t <= start:
            continue
        if t >= end:
            break
        if v and since is None:
            since = t
        elif not v and since is not None:
            runs.append((since, t))
            since = None
    if since is not None:
        runs.append((since, end))
    return runs


def _intersect(a: list[tuple[datetime, datetime]], b: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    out = []
    for s1, e1 in a:
        for s2, e2 in b:
            s, e = max(s1, s2), min(e1, e2)
            if e > s:
                out.append((s, e))
    return sorted(out)


def _merge(runs: list[tuple[datetime, datetime]], gap: timedelta) -> list[tuple[datetime, datetime]]:
    out = []
    for s, e in runs:
        if out and s - out[-1][1] <= gap:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def _first_change(steps, after: datetime, to: bool) -> datetime | None:
    return next((t for t, v in steps if t >= after and v is to), None)


def nights_from_home(signals: dict, tz, now: datetime, days: int, segments: list[dict] | None = None,
                     confidence: list[dict] | None = None, names: dict | None = None) -> list[dict]:
    """Estimate each night from your home.

    signals: {"lights": [history, ...], "charging": history, "in_use": history}, any of them.
    segments: nights from Android's sleep segments; confidence: the Sleep confidence history.
    A night is the longest stretch, overnight, when every signal that changed that night said
    "in bed": lights off, phone on charge, phone not in use. Short interruptions don't end it.
    """
    names = names or {}
    tracks = {}
    if signals.get("lights"):
        tracks["lights"] = _all_lights(signals["lights"])
    if signals.get("charging"):
        tracks["charging"] = _steps(signals["charging"], lambda s: s == "on")
    if signals.get("in_use"):
        tracks["in_use"] = _steps(signals["in_use"], lambda s: s == "off")
    tracks = {k: v for k, v in tracks.items() if v}
    if not tracks:
        return []
    conf = [(t, float(st)) for t, st in _changes(confidence or []) if _is_number(st)]
    local_now = now.astimezone(tz)
    nights = []
    for back in range(days, -1, -1):
        morning = (local_now - timedelta(days=back)).date()
        start = datetime.combine(morning - timedelta(days=1), datetime.min.time(), tz).replace(hour=18)
        end = min(datetime.combine(morning, datetime.min.time(), tz).replace(hour=14), local_now)
        if end - start < SHORTEST_NIGHT:
            continue
        # A signal that never said "in bed" for long that night (a light left on, a phone left off
        # charge) can't tell us anything, so that night goes by the others.
        per = {}
        for key, steps in tracks.items():
            runs = _merge(_runs(steps, start, end), QUIET_GAP)
            if sum(((e - s) for s, e in runs), timedelta()) >= timedelta(hours=2):
                per[key] = runs
        if not per:
            continue
        quiet = None
        for runs in per.values():
            quiet = runs if quiet is None else _intersect(quiet, runs)
        quiet = _merge(quiet or [], QUIET_GAP)
        if not quiet:
            continue
        bed, up = max(quiet, key=lambda r: r[1] - r[0])
        if up - bed < SHORTEST_NIGHT or up >= local_now - timedelta(minutes=20):
            continue  # too short, or you might still be in bed

        # When you were asleep, from Android's sleep detection if there is any.
        asleep_from = asleep_to = None
        asleep_by = None
        for seg in segments or []:
            s, e = max(seg["start"], bed), min(seg["end"], up)
            if e - s >= timedelta(hours=1):
                asleep_from, asleep_to, asleep_by = s, e, "segments"
                break
        if asleep_from is None and conf:
            inside = [(t, v) for t, v in conf if bed <= t <= up]
            high = [i for i in range(len(inside) - 1) if inside[i][1] >= ASLEEP_CONFIDENCE and inside[i + 1][1] >= ASLEEP_CONFIDENCE]
            if high:
                asleep_from = inside[high[0]][0]
                last = max(i for i in range(len(inside)) if inside[i][1] >= ASLEEP_CONFIDENCE)
                asleep_to = inside[last + 1][0] if last + 1 < len(inside) else up
                if asleep_to - asleep_from >= timedelta(hours=1):
                    asleep_by = "confidence"
                else:
                    asleep_from = asleep_to = None
        if asleep_to and up - asleep_to > LONGEST_LIE_IN and "lights" not in per and "in_use" not in per:
            up = asleep_to + LONGEST_LIE_IN  # the phone was only left on charge
        phases = []
        if asleep_from:
            if asleep_from > bed:
                phases.append((bed, asleep_from, "awake"))
            phases.append((asleep_from, asleep_to, ASLEEP))
            if up > asleep_to:
                phases.append((asleep_to, up, "awake"))
        else:
            phases.append((bed, up, ASLEEP))

        why = []
        local = lambda d: d.astimezone(tz).isoformat(timespec="minutes")  # noqa: E731
        bed_marks = {"lights": "Lights out", "charging": "Phone on charge", "in_use": "Phone put down"}
        up_marks = {"lights": "Light on", "charging": "Phone off charge", "in_use": "Phone picked up"}
        for key in per:
            t = max((w for w, v in tracks[key] if v and w <= bed), default=None)
            if t and bed - t < timedelta(hours=3):
                why.append({"at": local(t), "what": bed_marks[key], "entity": names.get(key)})
        if asleep_from:
            why.append({"at": local(asleep_from), "what": "Asleep", "entity": names.get(asleep_by)})
            why.append({"at": local(asleep_to), "what": "Awake", "entity": names.get(asleep_by)})
        for key in per:
            t = _first_change(tracks[key], up, False)
            if t and t - up <= QUIET_GAP:
                why.append({"at": local(t), "what": up_marks[key], "entity": names.get(key)})
        why.sort(key=lambda x: x["at"])
        nights.append({"start": bed, "end": up, "phases": phases, "source": "home", "why": why})
    return nights


# ---------------- the Awake switch ----------------

SWITCH_GAP = timedelta(hours=1)  # awake for less than this in the night (switched back by hand) is one night


def nights_from_awake_switch(rows: list[dict], tz, now: datetime) -> list[dict]:
    """Nights from the integration's Awake switch: each stretch it was off (asleep) overnight.

    The switch often decides a little after the fact ("asleep since the lights went off 30
    minutes ago"), and says so in its `since` attribute; that time is used when it's given."""
    steps: list[tuple[datetime, bool, str | None]] = []
    for r in rows:
        state = r.get("state")
        at = _when(r.get("last_changed") or r.get("last_updated"))
        if state not in ("on", "off") or at is None:
            continue
        attrs = r.get("attributes") or {}
        since = _when(attrs.get("since"))
        if since and timedelta(0) <= at - since <= timedelta(hours=3):
            at = since
        asleep = state == "off"
        if steps and steps[-1][1] == asleep:
            continue  # the same again (a restart)
        steps.append((at, asleep, attrs.get("how")))
    runs: list[list] = []
    for i, (at, asleep, how) in enumerate(steps):
        if not asleep:
            continue
        nxt = steps[i + 1] if i + 1 < len(steps) else None
        if nxt is None:
            continue  # still asleep
        if runs and at - runs[-1][1] <= SWITCH_GAP:
            runs[-1][1], runs[-1][3] = nxt[0], nxt[2]
        else:
            runs.append([at, nxt[0], how, nxt[2]])
    nights = []
    local = lambda d: d.astimezone(tz)  # noqa: E731
    for start, end, fell, woke in runs:
        hour = local(start).hour
        if end - start < SHORTEST_NIGHT or not (hour >= 18 or hour < 8):
            continue  # a nap, or not a night
        why = [{"at": local(start).isoformat(timespec="minutes"), "what": f"Asleep: {fell}" if fell else "Asleep"},
               {"at": local(end).isoformat(timespec="minutes"), "what": f"Awake: {woke}" if woke else "Awake"}]
        nights.append({"start": start, "end": end, "phases": [(start, end, ASLEEP)], "source": "awake_switch",
                       "why": why})
    return nights


def _is_number(value) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False
