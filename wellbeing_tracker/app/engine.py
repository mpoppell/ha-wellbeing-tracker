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
from datetime import datetime, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from .db import Database, NotFound
from .schedule import (
    describe_time,
    due_times,
    in_quiet_hours,
    nag_params,
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
        clean = normalise_person_settings(data)
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
        amount = " ".join(x for x in (cfg.get("dose"), cfg.get("unit")) if x)
        return {
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
                    await self._fire(call[1], call[2], call[3], call[4])
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

    async def _fire(self, user_id: str, rid: int | None, stage: str, infos: list[dict]) -> None:
        with self.db.connect() as conn:
            u = conn.execute("SELECT display_name, username FROM users WHERE id = ?", (user_id,)).fetchone()
        await self.ha.fire_event(EVENT_TYPE, {
            "user_id": user_id,
            "person": (u["display_name"] or u["username"]) if u else None,
            "reminder_id": rid,
            "stage": stage,
            "medications": [i["name"] for i in infos],
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


def _join(names: list[str]) -> str:
    if len(names) <= 1:
        return names[0] if names else ""
    return ", ".join(names[:-1]) + " and " + names[-1]
