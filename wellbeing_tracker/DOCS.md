# Wellbeing Tracker

Track mood, energy, symptoms, medications, sleep and other factors for everyone in your home.

## Using it

Open **Wellbeing** in the Home Assistant sidebar (or the Companion app menu). Each person sees only their own log, based on the Home Assistant user they're signed in as.

## Medication reminders

Reminders are off until you switch them on for a medication.

1. **Settings → Reminder settings → Change**: tick the phones that should get your reminders (any phone signed in to the Home Assistant Companion app) and tap **Send a test**.
2. **Settings → Medications**: tap the bell next to a medication, turn on **Remind me**, and pick the times and days.

Each reminder has **Taken**, **Snooze** and **Skip** buttons. Answering on one phone clears it on the others. You can also answer from the **Due now** card on the Check-in screen, by logging the medication there, or by switching on a linked Home Assistant toggle. Logging a dose shortly before its time means the reminder never goes off.

### Optional extras, per medication

- **Until I answer**: once only, gently (every 30 minutes), firmly (every 10 minutes) or your own pattern.
- **Latest time**: after it, nagging stops and you get one "skip today, or take it anyway?" question.
- **Make it hard to miss**: from the reminder number you choose, ring like an alarm (through Do Not Disturb) and/or announce it on speakers.
- **Home Assistant link**: keep an `input_boolean` in sync with "taken", set an `input_datetime` to the time taken, and choose how early a logged dose still counts.

### Optional extras, per person

Combine medications due at the same time into one reminder, offer **Undo** for a minute after answering, allow swiping reminders away, snooze length, quiet hours (no alarm sounds or announcements), and which speakers and voice to use for announcements, optionally only when you're home.

### Using reminders in your own automations

Every step fires a Home Assistant event, `wellbeing_tracker_reminder`, with:

| Field | Example |
| --- | --- |
| `stage` | `sent`, `repeated`, `escalated`, `last_call`, `snoozed`, `taken`, `skipped`, `undone`, `missed` |
| `person` | `Matthew Poppell` |
| `user_id` | the Home Assistant user id |
| `medications` | `["Vyvanse"]` |
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
