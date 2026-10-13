# Changelog

## 0.6.0

- **Check-in looks and works like Bearable.**
  - Sections with an icon, a heading, a count of what you've answered, and a collapse arrow.
  - Raised tiles throughout.
  - Ratings open a "Mood at 8:39pm" picker: faces above red-to-teal columns of numbers, with the time editable.
  - Symptoms use signal-bar level tiles with the level shown under the name and ⊖ to clear it.
  - Yes/no habits are chips you tap, with **+** to add one to a section.
- **Saves as you tap.** There's no Save button any more.
- **Bearable's colours and typeface:** ratings run red, orange, yellow, green, teal, and text uses Montserrat (bundled, so nothing is loaded from outside your home).

## 0.5.0

- **Matches Home Assistant's theme.** Colours, dark and light mode, and custom themes come from Home Assistant, and change when it does.
- **Medications work like Bearable.** Each has a usual dose and unit; each log records the time, the number of doses and the strength, with the total worked out ("2 × 30 mg (60 mg)").
- **Taken now and Taken at…** on the Check-in screen and the Due now card.
- **Change or delete logged doses** by tapping their time on the Check-in screen. Reminders timed from that dose move with it.
- **Mood and Energy are now 1 to 10.** Earlier answers were moved to the same place on the new scale (for example 3 of 5 became 6 of 10). Any rating can use a 1 to 5 or 1 to 10 scale.
- **Edit everything.** Existing items use the same form as new ones, including changing their type (which clears what was logged for them, with a warning first).
- **Water.** Counts and amounts can have a daily goal (Water starts at 8 glasses) shown as "3 of 8 glasses", plus optional **water reminders** with buttons to log a drink from the notification.

## 0.4.0

- **Check-in reminders.** Settings → Notifications → Check-in reminders: choose times and days, answer your mood straight from the notification (Good, Okay, Bad) or use Snooze and Not now, skip the reminder if you've checked in recently, and let unanswered ones tidy themselves away.
- **Search for icons.** Choosing an icon for a medication or tracker now opens a searchable emoji picker with suggestions, instead of a text box.
- **Clearer wording throughout.** Settings now groups **Phones and alerts** and **Check-in reminders** under **Notifications**, reminders are summarised in plain words ("Reminds you at 7am, every day"), and labels in the reminder editors say what they do ("If I don't answer", "Get louder if I don't answer", "Set a latest time").
- Saving one group of settings no longer resets the others.
- Home Assistant events now include a `type` (`medication` or `checkin`).

## 0.3.1

- **Time a medication from another dose.** In a medication's reminders, choose **After another dose**, for example "7 hours after I take Vyvanse" and "3 hours after I take Dex", with a daily limit. Reminders are timed from when you actually take the earlier dose, and the notification says what it was timed from.
- Undoing the earlier dose removes the follow-up reminder.

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
