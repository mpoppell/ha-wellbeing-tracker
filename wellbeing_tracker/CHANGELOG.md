# Changelog

## 0.24.0

- Outdoors card: today's temperature graph now has icons along the top for sunrise, sunset and the biggest changes in the sky, at most six. Rain starting or clearing and storms count most, then turning cloudy or clearing up; one-hour flickers in the forecast are ignored. Each icon has its time, a faint line shows where it falls on the graph, and screen readers hear the list.
- New optional setting, **Sunrise and sunset**, under Where the information comes from (found automatically as `sun.sun`).

## 0.23.1

- Outdoors card: in the evening the Bureau stops giving today's low (it's already happened), so Today's bar shrank to a sliver at the high and the "now" dot floated off on its own. Today's range now includes what your thermometer measured today, so it shows the real low to high with now on the bar.
- The Today row no longer shows a moon after dark; it summarises the whole day.

## 0.23.0

**Medications when you wake up, an antihistamine only on high-pollen days, and an easier time picker.**

Medications
- New way to time a reminder: **When I wake up**. The app counts you as up when your phone comes off the charger in the morning (after 4am, after at least 3 hours on charge), and reminds you anyway at 10am if it didn't see you get up. The Due card shows what's waiting, with an **I'm up** button.
- New **Only on some days**: add a medication to the day only when a Home Assistant number is high enough, such as pollen at or above your alert level. It's checked through the day and added at most once a day. Google Pollen's forecast for today is used even before the sensor rolls over at midnight.

Time picker
- Tapping a number on the dial always updates the big numbers at the top (before, it didn't if you'd tapped the big hour first).
- The big numbers switch between hours and minutes instead of opening the keyboard. Use the keyboard button to type, and the clock button to go back.
- A tap on the minutes lands on the nearest 5; drag for an exact minute. A line under the time says what to do next.
- Tapping outside the clock no longer closes it and loses your time; use Cancel.

Outdoors card
- Today's temperature is now a line graph: measured so far (solid) and forecast (dashed), with the high, low and now marked, and a reading for any time on hover or tap.
- New cards fill in every source they find (including your Bureau thermometer), so the editor shows exactly what the card uses.

Fixes
- Choosing from a search list inside a form could un-choose it straight away. Fields with more than one control are now labelled groups, which also fixes screen reader names.

## 0.22.0

**An Outdoors card: what the weather means for your day.**

- New dashboard card, **Outdoors** (`type: custom:wellbeing-outdoors-card`). At the top, a heads-up only when something needs doing: a Bureau weather warning, High-or-worse fire danger, strong UV with the hours to protect your skin, rain in the next few hours or later today, pollen, a cold morning or a hot day. Quiet days just say "Nothing to watch for today."
- From 6pm it looks ahead to tomorrow, so you can lay out an umbrella or warm layers the night before. "Coming up" chips flag the next rainy, hot, cold or high-pollen day.
- Below that: the temperature now on today's low-to-high range, rain chance for the next 12 hours, UV, pollen and fire danger on labelled scales, and the next few days on one shared temperature scale so they're easy to compare.
- Alert levels can be numbers or helpers. Pointing the card and your automations at the same helpers keeps them in step.
- It finds Bureau of Meteorology and Google pollen sensors automatically; anything can be changed in the card's editor. "Hide the card on quiet days" lets the heads-up sit at the top of a dashboard and only appear when it matters.
- Restart Home Assistant after updating to load the new card.

## 0.21.2

**See where your reminders went.**

- Every notification the app tries to send is now written to its log: "Sent 'Time for Vyvanse' to mobile_app_s26u", or why it wasn't ("reminders are paused until…", "nowhere chosen to send reminders", or Home Assistant refusing it).
- The "Reminders waiting" entity in Home Assistant shows a `delivery` attribute: where reminders go, any pause or quiet hours, and the last notification and what happened to it. (Restart Home Assistant after updating to get the new attribute.)
- The log no longer fills up with the dashboard card's update every 30 seconds.

## 0.21.1

- Only people who've used the app (logged something, added a medicine or changed a setting) get a device and entities in Home Assistant. Someone who only opened it once, or a tool that looked at it, no longer appears.

## 0.21.0

**A clock for every time, and an accessibility pass.**

Times
- Every time in the app now uses one picker, like Android's clock: tap the hour on the dial, then the minutes, or type straight into the big numbers at the top. AM/PM (or a 24-hour dial with an inner ring, if that's your setting), **Now**, and a keyboard button to just type. The dial also works with the arrow keys.
- Pausing reminders until a set time now uses a date and this picker.

Accessibility (checked against WCAG 2.2 AA with automated tests on every screen and window, in light and dark, plus by hand)
- Section names are headings, so screen readers can jump between them.
- Saving no longer loses your place: after a tap, focus stays on the same button instead of jumping to the top of the page. The automatic refresh waits while you're using the page.
- Every window is named by its title; errors in forms are announced.
- Coloured answers ("Very bad (2)") are now dark text with a coloured dot, so they're readable for everyone; colour is never the only clue.
- Notifications with Undo stay for 10 seconds and don't disappear while you're pointing at them or have tabbed to them.
- The "clear" buttons are bigger (at least 24 by 24 pixels).
- The sleep charts can be explored with the keyboard, and each bar and block is read out ("Tue 14 Oct: 7 h 28 min asleep").
- Three good things has a visible question above the box, not just a hint inside it.
- Reduced motion is respected everywhere, including scrolling. High-contrast (forced colours) mode keeps selected buttons visible.
- Settings that are switched off are no longer greyed out to an unreadable contrast.

