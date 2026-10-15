"""Good news, without guilt.

Looks for things that have changed for the better, compared with the day before, the week
before or the month before, and says so in plain words. Only improvements are ever called out:
nothing here points at a bad day or a missed one.

Which way is "better" is only assumed where it's obvious (fewer symptoms, more sleep when you're
short of your goal, reaching a goal, exercise, less alcohol). Anything else is left alone.
"""

from __future__ import annotations

import re
from datetime import date, timedelta

LOWER_BETTER_RATING = re.compile(r"stress|pain|anx|worr|irritab|craving|overwhelm", re.I)
GOOD_HABIT = re.compile(r"exercis|outdoor|outside|social|mindful|meditat|walk|stretch|yoga|read|journal|sunlight", re.I)
BAD_HABIT = re.compile(r"late.?screen|alcohol|drink|smok|vape|junk|takeaway|doomscroll", re.I)
GOOD_TAGS = {"happy", "calm", "grateful", "motivated", "content", "relaxed", "hopeful", "proud", "loved",
             "energised", "energized", "focused", "confident", "peaceful", "excited"}
BAD_TAGS = {"anxious", "irritable", "sad", "overwhelmed", "lonely", "angry", "stressed", "frustrated",
            "worried", "down", "numb", "guilty", "ashamed"}

PERIODS = {  # name: (days in each window, fewest days with data needed in each)
    "week": (7, 3),
    "month": (30, 10),
}


def _days(end: date, n: int) -> list[str]:
    return [(end - timedelta(days=i)).isoformat() for i in range(n)]


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _label(t: dict, v: float) -> str:
    cfg = t["config"]
    labels = cfg.get("labels") or []
    i = int(round(v)) - cfg.get("min", 1)
    return labels[i] if labels and 0 <= i < len(labels) else f"{v:.1f}".rstrip("0").rstrip(".")


def _hm(minutes: float) -> str:
    m = int(round(minutes))
    return f"{m // 60}h {m % 60}m" if m >= 60 else f"{m} min"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def daily_series(trackers: list[dict], entries: list[dict]) -> dict[int, dict[str, object]]:
    """{tracker id: {day: that day's value}} in each kind's own terms."""
    by: dict[int, dict[str, list]] = {}
    for e in entries:
        by.setdefault(e["tracker_id"], {}).setdefault(e["day"], []).append(e)
    out: dict[int, dict[str, object]] = {}
    for t in trackers:
        days = by.get(t["id"], {})
        s: dict[str, object] = {}
        for day, es in days.items():
            k = t["kind"]
            if k == "rating":
                vals = [e["value_num"] for e in es if e["value_num"] is not None]
                if vals:
                    s[day] = sum(vals) / len(vals)
            elif k == "symptom":
                vals = [e["value_num"] for e in es if e["value_num"] is not None]
                if vals:
                    s[day] = max(vals)
            elif k == "sleep":
                hours = [(e.get("value_json") or {}).get("hours") for e in es]
                hours = [h for h in hours if h is not None]
                if hours:
                    s[day] = hours[0]
            elif k == "factor":
                vals = [e["value_num"] for e in es if e["value_num"] is not None]
                if vals:
                    s[day] = sum(vals) if t["frequency"] == "many" else vals[0]
            elif k == "tags":
                s[day] = {str(x).lower() for e in es for x in (e.get("value_json") or [])}
            elif k == "gratitude":
                s[day] = len(es)
        out[t["id"]] = s
    return out


