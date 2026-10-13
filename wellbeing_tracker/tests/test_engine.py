"""Reminder engine tests with a fake Home Assistant and a controllable clock (Sydney time)."""

import asyncio
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.db import Database
from app.engine import Engine
from app.trackers import ValidationError

SYD = ZoneInfo("Australia/Sydney")


class FakeHA:
    def __init__(self):
        self.calls = []
        self.events = []
        self.states = [{"entity_id": "person.pops", "state": "home", "attributes": {"user_id": "u1"}}]

    async def call_service(self, domain, service, data):
        self.calls.append((domain, service, data))
        return True

    async def fire_event(self, event_type, data):
        self.events.append(data)
        return True

    async def get_states(self):
        return self.states

    # helpers for assertions
    def notifications(self, service="mobile_app_s26u"):
        return [d for (dom, svc, d) in self.calls if dom == "notify" and svc == service
                and d.get("message") != "clear_notification"]

    def clears(self, service="mobile_app_s26u"):
        return [d["data"]["tag"] for (dom, svc, d) in self.calls if dom == "notify" and svc == service
                and d.get("message") == "clear_notification"]

    def stages(self):
        return [e["stage"] for e in self.events]

    def reset(self):
        self.calls.clear()
        self.events.clear()


class Clock:
    def __init__(self, local: str):
        self.now = datetime.fromisoformat(local).replace(tzinfo=SYD)

    def __call__(self):
        return self.now

    def set(self, local: str):
        self.now = datetime.fromisoformat(local).replace(tzinfo=SYD)

    def advance(self, minutes: float):
        self.now += timedelta(minutes=minutes)


@pytest.fixture
def env(tmp_path):
    db = Database(tmp_path / "w.db")
    db.migrate()
    db.touch_user("u1", "matt", "Matthew Poppell")
    ha = FakeHA()
    clock = Clock("2026-10-14T06:00")
    engine = Engine(db, ha, tz=SYD, panel_path="/882b0587_wellbeing_tracker", clock=clock)
    engine.save_person("u1", {"devices": ["mobile_app_s26u", "mobile_app_tablet"]})

    def med(name, **cfg):
        return db.create_tracker("u1", {"kind": "medication", "name": name, "config": cfg})

    return db, ha, clock, engine, med


def run(coro):
    return asyncio.run(coro)


def schedule(engine, tid, enabled=True, **settings):
    return run(engine.save_schedule("u1", tid, enabled, settings))


def dose_rows(db, tid):
    with db.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM doses WHERE tracker_id = ? ORDER BY due_at", (tid,))]


