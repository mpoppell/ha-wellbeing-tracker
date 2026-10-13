# Wellbeing Tracker

Track mood, energy, symptoms, medications, sleep and other factors for everyone in your home.

## Using it

Open **Wellbeing** in the Home Assistant sidebar (or the Companion app menu). Each person sees only their own log, based on the Home Assistant user they're signed in as.

## Medication reminders

Reminders are off until you switch them on for a medication.

1. **Settings → Notifications → Phones and alerts → Change**: tick the phones that should get your reminders (any phone signed in to the Home Assistant Companion app) and tap **Send a test**.
2. **Settings → Medications**: tap the bell next to a medication, turn on **Remind me**, and pick the times and days.

Each reminder has **Taken**, **Snooze** and **Skip** buttons. Answering on one phone clears it on the others. You can also answer from the **Due now** card on the Check-in screen, by logging the medication there, or by switching on a linked Home Assistant toggle. Logging a dose shortly before its time means the reminder never goes off.

### Timing one medication from another

In a medication's reminders, choose **When → After another dose** to time it from when you actually take something, instead of fixed clock times. For example, for Dex:

- **7** hours after I take **Vyvanse**
- **3** hours after I take **Dex (this one)**
- Stop after **2** reminders a day

Taking Vyvanse at 7:04 schedules Dex for 2:04. Taking that Dex at 2:10 schedules the next one for 5:10, and the chain stops at the daily limit or the latest time. It counts however you record a dose: the Taken button, the Check-in screen, or a linked toggle. Undoing the earlier dose removes the follow-up.

### Optional extras, per medication

- **If I don't answer**: don't remind me again, remind me gently (every 30 minutes), firmly (every 10 minutes), or choose my own.
- **Set a latest time**: after it, reminders stop and you get one "skip today, or take it anyway?" question.
- **Get louder if I don't answer**: from the reminder you choose, ring like an alarm (through Do Not Disturb) and/or announce it on speakers.
- **Already taken it before the reminder?**: how early a logged dose still counts.
- **Link to Home Assistant**: keep an `input_boolean` in sync with "taken", and set an `input_datetime` to the time taken.

### Phones and alerts (per person)

Combine medications due at the same time into one reminder, offer **Undo** for a minute after answering, allow swiping reminders away, snooze length, quiet hours (no alarm sounds or announcements), and which speakers and voice to use for announcements, optionally only when you're home.

## Check-in reminders

**Settings → Notifications → Check-in reminders** sends a nudge to fill in your check-in at the times and days you choose. The notification can either have quick mood answers (**Good**, **Okay**, **Bad**, which log your mood straight away) or **Snooze** and **Not now**. Saving a check-in in the app clears it, and you can skip the reminder if you checked in recently. Unanswered check-in reminders remove themselves after the time you choose.

## Using reminders in your own automations

Every step fires a Home Assistant event, `wellbeing_tracker_reminder`, with:

| Field | Example |
| --- | --- |
| `type` | `medication` or `checkin` |
| `stage` | `sent`, `repeated`, `escalated`, `last_call`, `snoozed`, `taken`, `skipped`, `undone`, `missed`; for check-ins also `checked_in` and `expired` |
| `person` | `Matthew Poppell` |
| `user_id` | the Home Assistant user id |
| `medications` | `["Vyvanse"]` (empty for check-ins) |
| `due` | `07:00` |
| `reminder_id` | `12` |

For example, flash a light when a reminder escalates:

```yaml
triggers:
  - trigger: event
    event_type: wellbeing_tracker_reminder
    event_data:
      stage: escalated
actions:
  - action: light.turn_on
    target:
      entity_id: light.lounge_lights
    data:
      flash: long
```

## Your data

Everything is stored in a SQLite database inside this app's data folder. It never leaves your Home Assistant, and it's included in Home Assistant backups.

## Options

- **log_level**: how much detail the app writes to its log (`debug`, `info`, `warning` or `error`).
