"""SQLite storage with simple, ordered migrations.

The database lives in the app's /data folder, so Home Assistant backups
include it automatically. Each migration runs once, in order, and the applied
version is stored in PRAGMA user_version.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

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
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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

    def touch_user(self, user_id: str, username: str | None, display_name: str | None) -> dict:
        """Record that a user visited, creating them on first visit."""
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
            return dict(row)

    def user_count(self) -> int:
        with self.connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
