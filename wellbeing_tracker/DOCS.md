# Wellbeing Tracker

Track mood, energy, symptoms, medications, sleep and other factors for everyone in your home.

## Using it

Open **Wellbeing** in the Home Assistant sidebar (or the Companion app menu). Each person sees only their own log, based on the Home Assistant user they're signed in as.

Tapping outside a sheet you've changed asks whether to save first.

The Check-in screen is a dashboard of sections, each a card you can open or close. Everything saves the moment you tap it. The bar under the date shows how many questions you've answered today (medications, notes and yes/no habits aren't counted, because leaving them blank is a normal answer).

- **Other days**: use the arrows or swipe left and right. A banner shows which day you're changing, with **Back to today**.
- **Yesterday's answer** is shown under anything you haven't answered yet, and each section's ••• menu has **Copy yesterday's answers** and **Hide this section**.
- **Deleting** something happens straight away, with **Undo** in the message at the bottom.

- **Ratings like Mood**: tap **+** to pick a number, at the time shown (tap the time to change it). Tap a logged one to change or delete it.
- **Symptoms**: tap a level. Tap the minus under the name to clear it.
- **Habits**: tap a chip to say you did it today, or **+** to add one to that section.
- **Counts like Water**: use − and +.

### Arranging your dashboard

Tap the pencil at the top of Check-in to edit it, much like a Home Assistant dashboard. You can move sections up and down, rename them, hide them, or add a new one. For anything in a section you can move it, edit it, send it to another section, or hide it. Tap **Done** when you're finished. Each section's ••• menu has shortcuts too.

## Meds/Supplements

Each medication shows its usual strength and how many you usually take ("1 dose", "2 tablets"). Doses taken today appear as squares with their time, with the day's total on the right.

- Today's reminders show under each medication ("½ dose at 7pm ✓", "1 dose at 10pm"). Tap one that's still to come to log exactly that amount, or tap the bell to change the reminders.
- Tap **+** to log a dose: set how many (×1, ×1.5 and so on), change the strength or time if needed, then **Confirm**.
- **Skip** on the Due now card offers one-tap reasons (Felt fine, Side effects, Ran out…), or skip without one.
- Tap a logged dose to change it or delete it. Reminders timed from that dose move with it.
- **Groups**: make a group such as Morning or Sleep and tap it to log everything in it at once (with Undo).
- **Copy last**: logs the same doses as the last day you logged any, at the same times (only times that have already passed today).

## Medication reminders

Reminders are off until you switch them on for a medication.

1. **Settings → Reminders → Devices and alerts → Change**: tick where your reminders should go, and tap **Send a test**. Phones signed in to the Home Assistant Companion app get **Taken**, **Snooze** and **Skip** buttons. Anything else Home Assistant can notify (a notify entity, Telegram, a TV, Home Assistant's own notification bell) gets the message with "Open Wellbeing to answer".
2. **Settings → Meds/Supplements**: tap the bell next to a medication, turn on **Remind me**, and pick the times and days.

### A different amount at each time

Under **Times and amounts**, each time has its own **How many**. For example, Clonidine:

- **7:00pm**: 0.5 (half a dose, = 50 mcg)
- **10:00pm**: 1

The notification says how much to take ("Clonidine ½ dose (50 mcg)"), tapping **Taken** logs that amount, and the Meds/Supplements section on Check-in shows the day's plan under each medication ("½ dose at 7pm ✓ · 1 dose at 10pm"). Tap that line to change it.

Each reminder has **Taken**, **Snooze** and **Skip** buttons. Answering on one phone clears it on the others. You can also answer from the **Due now** card on the Check-in screen, by logging the medication there, or by switching on a linked Home Assistant toggle. Logging a dose shortly before its time means the reminder never goes off.

**Send me a test** in a medication's reminders sends one example to your devices, exactly as it will look (its buttons don't log anything).

### Supply, refills and when to see your doctor

Tap a medication's name on Check-in, then **Set up**:

