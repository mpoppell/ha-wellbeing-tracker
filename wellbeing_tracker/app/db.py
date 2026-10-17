"""SQLite storage with simple, ordered migrations.

The database lives in the app's /data folder, so Home Assistant backups
include it automatically. Each migration runs once, in order, and the applied
version is stored in PRAGMA user_version.

Every query that touches trackers or entries is scoped by user_id, so one
person can never read or change another person's data.
"""

from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .trackers import (
    DEFAULT_FREQUENCY,
    FREQUENCIES,
    ValidationError,
    default_trackers,
    normalise_config,
    validate_value,
)

MIGRATIONS: list[str] = [
    # 1: people who use the app, keyed by their Home Assistant user id
    """
    CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        username      TEXT,
        display_name  TEXT,
        first_seen    TEXT NOT NULL,
        last_seen     TEXT NOT NULL
    );
    """,
    # 2: trackers and logged entries
    """
    ALTER TABLE users ADD COLUMN seeded INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE trackers (
        id          INTEGER PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        kind        TEXT NOT NULL,
        name        TEXT NOT NULL,
        emoji       TEXT,
        group_name  TEXT NOT NULL DEFAULT '',
        config      TEXT NOT NULL DEFAULT '{}',
        frequency   TEXT NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        hidden      INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        UNIQUE (user_id, key)
    );

    CREATE TABLE entries (
        id          INTEGER PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tracker_id  INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        day         TEXT NOT NULL,
        logged_at   TEXT NOT NULL,
        value_num   REAL,
        value_json  TEXT,
        note        TEXT,
        source      TEXT NOT NULL DEFAULT 'app',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );

    CREATE INDEX entries_user_day ON entries (user_id, day);
    CREATE INDEX entries_tracker_day ON entries (tracker_id, day);
    """,
    # 3: reminders. A schedule says when a medication is due; each due time
    # becomes a dose; a reminder is the notification that asks about one or more doses.
    """
    CREATE TABLE person_settings (
        user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        settings  TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE schedules (
        tracker_id   INTEGER PRIMARY KEY REFERENCES trackers(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        enabled      INTEGER NOT NULL DEFAULT 1,
        settings     TEXT NOT NULL DEFAULT '{}',
        active_from  TEXT NOT NULL,
        updated_at   TEXT NOT NULL
    );

    CREATE TABLE reminders (
        id              INTEGER PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL DEFAULT 'dose',
        due_at          TEXT NOT NULL,
        status          TEXT NOT NULL,
        next_at         TEXT,
        sends           INTEGER NOT NULL DEFAULT 0,
        escalated       INTEGER NOT NULL DEFAULT 0,
        announced       INTEGER NOT NULL DEFAULT 0,
        last_call_sent  INTEGER NOT NULL DEFAULT 0,
        answered_at     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
    );
    CREATE INDEX reminders_status ON reminders (status, next_at);

    CREATE TABLE doses (
        id           INTEGER PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tracker_id   INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        due_at       TEXT NOT NULL,
        local_day    TEXT NOT NULL,
        local_time   TEXT NOT NULL,
        latest_at    TEXT,
        status       TEXT NOT NULL,
        reminder_id  INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
        entry_id     INTEGER REFERENCES entries(id) ON DELETE SET NULL,
        reason       TEXT,
        resolved_at  TEXT,
        resolved_by  TEXT,
        UNIQUE (tracker_id, due_at)
    );
    CREATE INDEX doses_status ON doses (status, due_at);
    CREATE INDEX doses_user_day ON doses (user_id, local_day);
    """,
    # 4: doses timed from another dose ("7 hours after Vyvanse"). anchor_entry_id is
    # the logged dose it was timed from; if that entry is undone the dose goes too.
    """
    ALTER TABLE doses ADD COLUMN derived INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE doses ADD COLUMN anchor_entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL;
    CREATE INDEX doses_anchor ON doses (anchor_entry_id);
    """,
    # 5: check-in reminders ("time to check in"), one row per scheduled reminder time
    """
    CREATE TABLE checkins (
        id           INTEGER PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        due_at       TEXT NOT NULL,
        local_day    TEXT NOT NULL,
        local_time   TEXT NOT NULL,
        status       TEXT NOT NULL,
        reminder_id  INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
        entry_id     INTEGER REFERENCES entries(id) ON DELETE SET NULL,
        resolved_at  TEXT,
        resolved_by  TEXT,
        UNIQUE (user_id, due_at)
    );
    CREATE INDEX checkins_status ON checkins (status, due_at);
    """,
    # 6: Mood and Energy move to a 1–10 scale (existing answers rescaled), Water gets a
    # daily goal, and reminders can carry extra details (how much water was logged).
    """
    ALTER TABLE reminders ADD COLUMN payload TEXT;

    UPDATE entries SET value_num = CAST(((value_num - 1) * 9.0 / 4 + 1) + 0.5 AS INTEGER)
    WHERE tracker_id IN (
        SELECT id FROM trackers WHERE key IN ('mood', 'energy') AND kind = 'rating'
        AND json_extract(config, '$.min') = 1 AND json_extract(config, '$.max') = 5);

    UPDATE trackers SET config = json('{"min": 1, "max": 10, "labels": ["Awful", "Very bad", "Bad", "Poor", "Meh", "Okay", "Fine", "Good", "Very good", "Great"]}')
    WHERE key = 'mood' AND kind = 'rating'
      AND json_extract(config, '$.min') = 1 AND json_extract(config, '$.max') = 5;

    UPDATE trackers SET config = json('{"min": 1, "max": 10, "labels": ["Exhausted", "Drained", "Very low", "Low", "Flat", "Okay", "Fair", "Good", "High", "Buzzing"]}')
    WHERE key = 'energy' AND kind = 'rating'
      AND json_extract(config, '$.min') = 1 AND json_extract(config, '$.max') = 5;

    UPDATE trackers SET config = json_set(config, '$.goal', 8)
    WHERE key = 'water' AND kind = 'factor' AND json_extract(config, '$.mode') = 'count'
      AND json_extract(config, '$.goal') IS NULL;
    """,
    # 7: the medications section is called Meds/Supplements, as in Bearable
    """
    UPDATE trackers SET group_name = 'Meds/Supplements' WHERE kind = 'medication' AND group_name = 'Medications';
    """,
    # 8: each reminder time can have its own amount (half a tablet at 7pm, one at 10pm).
    # NULL means the medication's usual number.
    """
    ALTER TABLE doses ADD COLUMN quantity REAL;
    """,
    # 9: medication supply (how many are left, refills, repeats, script expiry) and which
    # supply warnings have already been sent, so each is sent once.
    """
    CREATE TABLE supplies (
        tracker_id   INTEGER PRIMARY KEY REFERENCES trackers(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        settings     TEXT NOT NULL DEFAULT '{}',
        updated_at   TEXT NOT NULL
    );
    CREATE TABLE supply_alerts (
        tracker_id   INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,
        sent_at      TEXT NOT NULL,
        PRIMARY KEY (tracker_id, kind)
    );
    """,
    # 10: nights of sleep from Home Assistant (Sleep as Android or Android's sleep detection),
    # kept here because Home Assistant only keeps detailed history for about ten days.
    """
    CREATE TABLE sleep_nights (
        id           INTEGER PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tracker_id   INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        night        TEXT NOT NULL,
        start_at     TEXT NOT NULL,
        end_at       TEXT NOT NULL,
        phases       TEXT NOT NULL,
        source       TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (tracker_id, start_at)
    );
    CREATE INDEX sleep_nights_night ON sleep_nights (tracker_id, night);
    """,
    # 11: how an estimated night was worked out ("Lights out 11:40pm", ...), as JSON
    """
    ALTER TABLE sleep_nights ADD COLUMN why TEXT;
    """,
    # 12: Three good things, and a Mindful minute habit for the breathing exercise, for people
    # who already have their items (new people get them with the rest).
    """
    INSERT OR IGNORE INTO trackers (user_id, key, kind, name, emoji, group_name, config, frequency, sort_order, hidden, created_at)
    SELECT u.id, 'good_things', 'gratitude', 'Three good things', '🌱', 'Reflect',
           '{"times": ["12:30", "15:30", "21:30"], "remind": false}', 'many',
           COALESCE((SELECT MAX(sort_order) FROM trackers t WHERE t.user_id = u.id), 0) + 10, 0, strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
    FROM users u WHERE u.seeded = 1
      AND NOT EXISTS (SELECT 1 FROM trackers t WHERE t.user_id = u.id AND t.kind = 'gratitude');
    INSERT OR IGNORE INTO trackers (user_id, key, kind, name, emoji, group_name, config, frequency, sort_order, hidden, created_at)
    SELECT u.id, 'mindful', 'factor', 'Mindful minute', '🧘', 'Lifestyle', '{"mode": "bool"}', 'daily',
           COALESCE((SELECT MAX(sort_order) FROM trackers t WHERE t.user_id = u.id), 0) + 10, 0, strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')
    FROM users u WHERE u.seeded = 1
      AND NOT EXISTS (SELECT 1 FROM trackers t WHERE t.user_id = u.id AND t.key = 'mindful');
    """,
]


