from __future__ import annotations

import fcntl
import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import BinaryIO


class ArxivUpstreamLease:
    def __init__(self, handle: BinaryIO) -> None:
        self.handle = handle

    def release(self) -> None:
        if self.handle.closed:
            return
        fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        self.handle.close()


class ArxivRuntimeStore:
    """Instance-local response cache with an optionally shared arXiv upstream scheduler."""

    def __init__(
        self,
        database: Path,
        *,
        scheduler_database: Path | None = None,
        cache_ttl_seconds: int = 24 * 60 * 60,
    ) -> None:
        self.database = database.expanduser().resolve()
        self.scheduler_database = (scheduler_database or self.database).expanduser().resolve()
        self.cache_ttl_seconds = cache_ttl_seconds
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self.scheduler_database.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path = self.scheduler_database.with_name(f"{self.scheduler_database.name}.lock")
        self.connection = sqlite3.connect(self.database, timeout=30, check_same_thread=False)
        self.scheduler_connection = sqlite3.connect(self.scheduler_database, timeout=30, check_same_thread=False)
        for connection in (self.connection, self.scheduler_connection):
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA busy_timeout=30000")
        self._initialize()

    def close(self) -> None:
        self.connection.close()
        self.scheduler_connection.close()

    def get_cached_response(self, endpoint: str, parameters: dict[str, object]) -> str | None:
        row = self.connection.execute(
            "SELECT response_xml FROM arxiv_query_cache WHERE cache_key=? AND expires_at>?",
            (_query_cache_key(endpoint, parameters), round(time.time())),
        ).fetchone()
        return str(row["response_xml"]) if row is not None else None

    def put_cached_response(self, endpoint: str, parameters: dict[str, object], response_xml: str) -> None:
        now = round(time.time())
        with self.connection:
            self.connection.execute(
                """
                INSERT INTO arxiv_query_cache(
                    cache_key, endpoint, parameters_json, response_xml, created_at, expires_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    response_xml=excluded.response_xml,
                    created_at=excluded.created_at,
                    expires_at=excluded.expires_at
                """,
                (
                    _query_cache_key(endpoint, parameters),
                    endpoint,
                    json.dumps(parameters, sort_keys=True, separators=(",", ":")),
                    response_xml,
                    now,
                    now + self.cache_ttl_seconds,
                ),
            )
            self.connection.execute("DELETE FROM arxiv_query_cache WHERE expires_at<=?", (now,))

    def try_acquire_upstream_lock(self) -> ArxivUpstreamLease | None:
        """Acquire the one cross-process arXiv connection without blocking."""

        handle = self.lock_path.open("a+b")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            return None
        return ArxivUpstreamLease(handle)

    def upstream_delay(self, scope: str) -> float:
        """Read the applicable deadlines while holding the upstream lease; never reserve a future start."""

        row = self.scheduler_connection.execute(
            "SELECT max(next_allowed_at) AS next_allowed_at FROM arxiv_access_slots WHERE scope IN (?, 'any')",
            (scope,),
        ).fetchone()
        return max(0.0, float(row["next_allowed_at"] or 0) - time.time())

    def record_upstream_start(
        self, scope: str, min_interval_seconds: float, global_min_interval_seconds: float
    ) -> None:
        """Anchor both deadlines to the actual HTTP call, after all waiting, under the upstream lease."""

        with self.scheduler_connection:
            self.scheduler_connection.execute("BEGIN IMMEDIATE")
            now = time.time()
            self.scheduler_connection.executemany(
                """
                INSERT INTO arxiv_access_slots(scope, next_allowed_at) VALUES (?, ?)
                ON CONFLICT(scope) DO UPDATE SET next_allowed_at=excluded.next_allowed_at
                """,
                ((scope, now + min_interval_seconds), ("any", now + global_min_interval_seconds)),
            )

    def cooldown(self, delay_seconds: float) -> None:
        """Persist an upstream Retry-After window across service processes."""

        if delay_seconds <= 0:
            return
        with self.scheduler_connection:
            self.scheduler_connection.execute(
                "UPDATE arxiv_access_slots SET next_allowed_at=max(next_allowed_at, ?)",
                (time.time() + delay_seconds,),
            )

    def _initialize(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS arxiv_query_cache (
                cache_key TEXT PRIMARY KEY,
                endpoint TEXT NOT NULL,
                parameters_json TEXT NOT NULL,
                response_xml TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS arxiv_query_cache_expiry
            ON arxiv_query_cache(expires_at);
            """
        )
        self.scheduler_connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS arxiv_access_policy (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                next_allowed_at REAL NOT NULL
            );

            INSERT OR IGNORE INTO arxiv_access_policy(singleton, next_allowed_at) VALUES (1, 0);

            CREATE TABLE IF NOT EXISTS arxiv_access_slots (
                scope TEXT PRIMARY KEY,
                next_allowed_at REAL NOT NULL
            );

            INSERT OR IGNORE INTO arxiv_access_slots(scope, next_allowed_at)
            SELECT 'api', next_allowed_at FROM arxiv_access_policy WHERE singleton=1;

            INSERT OR IGNORE INTO arxiv_access_slots(scope, next_allowed_at) VALUES ('main', 0);
            INSERT OR IGNORE INTO arxiv_access_slots(scope, next_allowed_at) VALUES ('any', 0);
            """
        )
        self.connection.commit()
        self.scheduler_connection.commit()


def _query_cache_key(endpoint: str, parameters: dict[str, object]) -> str:
    canonical = json.dumps(
        {"endpoint": endpoint, "parameters": parameters},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(canonical).hexdigest()
