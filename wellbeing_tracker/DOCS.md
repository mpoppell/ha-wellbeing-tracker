# Wellbeing Tracker

Track mood, energy, symptoms, medications, sleep and other factors for everyone in your home.

## Using it

Open **Wellbeing** in the Home Assistant sidebar (or the Companion app menu). Each person sees only their own log, based on the Home Assistant user they're signed in as.

The Check-in screen is a dashboard of sections, each a card you can open or close. Everything saves the moment you tap it.

- **Ratings like Mood**: tap **+** to pick a number, at the time shown (tap the time to change it). Tap a logged one to change or delete it.
- **Symptoms**: tap a level. Tap the minus under the name to clear it.
- **Habits**: tap a chip to say you did it today, or **+** to add one to that section.
- **Counts like Water**: use − and +.

### Arranging your dashboard

Tap the pencil at the top of Check-in to edit it, much like a Home Assistant dashboard. You can move sections up and down, rename them, hide them, or add a new one. For anything in a section you can move it, edit it, send it to another section, or hide it. Tap **Done** when you're finished. Each section's ••• menu has shortcuts too.

## Meds/Supplements

Each medication shows its usual strength and how many you usually take ("1 dose", "2 tablets"). Doses taken today appear as squares with their time, with the day's total on the right.

- Tap **+** to log a dose: set how many (×1, ×1.5 and so on), change the strength or time if needed, then **Confirm**.
- Tap a logged dose to change it or delete it. Reminders timed from that dose move with it.
- **Groups**: make a group such as Morning or Sleep and tap it to log everything in it at once (with Undo).
- **Copy last**: logs the same doses as the last day you logged any, at the same times (only times that have already passed today).

## Medication reminders

Reminders are off until you switch them on for a medication.

1. **Settings → Notifications → Phones and alerts → Change**: tick the phones that should get your reminders (any phone signed in to the Home Assistant Companion app) and tap **Send a test**.
2. **Settings → Meds/Supplements**: tap the bell next to a medication, turn on **Remind me**, and pick the times and days.

### A different amount at each time

Under **Times and amounts**, each time has its own **How many**. For example, Clonidine:

- **7:00pm**: 0.5 (half a dose, = 50 mcg)
- **10:00pm**: 1

The notification says how much to take ("Clonidine ½ dose (50 mcg)"), tapping **Taken** logs that amount, and the Meds/Supplements section on Check-in shows the day's plan under each medication ("½ dose at 7pm ✓ · 1 dose at 10pm"). Tap that line to change it.

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

## Water reminders

Give **Water** (or any count or amount you track) a **daily goal** in Settings, then turn on **Settings → Notifications → Water reminders**. You'll get a nudge when you haven't logged any water for the time you choose, between the hours you choose, with buttons to log one or two drinks straight from the notification. Reminders stop once you reach your goal.

## Appearance

The app uses the same colours as your Home Assistant theme, including dark mode and custom themes, and changes when Home Assistant does.

## Using reminders in your own automations

Every step fires a Home Assistant event, `wellbeing_tracker_reminder`, with:

| Field | Example |
| --- | --- |
| `type` | `medication`, `checkin` or `hydration` |
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