class NotFound(LookupError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_logged_at(value: str) -> tuple[str, str]:
    """Return (logged_at, local day) from an ISO timestamp that includes its UTC offset.

    The day is the person's local calendar date, taken from the offset they logged with.
    """
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValidationError("logged_at must be an ISO date-time") from None
    if dt.tzinfo is None:
        raise ValidationError("logged_at must include a UTC offset")
    return dt.isoformat(timespec="seconds"), dt.date().isoformat()


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s[:40] or "tracker"


def _tracker_row(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["config"] = json.loads(d["config"] or "{}")
    d["hidden"] = bool(d["hidden"])
    d.pop("user_id", None)
    return d


def _entry_row(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["value_json"] = json.loads(d["value_json"]) if d["value_json"] else None
    d.pop("user_id", None)
    return d


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ----- schema -----

    def migrate(self) -> int:
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            current = conn.execute("PRAGMA user_version").fetchone()[0]
            for version, sql in enumerate(MIGRATIONS[current:], start=current + 1):
                conn.executescript(sql)
                conn.execute(f"PRAGMA user_version = {version}")
            return conn.execute("PRAGMA user_version").fetchone()[0]

    def schema_version(self) -> int:
        with self.connect() as conn:
            return conn.execute("PRAGMA user_version").fetchone()[0]

    # ----- users -----

    def touch_user(self, user_id: str, username: str | None, display_name: str | None) -> dict:
        """Record that a user visited, creating them (with default trackers) on first visit."""
        now = _now()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO users (id, username, display_name, first_seen, last_seen)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    username = excluded.username,
                    display_name = excluded.display_name,
                    last_seen = excluded.last_seen
                """,
                (user_id, username, display_name, now, now),
            )
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row["seeded"]:
                for t in default_trackers():
                    self._insert_tracker(conn, user_id, t, key=t["key"])
                conn.execute("UPDATE users SET seeded = 1 WHERE id = ?", (user_id,))
                row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            return dict(row)

    def list_users(self) -> list[dict]:
        with self.connect() as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM users ORDER BY first_seen")]

    def active_users(self) -> list[dict]:
        """People who've actually used the app: logged something, added a medicine or changed a setting. Someone who
        only opened it once (or a tool that looked at it) doesn't get entities in Home Assistant."""
        with self.connect() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM entries e WHERE e.user_id = u.id) "
                "OR EXISTS (SELECT 1 FROM person_settings p WHERE p.user_id = u.id) "
                "OR EXISTS (SELECT 1 FROM trackers t WHERE t.user_id = u.id AND t.kind = 'medication') ORDER BY first_seen")]

    def user_count(self) -> int:
        with self.connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]

    # ----- trackers -----

    def _insert_tracker(self, conn: sqlite3.Connection, user_id: str, data: dict, key: str) -> int:
        cur = conn.execute(
            """
            INSERT INTO trackers (user_id, key, kind, name, emoji, group_name, config,
                                  frequency, sort_order, hidden, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                user_id,
                key,
                data["kind"],
                data["name"],
                data.get("emoji"),
                data.get("group_name") or "",
                json.dumps(data.get("config") or {}),
                data["frequency"],
                data.get("sort_order", 0),
                _now(),
            ),
        )
        return cur.lastrowid

    def list_trackers(self, user_id: str, include_hidden: bool = False) -> list[dict]:
        sql = ("SELECT t.*, (SELECT COUNT(*) FROM entries e WHERE e.tracker_id = t.id) AS entry_count "
               "FROM trackers t WHERE t.user_id = ?")
        if not include_hidden:
            sql += " AND t.hidden = 0"
        sql += " ORDER BY t.sort_order, t.id"
        with self.connect() as conn:
            return [_tracker_row(r) for r in conn.execute(sql, (user_id,))]

    def get_tracker(self, user_id: str, tracker_id: int, conn: sqlite3.Connection | None = None) -> dict:
        def fetch(c: sqlite3.Connection) -> dict:
            row = c.execute(
                "SELECT * FROM trackers WHERE id = ? AND user_id = ?", (tracker_id, user_id)
            ).fetchone()
            if not row:
                raise NotFound("Tracker not found")
            return _tracker_row(row)

        if conn is not None:
            return fetch(conn)
        with self.connect() as c:
            return fetch(c)

    def create_tracker(self, user_id: str, data: dict) -> dict:
        kind = data.get("kind")
        name = str(data.get("name") or "").strip()[:60]
        if not name:
            raise ValidationError("Give it a name")
        config = normalise_config(kind, data.get("config"))
        frequency = data.get("frequency") or DEFAULT_FREQUENCY[kind]
        if frequency not in FREQUENCIES:
            raise ValidationError("Frequency must be 'many' or 'daily'")
        with self.connect() as conn:
            base = _slug(name)
            key, n = base, 2
            while conn.execute(
                "SELECT 1 FROM trackers WHERE user_id = ? AND key = ?", (user_id, key)
            ).fetchone():
                key, n = f"{base}_{n}", n + 1
            group_name = data.get("group_name")
            if group_name is None:
                group_name = "Meds/Supplements" if kind == "medication" else ""
            if kind == "medication":
                # Medications sit together at the top of the check-in: after the last
                # existing medication, or before everything else if this is the first.
                last_med = conn.execute(
                    "SELECT MAX(sort_order) FROM trackers WHERE user_id = ? AND kind = 'medication'",
                    (user_id,),
                ).fetchone()[0]
                if last_med is None:
                    sort_order = conn.execute(
                        "SELECT COALESCE(MIN(sort_order), 10) FROM trackers WHERE user_id = ?", (user_id,)
                    ).fetchone()[0] - 10
                else:
                    sort_order = last_med + 1
                    conn.execute(
                        "UPDATE trackers SET sort_order = sort_order + 10 "
                        "WHERE user_id = ? AND sort_order > ? AND kind != 'medication'",
                        (user_id, last_med),
                    )
            else:
                sort_order = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), 0) FROM trackers WHERE user_id = ?", (user_id,)
                ).fetchone()[0] + 10
            new_id = self._insert_tracker(
                conn,
                user_id,
                {
                    "kind": kind,
                    "name": name,
                    "emoji": (str(data["emoji"])[:8] if data.get("emoji") else None),
                    "group_name": str(group_name)[:40],
                    "config": config,
                    "frequency": frequency,
                    "sort_order": sort_order,
                },
                key=key,
            )
            return self.get_tracker(user_id, new_id, conn)

    def update_tracker(self, user_id: str, tracker_id: int, changes: dict) -> dict:
        with self.connect() as conn:
            current = self.get_tracker(user_id, tracker_id, conn)
            sets: dict[str, Any] = {}
            kind = changes.get("kind", current["kind"])
            if kind != current["kind"]:
                # Past answers were recorded differently, so a new type starts afresh.
                if kind not in DEFAULT_FREQUENCY:
                    raise ValidationError(f"Unknown tracker kind '{kind}'")
                sets["kind"] = kind
                sets["config"] = json.dumps(normalise_config(kind, changes.get("config")))
                sets["frequency"] = changes.get("frequency") if changes.get("frequency") in FREQUENCIES else DEFAULT_FREQUENCY[kind]
                conn.execute("DELETE FROM entries WHERE tracker_id = ? AND user_id = ?", (tracker_id, user_id))
                conn.execute("DELETE FROM doses WHERE tracker_id = ?", (tracker_id,))
                conn.execute("DELETE FROM schedules WHERE tracker_id = ?", (tracker_id,))
                changes = {k: v for k, v in changes.items() if k not in ("kind", "config", "frequency")}
            elif "config" in changes and current["kind"] == "rating":
                new = normalise_config("rating", changes["config"])
                old = current["config"]
                if (new["min"], new["max"]) != (old["min"], old["max"]):
                    # Keep past answers in the same place on the new scale.
                    conn.execute(
                        """
                        UPDATE entries SET value_num = CAST(
                            (? + (value_num - ?) * (? - ?) * 1.0 / (? - ?)) + 0.5 AS INTEGER)
                        WHERE tracker_id = ? AND user_id = ?
                        """,
                        (new["min"], old["min"], new["max"], new["min"], old["max"], old["min"],
                         tracker_id, user_id),
                    )
            if "name" in changes:
                name = str(changes["name"] or "").strip()[:60]
                if not name:
                    raise ValidationError("Give it a name")
                sets["name"] = name
            if "emoji" in changes:
                sets["emoji"] = str(changes["emoji"])[:8] if changes["emoji"] else None
            if "group_name" in changes:
                sets["group_name"] = str(changes["group_name"] or "")[:40]
            if "config" in changes:
                sets["config"] = json.dumps(normalise_config(current["kind"], changes["config"]))
            if "frequency" in changes:
                if changes["frequency"] not in FREQUENCIES:
                    raise ValidationError("Frequency must be 'many' or 'daily'")
                sets["frequency"] = changes["frequency"]
            if "hidden" in changes:
                sets["hidden"] = 1 if changes["hidden"] else 0
            if "sort_order" in changes:
                sets["sort_order"] = int(changes["sort_order"])
            if sets:
                cols = ", ".join(f"{k} = ?" for k in sets)
                conn.execute(
                    f"UPDATE trackers SET {cols} WHERE id = ? AND user_id = ?",
                    (*sets.values(), tracker_id, user_id),
                )
            return self.get_tracker(user_id, tracker_id, conn)

    def reorder_trackers(self, user_id: str, ids: list[int]) -> None:
        with self.connect() as conn:
            owned = {
                r[0] for r in conn.execute("SELECT id FROM trackers WHERE user_id = ?", (user_id,))
            }
            if not set(ids) <= owned:
                raise NotFound("Tracker not found")
            for i, tid in enumerate(ids):
                conn.execute(
                    "UPDATE trackers SET sort_order = ? WHERE id = ? AND user_id = ?",
                    ((i + 1) * 10, tid, user_id),
                )

    def rename_group(self, user_id: str, old: str, new: str) -> int:
        new = str(new or "").strip()[:40]
        if not new:
            raise ValidationError("Give the section a name")
        with self.connect() as conn:
            cur = conn.execute(
                "UPDATE trackers SET group_name = ? WHERE user_id = ? AND group_name = ?", (new, user_id, old)
            )
            return cur.rowcount

    def delete_tracker(self, user_id: str, tracker_id: int) -> None:
        with self.connect() as conn:
            cur = conn.execute(
                "DELETE FROM trackers WHERE id = ? AND user_id = ?", (tracker_id, user_id)
            )
            if cur.rowcount == 0:
                raise NotFound("Tracker not found")

    # ----- entries -----

    def list_entries(self, user_id: str, from_day: str, to_day: str) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM entries
                WHERE user_id = ? AND day BETWEEN ? AND ?
                ORDER BY logged_at DESC, id DESC
                """,
                (user_id, from_day, to_day),
            )
            return [_entry_row(r) for r in rows]

    def save_checkin(self, user_id: str, logged_at: str, items: list[dict], source: str = "app") -> dict:
        """Save several answers at once.

        'many' trackers get a new entry each time. 'daily' trackers update the
        day's existing entry if there is one. An item with clear=true removes
        that day's entry for a daily tracker.
        """
        logged_at, day = parse_logged_at(logged_at)
        now = _now()
        saved: list[dict] = []
        cleared: list[int] = []
        with self.connect() as conn:
            for item in items:
                tracker = self.get_tracker(user_id, int(item.get("tracker_id", 0)), conn)
                existing = None
                if tracker["frequency"] == "daily":
                    existing = conn.execute(
                        "SELECT id FROM entries WHERE tracker_id = ? AND user_id = ? AND day = ?",
                        (tracker["id"], user_id, day),
                    ).fetchone()
                if item.get("clear"):
                    if tracker["frequency"] != "daily":
                        raise ValidationError(f"{tracker['name']}: only daily items can be cleared")
                    if existing:
                        conn.execute("DELETE FROM entries WHERE id = ?", (existing["id"],))
                        cleared.append(tracker["id"])
                    continue
                clean = validate_value(tracker, item)
                value_json = json.dumps(clean["value_json"]) if clean["value_json"] is not None else None
                if existing:
                    conn.execute(
                        """
                        UPDATE entries SET logged_at = ?, value_num = ?, value_json = ?, note = ?,
                                           source = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (logged_at, clean["value_num"], value_json, clean["note"], source, now, existing["id"]),
                    )
                    entry_id = existing["id"]
                else:
                    cur = conn.execute(
                        """
                        INSERT INTO entries (user_id, tracker_id, day, logged_at, value_num, value_json,
                                             note, source, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (user_id, tracker["id"], day, logged_at, clean["value_num"], value_json,
                         clean["note"], source, now, now),
                    )
                    entry_id = cur.lastrowid
                saved.append(_entry_row(conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()))
        return {"day": day, "saved": saved, "cleared_tracker_ids": cleared}

    def update_entry(self, user_id: str, entry_id: int, changes: dict) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM entries WHERE id = ? AND user_id = ?", (entry_id, user_id)
            ).fetchone()
            if not row:
                raise NotFound("Entry not found")
            entry = _entry_row(row)
            tracker = self.get_tracker(user_id, entry["tracker_id"], conn)
            merged = {
                "value_num": changes.get("value_num", entry["value_num"]),
                "value_json": changes.get("value_json", entry["value_json"]),
                "note": changes.get("note", entry["note"]),
            }
            clean = validate_value(tracker, merged)
            logged_at, day = entry["logged_at"], entry["day"]
            if "logged_at" in changes:
                logged_at, day = parse_logged_at(changes["logged_at"])
                if tracker["frequency"] == "daily" and day != entry["day"]:
                    clash = conn.execute(
                        "SELECT 1 FROM entries WHERE tracker_id = ? AND user_id = ? AND day = ? AND id != ?",
                        (tracker["id"], user_id, day, entry_id),
                    ).fetchone()
                    if clash:
                        raise ValidationError(f"{tracker['name']} already has an entry that day")
            conn.execute(
                """
                UPDATE entries SET day = ?, logged_at = ?, value_num = ?, value_json = ?, note = ?, updated_at = ?,
                                   source = CASE WHEN source = 'ha' THEN 'app' ELSE source END
                WHERE id = ? AND user_id = ?
                """,
                (
                    day,
                    logged_at,
                    clean["value_num"],
                    json.dumps(clean["value_json"]) if clean["value_json"] is not None else None,
                    clean["note"],
                    _now(),
                    entry_id,
                    user_id,
                ),
            )
            return _entry_row(conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone())

    def delete_entry(self, user_id: str, entry_id: int) -> None:
        with self.connect() as conn:
            cur = conn.execute("DELETE FROM entries WHERE id = ? AND user_id = ?", (entry_id, user_id))
            if cur.rowcount == 0:
                raise NotFound("Entry not found")