def _change(t: dict, s: dict[str, object], latest: date, period: str, sleep_goal: float) -> list[dict]:
    """Improvements for one tracker over one period, as [{text, score, period}]."""
    n, need = PERIODS[period]
    recent = _days(latest, n)
    before = _days(latest - timedelta(days=n), n)
    this = "this week" if period == "week" else "over the last month"
    prev = "the week before" if period == "week" else "the month before"
    in_recent = [d for d in recent if d in s]
    in_before = [d for d in before if d in s]
    k, cfg, name = t["kind"], t["config"], t["name"]
    out = []

    if k == "rating":
        if len(in_recent) < need or len(in_before) < need:
            return []
        a, b = _mean([s[d] for d in in_recent]), _mean([s[d] for d in in_before])
        span = max(1, cfg.get("max", 10) - cfg.get("min", 1))
        lower = bool(LOWER_BETTER_RATING.search(name))
        gain = (b - a) if lower else (a - b)
        if gain / span >= (0.08 if period == "week" else 0.05) and _label(t, a) != _label(t, b):
            word = "down" if lower else "up"
            out.append({"text": f"{name} averaged {_label(t, a)} {this}, {word} from {_label(t, b)} {prev}.",
                        "score": gain / span * 10})
        return out

    if k == "symptom":
        # fewer days with it (days you answered "none" count as without it)
        if len(in_recent) < need or len(in_before) < need:
            return []
        a = sum(1 for d in in_recent if s[d] >= 1)
        b = sum(1 for d in in_before if s[d] >= 1)
        if b - a >= (2 if period == "week" else 3):
            when = "this week" if period == "week" else "in the last month"
            text = f"No {name.lower()} {when}, down from {_plural(b, 'day')} {prev}." if a == 0 else \
                f"{name} on {_plural(a, 'day')} {when}, down from {b} {prev}."
            out.append({"text": text, "score": (b - a) / n * 10})
        return out

    if k == "sleep":
        if len(in_recent) < need or len(in_before) < need:
            return []
        a, b = _mean([s[d] for d in in_recent]), _mean([s[d] for d in in_before])
        more = (a - b) * 60
        if b < sleep_goal and more >= (20 if period == "week" else 15) and a <= sleep_goal + 1:
            out.append({"text": f"Sleep averaged {_hm(a * 60)} a night {this}, {_hm(more)} more than {prev}.",
                        "score": more / 30})
        return out

    if k == "factor":
        mode, goal = cfg.get("mode", "bool"), cfg.get("goal")
        when = "this week" if period == "week" else "in the last month"
        step = 2 if period == "week" else 3
        if goal:
            a = sum(1 for d in recent if s.get(d, 0) >= goal)
            b = sum(1 for d in before if s.get(d, 0) >= goal)
            if a - b >= step:
                out.append({"text": f"{name} goal reached on {_plural(a, 'day')} {when}, up from {b} {prev}.",
                            "score": (a - b) / n * 10})
            return out
        good, bad = GOOD_HABIT.search(name) or t.get("key") in ("exercise", "outdoors", "socialised", "mindful"), \
            BAD_HABIT.search(name) or t.get("key") in ("late_screens", "alcohol")
        if mode == "bool" and (good or bad):
            a = sum(1 for d in recent if s.get(d))
            b = sum(1 for d in before if s.get(d))
            if good and a - b >= step:
                out.append({"text": f"{name} on {_plural(a, 'day')} {when}, up from {b} {prev}.", "score": (a - b) / n * 10})
            if bad and not good and b - a >= step:
                out.append({"text": f"{name} on {_plural(a, 'day')} {when}, down from {b} {prev}.", "score": (b - a) / n * 10})
        elif bad:
            a = sum(float(s.get(d, 0)) for d in recent)
            b = sum(float(s.get(d, 0)) for d in before)
            unit = cfg.get("unit", "")
            if len(in_before) >= need and b > 0 and (b - a) / b >= 0.3 and b - a >= 2:
                out.append({"text": f"{name}: {a:g} {unit} {this}, down from {b:g} {prev}.".replace("  ", " "),
                            "score": (b - a) / b * 3})
        return out

    if k == "tags":
        if len(in_recent) < need or len(in_before) < need:
            return []
        when = "this week" if period == "week" else "in the last month"
        step = 2 if period == "week" else 3
        options = {o.lower(): o for o in cfg.get("options", [])}
        for tag, label in options.items():
            a = sum(1 for d in in_recent if tag in s[d])
            b = sum(1 for d in in_before if tag in s[d])
            if tag in GOOD_TAGS and a - b >= step:
                out.append({"text": f"Felt {label.lower()} on {_plural(a, 'day')} {when}, up from {b} {prev}.",
                            "score": (a - b) / n * 10})
            elif tag in BAD_TAGS and b - a >= step:
                text = f"Didn't feel {label.lower()} {when}, down from {_plural(b, 'day')} {prev}." if a == 0 else \
                    f"Felt {label.lower()} on {_plural(a, 'day')} {when}, down from {b} {prev}."
                out.append({"text": text, "score": (b - a) / n * 10})
        return out
    return out


