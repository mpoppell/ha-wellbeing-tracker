# Wellbeing Tracker – Feature Plan

Baseline: the Bearable app, rebuilt as a Home Assistant app with a separate private log for each HA user.
This plan guides every build stage. Update it when decisions change.

## Decisions so far

- **Devices:** Android only (HA Companion app). Notifications are designed around Android's limits and features.
- **Users:** Multiple people. Each HA user gets their own trackers, data, devices and reminders. Nobody sees anyone else's data.
- **Delivery:** GitHub repo, installed through the HA app store.
- **Escalation:** Built-in options (repeat, louder Android channel, speaker announcement) **and** HA events/entities at every step, so any HA automation can react.
- **No partner/carer alerts** built in. (Possible through the HA events if ever wanted.)
- **Two main screens:** **Check-in** (answer everything due) and **History** (timeline, calendar, charts). A third **Settings** screen customises trackers, meds, devices and reminders.

## App structure

| Screen | Purpose |
| --- | --- |
| **Check-in** (default) | One scrolling page with every question for right now: mood, emotions, energy, symptoms, medications due or taken, factors, sleep, note. Once-per-day items show today's answer and can be changed. Saving logs everything in one go. Reminder notifications deep-link here. |
| **History** | Day-by-day timeline, then a calendar view and charts (overlay any trackers), weekly summary and insights as later stages land. Export lives here. |
| **Settings** | Add, rename, group, hide and reorder trackers; medication list and schedules; which phones get reminders; quiet hours; escalation options. |

## Trackers (Bearable baseline)

| Area | Bearable | Our version | Stage |
| --- | --- | --- | --- |
| Mood | Rating plus custom emotions | 1–5 rating, logged as often as you like, plus a custom emotions picker | 2 |
| Energy and wellbeing | Energy, stress, focus etc. | Energy built in; others as custom rating trackers | 2 |
| Symptoms | Custom, grouped, severity | None / mild / moderate / severe, custom groups | 2 |
| Medications | Logging plus reminders | Med list (dose, unit, notes) in stage 2; schedules, reminder engine, pill count and refill warnings in stage 3 | 2–3 |
| Sleep | Quality, duration, factors | Manual hours and quality in stage 2; imported from Sleep as Android in stage 4 | 2, 4 |
| Factors and habits | Yes/no and count factors, weather | Custom yes/no, count and amount factors; weather captured from HA | 2, 4 |
| Nutrition and hydration | Meals, water | Water count and simple meal tags (no calories by default) | 2 |
| Health measurements | Apple Health / Google Fit | Any HA sensor you pick (steps, heart rate, weight…) | 4 |
| Journal | Daily notes | Note on any check-in plus a daily journal | 2 |
| Cycle tracking | Yes | Optional tracker, off by default | 7 |
| Calendar, timeline, graphs | Yes | History screen | 2 (timeline), 5 (calendar, charts) |
| Insights and reports | Correlations, factor effects, 30+ reports | Weekly summary, correlations, experiments | 6 |
| Export | Reports for clinicians | CSV export and printable appointment summary | 5 |
| Privacy | PIN, export/delete | Per-person data, optional PIN, export or delete all my data, data never leaves HA | 5, 7 |
| Goals | Habit goals | Later | 7 |
| Community | Discord, shared experiments | Not planned | – |

## Reminder and check-in engine (stage 3, reused in stage 4)

Inspired by the "Advanced medication reminder" blueprint, but the logic lives in the app (state stored in its database), and HA only delivers notifications and passes back button presses.

### Schedules
- Any number of times per day; chosen weekdays; every N days; or "as needed" (no reminder).
- Each schedule belongs to one person and one tracker (a medication or a check-in).
- Quiet hours per person; medications can be allowed to break through.

### Notifications (Android)
- Sent to **every device the person has chosen**, all with the same `tag`.
- Answering on any device sends `clear_notification` with that tag to all the others, so the reminder disappears everywhere.
- Max 3 buttons on Android:
  - Medication: **Taken**, **Snooze**, **Skip**. Skip offers a reply box for a reason.
  - Mood check-in: **Good**, **Okay**, **Rough**, plus tapping the notification opens Check-in for the full picture.
- Own notification channels ("Medication reminders", "Check-ins", "Escalated reminders") so each can have its own sound and importance in Android settings.
- `persistent` for medications (can't be swiped away until answered); high priority and `ttl: 0` for prompt delivery.
- Answering anywhere counts: a notification button, the Check-in screen, an NFC tag on the pill bottle, or an existing HA toggle (e.g. "Vyvanse - Taken"). All of them clear the notifications.

### Escalation (each step optional, per reminder)
1. Repeat every N minutes until answered, up to a limit.
2. After X repeats, switch to the "Escalated" channel, optionally using Android's alarm stream so it sounds through Do Not Disturb.
3. Speaker announcement on chosen media players, optionally only when the person is home.
4. After a cutoff, mark the dose or check-in as **missed** and stop.

### HA triggers
At every step the app fires an HA event, `wellbeing_tracker_reminder`, with `person`, `tracker`, `reminder_id` and `stage` (`sent`, `repeated`, `escalated`, `announced`, `answered`, `snoozed`, `skipped`, `missed`), so any automation can react (flash a light, pause the TV…).
Each person also gets entities over MQTT, e.g. `sensor.<person>_<med>_status` (`due`, `snoozed`, `escalated`, `taken`, `skipped`, `missed`) and `sensor.<person>_<med>_last_taken`.

### Reliability
- Pending reminders, snoozes and repeat counts are stored in the database, so a restart of HA or the app resumes where it left off.
- "Already taken today" protection warns before logging a second dose.

### Migration
Once stage 3 works, turn off the existing "Medication – Vyvanse Reminder" automation to avoid double reminders, and link the "Vyvanse - Taken" and "Dex - Taken" toggles.

## Home Assistant link (stage 4)

- **Out to HA (MQTT discovery via Mosquitto):** each person's latest mood, energy, check-in streak, meds taken today, reminder statuses.
- **In from HA:** sleep from Sleep as Android, weather, any chosen sensor (steps, heart rate, weight, time at work zone) captured daily for insights.
- **Physical triggers:** NFC tags (HA tag events) and ESPHome buttons can log a dose or a factor.

## Build stages

| Stage | Contents | Status |
| --- | --- | --- |
| 1 | Skeleton: app installs, sidebar panel, per-user profiles | ✅ 0.1.0 |
| 2 | Tracker model, default trackers, Check-in screen, History timeline, Settings for trackers and med list | ✅ 0.2.0 |
| 3 | Reminder engine, medication schedules, synced actionable notifications, escalation, HA events | ✅ 0.3.0 |
| 4 | Check-in reminders on the same engine (✅ 0.4.0); HA data import; MQTT entities; NFC/button logging | In progress |
| 5 | History: calendar, charts, CSV export, appointment summary, delete-my-data | Planned |
| 6 | Insights: weekly summary notification, correlations, experiments | Planned |
| 7 | Extras: pill count and refill warnings, goals, cycle tracking, PIN lock, HA dashboard card | Planned |
