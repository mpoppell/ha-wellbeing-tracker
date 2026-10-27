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

Tap the pencil at the top of Check-in to edit it, much like a Home Assistant dashboard. Drag the grip handle (⠿) beside a section or anything in it to reorder it, or focus the handle and use the arrow keys. You can also rename sections, hide them, or add a new one. For anything in a section you can move it, edit it, send it to another section, or hide it. Tap **Done** when you're finished. Each section's ••• menu has shortcuts too. The small grey number beside a section's name is how many are still to fill in today (for medicines, doses still to take); a green tick means it's all done.

At the top, **Due** lists doses that are due and any check-in or water reminders you've been sent, with the same buttons as the notification. Anything in the next 30 minutes shows under it as **Coming up**.

On a computer with a wide window, a panel on the left asks one question that makes sense right now: your mood, energy or emotions if you haven't logged them in the last 3 hours, symptoms you haven't answered today, a good thing when one's due, and end-of-day habits (like exercise) from 6pm. It never asks about counts like alcohol or water, which you log as they happen, or habits about the night. **Skip** moves to another; once everything's done it asks "Anything changed?" about your mood, energy and emotions.

## Three good things

The **Reflect** section asks for one good thing at a time, spread through the day: after lunch, mid-afternoon and before bed. Small things count: a coffee, a kind word, a walk. Type it and tap **Save** (or press Enter). The dots beside the name show how many you've written today, and you can tap any of them to change or delete it. Once all three are in, **Add another** is there if you want it.

If you didn't write anything yesterday, the first question of the morning is "What were you grateful for yesterday?", saved to yesterday.

To change the times, or to get a quiet reminder at each one, edit **Three good things** (Settings, or the pencil on Check-in) and turn on **Remind me at these times**. You can answer the reminder straight from the notification with **Write it**. You won't be asked for a time you've already written one for.

## A minute to breathe

After you log a low mood (the bottom third of the scale), anxiety or stress at moderate or worse, or feeling anxious or overwhelmed, the app offers **A minute to breathe?** It asks at most once every three hours, and you can ignore it.

The exercise is one minute of slow breathing: in for 4, out for 6, following the circle. If your phone or computer is set to reduce motion, the circle stays still and the words guide you instead. When you finish, it's logged as a **Mindful minute** (under Lifestyle). Start it any time from the ••• menu on How you feel.

## Good news, and your week

When something's got better, Check-in says so in a **Good news** card: compared with the day before ("Your best mood in 3 weeks today", "No headache today, after 3 days of it"), the week before, or the month before ("Felt calm on 15 days in the last month, up from 2"). Close the card to hide those for a few days.

Only improvements are mentioned, and only where it's clear which way is better: fewer symptoms, less of things like alcohol or late screen time, more exercise or time outdoors, more sleep when you're short of your goal, reaching a daily goal, a better mood or energy. Nothing points out a bad day or a missed one.

**Your week**, at the top of History, sums up the last seven days: how many days you checked in, good things noted, sleep, doses taken when reminded, your best day, and everything that's going well.

## Meds/Supplements

Each medication shows its strength, a **Log** button, and one line for today's doses, in time order:

- **✓ ½ dose · 7:02pm**: taken. Tap it to change the amount or time, or delete it. Reminders timed from that dose move with it.
- **1 dose at 10pm**: still to come. Tap it to log exactly that amount now.
- **1 dose due** (filled in): due now. The **Due now** card at the top has Taken, Snooze and Skip too.
- Skipped and missed doses are crossed out.

Tap **Log** to log a dose at any time: set how many (×1, ×1.5 and so on), change the strength or time if needed, then **Confirm**. Tap the medicine's name for its supply, refills and reminders. Supply warnings ("8 days left", "New script needed by 3 Nov") show underneath.

- **Groups**: from the section's ••• menu, choose **Create a group to log together**, such as Morning or Bedtime. Your groups then show at the top of the section; tap one to log everything in it at once (with Undo).
- **Log the same as last time** (••• menu): logs the same doses as the last day you logged any, at the same times (only times that have already passed today).