def _day_before(t: dict, s: dict[str, object], latest: date, sleep_goal: float, real_today: date) -> list[dict]:
    """Compared with the day before: a clearly better day, or the best in a while."""
    k, name = t["kind"], t["name"]
    today, yesterday = latest.isoformat(), (latest - timedelta(days=1)).isoformat()
    when = "today" if latest == real_today else "yesterday"
    out = []
    if k == "rating" and today in s and yesterday in s and not LOWER_BETTER_RATING.search(name):
        span = max(1, t["config"].get("max", 10) - t["config"].get("min", 1))
        a, b = s[today], s[yesterday]
        # best in a while: how many days back until it was this good
        back = next((i for i in range(1, 61) if (latest - timedelta(days=i)).isoformat() in s
                     and s[(latest - timedelta(days=i)).isoformat()] >= a), None)
        if back is None and sum(1 for i in range(1, 61) if (latest - timedelta(days=i)).isoformat() in s) >= 14:
            out.append({"text": f"Your best {name.lower()} in at least two months {when}: {_label(t, a)}.", "score": 3})
        elif back and back >= 7:
            out.append({"text": f"Your best {name.lower()} in {_ago(back)} {when}: {_label(t, a)}.", "score": 1 + back / 14})
        elif (a - b) / span >= 0.2 and _label(t, a) != _label(t, b):
            out.append({"text": f"{name}'s up {when}: {_label(t, a)}, after {_label(t, b)} the day before.",
                        "score": (a - b) / span * 5})
    if k == "symptom" and s.get(today) == 0:
        run = 0
        for i in range(1, 30):
            v = s.get((latest - timedelta(days=i)).isoformat())
            if v is None or v < 1:
                break
            run += 1
        if run >= 2:
            out.append({"text": f"No {name.lower()} {when}, after {run} days of it.", "score": 1 + run / 3})
    if k == "sleep" and today in s:
        a = s[today]
        back = next((i for i in range(1, 61) if (latest - timedelta(days=i)).isoformat() in s
                     and s[(latest - timedelta(days=i)).isoformat()] >= a), None)
        if back and back >= 7 and a <= sleep_goal + 1:
            out.append({"text": f"{_hm(a * 60)} of sleep last night, your most in {_ago(back)}.", "score": 1 + back / 14})
    return out


def _ago(days: int) -> str:
    if days < 14:
        return "a week"
    if days < 28:
        return f"{days // 7} weeks"
    return "a month" if days < 60 else "two months"


def highlights(trackers: list[dict], entries: list[dict], today: date, sleep_goal: float = 8,
               limit: int = 6) -> list[dict]:
    """Good changes, best first, at most one per item."""
    series = daily_series(trackers, entries)
    # the most recent day: today if anything's been logged, otherwise yesterday
    any_today = any(e["day"] == today.isoformat() for e in entries)
    latest = today if any_today else today - timedelta(days=1)
    found = []
    for t in trackers:
        if t.get("hidden") or t["kind"] in ("medication", "note", "gratitude"):
            continue
        s = series.get(t["id"], {})
        options = _day_before(t, s, latest, sleep_goal, today)
        for period in ("week", "month"):
            options += [{**o, "period": period} for o in _change(t, s, latest, period, sleep_goal)]
        # one per item (feelings can have two: one more of, one less of), the strongest
        options.sort(key=lambda o: -o["score"])
        picked, seen = [], set()
        for o in options:
            subject = o["text"].split(" on ")[0].split(" in ")[0] if t["kind"] == "tags" else t["id"]
            if subject in seen:
                continue
            seen.add(subject)
            picked.append(o)
        for best in picked[:2 if t["kind"] == "tags" else 1]:
            found.append({"tracker_id": t["id"], "emoji": t.get("emoji"), "period": best.get("period", "day"),
                          "text": best["text"], "score": round(best["score"], 2)})
    found.sort(key=lambda x: -x["score"])
    return found[:limit]


def week_recap(trackers: list[dict], entries: list[dict], doses: list[dict], today: date,
               sleep_goal: float = 8) -> dict:
    """The last seven days, in a few friendly facts. Nothing here is a score to beat."""
    days = _days(today, 7)
    in_week = [e for e in entries if e["day"] in days]
    checked = sorted({e["day"] for e in in_week if e.get("source") not in ("ha",)})
    by_id = {t["id"]: t for t in trackers}
    good = [e for e in in_week if by_id.get(e["tracker_id"], {}).get("kind") == "gratitude"]
    series = daily_series(trackers, entries)
    sleep_t = next((t for t in trackers if t["kind"] == "sleep"), None)
    sleep = [series[sleep_t["id"]][d] for d in days if sleep_t and d in series[sleep_t["id"]]]
    mood_t = next((t for t in trackers if t.get("key") == "mood" and t["kind"] == "rating"), None)
    best_day = None
    if mood_t:
        moods = {d: v for d, v in series[mood_t["id"]].items() if d in days}
        if moods:
            d = max(moods, key=lambda x: moods[x])
            best_day = {"day": d, "label": _label(mood_t, moods[d])}
    resolved = [d for d in doses if d["status"] in ("taken", "skipped", "missed")]
    taken = sum(1 for d in resolved if d["status"] == "taken")
    return {
        "days_checked_in": len(checked),
        "good_things": len(good),
        "sleep_average": round(_mean(sleep) * 60) if sleep else None,
        "sleep_goal": sleep_goal,
        "nights_at_goal": sum(1 for h in sleep if h >= sleep_goal),
        "nights": len(sleep),
        "doses_taken": taken,
        "doses_planned": len(resolved),
        "best_day": best_day,
    }
