"""The reminder engine.

Every few seconds `tick()`:
  1. creates doses for today and tomorrow from each enabled medication schedule,
  2. turns doses that have reached their time into "due" (or straight to "taken"
     if the person already logged it early), grouping doses due at the same time
     into one reminder,
  3. moves doses past their latest time into a single "last call" reminder,
  4. marks doses from earlier days (or superseded by a newer dose) as missed,
  5. sends or repeats reminders whose time has come, escalating if set up to.

People answer from a notification button, the Due now card, the Check-in
screen, or a linked Home Assistant toggle. All of them end up in the same
`_resolve()` so every path clears the notification everywhere and fires the
same Home Assistant events.

All times in the database are UTC ISO strings, so they sort and compare as text.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from .db import Database, NotFound
from .schedule import (
    describe_time,
    due_times,
    in_quiet_hours,
    nag_params,
    runs_on,
    normalise_person_settings,
    normalise_schedule,
    person_settings,
    schedule_settings,
)
from .trackers import ValidationError

log = logging.getLogger(__name__)

EVENT_TYPE = "wellbeing_tracker_reminder"
ACTION_PREFIX = "WBT_"
UNDO_WINDOW = timedelta(minutes=15)
TOGGLE_ECHO = timedelta(seconds=30)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value)


@dataclass
class Outbox:
    """Home Assistant calls collected while the database is locked, sent afterwards."""

    calls: list[tuple] = field(default_factory=list)

    def add(self, kind: str, *args) -> None:
        self.calls.append((kind, *args))


class Engine:
    def __init__(
        self,
        db: Database,
        ha,
        tz: ZoneInfo | None = None,
        panel_path: str | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.db = db
        self.ha = ha
        self.tz = tz or ZoneInfo("UTC")
        self.panel_path = panel_path
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.lock = asyncio.Lock()
        self._toggle_echo: dict[str, datetime] = {}

    # ================= settings =================

    def get_person(self, user_id: str) -> dict:
        with self.db.connect() as conn:
            row = conn.execute("SELECT settings FROM person_settings WHERE user_id = ?", (user_id,)).fetchone()
        return person_settings(json.loads(row["settings"]) if row else None)

    def save_person(self, user_id: str, data: dict) -> dict:
        """Save person settings. Anything not included keeps its current value."""
        current = self.get_person(user_id)
        merged = {**current, **data}
        for group in ("checkins", "hydration"):
            if isinstance(data.get(group), dict):
                merged[group] = {**current[group], **data[group]}
        clean = normalise_person_settings(merged)
        clean["checkins_from"] = current.get("checkins_from")
        if clean["checkins"] != current["checkins"] or (clean["checkins"]["enabled"] and not clean["checkins_from"]):
            clean["checkins_from"] = iso(self.clock())
            with self.db.connect() as conn:
                conn.execute("DELETE FROM checkins WHERE user_id = ? AND status = 'scheduled'", (user_id,))
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO person_settings (user_id, settings) VALUES (?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings",
                (user_id, json.dumps(clean)),
            )
        return clean

    def get_schedule(self, user_id: str, tracker_id: int) -> dict:
        tracker = self.db.get_tracker(user_id, tracker_id)
        if tracker["kind"] != "medication":
            raise ValidationError("Reminders are for medications")
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM schedules WHERE tracker_id = ?", (tracker_id,)).fetchone()
        if not row:
            return {"enabled": False, "settings": schedule_settings(None)}
        return {"enabled": bool(row["enabled"]), "settings": schedule_settings(json.loads(row["settings"]))}

    async def save_schedule(self, user_id: str, tracker_id: int, enabled: bool, data: dict) -> dict:
        tracker = self.db.get_tracker(user_id, tracker_id)
        if tracker["kind"] != "medication":
            raise ValidationError("Reminders are for medications")
        clean = normalise_schedule(data)
        for rule in clean["after"]:
            target = self.db.get_tracker(user_id, rule["tracker_id"])  # NotFound if not theirs
            if target["kind"] != "medication":
                raise ValidationError("Reminders can only be timed from a medication")
        now = self.clock()
        out = Outbox()
        async with self.lock:
            with self.db.connect() as conn:
                conn.execute(
                    """
                    INSERT INTO schedules (tracker_id, user_id, enabled, settings, active_from, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(tracker_id) DO UPDATE SET
                        enabled = excluded.enabled, settings = excluded.settings,
                        active_from = excluded.active_from, updated_at = excluded.updated_at
                    """,
                    (tracker_id, user_id, int(bool(enabled)), json.dumps(clean), iso(now), iso(now)),
                )
                # Future doses follow the new settings; anything already due stays.
                conn.execute("DELETE FROM doses WHERE tracker_id = ? AND status = 'scheduled'", (tracker_id,))
                if not enabled:
                    rids = self._cancel_due(conn, tracker_id, now)
                    for rid in rids:
                        self._rerender(conn, rid, now, out)
            await self._flush(out)
        await self.tick()
        return self.get_schedule(user_id, tracker_id)

    def _cancel_due(self, conn, tracker_id: int, now: datetime) -> set[int]:
        rows = conn.execute(
            "SELECT id, reminder_id FROM doses WHERE tracker_id = ? AND status = 'due'", (tracker_id,)
        ).fetchall()
        conn.execute(
            "UPDATE doses SET status = 'cancelled', resolved_at = ?, resolved_by = 'settings' "
            "WHERE tracker_id = ? AND status = 'due'",
            (iso(now), tracker_id),
        )
        return {r["reminder_id"] for r in rows if r["reminder_id"]}

    # ================= main loop =================

    async def run(self, interval: float = 15) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Reminder check failed")
            await asyncio.sleep(interval)

    async def tick(self) -> None:
        async with self.lock:
            now = self.clock()
            out = Outbox()
            with self.db.connect() as conn:
                self._generate(conn, now)
                self._activate(conn, now, out)
                self._last_calls(conn, now, out)
                self._expire(conn, now, out)
                self._generate_checkins(conn, now)
                self._activate_checkins(conn, now, out)
                self._expire_checkins(conn, now, out)
                self._hydration(conn, now, out)
            await self._flush(out)
            await self._send_due(now)

    def _local_today(self, now: datetime):
        return now.astimezone(self.tz).date()

    def _generate(self, conn, now: datetime) -> None:
        today = self._local_today(now)
        rows = conn.execute(
            "SELECT s.* FROM schedules s JOIN trackers t ON t.id = s.tracker_id "
            "WHERE s.enabled = 1 AND t.hidden = 0"
        ).fetchall()
        for row in rows:
            s = schedule_settings(json.loads(row["settings"]))
            if s["mode"] == "after":
                self._generate_after(conn, row, s, now)
                continue
            for day in (today, today + timedelta(days=1)):
                for hhmm, due, latest in due_times(s, day, self.tz):
                    if iso(due) < row["active_from"]:
                        continue
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO doses (user_id, tracker_id, due_at, local_day, local_time,
                                                     latest_at, status)
                        VALUES (?, ?, ?, ?, ?, ?, 'scheduled')
                        """,
                        (row["user_id"], row["tracker_id"], iso(due), day.isoformat(), hhmm,
                         iso(latest) if latest else None),
                    )

    def _generate_after(self, conn, row, s: dict, now: datetime) -> None:
        """Doses timed from when another dose was actually taken, e.g. Dex 7 hours after Vyvanse."""
        tid = row["tracker_id"]
        today = self._local_today(now)
        # A dose whose anchor was undone or deleted no longer applies.
        conn.execute(
            "DELETE FROM doses WHERE tracker_id = ? AND derived = 1 AND status = 'scheduled' "
            "AND anchor_entry_id IS NULL",
            (tid,),
        )
        offsets = {r["tracker_id"]: r["minutes"] for r in s["after"]}
        if not offsets:
            return
        marks = ",".join("?" * len(offsets))
        entries = conn.execute(
            f"""
            SELECT e.id, e.tracker_id, e.logged_at FROM entries e
            WHERE e.user_id = ? AND e.tracker_id IN ({marks}) AND e.day >= ?
              AND NOT EXISTS (SELECT 1 FROM doses d WHERE d.tracker_id = ? AND d.anchor_entry_id = e.id)
            ORDER BY e.logged_at
            """,
            (row["user_id"], *offsets, (today - timedelta(days=1)).isoformat(), tid),
        ).fetchall()
        # Only time from doses taken since the last answered one, so an old log can't
        # produce a reminder that's already overdue. A dose taken early still counts.
        last = conn.execute(
            "SELECT due_at FROM doses WHERE tracker_id = ? AND status IN ('taken', 'skipped', 'missed') "
            "ORDER BY due_at DESC LIMIT 1",
            (tid,),
        ).fetchone()
        linked = {r[0] for r in conn.execute(
            "SELECT entry_id FROM doses WHERE tracker_id = ? AND entry_id IS NOT NULL", (tid,))}
        for e in entries:
            logged = parse(e["logged_at"])
            if last and e["id"] not in linked and logged < parse(last["due_at"]):
                continue
            due = logged + timedelta(minutes=offsets[e["tracker_id"]])
            if iso(due) < row["active_from"]:
                continue
            local = due.astimezone(self.tz)
            day = local.date()
            if day not in (today, today + timedelta(days=1)):
                continue
            latest = None
            if s["latest_time"]:
                h, m = map(int, s["latest_time"].split(":"))
                latest = datetime.combine(day, time(h, m), self.tz)
                if due >= latest:
                    continue  # too late in the day to start another
            pending = conn.execute(
                "SELECT 1 FROM doses WHERE tracker_id = ? AND status IN ('scheduled', 'due') LIMIT 1", (tid,)
            ).fetchone()
            if pending:
                continue  # one at a time: the next is timed from whenever this one is taken
            if s["max_per_day"]:
                count = conn.execute(
                    "SELECT COUNT(*) FROM doses WHERE tracker_id = ? AND derived = 1 AND local_day = ? "
                    "AND status != 'cancelled'",
                    (tid, day.isoformat()),
                ).fetchone()[0]
                if count >= s["max_per_day"]:
                    continue
            conn.execute(
                """
                INSERT OR IGNORE INTO doses (user_id, tracker_id, due_at, local_day, local_time, latest_at,
                                             status, derived, anchor_entry_id)
                VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 1, ?)
                """,
                (row["user_id"], tid, iso(due), day.isoformat(), local.strftime("%H:%M"),
                 iso(latest) if latest else None, e["id"]),
            )

    def _schedule_for(self, conn, tracker_id: int) -> dict:
        row = conn.execute("SELECT settings FROM schedules WHERE tracker_id = ?", (tracker_id,)).fetchone()
        return schedule_settings(json.loads(row["settings"]) if row else None)

    def _person_for(self, conn, user_id: str) -> dict:
        row = conn.execute("SELECT settings FROM person_settings WHERE user_id = ?", (user_id,)).fetchone()
        return person_settings(json.loads(row["settings"]) if row else None)

    def _logged_early(self, conn, dose, now: datetime) -> int | None:
        """An unlinked medication entry logged in the early window before this dose, if any."""
        s = self._schedule_for(conn, dose["tracker_id"])
        start = parse(dose["due_at"]) - timedelta(minutes=s["early_window"])
        candidates = conn.execute(
            """
            SELECT e.id, e.logged_at FROM entries e
            WHERE e.tracker_id = ? AND e.user_id = ?
              AND NOT EXISTS (SELECT 1 FROM doses d WHERE d.entry_id = e.id)
            ORDER BY e.logged_at
            """,
            (dose["tracker_id"], dose["user_id"]),
        ).fetchall()
        for c in candidates:
            when = parse(c["logged_at"])
            if start <= when <= now:
                return c["id"]
        return None

    def _activate(self, conn, now: datetime, out: Outbox) -> None:
        today = self._local_today(now).isoformat()
        doses = conn.execute(
            "SELECT * FROM doses WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at",
            (iso(now),),
        ).fetchall()
        for dose in doses:
            if dose["local_day"] < today:
                conn.execute(
                    "UPDATE doses SET status = 'missed', resolved_at = ?, resolved_by = 'auto' WHERE id = ?",
                    (iso(now), dose["id"]),
                )
                continue
            early = self._logged_early(conn, dose, now)
            if early:
                conn.execute(
                    "UPDATE doses SET status = 'taken', entry_id = ?, resolved_at = ?, resolved_by = 'early' "
                    "WHERE id = ?",
                    (early, iso(now), dose["id"]),
                )
                continue
            # An older dose of the same medication still waiting is now missed.
            older = conn.execute(
                "SELECT id, reminder_id FROM doses WHERE tracker_id = ? AND status = 'due' AND due_at < ?",
                (dose["tracker_id"], dose["due_at"]),
            ).fetchall()
            for o in older:
                self._mark_missed(conn, o["id"], now, out)
            person = self._person_for(conn, dose["user_id"])
            rid = None
            if person["group_doses"]:
                r = conn.execute(
                    "SELECT id FROM reminders WHERE user_id = ? AND kind = 'dose' AND due_at = ? "
                    "AND status IN ('active', 'snoozed')",
                    (dose["user_id"], dose["due_at"]),
                ).fetchone()
                rid = r["id"] if r else None
            if rid is None:
                cur = conn.execute(
                    "INSERT INTO reminders (user_id, kind, due_at, status, next_at, created_at, updated_at) "
                    "VALUES (?, 'dose', ?, 'active', ?, ?, ?)",
                    (dose["user_id"], dose["due_at"], iso(now), iso(now), iso(now)),
                )
                rid = cur.lastrowid
            else:
                # joining a reminder that may already have gone out: send it again now
                conn.execute("UPDATE reminders SET next_at = ? WHERE id = ? AND sends = 0", (iso(now), rid))
            conn.execute("UPDATE doses SET status = 'due', reminder_id = ? WHERE id = ?", (rid, dose["id"]))
            for o in older:
                if o["reminder_id"]:
                    self._rerender(conn, o["reminder_id"], now, out)

    def _last_calls(self, conn, now: datetime, out: Outbox) -> None:
        """Doses past their latest time leave their reminder for one 'skip or take anyway?' question."""
        doses = conn.execute(
            """
            SELECT d.* FROM doses d JOIN reminders r ON r.id = d.reminder_id
            WHERE d.status = 'due' AND d.latest_at IS NOT NULL AND d.latest_at <= ? AND r.kind = 'dose'
            ORDER BY d.latest_at
            """,
            (iso(now),),
        ).fetchall()
        touched: set[int] = set()
        for dose in doses:
            person = self._person_for(conn, dose["user_id"])
            rid = None
            if person["group_doses"]:
                r = conn.execute(
                    "SELECT id FROM reminders WHERE user_id = ? AND kind = 'last_call' AND due_at = ? "
                    "AND status = 'active' AND sends = 0",
                    (dose["user_id"], dose["latest_at"]),
                ).fetchone()
                rid = r["id"] if r else None
            if rid is None:
                cur = conn.execute(
                    "INSERT INTO reminders (user_id, kind, due_at, status, next_at, created_at, updated_at) "
                    "VALUES (?, 'last_call', ?, 'active', ?, ?, ?)",
                    (dose["user_id"], dose["latest_at"], iso(now), iso(now), iso(now)),
                )
                rid = cur.lastrowid
            touched.add(dose["reminder_id"])
            conn.execute("UPDATE doses SET reminder_id = ? WHERE id = ?", (rid, dose["id"]))
        for old in touched:
            self._rerender(conn, old, now, out)

    def _expire(self, conn, now: datetime, out: Outbox) -> None:
        today = self._local_today(now).isoformat()
        stale = conn.execute(
            "SELECT id, reminder_id FROM doses WHERE status = 'due' AND local_day < ?", (today,)
        ).fetchall()
        rids = set()
        for d in stale:
            self._mark_missed(conn, d["id"], now, out)
            if d["reminder_id"]:
                rids.add(d["reminder_id"])
        for rid in rids:
            self._rerender(conn, rid, now, out)

    def _mark_missed(self, conn, dose_id: int, now: datetime, out: Outbox) -> None:
        conn.execute(
            "UPDATE doses SET status = 'missed', resolved_at = ?, resolved_by = 'auto' WHERE id = ?",
            (iso(now), dose_id),
        )
        dose = conn.execute("SELECT * FROM doses WHERE id = ?", (dose_id,)).fetchone()
        out.add("event", dose["user_id"], dose["reminder_id"], "missed", [self._dose_info(conn, dose)])

    # ================= sending =================

    async def _send_due(self, now: datetime) -> None:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM reminders WHERE status IN ('active', 'snoozed') AND next_at IS NOT NULL "
                "AND next_at <= ? ORDER BY next_at",
                (iso(now),),
            ).fetchall()
        for r in rows:
            out = Outbox()
            with self.db.connect() as conn:
                self._send_one(conn, r["id"], now, out)
            await self._flush(out)

    def _due_doses(self, conn, rid: int) -> list:
        return conn.execute(
            "SELECT * FROM doses WHERE reminder_id = ? AND status = 'due' ORDER BY tracker_id", (rid,)
        ).fetchall()

    def _send_one(self, conn, rid: int, now: datetime, out: Outbox) -> None:
        r = conn.execute("SELECT * FROM reminders WHERE id = ?", (rid,)).fetchone()
        if r["kind"] == "checkin":
            self._send_checkin(conn, r, now, out)
            return
        if r["kind"] == "hydration":
            self._send_hydration(conn, r, now, out)
            return
        doses = self._due_doses(conn, rid)
        if not doses:
            self._close(conn, r, now, out)
            return
        person = self._person_for(conn, r["user_id"])
        infos = [self._dose_info(conn, d) for d in doses]
        sends = r["sends"] + 1

        if r["kind"] == "last_call":
            out.add("notify", r["user_id"], self._render(r, infos, person, sends, escalate=False, alarm=False))
            out.add("event", r["user_id"], rid, "last_call", infos)
            conn.execute(
                "UPDATE reminders SET sends = ?, status = 'active', next_at = NULL, updated_at = ? WHERE id = ?",
                (sends, iso(now), rid),
            )
            return

        schedules = [self._schedule_for(conn, d["tracker_id"]) for d in doses]
        params = [nag_params(s) for s in schedules]
        everies = [p[0] for p in params if p[0]]
        every = min(everies) if everies else None
        repeats = None if any(p[1] is None for p in params) else max(p[1] for p in params)

        hard = [s for s in schedules if s["hard_to_miss"]]
        escalate = bool(hard) and sends >= min(s["hard_after"] for s in hard)
        quiet = in_quiet_hours(person, now.astimezone(self.tz))
        alarm = escalate and any(s["alarm_sound"] for s in hard) and not quiet
        out.add("notify", r["user_id"], self._render(r, infos, person, sends, escalate=escalate, alarm=alarm))
        out.add("event", r["user_id"], rid, "sent" if sends == 1 else "repeated", infos)
        if escalate and not r["escalated"]:
            out.add("event", r["user_id"], rid, "escalated", infos)
        announced = r["announced"]
        if escalate and not announced and any(s["announce"] for s in hard) and not quiet:
            out.add("announce", r["user_id"], rid, infos)
            announced = 1

        exhausted = every is None or (repeats is not None and sends - 1 >= repeats)
        next_at = None if exhausted else iso(now + timedelta(minutes=every))
        conn.execute(
            "UPDATE reminders SET sends = ?, escalated = ?, announced = ?, status = 'active', next_at = ?, "
            "updated_at = ? WHERE id = ?",
            (sends, int(escalate or bool(r["escalated"])), announced, next_at, iso(now), rid),
        )

    def _rerender(self, conn, rid: int | None, now: datetime, out: Outbox) -> None:
        """After doses leave a reminder: close it if empty, otherwise update it quietly."""
        if not rid:
            return
        r = conn.execute("SELECT * FROM reminders WHERE id = ?", (rid,)).fetchone()
        if not r or r["status"] not in ("active", "snoozed"):
            return
        doses = self._due_doses(conn, rid)
        if not doses:
            self._close(conn, r, now, out)
            return
        if r["sends"] and r["status"] == "active":
            person = self._person_for(conn, r["user_id"])
            infos = [self._dose_info(conn, d) for d in doses]
            payload = self._render(r, infos, person, r["sends"], escalate=bool(r["escalated"]), alarm=False)
            payload["data"]["alert_once"] = True
            out.add("notify", r["user_id"], payload)

    def _close(self, conn, r, now: datetime, out: Outbox) -> None:
        conn.execute(
            "UPDATE reminders SET status = 'done', next_at = NULL, updated_at = ? WHERE id = ?",
            (iso(now), r["id"]),
        )
        if r["sends"]:
            out.add("clear", r["user_id"], self._tag(r["id"]))

    @staticmethod
    def _tag(rid: int) -> str:
        return f"wbt-reminder-{rid}"

    def _dose_info(self, conn, dose) -> dict:
        t = conn.execute("SELECT name, emoji, config FROM trackers WHERE id = ?", (dose["tracker_id"],)).fetchone()
        cfg = json.loads(t["config"]) if t else {}
        amount = " ".join(str(x) for x in (cfg.get("dose"), cfg.get("unit")) if x not in (None, ""))
        because = None
        if dose["anchor_entry_id"]:
            a = conn.execute(
                "SELECT t.name, e.logged_at FROM entries e JOIN trackers t ON t.id = e.tracker_id WHERE e.id = ?",
                (dose["anchor_entry_id"],),
            ).fetchone()
            if a:
                gap = parse(dose["due_at"]) - parse(a["logged_at"])
                because = f"{_hours(gap)} after your {a['name']} at {describe_time(parse(a['logged_at']).strftime('%H:%M'))}"
        return {
            "because": because,
            "dose_id": dose["id"],
            "tracker_id": dose["tracker_id"],
            "name": t["name"] if t else "Medication",
            "amount": amount,
            "notes": cfg.get("notes") or "",
            "time": dose["local_time"],
            "latest": parse(dose["latest_at"]).astimezone(self.tz).strftime("%H:%M") if dose["latest_at"] else None,
        }

    def _render(self, r, infos: list[dict], person: dict, sends: int, escalate: bool, alarm: bool) -> dict:
        names = [i["name"] for i in infos]
        when = describe_time(infos[0]["time"])
        lines = []
        for i in infos:
            line = i["name"] + (f" {i['amount']}" if i["amount"] else "")
            if i["notes"]:
                line += f". {i['notes']}"
            if i.get("because") and len(infos) == 1:
                line += f"\n{i['because'][0].upper()}{i['because'][1:]}"
            lines.append(line)
        rid = r["id"]
        data = {
            "tag": self._tag(rid),
            "group": "wellbeing-tracker",
            "importance": "high",
            "priority": "high",
            "ttl": 0,
            "sticky": True,
            "persistent": not person["swipe_away"],
            "notification_icon": "mdi:pill",
            "color": "#2c5d86",
        }
        if self.panel_path:
            data["clickAction"] = self.panel_path

        if r["kind"] == "last_call":
            latest = describe_time(infos[0]["latest"]) if infos[0]["latest"] else "the latest time"
            title = f"It's past {latest} for {_join(names)}"
            message = "Skip it today, or take it anyway?"
            data["channel"] = "Medication reminders"
            data["actions"] = [
                {"action": f"{ACTION_PREFIX}TAKEN_{rid}", "title": "Taken"},
                {"action": f"{ACTION_PREFIX}SKIP_{rid}", "title": "Skip today"},
            ]
            return {"title": title, "message": message, "data": data}

        title = f"Time for {names[0]}" if len(names) == 1 else f"Time for your {when} medications"
        message = "\n".join(lines)
        if sends > 1:
            message = f"Due since {when}. " + message
        if alarm:
            data["channel"] = "alarm_stream"
        elif escalate:
            data["channel"] = "Urgent medication reminders"
        else:
            data["channel"] = "Medication reminders"
        snooze = person["snooze_minutes"]
        data["actions"] = [
            {"action": f"{ACTION_PREFIX}TAKEN_{rid}", "title": "Taken"},
            {"action": f"{ACTION_PREFIX}SNOOZE_{rid}", "title": f"Snooze {snooze} min"},
            {
                "action": f"{ACTION_PREFIX}SKIP_{rid}",
                "title": "Skip",
                "behavior": "textInput",
                "textInputButtonTitle": "Skip",
                "textInputPlaceholder": "Reason (optional)",
            },
        ]
        return {"title": title, "message": message, "data": data}

    # ================= answering =================

    async def handle_event(self, event_type: str, data: dict) -> None:
        if event_type == "mobile_app_notification_action":
            action = str(data.get("action") or "")
            if not action.startswith(ACTION_PREFIX):
                return
            verb, _, rid = action[len(ACTION_PREFIX):].rpartition("_")
            if not rid.isdigit():
                return
            await self.answer_reminder(int(rid), verb, data.get("reply_text"), source="notification")
        elif event_type == "state_changed":
            entity = data.get("entity_id", "")
            if not entity.startswith("input_boolean."):
                return
            old = (data.get("old_state") or {}).get("state")
            new = (data.get("new_state") or {}).get("state")
            if old == "off" and new == "on":
                await self.toggle_turned_on(entity)

    async def answer_reminder(self, rid: int, verb: str, reply: str | None = None, source: str = "notification") -> None:
        async with self.lock:
            now = self.clock()
            out = Outbox()
            with self.db.connect() as conn:
                r = conn.execute("SELECT * FROM reminders WHERE id = ?", (rid,)).fetchone()
                if not r:
                    return
                if verb == "UNDO":
                    self._undo(conn, r, now, out)
                elif r["status"] not in ("active", "snoozed"):
                    out.add("clear", r["user_id"], self._tag(rid))  # already handled elsewhere
                elif r["kind"] == "checkin":
                    self._answer_checkin(conn, r, verb, now, source, out)
                elif r["kind"] == "hydration":
                    self._answer_hydration(conn, r, verb, now, out)
                elif verb == "SNOOZE" and r["kind"] == "dose":
                    person = self._person_for(conn, r["user_id"])
                    until = now + timedelta(minutes=person["snooze_minutes"])
                    conn.execute(
                        "UPDATE reminders SET status = 'snoozed', next_at = ?, updated_at = ? WHERE id = ?",
                        (iso(until), iso(now), rid),
                    )
                    out.add("clear", r["user_id"], self._tag(rid))
                    out.add("event", r["user_id"], rid, "snoozed", [self._dose_info(conn, d) for d in self._due_doses(conn, rid)])
                elif verb in ("TAKEN", "SKIP"):
                    doses = self._due_doses(conn, rid)
                    status = "taken" if verb == "TAKEN" else "skipped"
                    reason = (reply or "").strip()[:200] or None
                    infos = []
                    for d in doses:
                        infos.append(self._resolve(conn, d, status, now, source, reason, out))
                    conn.execute("UPDATE reminders SET answered_at = ? WHERE id = ?", (iso(now), rid))
                    self._close(conn, r, now, out)
                    if infos:
                        out.add("event", r["user_id"], rid, status, infos)
                        if source == "notification" and self._person_for(conn, r["user_id"])["undo"]:
                            out.add("notify", r["user_id"], self._undo_payload(rid, status, infos, now))
            await self._flush(out)

    def _resolve(self, conn, dose, status: str, now: datetime, source: str, reason: str | None,
                 out: Outbox, entry_id: int | None = None) -> dict:
        """Mark one dose taken or skipped. Taken doses get a log entry and update linked toggles."""
        if status == "taken" and entry_id is None:
            local = now.astimezone(self.tz)
            cur = conn.execute(
                """
                INSERT INTO entries (user_id, tracker_id, day, logged_at, value_num, value_json, note,
                                     source, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?)
                """,
                (dose["user_id"], dose["tracker_id"], local.date().isoformat(),
                 local.isoformat(timespec="seconds"), source, iso(now), iso(now)),
            )
            entry_id = cur.lastrowid
        conn.execute(
            "UPDATE doses SET status = ?, entry_id = ?, reason = ?, resolved_at = ?, resolved_by = ? WHERE id = ?",
            (status, entry_id if status == "taken" else None, reason, iso(now), source, dose["id"]),
        )
        if status == "taken":
            s = self._schedule_for(conn, dose["tracker_id"])
            if s["linked_entity"] and source != "toggle":
                out.add("toggle", s["linked_entity"], True)
            if s["linked_time_entity"]:
                out.add("set_time", s["linked_time_entity"], now.astimezone(self.tz))
        return self._dose_info(conn, dose)

    def _undo_payload(self, rid: int, status: str, infos: list[dict], now: datetime) -> dict:
        names = _join([i["name"] for i in infos])
        at = describe_time(now.astimezone(self.tz).strftime("%H:%M"))
        title = f"{names} taken at {at}" if status == "taken" else f"Skipped {names}"
        return {
            "title": title,
            "message": "Tap Undo if that was a mistake.",
            "data": {
                "tag": f"wbt-undo-{rid}",
                "group": "wellbeing-tracker",
                "channel": "Medication updates",
                "importance": "low",
                "timeout": 60,
                "notification_icon": "mdi:check",
                "actions": [{"action": f"{ACTION_PREFIX}UNDO_{rid}", "title": "Undo"}],
            },
        }

    def _undo(self, conn, r, now: datetime, out: Outbox) -> None:
        out.add("clear", r["user_id"], f"wbt-undo-{r['id']}")
        if not r["answered_at"] or now - parse(r["answered_at"]) > UNDO_WINDOW:
            return
        if r["kind"] == "checkin":
            self._undo_checkin(conn, r, now, out)
            return
        if r["kind"] == "hydration":
            self._undo_hydration(conn, r, now, out)
            return
        doses = conn.execute(
            "SELECT * FROM doses WHERE reminder_id = ? AND status IN ('taken', 'skipped') AND resolved_at >= ?",
            (r["id"], r["answered_at"]),
        ).fetchall()
        if not doses:
            return
        for d in doses:
            if d["entry_id"] and d["resolved_by"] == "notification":
                conn.execute("DELETE FROM entries WHERE id = ?", (d["entry_id"],))
            if d["status"] == "taken":
                s = self._schedule_for(conn, d["tracker_id"])
                if s["linked_entity"]:
                    out.add("toggle", s["linked_entity"], False)
            conn.execute(
                "UPDATE doses SET status = 'due', entry_id = NULL, reason = NULL, resolved_at = NULL, "
                "resolved_by = NULL WHERE id = ?",
                (d["id"],),
            )
        conn.execute(
            "UPDATE reminders SET status = 'active', next_at = ?, answered_at = NULL, updated_at = ? WHERE id = ?",
            (iso(now), iso(now), r["id"]),
        )
        out.add("event", r["user_id"], r["id"], "undone", [self._dose_info(conn, d) for d in doses])
        # sending again happens on the next tick

    async def answer_dose(self, user_id: str, dose_id: int, verb: str, reason: str | None = None) -> None:
        """Answer one dose from the app (Due now card)."""
        if verb not in ("taken", "skip", "snooze"):
            raise ValidationError("Unknown action")
        async with self.lock:
            now = self.clock()
            out = Outbox()
            with self.db.connect() as conn:
                dose = conn.execute(
                    "SELECT * FROM doses WHERE id = ? AND user_id = ?", (dose_id, user_id)
                ).fetchone()
                if not dose:
                    raise NotFound("Dose not found")
                if verb == "snooze":
                    if dose["status"] != "due" or not dose["reminder_id"]:
                        raise ValidationError("Only due reminders can be snoozed")
                    r = conn.execute("SELECT * FROM reminders WHERE id = ?", (dose["reminder_id"],)).fetchone()
                    if r["kind"] != "dose":
                        raise ValidationError("This one can only be taken or skipped")
                    person = self._person_for(conn, user_id)
                    until = now + timedelta(minutes=person["snooze_minutes"])
                    conn.execute(
                        "UPDATE reminders SET status = 'snoozed', next_at = ?, updated_at = ? WHERE id = ?",
                        (iso(until), iso(now), r["id"]),
                    )
                    out.add("clear", user_id, self._tag(r["id"]))
                    out.add("event", user_id, r["id"], "snoozed", [self._dose_info(conn, dose)])
                else:
                    if dose["status"] not in ("due", "scheduled"):
                        raise ValidationError("This dose has already been answered")
                    status = "taken" if verb == "taken" else "skipped"
                    info = self._resolve(conn, dose, status, now, "app", (reason or "").strip()[:200] or None, out)
                    out.add("event", user_id, dose["reminder_id"], status, [info])
                    self._rerender(conn, dose["reminder_id"], now, out)
            await self._flush(out)

    async def medication_logged(self, user_id: str, entries: list[dict]) -> None:
        """A medication was logged on the Check-in screen: it answers a due dose, if there is one."""
        async with self.lock:
            now = self.clock()
            out = Outbox()
            with self.db.connect() as conn:
                for e in entries:
                    dose = conn.execute(
                        "SELECT * FROM doses WHERE user_id = ? AND tracker_id = ? AND status = 'due' "
                        "ORDER BY due_at LIMIT 1",
                        (user_id, e["tracker_id"]),
                    ).fetchone()
                    if not dose:
                        continue
                    info = self._resolve(conn, dose, "taken", now, "app", None, out, entry_id=e["id"])
                    out.add("event", user_id, dose["reminder_id"], "taken", [info])
                    self._rerender(conn, dose["reminder_id"], now, out)
            await self._flush(out)

    async def toggle_turned_on(self, entity_id: str) -> None:
        """A linked Home Assistant toggle was switched on outside the app: count it as taken."""
        now = self.clock()
        echo = self._toggle_echo.get(entity_id)
        if echo and now - echo < TOGGLE_ECHO:
            return
        async with self.lock:
            out = Outbox()
            with self.db.connect() as conn:
                rows = conn.execute("SELECT tracker_id, user_id, settings FROM schedules WHERE enabled = 1").fetchall()
                for row in rows:
                    s = schedule_settings(json.loads(row["settings"]))
                    if s["linked_entity"] != entity_id:
                        continue
                    dose = conn.execute(
                        "SELECT * FROM doses WHERE tracker_id = ? AND status = 'due' ORDER BY due_at LIMIT 1",
                        (row["tracker_id"],),
                    ).fetchone()
                    if dose:
                        info = self._resolve(conn, dose, "taken", now, "toggle", None, out)
                        out.add("event", row["user_id"], dose["reminder_id"], "taken", [info])
                        self._rerender(conn, dose["reminder_id"], now, out)
                    else:
                        # Taken before the reminder: log it so the upcoming dose counts it as early.
                        local = now.astimezone(self.tz)
                        conn.execute(
                            """
                            INSERT INTO entries (user_id, tracker_id, day, logged_at, value_num, source,
                                                 created_at, updated_at)
                            VALUES (?, ?, ?, ?, 1, 'toggle', ?, ?)
                            """,
                            (row["user_id"], row["tracker_id"], local.date().isoformat(),
                             local.isoformat(timespec="seconds"), iso(now), iso(now)),
                        )
            await self._flush(out)

    def linked_entities(self) -> set[str]:
        with self.db.connect() as conn:
            rows = conn.execute("SELECT settings FROM schedules WHERE enabled = 1").fetchall()
        return {e for r in rows if (e := schedule_settings(json.loads(r["settings"]))["linked_entity"])}

    # ================= what's due (for the app) =================

    def doses_today(self, user_id: str) -> list[dict]:
        now = self.clock()
        today = self._local_today(now).isoformat()
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT d.*, r.status AS reminder_status, r.next_at AS reminder_next, r.kind AS reminder_kind
                FROM doses d LEFT JOIN reminders r ON r.id = d.reminder_id
                WHERE d.user_id = ? AND (d.local_day = ? OR d.status = 'due')
                ORDER BY d.due_at, d.tracker_id
                """,
                (user_id, today),
            ).fetchall()
            out = []
            for d in rows:
                info = self._dose_info(conn, d)
                snoozed_until = None
                if d["status"] == "due" and d["reminder_status"] == "snoozed" and d["reminder_next"]:
                    snoozed_until = parse(d["reminder_next"]).astimezone(self.tz).strftime("%H:%M")
                resolved_local = (
                    parse(d["resolved_at"]).astimezone(self.tz).strftime("%H:%M") if d["resolved_at"] else None
                )
                out.append({
                    **info,
                    "status": d["status"],
                    "local_day": d["local_day"],
                    "reason": d["reason"],
                    "resolved_at": resolved_local,
                    "resolved_by": d["resolved_by"],
                    "snoozed_until": snoozed_until,
                    "last_call": d["reminder_kind"] == "last_call",
                })
            return out

    # ================= check-in reminders =================

    def _generate_checkins(self, conn, now: datetime) -> None:
        today = self._local_today(now)
        for row in conn.execute("SELECT user_id, settings FROM person_settings").fetchall():
            p = person_settings(json.loads(row["settings"]))
            c = p["checkins"]
            if not c["enabled"] or not p["checkins_from"]:
                continue
            rule = {"days": c["days"], "times": c["times"], "latest_time": None}
            for day in (today, today + timedelta(days=1)):
                for hhmm, due, _ in due_times(rule, day, self.tz):
                    if iso(due) < p["checkins_from"]:
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO checkins (user_id, due_at, local_day, local_time, status) "
                        "VALUES (?, ?, ?, ?, 'scheduled')",
                        (row["user_id"], iso(due), day.isoformat(), hhmm),
                    )

    def _activate_checkins(self, conn, now: datetime, out: Outbox) -> None:
        today = self._local_today(now).isoformat()
        rows = conn.execute(
            "SELECT * FROM checkins WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at", (iso(now),)
        ).fetchall()
        for ck in rows:
            c = self._person_for(conn, ck["user_id"])["checkins"]
            if ck["local_day"] < today or not c["enabled"]:
                self._end_checkin(conn, ck, "expired", now, "auto", out, quiet=True)
                continue
            if c["skip_if_recent"]:
                since = iso(parse(ck["due_at"]) - timedelta(minutes=c["skip_if_recent"]))
                recent = conn.execute(
                    "SELECT 1 FROM entries WHERE user_id = ? AND source = 'app' AND created_at >= ? LIMIT 1",
                    (ck["user_id"], since),
                ).fetchone()
                if recent:
                    self._end_checkin(conn, ck, "done", now, "early", out, quiet=True)
                    continue
            # An earlier check-in still waiting gives way to this one.
            for old in conn.execute(
                "SELECT * FROM checkins WHERE user_id = ? AND status = 'due'", (ck["user_id"],)
            ).fetchall():
                self._end_checkin(conn, old, "expired", now, "auto", out)
            cur = conn.execute(
                "INSERT INTO reminders (user_id, kind, due_at, status, next_at, created_at, updated_at) "
                "VALUES (?, 'checkin', ?, 'active', ?, ?, ?)",
                (ck["user_id"], ck["due_at"], iso(now), iso(now), iso(now)),
            )
            conn.execute("UPDATE checkins SET status = 'due', reminder_id = ? WHERE id = ?", (cur.lastrowid, ck["id"]))

    def _expire_checkins(self, conn, now: datetime, out: Outbox) -> None:
        today = self._local_today(now).isoformat()
        for ck in conn.execute("SELECT * FROM checkins WHERE status = 'due'").fetchall():
            c = self._person_for(conn, ck["user_id"])["checkins"]
            too_old = parse(ck["due_at"]) + timedelta(minutes=c["expire_after"]) <= now
            if not c["enabled"] or ck["local_day"] < today or too_old:
                self._end_checkin(conn, ck, "expired", now, "auto", out)

    def _end_checkin(self, conn, ck, status: str, now: datetime, by: str, out: Outbox,
                     quiet: bool = False, entry_id: int | None = None) -> None:
        conn.execute(
            "UPDATE checkins SET status = ?, resolved_at = ?, resolved_by = ?, entry_id = COALESCE(?, entry_id) "
            "WHERE id = ?",
            (status, iso(now), by, entry_id, ck["id"]),
        )
        if ck["reminder_id"]:
            r = conn.execute("SELECT * FROM reminders WHERE id = ?", (ck["reminder_id"],)).fetchone()
            if r and r["status"] in ("active", "snoozed"):
                self._close(conn, r, now, out)
        if not quiet:
            stage = {"done": "checked_in", "skipped": "skipped", "expired": "expired"}[status]
            out.add("event", ck["user_id"], ck["reminder_id"], stage,
                    [{"name": "Check-in", "time": ck["local_time"]}], "checkin")

    def _mood_tracker(self, conn, user_id: str):
        row = conn.execute(
            "SELECT * FROM trackers WHERE user_id = ? AND key = 'mood' AND kind = 'rating' AND hidden = 0",
            (user_id,),
        ).fetchone()
        return dict(row, config=json.loads(row["config"])) if row else None

    @staticmethod
    def _mood_choices(mood: dict) -> list[tuple[int, str]]:
        """Three quick answers that fit Android's three buttons: good, middle, bad."""
        cfg = mood["config"]
        lo, hi = cfg["min"], cfg["max"]
        # roughly three-quarters, half and a quarter of the way up the scale
        values = [int(lo + (hi - lo) * f + 0.5) for f in (0.75, 0.5, 0.25)]
        labels = cfg.get("labels") or []
        out = []
        for v in dict.fromkeys(values):
            out.append((v, labels[v - lo] if labels else str(v)))
        return out

    def _send_checkin(self, conn, r, now: datetime, out: Outbox) -> None:
        ck = conn.execute("SELECT * FROM checkins WHERE reminder_id = ?", (r["id"],)).fetchone()
        if not ck or ck["status"] != "due":
            self._close(conn, r, now, out)
            return
        person = self._person_for(conn, r["user_id"])
        c = person["checkins"]
        sends = r["sends"] + 1
        rid = r["id"]
        mood = self._mood_tracker(conn, r["user_id"]) if c["buttons"] == "mood" else None
        data = {
            "tag": self._tag(rid),
            "group": "wellbeing-checkins",
            "channel": "Check-in reminders",
            "importance": "default",
            "notification_icon": "mdi:emoticon-happy-outline",
            "color": "#2c5d86",
        }
        if self.panel_path:
            data["clickAction"] = self.panel_path
        if mood:
            message = "How are you feeling? Tap an answer to log your mood, or open the app to fill in the rest."
            data["actions"] = [{"action": f"{ACTION_PREFIX}MOOD_{v}_{rid}", "title": label}
                               for v, label in self._mood_choices(mood)]
        else:
            message = "How are you feeling? Tap to fill in your check-in."
            data["actions"] = [
                {"action": f"{ACTION_PREFIX}SNOOZE_{rid}", "title": f"Snooze {person['snooze_minutes']} min"},
                {"action": f"{ACTION_PREFIX}SKIP_{rid}", "title": "Not now"},
            ]
        title = "Time to check in" if sends == 1 else "Reminder: time to check in"
        out.add("notify", r["user_id"], {"title": title, "message": message, "data": data})
        out.add("event", r["user_id"], rid, "sent" if sends == 1 else "repeated",
                [{"name": "Check-in", "time": ck["local_time"]}], "checkin")
        every, repeats = nag_params(c)
        exhausted = every is None or (repeats is not None and sends - 1 >= repeats)
        conn.execute(
            "UPDATE reminders SET sends = ?, status = 'active', next_at = ?, updated_at = ? WHERE id = ?",
            (sends, None if exhausted else iso(now + timedelta(minutes=every)), iso(now), rid),
        )

    def _answer_checkin(self, conn, r, verb: str, now: datetime, source: str, out: Outbox) -> None:
        ck = conn.execute("SELECT * FROM checkins WHERE reminder_id = ?", (r["id"],)).fetchone()
        if not ck or ck["status"] != "due":
            out.add("clear", r["user_id"], self._tag(r["id"]))
            return
        person = self._person_for(conn, r["user_id"])
        if verb == "SNOOZE":
            until = now + timedelta(minutes=person["snooze_minutes"])
            conn.execute(
                "UPDATE reminders SET status = 'snoozed', next_at = ?, updated_at = ? WHERE id = ?",
                (iso(until), iso(now), r["id"]),
            )
            out.add("clear", r["user_id"], self._tag(r["id"]))
            out.add("event", r["user_id"], r["id"], "snoozed", [{"name": "Check-in", "time": ck["local_time"]}], "checkin")
            return
        conn.execute("UPDATE reminders SET answered_at = ? WHERE id = ?", (iso(now), r["id"]))
        if verb == "SKIP":
            self._end_checkin(conn, ck, "skipped", now, source, out)
            return
        if not verb.startswith("MOOD_"):
            return
        mood = self._mood_tracker(conn, r["user_id"])
        try:
            value = int(verb[len("MOOD_"):])
        except ValueError:
            return
        if not mood or not mood["config"]["min"] <= value <= mood["config"]["max"]:
            self._end_checkin(conn, ck, "done", now, source, out)
            return
        local = now.astimezone(self.tz)
        cur = conn.execute(
            """
            INSERT INTO entries (user_id, tracker_id, day, logged_at, value_num, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'notification', ?, ?)
            """,
            (r["user_id"], mood["id"], local.date().isoformat(), local.isoformat(timespec="seconds"),
             value, iso(now), iso(now)),
        )
        self._end_checkin(conn, ck, "done", now, source, out, entry_id=cur.lastrowid)
        if person["undo"]:
            labels = mood["config"].get("labels") or []
            label = labels[value - mood["config"]["min"]] if labels else str(value)
            out.add("notify", r["user_id"], {
                "title": f"Mood logged: {label}",
                "message": "Open the app to add more, or tap Undo if that was a mistake.",
                "data": {
                    "tag": f"wbt-undo-{r['id']}",
                    "group": "wellbeing-checkins",
                    "channel": "Check-in reminders",
                    "importance": "low",
                    "timeout": 60,
                    "notification_icon": "mdi:check",
                    **({"clickAction": self.panel_path} if self.panel_path else {}),
                    "actions": [{"action": f"{ACTION_PREFIX}UNDO_{r['id']}", "title": "Undo"}],
                },
            })

    def _undo_checkin(self, conn, r, now: datetime, out: Outbox) -> None:
        ck = conn.execute("SELECT * FROM checkins WHERE reminder_id = ?", (r["id"],)).fetchone()
        if not ck or ck["status"] not in ("done", "skipped") or ck["resolved_by"] != "notification":
            return
        if ck["entry_id"]:
            conn.execute("DELETE FROM entries WHERE id = ?", (ck["entry_id"],))
        conn.execute(
            "UPDATE checkins SET status = 'due', entry_id = NULL, resolved_at = NULL, resolved_by = NULL WHERE id = ?",
            (ck["id"],),
        )
        conn.execute(
            "UPDATE reminders SET status = 'active', next_at = ?, answered_at = NULL, updated_at = ? WHERE id = ?",
            (iso(now), iso(now), r["id"]),
        )
        out.add("event", r["user_id"], r["id"], "undone", [{"name": "Check-in", "time": ck["local_time"]}], "checkin")

    async def checkin_logged(self, user_id: str) -> None:
        """Something was saved on the Check-in screen: that answers any check-in reminder waiting."""
        async with self.lock:
            now = self.clock()
            out = Outbox()
            with self.db.connect() as conn:
                for ck in conn.execute(
                    "SELECT * FROM checkins WHERE user_id = ? AND status = 'due'", (user_id,)
                ).fetchall():
                    self._end_checkin(conn, ck, "done", now, "app", out)
            await self._flush(out)

    def next_checkin(self, user_id: str) -> str | None:
        """Local time of the next check-in reminder today, for the app."""
        now = self.clock()
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT local_time FROM checkins WHERE user_id = ? AND status = 'scheduled' AND local_day = ? "
                "ORDER BY due_at LIMIT 1",
                (user_id, self._local_today(now).isoformat()),
            ).fetchone()
        return row["local_time"] if row else None

    # ================= water reminders =================

    def _water_tracker(self, conn, user_id: str, h: dict):
        if h["tracker_id"]:
            row = conn.execute(
                "SELECT * FROM trackers WHERE id = ? AND user_id = ? AND hidden = 0", (h["tracker_id"], user_id)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM trackers WHERE user_id = ? AND key = 'water' AND hidden = 0", (user_id,)
            ).fetchone()
        if not row or row["kind"] != "factor":
            return None
        t = dict(row, config=json.loads(row["config"]))
        return t if t["config"].get("mode") in ("count", "amount") else None

    @staticmethod
    def _water_total(conn, tracker: dict, day: str) -> float:
        total = conn.execute(
            "SELECT COALESCE(SUM(value_num), 0) FROM entries WHERE tracker_id = ? AND day = ?", (tracker["id"], day)
        ).fetchone()[0]
        return int(total) if total == int(total) else total

    def _hydration(self, conn, now: datetime, out: Outbox) -> None:
        local = now.astimezone(self.tz)
        today = local.date()
        hhmm = local.strftime("%H:%M")
        for row in conn.execute("SELECT user_id, settings FROM person_settings").fetchall():
            user_id = row["user_id"]
            h = person_settings(json.loads(row["settings"]))["hydration"]
            active = conn.execute(
                "SELECT * FROM reminders WHERE user_id = ? AND kind = 'hydration' AND status IN ('active', 'snoozed') "
                "ORDER BY id DESC LIMIT 1",
                (user_id,),
            ).fetchone()
            tracker = self._water_tracker(conn, user_id, h) if h["enabled"] else None
            in_window = bool(tracker) and runs_on(h, today) and h["start"] <= hhmm < h["end"]
            goal = tracker["config"].get("goal") if tracker else None
            total = self._water_total(conn, tracker, today.isoformat()) if tracker else 0
            if not in_window or (goal and total >= goal):
                if active:
                    self._close(conn, active, now, out)
                continue
            last_drink = conn.execute(
                "SELECT MAX(updated_at) FROM entries WHERE tracker_id = ? AND day = ?",
                (tracker["id"], today.isoformat()),
            ).fetchone()[0]
            if active:
                if last_drink and last_drink > active["created_at"]:
                    self._close(conn, active, now, out)  # had a drink since: no need to ask
                continue
            h_, m_ = map(int, h["start"].split(":"))
            window_start = iso(datetime.combine(today, time(h_, m_), self.tz))
            last_reminder = conn.execute(
                "SELECT MAX(created_at) FROM reminders WHERE user_id = ? AND kind = 'hydration'", (user_id,)
            ).fetchone()[0]
            since = max(window_start, last_drink or "", last_reminder or "")
            if parse(since) + timedelta(minutes=h["every"]) <= now:
                conn.execute(
                    "INSERT INTO reminders (user_id, kind, due_at, status, next_at, created_at, updated_at) "
                    "VALUES (?, 'hydration', ?, 'active', ?, ?, ?)",
                    (user_id, iso(now), iso(now), iso(now), iso(now)),
                )

    @staticmethod
    def _unit_for(n, unit: str) -> str:
        if not unit:
            return ""
        if n == 1:
            if unit.endswith("sses"):
                return unit[:-2]
            if unit.endswith("s") and len(unit) > 3:
                return unit[:-1]
        return unit

    def _water_steps(self, tracker: dict, h: dict) -> list[tuple[float, str]]:
        unit = tracker["config"].get("unit", "")
        if tracker["config"]["mode"] == "amount":
            a = h["amount"]
            return [(a, f"+{a} {unit}".strip()), (a * 2, f"+{a * 2} {unit}".strip())]
        return [(1, f"+1 {self._unit_for(1, unit)}".strip()), (2, f"+2 {unit}".strip())]

    def _send_hydration(self, conn, r, now: datetime, out: Outbox) -> None:
        person = self._person_for(conn, r["user_id"])
        h = person["hydration"]
        tracker = self._water_tracker(conn, r["user_id"], h)
        if not tracker:
            self._close(conn, r, now, out)
            return
        rid = r["id"]
        local_day = now.astimezone(self.tz).date().isoformat()
        total = self._water_total(conn, tracker, local_day)
        unit = tracker["config"].get("unit", "")
        goal = tracker["config"].get("goal")
        so_far = f"{total} of {goal} {unit}" if goal else f"{total} {unit}"
        data = {
            "tag": self._tag(rid),
            "group": "wellbeing-water",
            "channel": "Water reminders",
            "importance": "default",
            "notification_icon": "mdi:cup-water",
            "color": "#2c5d86",
            "actions": [{"action": f"{ACTION_PREFIX}WATER_{v}_{rid}", "title": label}
                        for v, label in self._water_steps(tracker, h)]
                       + [{"action": f"{ACTION_PREFIX}SNOOZE_{rid}", "title": f"Snooze {person['snooze_minutes']} min"}],
        }
        if self.panel_path:
            data["clickAction"] = self.panel_path
        out.add("notify", r["user_id"], {
            "title": "Time for some water",
            "message": f"{so_far.strip()} so far today. Tap how much you've just had.",
            "data": data,
        })
        out.add("event", r["user_id"], rid, "sent", [], "hydration")
        conn.execute(
            "UPDATE reminders SET sends = sends + 1, status = 'active', next_at = NULL, updated_at = ? WHERE id = ?",
            (iso(now), rid),
        )

    def _answer_hydration(self, conn, r, verb: str, now: datetime, out: Outbox) -> None:
        person = self._person_for(conn, r["user_id"])
        if verb == "SNOOZE":
            until = now + timedelta(minutes=person["snooze_minutes"])
            conn.execute(
                "UPDATE reminders SET status = 'snoozed', next_at = ?, updated_at = ? WHERE id = ?",
                (iso(until), iso(now), r["id"]),
            )
            out.add("clear", r["user_id"], self._tag(r["id"]))
            out.add("event", r["user_id"], r["id"], "snoozed", [], "hydration")
            return
        if not verb.startswith("WATER_"):
            return
        tracker = self._water_tracker(conn, r["user_id"], person["hydration"])
        try:
            add = float(verb[len("WATER_"):])
        except ValueError:
            return
        if not tracker or not 0 < add <= 5000:
            return
        add = int(add) if add == int(add) else add
        local = now.astimezone(self.tz)
        day = local.date().isoformat()
        existing = None
        if tracker["frequency"] == "daily":
            existing = conn.execute(
                "SELECT id, value_num FROM entries WHERE tracker_id = ? AND day = ?", (tracker["id"], day)
            ).fetchone()
        if existing:
            conn.execute(
                "UPDATE entries SET value_num = value_num + ?, logged_at = ?, updated_at = ? WHERE id = ?",
                (add, local.isoformat(timespec="seconds"), iso(now), existing["id"]),
            )
            payload = {"entry_id": existing["id"], "before": existing["value_num"], "added": add}
        else:
            cur = conn.execute(
                "INSERT INTO entries (user_id, tracker_id, day, logged_at, value_num, source, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, 'notification', ?, ?)",
                (r["user_id"], tracker["id"], day, local.isoformat(timespec="seconds"), add, iso(now), iso(now)),
            )
            payload = {"entry_id": cur.lastrowid, "before": None, "added": add}
        conn.execute("UPDATE reminders SET answered_at = ?, payload = ? WHERE id = ?",
                     (iso(now), json.dumps(payload), r["id"]))
        self._close(conn, r, now, out)
        out.add("event", r["user_id"], r["id"], "logged", [], "hydration")
        if person["undo"]:
            unit = tracker["config"].get("unit", "")
            total = self._water_total(conn, tracker, day)
            goal = tracker["config"].get("goal")
            out.add("notify", r["user_id"], {
                "title": f"Logged {add} {self._unit_for(add, unit)}".strip(),
                "message": (f"{total} of {goal} {unit} today." if goal else f"{total} {unit} today.") + " Tap Undo if that was a mistake.",
                "data": {
                    "tag": f"wbt-undo-{r['id']}",
                    "group": "wellbeing-water",
                    "channel": "Water reminders",
                    "importance": "low",
                    "timeout": 60,
                    "notification_icon": "mdi:check",
                    "actions": [{"action": f"{ACTION_PREFIX}UNDO_{r['id']}", "title": "Undo"}],
                },
            })

    def _undo_hydration(self, conn, r, now: datetime, out: Outbox) -> None:
        if not r["payload"]:
            return
        p = json.loads(r["payload"])
        if p.get("before") is None:
            conn.execute("DELETE FROM entries WHERE id = ?", (p["entry_id"],))
        else:
            conn.execute("UPDATE entries SET value_num = ?, updated_at = ? WHERE id = ?",
                         (p["before"], iso(now), p["entry_id"]))
        conn.execute("UPDATE reminders SET payload = NULL, answered_at = NULL WHERE id = ?", (r["id"],))
        out.add("event", r["user_id"], r["id"], "undone", [], "hydration")

    # ================= editing logged doses =================

    async def entry_changed(self, user_id: str, entry_id: int) -> None:
        """A logged dose's time changed: reminders timed from it are worked out again."""
        async with self.lock:
            with self.db.connect() as conn:
                conn.execute(
                    "DELETE FROM doses WHERE user_id = ? AND anchor_entry_id = ? AND status = 'scheduled'",
                    (user_id, entry_id),
                )
        await self.tick()

    # ================= Home Assistant side effects =================

    async def _flush(self, out: Outbox) -> None:
        for call in out.calls:
            kind = call[0]
            try:
                if kind == "notify":
                    await self._notify(call[1], call[2])
                elif kind == "clear":
                    await self._notify(call[1], {"message": "clear_notification", "data": {"tag": call[2]}})
                elif kind == "event":
                    await self._fire(call[1], call[2], call[3], call[4], call[5] if len(call) > 5 else "medication")
                elif kind == "toggle":
                    self._toggle_echo[call[1]] = self.clock()
                    await self.ha.call_service("input_boolean", "turn_on" if call[2] else "turn_off",
                                               {"entity_id": call[1]})
                elif kind == "set_time":
                    await self.ha.call_service("input_datetime", "set_datetime", {
                        "entity_id": call[1], "datetime": call[2].strftime("%Y-%m-%d %H:%M:%S")})
                elif kind == "announce":
                    await self._announce(call[1], call[3])
            except Exception:
                log.exception("Home Assistant call %s failed", kind)

    async def _notify(self, user_id: str, payload: dict) -> None:
        person = self.get_person(user_id)
        for service in person["devices"]:
            await self.ha.call_service("notify", service, payload)

    async def _fire(self, user_id: str, rid: int | None, stage: str, infos: list[dict],
                    kind: str = "medication") -> None:
        with self.db.connect() as conn:
            u = conn.execute("SELECT display_name, username FROM users WHERE id = ?", (user_id,)).fetchone()
        await self.ha.fire_event(EVENT_TYPE, {
            "type": kind,
            "user_id": user_id,
            "person": (u["display_name"] or u["username"]) if u else None,
            "reminder_id": rid,
            "stage": stage,
            "medications": [i["name"] for i in infos] if kind == "medication" else [],
            "due": infos[0]["time"] if infos else None,
        })

    async def _announce(self, user_id: str, infos: list[dict]) -> None:
        person = self.get_person(user_id)
        if not person["speakers"] or not person["tts_entity"]:
            return
        if person["announce_only_home"]:
            if not await self._is_home(user_id, person):
                return
        with self.db.connect() as conn:
            u = conn.execute("SELECT display_name, username FROM users WHERE id = ?", (user_id,)).fetchone()
        first = ((u["display_name"] or u["username"] or "") if u else "").split(" ")[0]
        message = f"{first + ', ' if first else ''}it's time for your {_join([i['name'] for i in infos])}."
        await self.ha.call_service("tts", "speak", {
            "entity_id": person["tts_entity"],
            "media_player_entity_id": person["speakers"],
            "message": message,
        })

    async def _is_home(self, user_id: str, person: dict) -> bool:
        states = await self.ha.get_states()
        for s in states:
            eid = s.get("entity_id", "")
            if not eid.startswith("person."):
                continue
            if person["person_entity"] == eid or (
                not person["person_entity"] and s.get("attributes", {}).get("user_id") == user_id
            ):
                return s.get("state") == "home"
        return True  # no linked person: don't block the announcement

    async def send_test(self, user_id: str) -> int:
        person = self.get_person(user_id)
        if not person["devices"]:
            raise ValidationError("Choose at least one phone first")
        await self._notify(user_id, {
            "title": "Wellbeing reminders are working",
            "message": "This is how medication reminders will arrive.",
            "data": {"tag": "wbt-test", "channel": "Medication reminders", "importance": "high",
                     "notification_icon": "mdi:pill", "timeout": 120,
                     **({"clickAction": self.panel_path} if self.panel_path else {})},
        })
        return len(person["devices"])


def _hours(gap: timedelta) -> str:
    minutes = round(gap.total_seconds() / 60)
    h, m = divmod(minutes, 60)
    if h and m:
        return f"{h} h {m} min"
    if h:
        return f"{h} hour{'s' if h != 1 else ''}"
    return f"{m} minutes"


def _join(names: list[str]) -> str:
    if len(names) <= 1:
        return names[0] if names else ""
    return ", ".join(names[:-1]) + " and " + names[-1]