def test_doses_generated_for_today_and_tomorrow(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse", dose="30", unit="mg")
    schedule(engine, v["id"], times=["07:00", "13:00"])
    doses = dose_rows(db, v["id"])
    assert [(d["local_day"], d["local_time"]) for d in doses] == [
        ("2026-10-14", "07:00"), ("2026-10-14", "13:00"), ("2026-10-15", "07:00"), ("2026-10-15", "13:00")]
    # stored in UTC: 7am Sydney (AEDT, +11) is 8pm UTC the day before
    assert doses[0]["due_at"] == "2026-10-13T20:00:00+00:00"


def test_times_already_passed_today_are_not_reminded(env):
    db, ha, clock, engine, med = env
    clock.set("2026-10-14T16:00")
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"])
    assert [d["local_day"] for d in dose_rows(db, v["id"])] == ["2026-10-15"]
    assert ha.notifications() == []


def test_reminder_sent_to_every_device_with_actions(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse", dose="30", unit="mg", notes="With breakfast")
    schedule(engine, v["id"], times=["07:00"])
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    for phone in ("mobile_app_s26u", "mobile_app_tablet"):
        [n] = ha.notifications(phone)
        assert n["title"] == "Time for Vyvanse"
        assert n["message"] == "Vyvanse 30 mg. With breakfast"
        actions = [a["title"] for a in n["data"]["actions"]]
        assert actions == ["Taken", "Snooze 15 min", "Skip"]
        assert n["data"]["actions"][2]["behavior"] == "textInput"
        assert n["data"]["persistent"] is True
        assert n["data"]["channel"] == "Medication reminders"
        assert n["data"]["clickAction"] == "/882b0587_wellbeing_tracker"
    assert ha.stages() == ["sent"]


def test_firmly_repeats_every_10_minutes_then_stops(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], nag="firmly")
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    clock.advance(5)
    run(engine.tick())
    assert len(ha.notifications()) == 1
    for _ in range(10):
        clock.advance(10)
        run(engine.tick())
    sent = ha.notifications()
    assert len(sent) == 7  # first + 6 repeats
    assert sent[1]["message"].startswith("Due since 7am.")
    assert ha.stages().count("repeated") == 6


def test_once_only_and_custom(env):
    db, ha, clock, engine, med = env
    a = med("A")
    b = med("B")
    schedule(engine, a["id"], times=["07:00"], nag="once")
    schedule(engine, b["id"], times=["08:00"], nag="custom", nag_every=5, nag_repeats=2)
    clock.set("2026-10-14T07:00")
    for _ in range(36):  # 7:00 to 9:55
        run(engine.tick())
        clock.advance(5)
    titles = [n["title"] for n in ha.notifications()]
    assert titles.count("Time for A") == 1
    assert titles.count("Time for B") == 3


def test_taken_from_notification(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], linked_entity="input_boolean.vyvanse_taken",
             linked_time_entity="input_datetime.vyvanse_taken_time")
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    clock.set("2026-10-14T07:04")
    ha.reset()
    run(engine.handle_event("mobile_app_notification_action", {"action": f"WBT_TAKEN_{rid}"}))

    d = dose_rows(db, v["id"])[0]
    assert d["status"] == "taken" and d["resolved_by"] == "notification"
    entries = db.list_entries("u1", "2026-10-14", "2026-10-14")
    assert len(entries) == 1 and entries[0]["logged_at"] == "2026-10-14T07:04:00+11:00"
    assert entries[0]["source"] == "notification"
    # cleared on both phones, undo offered, toggle and time helper updated
    assert ha.clears("mobile_app_s26u") == [f"wbt-reminder-{rid}"]
    assert ha.clears("mobile_app_tablet") == [f"wbt-reminder-{rid}"]
    [undo] = ha.notifications()
    assert undo["title"] == "Vyvanse taken at 7:04am"
    assert undo["data"]["timeout"] == 60
    assert ("input_boolean", "turn_on", {"entity_id": "input_boolean.vyvanse_taken"}) in ha.calls
    assert ("input_datetime", "set_datetime", {"entity_id": "input_datetime.vyvanse_taken_time",
                                                 "datetime": "2026-10-14 07:04:00"}) in ha.calls
    assert ha.stages() == ["taken"]
    # no more nagging
    ha.reset()
    clock.advance(30)
    run(engine.tick())
    assert ha.notifications() == []


def test_undo_puts_it_back(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], linked_entity="input_boolean.vyvanse_taken")
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    run(engine.answer_reminder(rid, "TAKEN"))
    clock.advance(1)
    ha.reset()
    run(engine.answer_reminder(rid, "UNDO"))
    assert dose_rows(db, v["id"])[0]["status"] == "due"
    assert db.list_entries("u1", "2026-10-14", "2026-10-14") == []
    assert ("input_boolean", "turn_off", {"entity_id": "input_boolean.vyvanse_taken"}) in ha.calls
    assert f"wbt-undo-{rid}" in ha.clears()
    run(engine.tick())
    [again] = ha.notifications()
    assert again["title"] == "Time for Vyvanse"
    assert "undone" in ha.stages()


