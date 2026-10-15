"""The companion integration against a pretend Wellbeing Tracker app."""

from unittest.mock import patch

import pytest
from homeassistant import config_entries
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import ServiceValidationError, Unauthorized
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.wellbeing_tracker.const import CARD_URL, DOMAIN

URL = "http://882b0587-wellbeing-tracker:8099"
CONNECTION = {"url": URL, "token": "secret"}


def person(uid="u1", name="Matthew Poppell", inbox=None):
    return {
        "user_id": uid, "name": name,
        "inbox": inbox if inbox is not None else [
            {"id": 12, "kind": "dose", "title": "Time for Clonidine", "message": "Clonidine ½ dose (50 mcg)",
             "actions": [{"verb": "TAKEN", "label": "Taken", "reason": False},
                         {"verb": "SNOOZE", "label": "Snooze 15 min", "reason": False},
                         {"verb": "SKIP", "label": "Skip", "reason": True}]}],
        "doses": [{"dose_id": 1, "tracker_id": 18, "name": "Clonidine", "amount": "½ dose (50 mcg)", "quantity": 0.5,
                   "time": "19:00", "status": "due"}],
        "next_dose": {"at": "2026-10-15T19:00:00+11:00", "name": "Clonidine", "amount": "½ dose (50 mcg)", "status": "due"},
        "supply": [{"tracker_id": 18, "name": "Clonidine", "stock": 16, "word": "tablets", "days_left": 8,
                    "runs_out": "2026-10-23", "script_by": "2026-12-12", "script_by_text": "12 Dec",
                    "script_reason": "repeats run out", "repeats": 1, "refill_from": None,
                    "alerts": [{"kind": "low", "level": "warning", "text": "8 days left"}]}],
        "doctor": {"by": "2026-12-12", "by_text": "12 Dec", "names": ["Clonidine"]},
        "medications": [{"id": 18, "name": "Clonidine", "emoji": None, "usual": 1}],
        "mood": {"value": 8, "max": 10, "label": "Good", "at": "2026-10-15T09:00:00+11:00"},
        "mood_scale": {"tracker_id": 1, "min": 1, "max": 10, "labels": ["Awful", "Very bad", "Bad", "Poor", "Meh",
                                                                       "Okay", "Fine", "Good", "Very good", "Great"]},
    }


def overview(*people):
    return {"version": "0.13.0", "panel_path": "/882b0587_wellbeing_tracker", "people": list(people) or [person()]}


async def setup(hass, aioclient_mock, *people):
    aioclient_mock.get(f"{URL}/api/integration/overview", json=overview(*people))
    entry = MockConfigEntry(domain=DOMAIN, data=CONNECTION, unique_id=DOMAIN)
    entry.add_to_hass(hass)
    with patch("custom_components.wellbeing_tracker.read_connection", return_value=None):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry


async def test_one_click_setup(hass: HomeAssistant, aioclient_mock):
    aioclient_mock.get(f"{URL}/api/integration/overview", json=overview())
    with patch("custom_components.wellbeing_tracker.config_flow.read_connection", return_value=CONNECTION), \
         patch("custom_components.wellbeing_tracker.read_connection", return_value=None):
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        assert result["type"] == "form"
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
        assert result["type"] == "create_entry"
        assert result["data"] == CONNECTION
        await hass.async_block_till_done()
    # every request carries the key
    assert all(call[3]["Authorization"] == "Bearer secret" for call in aioclient_mock.mock_calls)


async def test_setup_needs_the_app(hass: HomeAssistant):
    with patch("custom_components.wellbeing_tracker.config_flow.read_connection", return_value=None):
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] == "abort" and result["reason"] == "no_app"


async def test_entities(hass: HomeAssistant, aioclient_mock):
    await setup(hass, aioclient_mock)
    waiting = hass.states.get("sensor.wellbeing_matthew_poppell_reminders_waiting")
    assert waiting.state == "1"
    assert waiting.attributes["wellbeing_card"] is True and waiting.attributes["user_id"] == "u1"
    assert waiting.attributes["inbox"][0]["title"] == "Time for Clonidine"
    assert hass.states.get("sensor.wellbeing_matthew_poppell_next_dose").state == "2026-10-15T08:00:00+00:00"
    assert hass.states.get("sensor.wellbeing_matthew_poppell_mood_today").state == "8"
    assert hass.states.get("sensor.wellbeing_matthew_poppell_see_the_doctor_by").state == "2026-12-12"
    supply = hass.states.get("sensor.clonidine_supply_left")
    assert supply.state == "8" and supply.attributes["left"] == 16
    assert hass.states.get("sensor.clonidine_new_script_needed_by").state == "2026-12-12"


