"""Going back to sleep after the alarm: Sleep as Android's tracking starts again, and stops once
you're up. The rules first, replaying two real mornings, then the switch inside Home Assistant."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed, async_mock_service

from custom_components.wellbeing_tracker.wake import MAX_RESTARTS, Rules, settings

from test_wellbeing import URL, person, setup

TZ = ZoneInfo("Australia/Melbourne")
SETUP = {"sleep_tracking": "event.sleep_tracking", "alarm": "event.alarm_clock",
         "charging": "binary_sensor.phone_is_charging", "phone_locked": "binary_sensor.phone_device_locked",
         "activity": "sensor.phone_detected_activity", "person": "person.pops", "lights": ["light.bedroom"],
         "signs": ["sensor.mados_lastsystemstatechange"], "keep_awake": ["switch.mados"],
         "start_tracking": "script.start_sleep_tracking", "stop_tracking": "script.stop_sleep_tracking"}


def t(local: str) -> datetime:
    return datetime.fromisoformat(local).replace(tzinfo=TZ)


def rules(**over) -> Rules:
    r = Rules(settings({**SETUP, **over}), TZ)
    r.home = True
    return r


def changes(r: Rules) -> list[tuple[str, str, str]]:
    out = [("awake" if c.awake else "asleep", c.at.astimezone(TZ).strftime("%H:%M"), c.source) for c in r.pending]
    r.pending.clear()
    return out


def actions(r: Rules) -> list[tuple[str, str, str | None]]:
    out = [(a.kind, a.at.astimezone(TZ).strftime("%H:%M"),
            a.since.astimezone(TZ).strftime("%H:%M") if a.since else None) for a in r.actions]
    r.actions.clear()
    return out


def ticks(r: Rules, start: str, end: str) -> None:
    now, last = t(start), t(end)
    while now <= last:
        r.tick(now)
        now += timedelta(minutes=1)


def a_night(r: Rules, started: str = "2026-11-09T04:58") -> None:
    """On charge, locked and tracking since the small hours."""
    r.charging_changed(True, t("2026-11-09T00:30"), t("2026-11-09T00:30"))
    r.lock_changed(True, t("2026-11-09T00:31"))
    r.tracking_event("started", t(started))
    changes(r)


# ----- the rules -----

def test_monday_back_to_sleep_after_the_alarm():
    """9 Nov: alarm dismissed 8:19 and the phone used for a bit, then locked at 8:35 and left on
    charge until 9:48. Tracking starts again at 8:50, counted from 8:35, and stops at 9:58 once the
    phone has been in use for ten minutes. Up at 9:48, not 8:19."""
    r = rules()
    a_night(r)
    r.alarm_event("alert_dismiss", t("2026-11-09T08:19:17"))
    r.tracking_event("stopped", t("2026-11-09T08:19:17"))
    r.lock_changed(False, t("2026-11-09T08:19:24"))
    ticks(r, "2026-11-09T08:20", "2026-11-09T08:30")
    assert changes(r) == [("awake", "08:19", "phone in use")]
    r.lock_changed(True, t("2026-11-09T08:35:39"))
    ticks(r, "2026-11-09T08:36", "2026-11-09T08:50")
    assert actions(r) == []  # quiet for 14 minutes: not yet
    ticks(r, "2026-11-09T08:51", "2026-11-09T09:00")
    assert actions(r) == [("start_tracking", "08:51", "08:35")]  # once, not every minute
    r.tracking_event("started", t("2026-11-09T08:51:20"))
    assert changes(r) == [("asleep", "08:35", "sleep tracking started again")]
    assert actions(r) == [("back_asleep", "08:51", "08:35")]
    r.lock_changed(False, t("2026-11-09T09:48:26"))
    ticks(r, "2026-11-09T09:49", "2026-11-09T09:58")
    assert changes(r) == [] and actions(r) == []
    ticks(r, "2026-11-09T09:59", "2026-11-09T10:00")  # unlocked at 9:48:26, so ten minutes at 9:59
    assert changes(r) == [("awake", "09:48", "phone in use")]
    assert actions(r) == [("stop_tracking", "09:59", None)]
    r.tracking_event("stopped", t("2026-11-09T09:58:30"))
    r.charging_changed(False, t("2026-11-09T10:01"), t("2026-11-09T10:01"))
    ticks(r, "2026-11-09T10:02", "2026-11-09T11:00")
    assert actions(r) == []  # off the charger: up


def test_tuesday_snoozed_for_more_than_ten_minutes():
    """10 Nov: snoozed at 8:01, tracking stopped at 8:10 while still snoozed. Started again at
    8:11, as soon as it's been snoozed ten minutes, counted from 8:10."""
    r = rules()
    a_night(r, "2026-11-10T01:38")
    r.alarm_event("alert_start", t("2026-11-10T08:00:15"))
    r.alarm_event("snooze_clicked", t("2026-11-10T08:01:15"))
    r.tracking_event("stopped", t("2026-11-10T08:10:08"))
    ticks(r, "2026-11-10T08:02", "2026-11-10T08:11")
    assert actions(r) == []
    ticks(r, "2026-11-10T08:12", "2026-11-10T08:13")
    assert actions(r) == [("start_tracking", "08:12", "08:10")]