- **How many do you have now?** Each dose you log comes off what's left.
- **How many a day?** Starts from your reminder times and amounts. Change it to match your script.
- **How many in a refill?**
- **Your script**: repeats left, when the script ends, the last refill, and **Refill again after** (for medicines that can't be refilled too soon).
- **Warn me** X days before you run out, and X days before you need a new script.

The medication's sheet shows "About 28 days left", when it runs out, repeats left and **New script needed by**, with a small **Refill** button. A new script is needed when your supply plus the repeats left would run out, or when the script ends, whichever comes first.

**Settings → Supply and scripts** puts it together: "See your doctor by 4 Nov for a new Vyvanse script. Then Clonidine by 12 Dec." Use it to plan your next appointment.

Check-in shows one warning under a medication, only when something needs doing. Warnings are also sent to your devices once (between 9am and 8pm) and fire a `wellbeing_tracker_reminder` event with `type: supply` and `stage` set to `low`, `out` or `script`.

### Notifications in the app

The bell at the top of Check-in shows how many reminders are waiting. Tap it to see them with the same words and buttons as on your phone. Answering in either place clears both.

### Pausing and checking reminders

- **Settings → Reminders → Pause reminders**: for an hour, until tomorrow morning, a few days, a week or a time you choose. Nothing is sent to phones or speakers until then, but doses still show in the app, and anything still due comes back afterwards. Check-in shows a banner with **Resume**.
- **Settings → Reminders → Today's reminders** lists every medication and check-in reminder for today in time order, with what's been taken.

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

### Devices and alerts (per person)

Combine medications due at the same time into one reminder, offer **Undo** for a minute after answering, allow swiping reminders away, snooze length, quiet hours (no alarm sounds or announcements), and which speakers and voice to use for announcements, optionally only when you're home.

## Check-in reminders

**Settings → Reminders → Check-in reminders** sends a nudge to fill in your check-in at the times and days you choose. The notification can either have quick mood answers (**Good**, **Okay**, **Bad**, which log your mood straight away) or **Snooze** and **Not now**. Saving a check-in in the app clears it, and you can skip the reminder if you checked in recently. Unanswered check-in reminders remove themselves after the time you choose.

## Water reminders

Give **Water** (or any count or amount you track) a **daily goal** in Settings, then turn on **Settings → Reminders → Water reminders**. You'll get a nudge when you haven't logged any water for the time you choose, between the hours you choose, with buttons to log one or two drinks straight from the notification. Reminders stop once you reach your goal.

## Filling things in from Home Assistant

Steps, sleep, weight, heart rate and anything else Home Assistant already knows can fill in your tracking for you. Edit a count, an amount or Sleep, open **Fill in from Home Assistant**, search for the sensor, and choose which reading counts for the day:

- **The latest reading**: weight, last night's sleep
- **The highest that day**: totals that reset at midnight, like steps
- **The average that day**: heart rate

Linking fills in the last 30 days from Home Assistant's history, then keeps up every 15 minutes. Values filled in this way say "from Home Assistant" on Check-in. Anything you enter or correct yourself always wins and isn't overwritten.

Good sources: the Google Health integration (Fitbit, Pixel Watch and other devices that sync to Google), Health Connect sensors in the Home Assistant Companion app, Withings, and Sleep as Android.

## Dashboard card, entities and actions

The app installs a companion integration into Home Assistant for you. After installing or updating the app, restart Home Assistant, then go to **Settings → Devices & services → Add integration → Wellbeing Tracker** and confirm. There's nothing to type: the app has already given it its address and a private key.

**Dashboard card**: edit a dashboard, add a card and choose **Wellbeing** (or use `type: custom:wellbeing-card`). It shows:

- reminders waiting, with the same buttons as your phone
- today's medications (tap a dose that's due to log it)
- supply warnings and when to see your doctor
- today's mood

It shows whoever is looking at the dashboard. To always show one person, choose their "Reminders waiting" sensor in the card's settings.

**Entities**, for each person: *Reminders waiting*, *Next dose*, *Mood today*, *See the doctor by*. For each medication you count: *Supply left* (days) and *New script needed by*.

**Actions** for automations and scripts:

```yaml
action: wellbeing_tracker.log_dose
data:
  medication: Clonidine
  quantity: 0.5          # optional, the usual amount if left out
  person: Matthew Poppell  # optional when run by that person
```

```yaml
action: wellbeing_tracker.answer_reminder
data:
  reminder_id: 12        # from the Reminders waiting sensor
  answer: taken          # taken, snooze or skip
```

## Appearance

The app uses the same colours as your Home Assistant theme, including dark mode and custom themes, and changes when Home Assistant does. Times use the 12 or 24-hour clock set in your Home Assistant profile.

## Using reminders in your own automations

Every step fires a Home Assistant event, `wellbeing_tracker_reminder`, with:

| Field | Example |
| --- | --- |
| `type` | `medication`, `checkin`, `hydration` or `supply` |
| `stage` | `sent`, `repeated`, `escalated`, `last_call`, `snoozed`, `taken`, `skipped`, `undone`, `missed`; for check-ins also `checked_in` and `expired` |
| `person` | `Matthew Poppell` |
| `user_id` | the Home Assistant user id |
| `medications` | `["Vyvanse"]` (empty for check-ins) |
| `due` | `07:00` |
| `reminder_id` | `12` |
| `paused` | `true` while reminders are paused, so your automations can stay quiet too |

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