def test_undo_expires(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"])
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    run(engine.answer_reminder(rid, "TAKEN"))
    clock.advance(20)
    run(engine.answer_reminder(rid, "UNDO"))
    assert dose_rows(db, v["id"])[0]["status"] == "taken"


def test_undo_can_be_turned_off(env):
    db, ha, clock, engine, med = env
    engine.save_person("u1", {"devices": ["mobile_app_s26u"], "undo": False})
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"])
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    ha.reset()
    run(engine.answer_reminder(dose_rows(db, v["id"])[0]["reminder_id"], "TAKEN"))
    assert ha.notifications() == []


def test_snooze_then_comes_back(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], nag="once")
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    ha.reset()
    run(engine.handle_event("mobile_app_notification_action", {"action": f"WBT_SNOOZE_{rid}"}))
    assert ha.clears() == [f"wbt-reminder-{rid}"]
    assert ha.stages() == ["snoozed"]
    clock.advance(14)
    run(engine.tick())
    assert ha.notifications() == []
    clock.advance(1)
    run(engine.tick())
    assert len(ha.notifications()) == 1  # snooze always brings it back, even with "once"


def test_skip_with_reason(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"])
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    run(engine.handle_event("mobile_app_notification_action",
                            {"action": f"WBT_SKIP_{rid}", "reply_text": "Ran out"}))
    d = dose_rows(db, v["id"])[0]
    assert d["status"] == "skipped" and d["reason"] == "Ran out"
    assert db.list_entries("u1", "2026-10-14", "2026-10-14") == []


def test_ignores_other_actions_and_stale_buttons(env):
    db, ha, clock, engine, med = env
    run(engine.handle_event("mobile_app_notification_action", {"action": "VYVANSE_COMPLETE"}))
    run(engine.handle_event("mobile_app_notification_action", {"action": "WBT_TAKEN_999"}))
    assert ha.calls == []
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"])
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    run(engine.answer_reminder(rid, "TAKEN"))
    ha.reset()
    run(engine.answer_reminder(rid, "TAKEN"))  # tapped again on a second device
    assert ha.clears() == [f"wbt-reminder-{rid}"]
    assert len(db.list_entries("u1", "2026-10-14", "2026-10-14")) == 1


def test_grouped_doses_share_one_notification(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse", dose="30", unit="mg")
    d = med("Dex", dose="5", unit="mg")
    schedule(engine, v["id"], times=["07:00"])
    schedule(engine, d["id"], times=["07:00"])
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    [n] = ha.notifications()
    assert n["title"] == "Time for your 7am medications"
    assert n["message"] == "Vyvanse 30 mg\nDex 5 mg"
    # take one in the app: the notification updates quietly to the other
    ha.reset()
    run(engine.answer_dose("u1", dose_rows(db, v["id"])[0]["id"], "taken"))
    [upd] = ha.notifications()
    assert upd["message"] == "Dex 5 mg" and upd["data"]["alert_once"] is True
    ha.reset()
    run(engine.answer_dose("u1", dose_rows(db, d["id"])[0]["id"], "skip", "Not needed"))
    assert ha.clears() == [n["data"]["tag"]]


def test_grouping_can_be_turned_off(env):
    db, ha, clock, engine, med = env
    engine.save_person("u1", {"devices": ["mobile_app_s26u"], "group_doses": False})
    for name in ("Vyvanse", "Dex"):
        schedule(engine, med(name)["id"], times=["07:00"])
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    assert sorted(n["title"] for n in ha.notifications()) == ["Time for Dex", "Time for Vyvanse"]


def test_logged_early_means_no_reminder(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"])
    clock.set("2026-10-14T06:30")
    db.save_checkin("u1", "2026-10-14T06:30:00+11:00", [{"tracker_id": v["id"]}])
    run(engine.tick())
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    assert ha.notifications() == []
    d = dose_rows(db, v["id"])[0]
    assert d["status"] == "taken" and d["resolved_by"] == "early"


def test_logged_too_early_does_not_count(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["13:00"], early_window=60)
    db.save_checkin("u1", "2026-10-14T06:30:00+11:00", [{"tracker_id": v["id"]}])
    clock.set("2026-10-14T13:00")
    run(engine.tick())
    assert len(ha.notifications()) == 1


def test_checkin_answers_due_dose(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"])
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    clock.set("2026-10-14T07:20")
    saved = db.save_checkin("u1", "2026-10-14T07:20:00+11:00", [{"tracker_id": v["id"]}])["saved"]
    ha.reset()
    run(engine.medication_logged("u1", saved))
    d = dose_rows(db, v["id"])[0]
    assert d["status"] == "taken" and d["entry_id"] == saved[0]["id"]
    assert len(ha.clears()) == 1
    assert len(db.list_entries("u1", "2026-10-14", "2026-10-14")) == 1  # no duplicate entry


def test_latest_time_turns_into_last_call(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], nag="gently", latest_time="11:00")
    clock.set("2026-10-14T07:00")
    for _ in range(8):  # 7:00 to 10:30 in 30 minute steps
        run(engine.tick())
        clock.advance(30)
    clock.set("2026-10-14T11:00")
    ha.reset()
    run(engine.tick())
    [last] = ha.notifications()
    assert last["title"] == "It's past 11am for Vyvanse"
    assert [a["title"] for a in last["data"]["actions"]] == ["Taken", "Skip today"]
    assert "last_call" in ha.stages()
    assert len(ha.clears()) == 1  # the old reminder went away
    ha.reset()
    clock.advance(60)
    run(engine.tick())
    assert ha.notifications() == []  # asked once, no more nagging


def test_missed_at_end_of_day(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], nag="once")
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    ha.reset()
    clock.set("2026-10-15T00:01")
    run(engine.tick())
    assert dose_rows(db, v["id"])[0]["status"] == "missed"
    assert "missed" in ha.stages()
    assert ha.clears() == [f"wbt-reminder-{rid}"]


def test_twice_daily_older_dose_missed_when_next_is_due(env):
    db, ha, clock, engine, med = env
    v = med("Dex")
    schedule(engine, v["id"], times=["07:00", "12:00"], nag="once")
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    clock.set("2026-10-14T12:00")
    run(engine.tick())
    statuses = [d["status"] for d in dose_rows(db, v["id"])[:2]]
    assert statuses == ["missed", "due"]


def test_hard_to_miss_escalates_with_alarm_and_announcement(env):
    db, ha, clock, engine, med = env
    engine.save_person("u1", {"devices": ["mobile_app_s26u"], "speakers": ["media_player.echo_show"],
                              "tts_entity": "tts.home_assistant_cloud"})
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], nag="firmly", hard_to_miss=True, hard_after=3, announce=True)
    clock.set("2026-10-14T07:00")
    for _ in range(4):
        run(engine.tick())
        clock.advance(10)
    channels = [n["data"]["channel"] for n in ha.notifications()]
    assert channels == ["Medication reminders", "Medication reminders", "alarm_stream", "alarm_stream"]
    speaks = [d for (dom, svc, d) in ha.calls if (dom, svc) == ("tts", "speak")]
    assert len(speaks) == 1
    assert speaks[0]["message"] == "Matthew, it's time for your Vyvanse."
    assert speaks[0]["media_player_entity_id"] == ["media_player.echo_show"]
    assert ha.stages().count("escalated") == 1