def test_up_after_the_alarm_starts_nothing():
    r = rules()
    a_night(r)
    r.alarm_event("alert_dismiss", t("2026-11-09T07:00"))
    r.tracking_event("stopped", t("2026-11-09T07:00"))
    r.charging_changed(False, t("2026-11-09T07:05"), t("2026-11-09T07:05"))
    r.lock_changed(False, t("2026-11-09T07:06"))
    r.lock_changed(True, t("2026-11-09T07:08"))
    ticks(r, "2026-11-09T07:06", "2026-11-09T09:00")
    assert actions(r) == []


def test_the_phone_in_use_or_something_happening_holds_it_off():
    r = rules()
    a_night(r)
    r.tracking_event("stopped", t("2026-11-09T07:00"))
    r.lock_changed(False, t("2026-11-09T07:01"))
    ticks(r, "2026-11-09T07:02", "2026-11-09T07:09")  # unlocked, but not ten minutes yet
    assert actions(r) == []
    r.lock_changed(True, t("2026-11-09T07:09"))
    r.busy_changed(True, t("2026-11-09T07:12"))  # the computer's on
    ticks(r, "2026-11-09T07:10", "2026-11-09T07:40")
    assert actions(r) == []
    r.busy_changed(False, t("2026-11-09T07:41"))
    ticks(r, "2026-11-09T07:42", "2026-11-09T07:55")
    assert actions(r) == []
    ticks(r, "2026-11-09T07:56", "2026-11-09T07:57")
    assert actions(r) == [("start_tracking", "07:56", "07:41")]


def test_only_in_the_morning_only_twice_and_only_when_set_up():
    r = rules()
    a_night(r)
    r.tracking_event("stopped", t("2026-11-08T23:00"))  # stopped in the evening: not waking up
    ticks(r, "2026-11-08T23:01", "2026-11-09T00:30")
    assert actions(r) == []

    r = rules()
    a_night(r)
    for n in range(MAX_RESTARTS + 1):
        stop = t("2026-11-09T07:00") + timedelta(hours=n)
        r.tracking_event("stopped", stop)
        ticks(r, stop.isoformat()[:16], (stop + timedelta(minutes=30)).isoformat()[:16])
        r.tracking_event("started", stop + timedelta(minutes=30))
    assert [a[0] for a in actions(r) if a[0] == "start_tracking"] == ["start_tracking"] * MAX_RESTARTS

    r = rules(start_tracking=None)
    a_night(r)
    r.tracking_event("stopped", t("2026-11-09T07:00"))
    ticks(r, "2026-11-09T07:01", "2026-11-09T08:00")
    assert actions(r) == []


def test_stop_on_the_notification():
    r = rules()
    a_night(r)
    r.tracking_event("stopped", t("2026-11-09T07:00"))
    ticks(r, "2026-11-09T07:01", "2026-11-09T07:16")
    actions(r)
    r.tracking_event("started", t("2026-11-09T07:16"))
    changes(r)
    actions(r)
    r.stop_from_notification(t("2026-11-09T07:20"))
    assert changes(r) == [("awake", "07:20", "stopped sleep tracking")]
    assert actions(r) == [("stop_tracking", "07:20", None)]
    r.tracking_event("stopped", t("2026-11-09T07:20"))
    ticks(r, "2026-11-09T07:21", "2026-11-09T08:30")
    assert actions(r) == []  # no more this morning


