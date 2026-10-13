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
        sql = "SELECT * FROM trackers WHERE user_id = ?"
        if not include_hidden:
            sql += " AND hidden = 0"
        sql += " ORDER BY sort_order, id"
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
                group_name = "Medications" if kind == "medication" else ""
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
                UPDATE entries SET day = ?, logged_at = ?, value_num = ?, value_json = ?, note = ?, updated_at = ?
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
