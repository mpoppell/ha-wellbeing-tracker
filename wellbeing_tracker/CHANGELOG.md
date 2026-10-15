# Changelog

## 0.15.0

**Drag to arrange Check-in, and your nights from Sleep as Android.**

- In edit mode, drag the grip handle beside a section or anything in it to reorder. Arrow keys work on the handle too.
- **Sleep**: link Sleep as Android (or Android's sleep segments) and see each night:
  - bedtime, wake time and how long you slept;
  - a phase graph (awake, REM, light, deep) you can tap for times;
  - time in each phase, and the last 14 nights against your sleep goal;
  - your usual bedtime and wake time, and how far short you've been this week.
- The last 10 days are imported straight away; after that the app keeps every night, beyond what Home Assistant remembers.
- Sleep hours fill in from each night automatically. Your own entries still win.

## 0.14.0

**Choose what the dashboard card shows, and use it with Bubble Card.**

- In the card's visual editor:
  - **What to show, in order**: reminders waiting, today's medications, supply and doctor, mood. Drag to reorder.
  - **Only these medications**: pick their "Log dose" buttons.
  - **Style**: Home Assistant, **Bubble Card** (rounded bubbles that follow Bubble Card's theme colours and accent), or **No background** for inside Bubble pop-ups and stacks.
  - **Compact**, **Hide the title**, and **Hide when there's nothing to do** (it stays visible while you edit the dashboard).
- **Mood on the card**: five quick answers (Great, Good, Okay, Bad, Awful) that log your mood straight away.
- **New entities that Bubble Card's own cards can use**:
  - a **Log dose** button for each medication (logs the dose that's due, or the next one today), for Bubble buttons;
  - a **Mood** select for each person (choosing an option logs it), for Bubble's select card.
- New action: `wellbeing_tracker.log` logs a rating such as Mood or Energy.

## 0.13.0

**Wellbeing in Home Assistant: a dashboard card, entities and actions.**

The app now installs a small companion integration for you. After updating, restart Home Assistant, then add **Wellbeing Tracker** in Settings → Devices & services (one click, nothing to type).

- **Dashboard card** (`custom:wellbeing-card`, listed as "Wellbeing" when you add a card). It shows reminders waiting with the same buttons as your phone (including skip reasons), today's medications (tap one that's due to log it), supply warnings and when to see your doctor, and today's mood. It shows whoever is signed in, or a chosen person, and has a visual editor. No resource to add by hand.
- **Entities** for each person: Reminders waiting, Next dose, Mood today and See the doctor by. For each medication you count: Supply left (days) and New script needed by.
- **Actions** for automations, scripts and voice: `wellbeing_tracker.answer_reminder` (taken, snooze or skip) and `wellbeing_tracker.log_dose`. People can answer their own reminders; admins and automations can answer anyone's.
- Updates within seconds of any reminder changing, and every 30 seconds otherwise.
- The app can now write to Home Assistant's config folder, only to install and update this integration.
- Fixed: a dose logged in the same second the supply count was set wasn't counted.

## 0.12.0

- **Fill in from Home Assistant.** Counts, amounts and Sleep can be linked to any Home Assistant sensor, such as steps, sleep or weight from Google Health, or your scales. Choose which reading counts for the day: the latest (weight, last night's sleep), the highest (daily totals like steps) or the average (heart rate). Linking fills in the last 30 days from Home Assistant's history, then keeps up every 15 minutes. Anything you enter or correct yourself always wins. Sleep in minutes or seconds is turned into hours.
- **Notifications in the app.** A bell on Check-in shows how many reminders are waiting. It lists the same reminders as your phone, worded the same, with the same buttons (Taken, Snooze, Skip, mood answers, water amounts), plus supply warnings. Answering in the app clears it from your phone, and the other way round.
- Check-in keeps itself up to date while it's open, so new reminders appear without reloading (not while you're typing).
- Big numbers have separators ("10,800 steps").
- Counts can now go up to 1,000,000 (for steps).

## 0.11.1

- **Choosing devices and speakers works like Home Assistant.** What you've chosen shows as chips (tap × to remove), and **Add a device** / **Add a speaker** searches what Home Assistant has right now, with an icon and a line saying what each one is ("Phone · with Taken, Snooze and Skip", "Notify entity · message only"). Arrow keys and Enter work too.

## 0.11.0

- **When to see your doctor.** Settings → **Supply and scripts** now starts with "See your doctor by 4 Nov for a new Vyvanse script. Then Clonidine by 12 Dec." It's worked out from what you have left, your repeats and when each script ends.
- Each medication's sheet shows **New script needed by**, and the warning, notification and Home Assistant event for it now say the same thing ("Book a doctor's visit for Clonidine"). Script expiry and last repeats are one warning instead of three, with one "Warn me X days before I need a new script" setting.
- **Save your changes?** Tapping outside a sheet (or pressing Escape) after changing something now asks: Save, Discard or Keep editing.
- **Words that match what you're doing**: "Set up", "Keep count", "How many a day?", "How many in a refill?", "Your script", "Refill again after", "Script ends".
- **Settings in the order you'll need it**: supply and scripts first, then reminders (Today's reminders, Pause), then setting up medicines and what you track. "Notifications" is now **Reminders**.
- The Check-in header says "next check-in 9am" instead of "next reminder".

## 0.10.1

- On wider screens (tablets in landscape, computers), sheets and pickers open as a panel near the top of the screen instead of rising from the bottom. Phones keep the bottom sheet.

## 0.10.0

**Supply and refills**, optional for each medication.

- Tap a medication's name on Check-in to see how many you have left, about how many days that is, and when it runs out. Doses you log count it down.
- **Refill** adds what you collected, uses a repeat, or starts a new script. Undo is in the message.
- One warning at a time on Check-in, only when something needs doing: running low, a new script needed (no repeats left), or the script ending or expired. They're also sent to your devices once, in the daytime, and as a Home Assistant event (`type: supply`).
- Choose when to be warned: "Warn me 10 days before I run out", "14 days before I need a new script", "30 days before the script ends".
- **Prescribed per day** starts from your reminder times and amounts. Type your own to override it.
- The early supply rule shows "Refill from 30 Oct" until you're allowed to refill.
- Settings has a **Supply** overview of every medication.

## 0.9.1

- **Send reminders anywhere Home Assistant can notify.** Settings → Notifications → **Devices and alerts** now lists Companion app phones (with Taken, Snooze and Skip buttons) and everything else: notify entities, other notify services such as Telegram, and Home Assistant's own notification bell. Those get the message with "Open Wellbeing to answer". Reminders in the bell are removed when you answer.
- A device chosen earlier that Home Assistant can't find right now stays ticked instead of being dropped.
- Tapping the heading of the device list no longer ticks the first phone.

## 0.9.0

Polish: easier to use and easier to understand.

**Check-in**
- A progress bar under the date: "5 of 12 answered".
- Swipe left and right to change day. When you're on another day, a banner says so, with **Back to today**.
- Anything not answered yet shows yesterday's answer ("Not logged yet · yesterday Good (8)"). Symptoms you haven't answered say **Not answered**, so a blank isn't mistaken for "None".
- Each section's ••• menu has **Copy yesterday's answers** and **Hide this section** (both with Undo).
- A friendlier start when nothing is set up yet.

**Meds/Supplements**
- Today's reminders under each medication are buttons: tap "1 dose at 10pm" to log exactly that. A bell next to the name opens its reminders.
- Skipping a dose offers one-tap reasons instead of a typed box.
- Halves show as ½ in History too ("½ dose (50 mcg)").
- "Counted as" is now "Each one is a…", with examples.

**Reminders**
- **Pause reminders** for an hour, until tomorrow morning, a few days, a week or a time you choose. Doses still show in the app, and the Home Assistant event says `paused: true`.
- **Today's reminders** lists everything due today in time order.
- **Send me a test** for any medication sends a real-looking example to your phones.
- Check-in reminders are shorter: "How are you feeling? Tap one to log your mood."

**Everywhere**
- Deleting an entry, dose or group happens straight away with **Undo**, instead of an "Are you sure?" box.
- Times follow the 12 or 24-hour clock in your Home Assistant profile.
- History's day headings stay at the top as you scroll; tap one to open that day in Check-in.
- Each type in **Add something to track** has examples ("For example stress, focus, pain or motivation").
- Editing an item from Check-in no longer jumps to the Settings screen.

## 0.8.0

- **A different amount at each reminder time.** For example, Clonidine half a dose at 7pm and one at 10pm. Set it under **Times and amounts** in a medication's reminders, with the strength worked out as you type.
- Reminders say how much to take ("Clonidine ½ dose (50 mcg)"), and **Taken** logs that amount.
- Each medication on Check-in shows today's plan ("½ dose at 7pm ✓ · 1 dose at 10pm"). Tap it to change the reminders.
- The dose dialog starts at the amount that's due, and steps in quarters.
- Halves and quarters show as ½ and ¼.

## 0.7.0

- **Back to our own look.** Your Home Assistant theme colours, our rating colours and the Atkinson Hyperlegible typeface. Each section is a Home Assistant-style card that opens and closes like an accordion. The Bearable-style layout stays.
- **Arrange your dashboard.** The pencil on Check-in opens edit mode, like Home Assistant's dashboards:
  - reorder, rename, hide and add sections;
  - move, edit, hide or send any item to another section.
- **Meds/Supplements, laid out like Bearable.**
  - Name with strength, the usual number of doses, today's doses as squares with their time, **+** to log, and the day's total.
  - A dose dialog with ×N and −1/−0.5/+0.5/+1 steps, editable strength and time, delete and Confirm.
  - Medication **groups** you can log in one tap, and **Copy last**.
- Medications have a **usual number** and what one is **counted as** (dose, tablet, application…).
- The medications section is now called **Meds/Supplements**.

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