## 0.20.0

**The question beside Check-in is now one tap.**

Each kind of question has its own simple answer, instead of a copy of the Check-in row (no times, no history, no + to open another window). Your answer is saved for right now, it says "Saved: Fair (7)", and moves on to the next question by itself.

- Mood and energy: the numbers, with the words for each end of the scale underneath.
- Symptoms: None, Mild, Moderate, Severe.
- Habits: "Did you exercise today?" Yes or Not today.
- Feelings: pick as many as fit, then Done.
- A good thing: type it and Save.
- Skip is quieter, and only shows before you answer.

## 0.19.0

**Sleep times like Bearable, and a side question that makes sense.**

- Tap the hours on the Sleep row (or **Change times** on a night) to say when you **fell asleep** and **woke up**, and optionally when you **went to bed** and **got up**. It works out time asleep and time in bed as you type. Or tap **Or just enter how long you slept**. Your times fill in Sleep hours and keep your sleep quality.
- The question beside Check-in on a computer now only asks what makes sense right now:
  - mood, energy and emotions if you haven't logged them in the last 3 hours;
  - symptoms you haven't answered today;
  - a good thing, when one's due;
  - end-of-day habits like exercise or time outdoors, from 6pm.
  - Never counts like alcohol, caffeine or water, habits about the night like late screen time, or anything Home Assistant fills in.
- It asks a real question ("How's your energy right now?", "Any headache today?"), sits in the middle of the screen, and offers **Skip**, or **Next** once answered.

## 0.18.0

**Three good things, a minute to breathe, and good news without guilt.**

- **Three good things**, in a new **Reflect** section after How you feel. One at a time through the day: after lunch ("What's gone well so far today?"), mid-afternoon, and before bed. Small dots show how many you've written. Tap one to change or delete it.
  - Nothing from yesterday? Before the first one's due, it asks "What were you grateful for yesterday?" instead.
  - Optional reminders at those times, which you can answer straight from the notification. Turn them on, or change the times, by editing Three good things.
- **A minute to breathe**: after a low mood, or anxiety at moderate or worse, the app gently offers a one-minute breathing exercise (at most every three hours). A circle grows as you breathe in for 4 and shrinks as you breathe out for 6, or stays still if your device asks for less motion. Finishing logs a new **Mindful minute** habit. You can also start it any time from How you feel's ••• menu.
- **Good news**: when something's improved since the day before, the week before or the month before, Check-in says so ("Headache on 1 day this week, down from 6", "Your best mood in 3 weeks today"). Only improvements are ever mentioned, and only where it's clear which way is better.
- **Your week**, at the top of History: days checked in, good things noted, sleep, doses taken, your best day, and everything that's going well.
- A small "Nice work" when you fill in the last thing for the day.
- Fixed: editing the Sleep item could forget where your nights come from and your sleep goal.

## 0.17.0

**What needs doing first, and one question at a time on a computer.**

- **Due** sits at the top of Check-in: doses that are due, plus check-in and water reminders you've been sent, each with the same buttons as the notification.
- **Coming up** only lists what's in the next 30 minutes, with **Log now**.
- Section headings show how many are **still to fill in** (or doses still to take) in a small grey number, and a green tick once everything's done.
- On a wide screen, a panel beside Check-in asks one thing you haven't filled in today, picked at random. **Another one** shuffles. Once everything's filled in, it goes round again so you can update anything that's changed.

## 0.16.0

**Sleep from your bedroom and phone, and a cleaner, calmer Check-in.**

Sleep
- Every night can now be **estimated from your home**: bedroom lights, your phone on charge, and (optionally) your phone in use mark bedtime and getting up. Android's sleep confidence or sleep segments then show when you were actually asleep.
- Each morning shows the best night available: your own times, then Sleep as Android, then the estimate, then Android's sleep segments.
- **How this was worked out** lists each step ("Lights out 11:40pm", "Phone on charge", "Asleep"...).
- **Change times**, **Not a night's sleep** and **Add this night**, with your times always winning. Sleep hours follow.
- Setup suggests the right entities, grouped by source, and explains how to turn on the phone's Interactive sensor.
- Nights without stages show as Awake and Asleep (grey), on Check-in and in the 14-night chart.

Check-in
- Medications: one line of today's doses in time order (taken ✓ with the time you took it, due, still to come) and a single **Log** button, instead of three different displays of the same thing.
- The **Coming up** card is gone (each medicine already shows what's coming); **Due now** stays.
- Groups only show once you have some. Creating a group and **Log the same as last time** are in the section's ••• menu.
- No more "Not answered" under every item; you'll see yesterday's answer instead, when there was one.
- A section's count reads "2 of 5" instead of a bare number in a bubble.
- Sleep shows as 7h 44m, not 7.73h; "from Home Assistant" is shown quietly beside the value.
- Strengths read "100 mcg", not "100mcg"; numbers from 1,000 have commas.

Settings
- Every row is one tap target with a chevron, instead of buttons and up/down arrows. Reorder things on Check-in by dragging, in one place.
- "Devices and alerts" is now **Where reminders go**, and the reminder rows say what they're set to in fewer words.
- When editing an item, the warning about changing its type only shows if you change it.

Also
- On a computer, the tab bar sits under the page instead of stretching across the window.
- Edit mode no longer says medicines have "No reminders" when they do.

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