def test_no_announcement_when_away_or_in_quiet_hours(env):
    db, ha, clock, engine, med = env
    ha.states[0]["state"] = "not_home"
    engine.save_person("u1", {"devices": ["mobile_app_s26u"], "speakers": ["media_player.echo_show"],
                              "tts_entity": "tts.piper", "quiet": {"enabled": True, "start": "22:00", "end": "07:30"}})
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], nag="custom", nag_every=10, nag_repeats=5,
             hard_to_miss=True, hard_after=1, announce=True)
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    n = ha.notifications()[0]
    assert n["data"]["channel"] == "Urgent medication reminders"  # quiet hours: no alarm sound
    assert not [c for c in ha.calls if c[0] == "tts"]
    clock.set("2026-10-14T07:40")
    run(engine.tick())
    assert ha.notifications()[-1]["data"]["channel"] == "alarm_stream"
    assert not [c for c in ha.calls if c[0] == "tts"]  # still away


def test_linked_toggle_counts_as_taken(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], linked_entity="input_boolean.vyvanse_taken")
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    ha.reset()
    clock.advance(3)
    run(engine.handle_event("state_changed", {
        "entity_id": "input_boolean.vyvanse_taken",
        "old_state": {"state": "off"}, "new_state": {"state": "on"}}))
    d = dose_rows(db, v["id"])[0]
    assert d["status"] == "taken" and d["resolved_by"] == "toggle"
    assert len(ha.clears()) == 1
    assert not [c for c in ha.calls if c[0] == "input_boolean"]  # doesn't switch it again


