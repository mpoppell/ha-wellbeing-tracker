"""The Awake switch: its rules on their own, then the switch inside Home Assistant."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from custom_components.wellbeing_tracker.wake import Rules, counts_as_sign, settings

from test_wellbeing import URL, person, setup

TZ = ZoneInfo("Australia/Melbourne")
FULL = {"sleep_tracking": "event.sleep_tracking", "charging": "binary_sensor.phone_is_charging",
        "phone_locked": "binary_sensor.phone_device_locked", "activity": "sensor.phone_detected_activity",
        "person": "person.pops", "lights": ["light.bedroom"], "signs": ["sensor.dishwasher_door"],
        "keep_awake": ["switch.mados"]}


def t(local: str) -> datetime:
    return datetime.fromisoformat(local).replace(tzinfo=TZ)


def rules(**over) -> Rules:
    return Rules(settings({**FULL, **over}), TZ)


def changes(r: Rules) -> list[tuple[str, str, str]]:
    out = [("awake" if c.awake else "asleep", c.at.astimezone(TZ).strftime("%H:%M"), c.source) for c in r.pending]
    r.pending.clear()
    return out


# ----- the rules -----

def test_asleep_when_tracking_starts_and_up_when_off_charge():
    r = rules()
    r.charging_changed(True, t("2026-10-23T00:12"), t("2026-10-23T00:12"))
    r.tracking_event("started", t("2026-10-23T00:19"))
    assert changes(r) == [("asleep", "00:19", "sleep tracking started")]
    r.tracking_event("stopped", t("2026-10-23T05:30"))
    r.charging_changed(False, t("2026-10-23T05:47"), t("2026-10-23T05:47"))
    assert changes(r) == [("awake", "05:47", "phone off charger")]


def test_a_fresh_unlock_kept_for_ten_minutes_counts_from_the_unlock():
    r = rules()
    r.tracking_event("started", t("2026-10-23T00:19"))
    r.tracking_event("stopped", t("2026-10-23T05:30"))
    changes(r)
    r.lock_changed(False, t("2026-10-23T05:31"))
    r.tick(t("2026-10-23T05:35"))
    assert changes(r) == []
    r.tick(t("2026-10-23T05:41"))
    assert changes(r) == [("awake", "05:31", "phone in use")]


def test_nothing_wakes_you_before_the_earliest_time_or_while_tracking():
    r = rules()
    r.tracking_event("started", t("2026-10-23T00:19"))
    changes(r)
    r.sign("Dishwasher: open", t("2026-10-23T03:00"), t("2026-10-23T03:00"))
    r.tracking_event("stopped", t("2026-10-23T03:10"))
    r.lock_changed(False, t("2026-10-23T03:11"))
    r.tick(t("2026-10-23T03:25"))  # in use, but before 4am: used up, doesn't count later
    r.tick(t("2026-10-23T04:30"))
    assert changes(r) == []
    r2 = rules()
    r2.tracking_event("started", t("2026-10-23T00:19"))
    changes(r2)
    r2.sign("Dishwasher: open", t("2026-10-23T06:00"), t("2026-10-23T06:00"))  # still tracking
    assert changes(r2) == []
    r2.charging_changed(True, t("2026-10-23T00:10"), t("2026-10-23T00:10"))
    r2.charging_changed(False, t("2026-10-23T06:05"), t("2026-10-23T06:05"))  # the charger overrides
    assert changes(r2) == [("awake", "06:05", "phone off charger")]


def test_a_top_up_isnt_a_night_on_charge():
    r = rules()
    r.tracking_event("started", t("2026-10-23T00:19"))
    r.tracking_event("stopped", t("2026-10-23T05:30"))
    changes(r)
    r.charging_changed(True, t("2026-10-23T05:00"), t("2026-10-23T05:00"))
    r.charging_changed(False, t("2026-10-23T05:40"), t("2026-10-23T05:40"))
    assert changes(r) == []


def test_bedtime_without_tracking_is_dated_to_when_it_went_quiet():
    r = rules()
    r.home = True
    r.charging_changed(True, t("2026-10-22T23:50"), t("2026-10-22T23:50"))
    r.lights_changed(True, t("2026-10-23T00:05"))
    r.tick(t("2026-10-23T00:20"))
    assert changes(r) == []
    r.tick(t("2026-10-23T00:36"))
    assert changes(r) == [("asleep", "00:05", "phone on charge and lights off")]


def test_not_asleep_while_the_computer_is_on_or_away_or_in_the_day():
    r = rules()
    r.home = True
    r.busy_changed(True, t("2026-10-22T22:00"))
    r.charging_changed(True, t("2026-10-22T22:30"), t("2026-10-22T22:30"))
    r.lights_changed(True, t("2026-10-22T22:30"))
    r.tick(t("2026-10-23T00:30"))
    assert changes(r) == []
    r.busy_changed(False, t("2026-10-23T01:00"))
    r.tick(t("2026-10-23T01:20"))
    assert changes(r) == []
    r.tick(t("2026-10-23T01:31"))
    assert changes(r) == [("asleep", "01:00", "phone on charge and lights off")]
    day = rules()
    day.home = True
    day.charging_changed(True, t("2026-10-23T13:00"), t("2026-10-23T13:00"))
    day.lights_changed(True, t("2026-10-23T13:00"))
    day.tick(t("2026-10-23T15:00"))
    assert changes(day) == []


def test_a_nap_ends_with_any_sign_and_leaving_home_always_counts():
    r = rules()
    r.tracking_event("started", t("2026-10-23T14:00"))
    r.tracking_event("stopped", t("2026-10-23T15:00"))
    changes(r)
    r.activity_changed("walking", t("2026-10-23T15:05"), t("2026-10-23T15:05"))
    assert changes(r) == [("awake", "15:05", "walking")]
    night = rules()
    night.home = True
    night.tracking_event("started", t("2026-10-23T00:19"))
    changes(night)
    night.home_changed(False, t("2026-10-23T07:29"), t("2026-10-23T07:29"))
    assert changes(night) == [("awake", "07:29", "left home")]


def test_remembered_across_a_restart():
    r = rules()
    r.charging_changed(True, t("2026-10-23T00:12"), t("2026-10-23T00:12"))
    r.tracking_event("started", t("2026-10-23T00:19"))
    again = rules()
    again.restore(r.memory())
    assert again.charging_since == t("2026-10-23T00:12") and again.tracking == "started"


def test_what_counts_as_a_sign():
    assert counts_as_sign("open", None, "closed")
    assert counts_as_sign("SessionUnlock", None, "SessionLock")
    assert counts_as_sign("SessionUnlock", None, "unavailable")  # the computer woke up and was unlocked
    assert not counts_as_sign("closed", None, "open")
    assert not counts_as_sign("open", None, "open")
    assert counts_as_sign("884.5", "W", "0.8")
    assert not counts_as_sign("900", "W", "880")  # already on
    assert not counts_as_sign("unavailable", None, "on")


# ----- inside Home Assistant -----

async def test_configure_suggests_the_phone_and_saves(hass: HomeAssistant, aioclient_mock):
    hass.states.async_set("binary_sensor.my_phone_s26u_is_charging", "off")
    hass.states.async_set("binary_sensor.doorbell_charging", "off")
    hass.states.async_set("binary_sensor.my_phone_s26u_device_locked", "on")
    hass.states.async_set("event.sleep_as_android_sleep_tracking_2", "unknown")
    hass.states.async_set("light.bedroom_light_ceiling", "off")
    entry = await setup(hass, aioclient_mock)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] == "form" and result["step_id"] == "person"
    schema = {str(k): k for k in result["data_schema"].schema}
    assert schema["charging"].description["suggested_value"] == "binary_sensor.my_phone_s26u_is_charging"
    assert schema["sleep_tracking"].description["suggested_value"] == "event.sleep_as_android_sleep_tracking_2"
    assert schema["lights"].description["suggested_value"] == ["light.bedroom_light_ceiling"]
    result = await hass.config_entries.options.async_configure(result["flow_id"], {
        "charging": "binary_sensor.my_phone_s26u_is_charging", "sleep_tracking": "event.sleep_as_android_sleep_tracking_2",
        "earliest": "04:00:00", "bedtime_after": "20:00:00", "night_charge_hours": 3, "in_use_minutes": 10,
        "quiet_minutes": 30})
    assert result["type"] == "create_entry"
    await hass.async_block_till_done()
    assert entry.options["people"]["u1"]["charging"] == "binary_sensor.my_phone_s26u_is_charging"
    # the reloaded switch tells the app it decides now
    calls = [c for c in aioclient_mock.mock_calls if str(c[1]).endswith("/wake_source")]
    assert calls[-1][2] == {"user_id": "u1", "entity_id": "switch.wellbeing_matthew_poppell_awake"}


async def test_the_switch_follows_the_phone_and_tells_the_app(hass: HomeAssistant, aioclient_mock, freezer):
    freezer.move_to("2026-10-22T13:00:00+00:00")  # midnight in Melbourne
    await hass.config.async_set_time_zone("Australia/Melbourne")
    hass.states.async_set("binary_sensor.phone_is_charging", "off")
    hass.states.async_set("event.sleep_tracking", "2026-10-21T19:00:00", {"event_type": "stopped"})
    opts = {"people": {"u1": {"charging": "binary_sensor.phone_is_charging", "sleep_tracking": "event.sleep_tracking"}}}
    await setup(hass, aioclient_mock, options=opts)
    aioclient_mock.post(f"{URL}/api/integration/wake", json=person())
    sw = "switch.wellbeing_matthew_poppell_awake"
    assert hass.states.get(sw).state == "on"
    freezer.tick(timedelta(minutes=5))  # past the settling-in after a restart
    hass.states.async_set("binary_sensor.phone_is_charging", "on")
    freezer.tick(timedelta(minutes=7))
    hass.states.async_set("event.sleep_tracking", "2026-10-22T13:12:00", {"event_type": "started"})
    await hass.async_block_till_done()
    assert hass.states.get(sw).state == "off"
    assert hass.states.get(sw).attributes["how"] == "sleep tracking started"
    freezer.tick(timedelta(hours=5))  # 5:12am
    hass.states.async_set("event.sleep_tracking", "2026-10-22T18:12:00", {"event_type": "stopped"})
    freezer.tick(timedelta(minutes=10))
    hass.states.async_set("binary_sensor.phone_is_charging", "off")
    await hass.async_block_till_done()
    assert hass.states.get(sw).state == "on"
    assert hass.states.get(sw).attributes["how"] == "phone off charger"
    sent = [c for c in aioclient_mock.mock_calls if str(c[1]).endswith("/wake")][-1][2]
    assert sent["user_id"] == "u1" and sent["source"] == "phone off charger"
    assert dt_util.parse_datetime(sent["at"]) == dt_util.parse_datetime("2026-10-22T18:22:00+00:00")


async def test_flip_it_by_hand(hass: HomeAssistant, aioclient_mock):
    await setup(hass, aioclient_mock)
    aioclient_mock.post(f"{URL}/api/integration/wake", json=person())
    sw = "switch.wellbeing_matthew_poppell_awake"
    await hass.services.async_call("switch", "turn_off", {"entity_id": sw}, blocking=True)
    assert hass.states.get(sw).state == "off" and hass.states.get(sw).attributes["how"] == "manual"
    await hass.services.async_call("switch", "turn_on", {"entity_id": sw}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get(sw).state == "on"
    assert any(str(c[1]).endswith("/wake") for c in aioclient_mock.mock_calls)