async def test_answering_and_logging(hass: HomeAssistant, aioclient_mock, hass_admin_user):
    await setup(hass, aioclient_mock)
    aioclient_mock.post(f"{URL}/api/integration/answer", json=person(inbox=[]))
    await hass.services.async_call(DOMAIN, "answer_reminder", {"reminder_id": 12, "answer": "taken"}, blocking=True)
    call = aioclient_mock.mock_calls[-1]
    assert call[2] == {"user_id": "u1", "reminder_id": 12, "answer": "taken", "reason": None}
    await hass.async_block_till_done()
    assert hass.states.get("sensor.wellbeing_matthew_poppell_reminders_waiting").state == "0"

    aioclient_mock.post(f"{URL}/api/integration/log_dose", json=person(inbox=[]))
    await hass.services.async_call(DOMAIN, "log_dose", {"medication": "Clonidine", "quantity": 0.5}, blocking=True)
    assert aioclient_mock.mock_calls[-1][2] == {"user_id": "u1", "medication": "Clonidine", "quantity": 0.5}


async def test_people_only_answer_their_own(hass: HomeAssistant, aioclient_mock, hass_read_only_user):
    await setup(hass, aioclient_mock, person(), person("u2", "Kayla", inbox=[]))
    with pytest.raises(Unauthorized):
        await hass.services.async_call(DOMAIN, "answer_reminder", {"reminder_id": 12, "answer": "taken"},
                                       blocking=True, context=Context(user_id=hass_read_only_user.id))
    with pytest.raises(ServiceValidationError):  # two people and no one named: which one?
        await hass.services.async_call(DOMAIN, "log_dose", {"medication": "Clonidine"}, blocking=True)


async def test_card_is_served_and_loaded_everywhere(hass: HomeAssistant, aioclient_mock, hass_client):
    await setup(hass, aioclient_mock)
    assert await async_setup_component(hass, "frontend", {})
    client = await hass_client()
    resp = await client.get(CARD_URL)
    assert resp.status == 200
    assert "customElements.define(\"wellbeing-card\"" in await resp.text()
    from homeassistant.components.frontend import DATA_EXTRA_JS_URL_ES5, DATA_EXTRA_MODULE_URL  # noqa: F401
    urls = hass.data[DATA_EXTRA_MODULE_URL].urls
    assert any(u.startswith(CARD_URL) for u in urls)



async def test_bubble_friendly_entities(hass: HomeAssistant, aioclient_mock):
    await setup(hass, aioclient_mock)
    button = hass.states.get("button.clonidine_log_dose")
    assert button.attributes["due"] is True and button.attributes["next_amount"] == "½ dose (50 mcg)"
    aioclient_mock.post(f"{URL}/api/integration/log_dose", json=person(inbox=[]))
    await hass.services.async_call("button", "press", {"entity_id": "button.clonidine_log_dose"}, blocking=True)
    assert aioclient_mock.mock_calls[-1][2] == {"user_id": "u1", "medication": "18", "quantity": 0.5}

    mood = hass.states.get("select.wellbeing_matthew_poppell_mood")
    assert mood.state == "8 Good"
    assert mood.attributes["options"][0] == "10 Great" and len(mood.attributes["options"]) == 10
    aioclient_mock.post(f"{URL}/api/integration/log", json=person(inbox=[]))
    await hass.services.async_call("select", "select_option",
                                   {"entity_id": "select.wellbeing_matthew_poppell_mood", "option": "6 Okay"}, blocking=True)
    assert aioclient_mock.mock_calls[-1][2] == {"user_id": "u1", "item": "mood", "value": 6}

    await hass.services.async_call(DOMAIN, "log", {"item": "Energy", "value": 7}, blocking=True)
    assert aioclient_mock.mock_calls[-1][2] == {"user_id": "u1", "item": "Energy", "value": 7.0}
