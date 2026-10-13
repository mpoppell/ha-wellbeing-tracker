# Changelog

## 0.3.0

- **Medication reminders.** Turn them on per medication with the bell in Settings: any number of times a day, every day, chosen days or every few days.
- **Answer from the notification** with Taken, Snooze or Skip (with an optional reason). Answering on one phone clears it everywhere.
- **Due now card** at the top of Check-in, plus "Later today" and each medication's next reminder time.
- **Logging counts:** logging a dose on the Check-in screen answers its reminder, and logging it early means the reminder never goes off.
- **Optional extras per medication:** how often to repeat (once, gently, firmly or your own pattern), a latest time with one last "skip or take anyway?" question, escalation to an alarm sound and/or a speaker announcement, and a linked Home Assistant toggle and time helper.
- **Optional extras per person:** which phones, combining medications due together, Undo after answering, swipe-away, snooze length, quiet hours, and speakers and voice for announcements (optionally only when home).
- **Home Assistant events** (`wellbeing_tracker_reminder`) at every step, for your own automations.
- Reminders survive restarts: anything due or snoozed picks up where it left off.

## 0.2.1

- Updates now download a ready-made image instead of building on your Home Assistant machine, so they install in seconds.
- New icon and logo in the app store.

## 0.2.0

- **Check-in screen:** answer everything in one place: mood, emotions, energy, symptoms, medications, sleep, lifestyle factors and a journal note. Unsaved answers are marked with a dot and saved together.
- **Back-filling:** step back to earlier days to log or change what you missed.
- **History screen:** the last 14 days, newest first, with a mood and energy summary for each day. Tap an entry to change or delete it.
- **Settings screen:** add medications and your own trackers (ratings, symptoms, yes/no, counts, amounts, pick-lists, notes); rename, regroup, reorder, hide or delete any tracker.
- Everyone starts with a set of default trackers they can change.
- Medications appear at the top of the check-in and warn before logging a second dose on the same day.
- Text uses Atkinson Hyperlegible, bundled with the app so nothing is loaded from outside your home.

## 0.1.0

- First build: installs as a Home Assistant app and appears in the sidebar.
- Recognises which Home Assistant user is signed in and keeps a separate profile for each person.
- Stores data in SQLite inside the app's data folder, so Home Assistant backups include it.
- Shows connection status to Home Assistant.
