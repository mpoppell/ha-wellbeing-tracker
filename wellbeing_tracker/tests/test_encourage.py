"""Good news without guilt: only improvements, in plain words."""

from datetime import date, timedelta

from app import encourage

TODAY = date(2026, 10, 15)
MOOD = {"id": 1, "key": "mood", "kind": "rating", "name": "Mood", "frequency": "many",
        "config": {"min": 1, "max": 10, "labels": ["Awful", "Very bad", "Bad", "Poor", "Meh", "Okay", "Fine", "Good", "Very good", "Great"]}}
HEAD = {"id": 2, "key": "headache", "kind": "symptom", "name": "Headache", "frequency": "daily", "config": {}}
EXER = {"id": 3, "key": "exercise", "kind": "factor", "name": "Exercise", "frequency": "daily", "config": {"mode": "bool"}}
SLEEP = {"id": 4, "key": "sleep", "kind": "sleep", "name": "Sleep", "frequency": "daily", "config": {"goal": 8}}
CAFFEINE = {"id": 5, "key": "caffeine", "kind": "factor", "name": "Caffeine", "frequency": "daily", "config": {"mode": "count"}}
EMO = {"id": 6, "key": "emotions", "kind": "tags", "name": "Emotions", "frequency": "many",
       "config": {"options": ["Happy", "Calm", "Anxious"]}}
GOOD = {"id": 7, "key": "good_things", "kind": "gratitude", "name": "Three good things", "frequency": "many", "config": {}}
ALL = [MOOD, HEAD, EXER, SLEEP, CAFFEINE, EMO, GOOD]


def day(n):
    return (TODAY - timedelta(days=n)).isoformat()


def e(t, n, value=None, js=None, source="app"):
    return {"tracker_id": t["id"], "day": day(n), "value_num": value, "value_json": js, "source": source}


def test_better_week_is_called_out():
    entries = [e(MOOD, n, 8) for n in range(0, 7)] + [e(MOOD, n, 6) for n in range(7, 14)]
    entries += [e(HEAD, n, 1 if n in (2,) else 0) for n in range(0, 7)] + [e(HEAD, n, 2) for n in range(7, 13)] + [e(HEAD, 13, 0)]
    entries += [e(EXER, n, 1) for n in (0, 1, 3, 5)] + [e(EXER, n, 1) for n in (9,)]
    entries += [e(SLEEP, n, js={"hours": 7.5}) for n in range(0, 7)] + [e(SLEEP, n, js={"hours": 6.5}) for n in range(7, 14)]
    texts = [h["text"] for h in encourage.highlights(ALL, entries, TODAY)]
    assert "Mood averaged Good this week, up from Okay the week before." in texts
    assert "Headache on 1 day this week, down from 6 the week before." in texts
    assert "Exercise on 4 days this week, up from 1 the week before." in texts
    assert "Sleep averaged 7h 30m a night this week, 1h 0m more than the week before." in texts
    assert not any("Caffeine" in t for t in texts)  # which way is better isn't obvious


def test_nothing_negative_is_ever_said():
    entries = [e(MOOD, n, 3) for n in range(0, 7)] + [e(MOOD, n, 8) for n in range(7, 14)]
    entries += [e(HEAD, n, 3) for n in range(0, 14)]
    assert encourage.highlights(ALL, entries, TODAY) == []


def test_compared_with_the_day_before():
    entries = [e(MOOD, n, 5) for n in range(1, 20)] + [e(MOOD, 0, 9)]
    entries += [e(HEAD, 0, 0), e(HEAD, 1, 2), e(HEAD, 2, 1), e(HEAD, 3, 2)]
    texts = [h["text"] for h in encourage.highlights(ALL, entries, TODAY)]
    assert "Your best mood in at least two months today: Very good." in texts
    assert "No headache today, after 3 days of it." in texts


def test_feelings_and_month():
    entries = [e(EMO, n, js=["Calm"]) for n in range(0, 30, 2)] + [e(EMO, n, js=["Anxious"]) for n in range(30, 60, 2)]
    entries += [e(EMO, n, js=["Calm"]) for n in (31, 35)]
    texts = [h["text"] for h in encourage.highlights(ALL, entries, TODAY)]
    assert texts == ["Didn't feel anxious in the last month, down from 15 days the month before.",
                     "Felt calm on 15 days in the last month, up from 2 the month before."]


def test_week_recap():
    entries = [e(MOOD, n, 6 + n % 3) for n in range(0, 5)] + [e(GOOD, n) for n in (0, 0, 1, 2)]
    entries += [e(SLEEP, n, js={"hours": h}, source="ha") for n, h in ((0, 8.2), (1, 7.0), (2, 8.0))]
    doses = [{"status": "taken"}] * 9 + [{"status": "skipped"}, {"status": "scheduled"}]
    w = encourage.week_recap(ALL, entries, doses, TODAY)
    assert w["days_checked_in"] == 5 and w["good_things"] == 4
    assert w["sleep_average"] == 464 and w["nights_at_goal"] == 2
    assert (w["doses_taken"], w["doses_planned"]) == (9, 10)
    assert w["best_day"]["label"] == "Good"