## Medication reminders

Reminders are off until you switch them on for a medication.

1. **Settings → Reminders → Devices and alerts → Change**: tick where your reminders should go, and tap **Send a test**. Phones signed in to the Home Assistant Companion app get **Taken**, **Snooze** and **Skip** buttons. Anything else Home Assistant can notify (a notify entity, Telegram, a TV, Home Assistant's own notification bell) gets the message with "Open Wellbeing to answer".
2. **Settings → Meds/Supplements**: tap a medication (or add one). Its reminders are right there under its dose: turn on **Remind me to take it**, and pick the times, how many at each, and the days. One **Save** keeps both. Less-used options (repeats if you don't answer, a latest time, getting louder, linking to Home Assistant) are under **More reminder options**.

### When I wake up

Choose **When I wake up** instead of set times, for medications you take as soon as you're up.

- The app counts you as up when your phone comes off the charger in the morning: after 4am, having charged for at least 3 hours, so a night-time unplug or a quick top-up doesn't count. Choose the phone's *Is charging* sensor from the Home Assistant app (Companion app → Manage sensors → Battery). If you haven't chosen one, the app uses the charging sensor of the phone your reminders go to.
- For more ways to tell, use Home Assistant's **Awake** switch (below). Once it's set up, it decides when you're up, and this screen links to its settings.
- Home Assistant can also tell it you're up with the **I'm up** action (see Actions below). The first sign of the day counts.
- The **Up today** sensor shows when you got up and how the app knew.
- **Remind me anyway** at a set time (10am unless you change it) for mornings the phone wasn't on the charger.
- The **Due** card shows what's waiting for you to get up, with an **I'm up** button.
- These settings are shared by every "when I wake up" reminder. **Fine-tune** changes the earliest time and how long a charge counts as a night.
- Set it up after you've already got up, and it starts tomorrow.

### Only on some days

Turn on **Only on some days** to add a medication to the day only when a Home Assistant number is high enough, for example an antihistamine when pollen is at least Moderate. Choose the sensor, then either type a number or follow a number helper (such as the Outdoors card's pollen alert level, so they always agree).

- It's checked through the day: if pollen rises at lunchtime, it's added then.
- Once added it stays for the day, and it's never added more than once a day.
- Pollen sensors that forecast by day (Google Pollen) use today's forecast, even just after midnight before the sensor itself has moved on to the new day.

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

## Sleep

Check-in can show each night's sleep, the way Sleep as Android does. On the **Sleep** row tap **Show your nights from Home Assistant** (or **from Sleep as Android**), check the suggested entities and tap **Save and import**. To change them later, open a night and tap **Change** at the bottom.

You can use any of these together. Each morning shows the best one available:

1. **Sleep as Android**: its **Sleep tracking** events mark the night, and **Sleep phase** events add deep, light, REM and awake. Only on nights you track.
2. **Your Awake switch** in Home Assistant (see Awake switch below), if you've set it up: asleep while it's off. Used automatically for nights Sleep as Android didn't track, with nothing to choose here. Open a night and tap **How this was worked out** to see why it went to sleep and woke ("Asleep: phone on charge and lights off").
3. **Your bedroom and phone**: an estimate for every night, with nothing to start or stop.
   - **Bedroom lights**: lights out means you've gone to bed; on again means you're up.
   - **Phone charging**: most people put their phone on charge at bedtime.
   - **Phone in use** (optional): the Companion app's **Interactive** sensor. It's off by default: turn it on in the Home Assistant app under **Settings → Companion app → Manage sensors**.
   - **Sleep confidence**, from the Companion app, tells when you actually fell asleep and woke, rather than when you went to bed.
4. **Android's sleep detection**: the Companion app's **Sleep segment** sensor. Bedtimes and wake times, without stages. It also sharpens the estimate above.

How the estimate works: bedtime is when everything you chose says you're in bed (lights off, phone on charge, phone not in use), and you're up when any of them changes. A trip to the bathroom or a quick look at your phone (under 15 minutes) doesn't end the night. If a light stays on all night, or the phone never goes on charge, that night goes by the others. If only the charger is chosen and it stays plugged in, you're counted as up within an hour of waking. Open a night and tap **How this was worked out** to see each step ("Lights out 11:40pm", "Phone on charge 11:42pm", "Asleep 11:58pm"...).

Estimates can be wrong, so every night except Sleep as Android's can be changed:

- **Change times**: set when you fell asleep and woke. Your times are kept and win over everything else. **Use Home Assistant's times** puts it back.
- **Not a night's sleep**: for a night away from home, or one that's just wrong. It's removed, along with its Sleep hours (Undo is offered).
- **Add this night**: for a morning with nothing recorded.

Importing brings in the last 10 days (all Home Assistant keeps), and new nights are added every 15 minutes. Nights are kept by the app from then on, so your history keeps growing. Each night also fills in **Sleep** hours for that morning; anything you enter yourself still wins.

To enter a night yourself, tap the hours on the **Sleep** row: fill in when you fell asleep and woke up, and if you like, when you went to bed and got up. Time asleep and time in bed are worked out as you type. Or choose **Or just enter how long you slept**. Your times win over everything from Home Assistant, and your sleep quality is kept.

Tap a night on Check-in to see it in full: when you fell asleep and woke, a graph of the night (tap a block to see its times), time in each stage, and the last 14 nights against your sleep goal. Nights without stages show in grey.

## Dashboard card, entities and actions

The app installs a companion integration into Home Assistant for you. After installing or updating the app, restart Home Assistant, then go to **Settings → Devices & services → Add integration → Wellbeing Tracker** and confirm. There's nothing to type: the app has already given it its address and a private key.

Both cards are added to your dashboard resources (**Settings → Dashboards → ⋮ → Resources**) automatically and kept up to date, so they load in the phone apps as well as the browser. Don't remove those two entries; if you do, restarting Home Assistant adds them back.

**Dashboard card**: edit a dashboard, add a card and choose **Wellbeing** (or use `type: custom:wellbeing-card`). It shows:

- reminders waiting, with the same buttons as your phone
- today's medications (tap a dose that's due to log it)
- supply warnings and when to see your doctor
- today's mood

It shows whoever is looking at the dashboard. To always show one person, choose their "Reminders waiting" sensor in the card's settings.

Everything the card shows is set in its editor: which sections and in what order, only some medications, the style (Home Assistant, Bubble Card, or no background), compact, hiding the title, and hiding it when there's nothing to do.

**Outdoors card**: add a card and choose **Outdoors** (or `type: custom:wellbeing-outdoors-card`). It turns the forecast into what to do:

- **Heads-up**, only when it matters: weather warnings, fire danger of High or worse, strong UV (with the hours to protect your skin), rain soon or later today, pollen, a cold morning or a hot day. The three most important are shown in full and the rest as small chips. From 6pm it looks at tomorrow instead. Tap one for the details.
- **Now and today**: the temperature now, and a line graph of today: solid for what your thermometer has measured so far, dashed for the forecast for the rest of the day. The high and low are labelled; hover or tap for any time. Above the graph, up to six icons mark sunrise, sunset and the biggest changes in the sky (rain starting or clearing, storms, turning cloudy or clearing up), each with its time. Small one-hour flickers are ignored, and changes earlier today come from the weather's history when Home Assistant records it.
- **Rain, next 12 hours**: one bar per hour. Filled bars reach your rain alert level, shown as a dashed line.
- **UV, pollen and fire danger** on scales with a word for each level, so colour is never the only clue.
- **Next days**: rain chance and each day's temperature range on one shared scale.

Choose which parts to show and their order in the card's editor. **Alert levels** sets when something is called out (rain chance, UV index, pollen 0 to 5, cold below, hot from). Use a number helper (Settings → Helpers → Number) for any of them, and use the same helper in your automations so they agree. **Where the information comes from** is filled in automatically for Bureau of Meteorology and Google pollen; change anything there. Turn on **Hide the card on quiet days** and show only Heads-up to put it at the top of a dashboard.

 *Reminders waiting*, *Next dose*, *Mood today*, *See the doctor by*, and a *Mood* select (choosing an option logs it). For each medication: a *Log dose* button. For each medication you count: *Supply left* (days) and *New script needed by*.

### With Bubble Card

A pop-up with the card inside, styled to match:

```yaml
type: vertical-stack
cards:
  - type: custom:bubble-card
    card_type: pop-up
    hash: '#wellbeing'
    name: Wellbeing
    icon: mdi:heart-pulse
  - type: custom:wellbeing-card
    style: bubble
    hide_header: true
```

A Bubble button that logs a dose, with today's supply as a sub-button:

```yaml
type: custom:bubble-card
card_type: button
button_type: name
entity: button.clonidine_log_dose
name: Clonidine
icon: mdi:pill
tap_action:
  action: perform-action
  perform_action: button.press
  target:
    entity_id: button.clonidine_log_dose
sub_button:
  - entity: sensor.clonidine_supply_left
    show_state: true
    show_background: false
```

Mood with Bubble's select card:

```yaml
type: custom:bubble-card
card_type: select
entity: select.wellbeing_matthew_poppell_mood
name: Mood today
```

**Awake switch**: each person's device has an **Awake** switch: on while you're up, off while you're most likely asleep. Set it up in **Settings → Devices & services → Wellbeing Tracker → Configure** (suggestions are filled in from your phone and Sleep as Android):

- **Asleep** when sleep tracking starts. If you don't track a night: between **Bedtime from** and **Bedtime until** (8pm to 9am to start with), home, phone on charge and the bedroom lights off, with nothing else happening for a while (and nothing in **Not asleep while on**, such as your computer). It's dated to when things went quiet.
- **Awake**, after the **Earliest wake-up** and once sleep tracking has stopped, at the first of: the phone coming off a night's charge, a fresh unlock that stays unlocked for a few minutes, the phone noticing walking, any of your **Signs you're up** (a computer unlocking, the dishwasher opening, a kettle's power), or leaving home. Leaving home and the charger count even if sleep tracking was left running. A daytime nap ends at the first sign of life.
- You can always flip it by hand. Its **since** and **how** attributes say when and why it last changed.
- Waking up counts for medications due when you're up. Use the switch in your own automations: "when Awake turns on" for when you wake up, "when it turns off" for when you fall asleep.

**Actions** for automations and scripts:

```yaml
action: wellbeing_tracker.log_dose
data:
  medication: Clonidine
  quantity: 0.5          # optional, the usual amount if left out
  person: Matthew Poppell  # optional when run by that person
```

```yaml
action: wellbeing_tracker.log
data:
  item: Mood
  value: 8
```

```yaml
action: wellbeing_tracker.answer_reminder
data:
  reminder_id: 12        # from the Reminders waiting sensor
  answer: taken          # taken, snooze or skip
```

```yaml
action: wellbeing_tracker.im_up   # medications due "when I wake up" are due now
data:
  person: Matthew Poppell         # optional when run by that person
  at: "{{ now() }}"               # optional: when, if earlier (today only)
  source: computer unlocked       # optional: shown on the Up today sensor
```

## Times

Wherever you set a time, tap it to open the clock: tap the hour on the dial, then the minutes (dragging works too), or type into the big numbers at the top. Use **AM**/**PM** to switch, **Now** for the current time, and the keyboard button to hide the dial and just type. With a keyboard, type the digits, or focus the dial and use the arrow keys (Page Up and Page Down jump 5 minutes); Enter confirms. It follows the 12 or 24-hour setting in your Home Assistant profile.

## Accessibility

The app aims for WCAG 2.2 AA, with automated checks on every screen in light and dark. It works with a keyboard alone and is built for screen readers (named buttons, headings, announced changes); keeps your place when something saves; never relies on colour alone; respects reduced motion, text size and high-contrast settings; and drag-to-reorder has an arrow-key alternative. If anything gets in your way, please report it.

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