def test_own_toggle_change_is_not_double_counted(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], linked_entity="input_boolean.vyvanse_taken")
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    run(engine.answer_reminder(dose_rows(db, v["id"])[0]["reminder_id"], "TAKEN"))
    run(engine.handle_event("state_changed", {
        "entity_id": "input_boolean.vyvanse_taken",
        "old_state": {"state": "off"}, "new_state": {"state": "on"}}))
    assert len(db.list_entries("u1", "2026-10-14", "2026-10-14")) == 1


def test_toggle_before_reminder_logs_early(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"], linked_entity="input_boolean.vyvanse_taken")
    clock.set("2026-10-14T06:45")
    run(engine.toggle_turned_on("input_boolean.vyvanse_taken"))
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    assert ha.notifications() == []
    assert dose_rows(db, v["id"])[0]["status"] == "taken"


def test_turning_reminders_off_cancels_due_and_clears(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"])
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    ha.reset()
    schedule(engine, v["id"], enabled=False, times=["07:00"])
    assert dose_rows(db, v["id"])[0]["status"] == "cancelled"
    assert ha.clears() == [f"wbt-reminder-{rid}"]
    clock.set("2026-10-15T07:00")
    run(engine.tick())
    assert ha.notifications() == []


def test_changing_times_replaces_future_doses(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    schedule(engine, v["id"], times=["07:00"])
    schedule(engine, v["id"], times=["08:30"])
    assert [d["local_time"] for d in dose_rows(db, v["id"])] == ["08:30", "08:30"]


def test_weekday_and_interval_schedules(env):
    db, ha, clock, engine, med = env
    a = med("Weekdays")
    b = med("Every3")
    schedule(engine, a["id"], times=["07:00"], days={"mode": "weekdays", "weekdays": [5, 6]})
    schedule(engine, b["id"], times=["07:00"], days={"mode": "interval", "every": 3, "start": "2026-10-12"})
    # 14 Oct 2026 is a Wednesday, 15th Thursday: no weekend doses yet
    assert dose_rows(db, a["id"]) == []
    assert [d["local_day"] for d in dose_rows(db, b["id"])] == ["2026-10-15"]


def test_schedule_validation(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    for bad in (
        {"times": []},
        {"times": ["7am"]},
        {"times": ["07:00"], "days": {"mode": "weekdays", "weekdays": []}},
        {"times": ["07:00"], "days": {"mode": "interval", "every": 1, "start": "2026-10-01"}},
        {"times": ["07:00"], "nag": "loudly"},
        {"times": ["07:00"], "latest_time": "06:00"},
        {"times": ["07:00"], "linked_entity": "switch.kettle"},
    ):
        with pytest.raises(ValidationError):
            schedule(engine, v["id"], **bad)
    mood = [t for t in db.list_trackers("u1") if t["key"] == "mood"][0]
    with pytest.raises(ValidationError):
        schedule(engine, mood["id"], times=["07:00"])


def test_doses_today_for_the_app(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse", dose="30", unit="mg")
    schedule(engine, v["id"], times=["07:00", "13:00"], latest_time="15:00")
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    run(engine.answer_reminder(rid, "SNOOZE"))
    today = engine.doses_today("u1")
    assert [(d["time"], d["status"]) for d in today] == [("07:00", "due"), ("13:00", "scheduled")]
    assert today[0]["snoozed_until"] == "07:15"
    assert today[0]["amount"] == "30 mg"
    assert today[0]["latest"] == "15:00"


def test_hidden_medication_is_not_reminded(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    db.update_tracker("u1", v["id"], {"hidden": True})
    schedule(engine, v["id"], times=["07:00"])
    assert dose_rows(db, v["id"]) == []


# ----- "after another dose" schedules -----

def after_rules(engine, tid, rules, **extra):
    return schedule(engine, tid, mode="after", after=[{"tracker_id": a, "minutes": m} for a, m in rules], **extra)


def chain_env(env, max_per_day=2, **extra):
    db, ha, clock, engine, med = env
    v = med("Vyvanse", dose="30", unit="mg")
    d = med("Dex", dose="5", unit="mg")
    schedule(engine, v["id"], times=["07:00"])
    after_rules(engine, d["id"], [(v["id"], 7 * 60), (d["id"], 3 * 60)], max_per_day=max_per_day, **extra)
    return v, d


def test_dex_seven_hours_after_vyvanse_then_three_hours_after_dex(env):
    db, ha, clock, engine, med = env
    v, d = chain_env(env)
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    clock.set("2026-10-14T07:04")
    run(engine.answer_reminder(dose_rows(db, v["id"])[0]["reminder_id"], "TAKEN"))
    run(engine.tick())
    [dex1] = dose_rows(db, d["id"])
    assert (dex1["local_time"], dex1["status"], dex1["derived"]) == ("14:04", "scheduled", 1)

    ha.reset()
    clock.set("2026-10-14T14:04")
    run(engine.tick())
    [n] = ha.notifications()
    assert n["title"] == "Time for Dex"
    assert n["message"] == "Dex 5 mg\n7 hours after your Vyvanse at 7:04am"

    clock.set("2026-10-14T14:10")
    run(engine.answer_reminder(dex1["reminder_id"] or dose_rows(db, d["id"])[0]["reminder_id"], "TAKEN"))
    run(engine.tick())
    dex2 = dose_rows(db, d["id"])[1]
    assert dex2["local_time"] == "17:10"

    ha.reset()
    clock.set("2026-10-14T17:10")
    run(engine.tick())
    assert ha.notifications()[0]["message"].endswith("3 hours after your Dex at 2:10pm")
    clock.set("2026-10-14T17:12")
    run(engine.answer_reminder(dose_rows(db, d["id"])[1]["reminder_id"], "TAKEN"))
    run(engine.tick())
    assert len(dose_rows(db, d["id"])) == 2  # daily limit of 2 reached: chain stops


def test_chain_follows_check_in_logging_and_toggles(env):
    db, ha, clock, engine, med = env
    v, d = chain_env(env)
    # Vyvanse logged from the Check-in screen before its reminder
    clock.set("2026-10-14T06:50")
    db.save_checkin("u1", "2026-10-14T06:50:00+11:00", [{"tracker_id": v["id"]}])
    run(engine.tick())
    assert dose_rows(db, d["id"])[0]["local_time"] == "13:50"


def test_dex_taken_early_restarts_the_clock_from_then(env):
    db, ha, clock, engine, med = env
    v, d = chain_env(env, max_per_day=3)
    clock.set("2026-10-14T07:00")
    db.save_checkin("u1", "2026-10-14T07:00:00+11:00", [{"tracker_id": v["id"]}])
    run(engine.tick())  # Dex due 14:00
    clock.set("2026-10-14T13:00")
    db.save_checkin("u1", "2026-10-14T13:00:00+11:00", [{"tracker_id": d["id"]}])
    run(engine.tick())
    clock.set("2026-10-14T14:00")
    run(engine.tick())
    rows = dose_rows(db, d["id"])
    assert rows[0]["status"] == "taken" and rows[0]["resolved_by"] == "early"
    assert ha.notifications() == []
    run(engine.tick())
    assert dose_rows(db, d["id"])[1]["local_time"] == "16:00"  # 3 h after 1pm, not after 2pm


def test_old_log_does_not_create_overdue_reminder(env):
    db, ha, clock, engine, med = env
    v, d = chain_env(env, max_per_day=5, early_window=60)
    clock.set("2026-10-14T07:00")
    db.save_checkin("u1", "2026-10-14T07:00:00+11:00", [{"tracker_id": v["id"]}])
    run(engine.tick())  # Dex due 14:00
    clock.set("2026-10-14T09:00")
    db.save_checkin("u1", "2026-10-14T09:00:00+11:00", [{"tracker_id": d["id"]}])  # outside early window
    run(engine.tick())
    clock.set("2026-10-14T14:00")
    run(engine.tick())
    clock.set("2026-10-14T14:05")
    run(engine.answer_reminder(dose_rows(db, d["id"])[0]["reminder_id"], "TAKEN"))
    run(engine.tick())
    times = [r["local_time"] for r in dose_rows(db, d["id"])]
    assert times == ["14:00", "17:05"]  # nothing for 12:00 (9am + 3h)


def test_latest_time_stops_the_chain(env):
    db, ha, clock, engine, med = env
    v, d = chain_env(env, max_per_day=None, latest_time="16:00")
    clock.set("2026-10-14T08:30")
    db.save_checkin("u1", "2026-10-14T08:30:00+11:00", [{"tracker_id": v["id"]}])
    run(engine.tick())
    assert dose_rows(db, d["id"])[0]["local_time"] == "15:30"
    clock.set("2026-10-14T15:30")
    run(engine.tick())
    run(engine.answer_reminder(dose_rows(db, d["id"])[0]["reminder_id"], "TAKEN"))
    run(engine.tick())
    assert len(dose_rows(db, d["id"])) == 1  # 18:30 would be past 4pm


def test_undoing_the_anchor_removes_the_follow_up(env):
    db, ha, clock, engine, med = env
    v, d = chain_env(env)
    clock.set("2026-10-14T07:00")
    run(engine.tick())
    rid = dose_rows(db, v["id"])[0]["reminder_id"]
    run(engine.answer_reminder(rid, "TAKEN"))
    run(engine.tick())
    assert len(dose_rows(db, d["id"])) == 1
    clock.advance(1)
    run(engine.answer_reminder(rid, "UNDO"))
    run(engine.tick())
    assert dose_rows(db, d["id"]) == []


def test_anchor_before_setup_is_ignored(env):
    db, ha, clock, engine, med = env
    v = med("Vyvanse")
    d = med("Dex")
    clock.set("2026-10-14T07:00")
    db.save_checkin("u1", "2026-10-14T07:00:00+11:00", [{"tracker_id": v["id"]}])
    clock.set("2026-10-14T15:00")
    after_rules(engine, d["id"], [(v["id"], 7 * 60)])  # 7am + 7h = 2pm, already past
    run(engine.tick())
    assert dose_rows(db, d["id"]) == []


def test_after_rules_validation(env):
    db, ha, clock, engine, med = env
    d = med("Dex")
    mood = [t for t in db.list_trackers("u1") if t["key"] == "mood"][0]
    with pytest.raises(ValidationError):
        schedule(engine, d["id"], mode="after", after=[])
    with pytest.raises(ValidationError):
        after_rules(engine, d["id"], [(d["id"], 0)])
    with pytest.raises(ValidationError):
        after_rules(engine, d["id"], [(mood["id"], 60)])
    db.touch_user("u2", "k", "Kayla")
    kmed = db.create_tracker("u2", {"kind": "medication", "name": "Theirs"})
    with pytest.raises(Exception):
        after_rules(engine, d["id"], [(kmed["id"], 60)])
