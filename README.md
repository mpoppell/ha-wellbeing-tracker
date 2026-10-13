# Wellbeing Tracker for Home Assistant

A Home Assistant app for tracking mood, energy, symptoms, medications, sleep and lifestyle factors, with a separate private log for each person in your home.

## Install

1. In Home Assistant, go to **Settings → Apps → App store**.
2. Open the **⋮** menu, choose **Repositories**, and add `https://github.com/mpoppell/ha-wellbeing-tracker`.
3. Find **Wellbeing Tracker** in the store, install it, then start it with **Show in sidebar** turned on.

## Roadmap

| Stage | What it adds | Status |
| --- | --- | --- |
| 1 | App skeleton, sidebar panel, per-user profiles | ✅ 0.1.0 |
| 2 | Logging: mood & energy, symptoms, medications, factors | Next |
| 3 | Home Assistant link: import sleep, meds and weather; publish entities over MQTT | Planned |
| 4 | Calendar view and history charts | Planned |
| 5 | Reminder notifications | Planned |
| v2 | Correlation insights | Later |

## Development

```bash
cd wellbeing_tracker
pip install -r requirements.txt pytest
python -m pytest
WELLBEING_DEV=1 WELLBEING_DATA_DIR=./devdata python -m app.main   # http://localhost:8099
```

In dev mode the app accepts requests from anywhere and treats you as a "Developer" user. Inside Home Assistant it only accepts requests through ingress.