def test_tracking_you_started_yourself_still_holds_back_waking():
    r = rules()
    a_night(r)
    r.tracking_event("stopped", t("2026-11-09T07:00"))
    r.tracking_event("started", t("2026-11-09T07:05"))  # by hand: not asked for
    changes(r)
    r.sign("Dishwasher: open", t("2026-11-09T07:30"), t("2026-11-09T07:30"))
    assert changes(r) == [] and actions(r) == []


def test_remembered_across_a_restart():
    r = rules()
    a_night(r)
    r.alarm_event("snooze_clicked", t("2026-11-10T08:01"))
    r.tracking_event("stopped", t("2026-11-10T08:10"))
    r2 = rules()
    r2.restore(r.memory())
    r2.charging_since = r.charging_since
    assert r2.snoozed_at == r.snoozed_at and r2.woke_at == r.woke_at and r2.restarts == 0
    ticks(r2, "2026-11-10T08:11", "2026-11-10T08:12")
    assert actions(r2) == [("start_tracking", "08:11", "08:10")]
    r3 = rules()
    r3.restore(r2.memory())
    assert r3.restarts == 1 and r3.restart_asked == r2.restart_asked


# ----- inside Home Assistant -----

async def test_the_switch_starts_and_stops_tracking(hass: HomeAssistant, aioclient_mock, freezer):
    freezer.move_to("2026-11-08T21:00:00+00:00")  # 8am in Melbourne
    await hass.config.async_set_time_zone("Australia/Melbourne")
    scripts = async_mock_service(hass, "script", "turn_on")
    notes = async_mock_service(hass, "notify", "mobile_app_s26u")
    me = {**person(), "delivery": {"devices": ["mobile_app_s26u"]}}
    hass.states.async_set("binary_sensor.phone_is_charging", "on")
    hass.states.async_set("binary_sensor.phone_device_locked", "on")
    hass.states.async_set("light.bedroom", "on")
    hass.states.async_set("event.sleep_tracking", "2026-11-08T17:58:00", {"event_type": "started"})
    hass.states.async_set("event.alarm_clock", "2026-11-07T21:00:00", {"event_type": "alert_dismiss"})
    opts = {"people": {"u1": {k: SETUP[k] for k in ("sleep_tracking", "alarm", "charging", "phone_locked", "lights",
                                                    "start_tracking", "stop_tracking")}}}
    await setup(hass, aioclient_mock, me, options=opts)
    aioclient_mock.post(f"{URL}/api/integration/wake", json=me)
    aioclient_mock.post(f"{URL}/api/integration/asleep", json=me)
    sw = "switch.wellbeing_matthew_poppell_awake"
    freezer.tick(timedelta(minutes=19))  # 8:19: the alarm's dismissed and tracking stops
    hass.states.async_set("event.alarm_clock", "2026-11-08T21:19:17", {"event_type": "alert_dismiss"})
    hass.states.async_set("event.sleep_tracking", "2026-11-08T21:19:17", {"event_type": "stopped"})
    await hass.async_block_till_done()
    await hass.services.async_call("switch", "turn_on", {"entity_id": sw}, blocking=True)  # up, for now
    assert hass.states.get(sw).state == "on"
    for _ in range(16):  # quiet: still locked and on charge
        freezer.tick(timedelta(minutes=1))
        async_fire_time_changed(hass, dt_util.utcnow())
        await hass.async_block_till_done()
    assert [c.data["entity_id"] for c in scripts] == ["script.start_sleep_tracking"]
    assert len(notes) == 1 and notes[0].data["title"] == "Back to sleep?"
    action = notes[0].data["data"]["actions"][0]["action"]
    freezer.tick(timedelta(seconds=30))
    hass.states.async_set("event.sleep_tracking", dt_util.utcnow().isoformat(), {"event_type": "started"})
    await hass.async_block_till_done()
    assert hass.states.get(sw).state == "off"
    assert hass.states.get(sw).attributes["how"] == "sleep tracking started again"
    assert any(str(c[1]).endswith("/asleep") for c in aioclient_mock.mock_calls)
    hass.bus.async_fire("mobile_app_notification_action", {"action": action})
    await hass.async_block_till_done()
    assert hass.states.get(sw).state == "on"
    assert [c.data["entity_id"] for c in scripts][-1] == "script.stop_sleep_tracking"
