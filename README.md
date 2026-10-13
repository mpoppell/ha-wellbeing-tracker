# Wellbeing Tracker for Home Assistant

A Home Assistant app for tracking mood, energy, symptoms, medications, sleep and lifestyle factors, with a separate private log for each person in your home.

## Install

1. In Home Assistant, go to **Settings → Apps → App store**.
2. Open the **⋮** menu, choose **Repositories**, and add `https://github.com/mpoppell/ha-wellbeing-tracker`.
3. Find **Wellbeing Tracker** in the store, install it, then start it with **Show in sidebar** turned on.

## Roadmap

See [docs/FEATURE_PLAN.md](docs/FEATURE_PLAN.md) for the full plan.

| Stage | What it adds |
| --- | --- |
| 1 ✅ | App skeleton, sidebar panel, per-user profiles |
| 2 ✅ | Trackers, Check-in screen, History timeline, Settings |
| 3 | Reminder engine: medication schedules, synced actionable Android notifications, escalation, HA events |
| 4 | Check-in reminders, HA data import (sleep, weather, sensors), MQTT entities, NFC logging |
| 5 | Calendar, charts, export, appointment summary |
| 6 | Insights: weekly summary, correlations, experiments |
| 7 | Goals, cycle tracking, PIN lock, dashboard card |

## Development

```bash
cd wellbeing_tracker
pip install -r requirements.txt pytest
python -m pytest
WELLBEING_DEV=1 WELLBEING_DATA_DIR=./devdata python -m app.main   # http://localhost:8099
```

In dev mode the app accepts requests from anywhere and treats you as a "Developer" user. Inside Home Assistant it only accepts requests through ingress.
