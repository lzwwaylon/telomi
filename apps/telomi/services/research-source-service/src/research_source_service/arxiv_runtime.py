from __future__ import annotations

import fcntl
import hashlib
import json
import re
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
            (_query_cache_key(endpoint, parameters), time.time()),
        ).fetchone()
        return str(row["response_xml"]) if row is not None else None

    def put_cached_response(self, endpoint: str, parameters: dict[str, object], response_xml: str) -> None:
        now = time.time()
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

    def get_cached_paper(self, arxiv_id: str) -> str | None:
        row = self.connection.execute(
            "SELECT result_json FROM arxiv_paper_metadata WHERE arxiv_id=? AND expires_at>?",
            (arxiv_id, time.time()),
        ).fetchone()
        return str(row["result_json"]) if row is not None else None

    def cache_papers(self, papers: dict[str, str], endpoint: str, parameters: dict[str, object]) -> None:
        """Trusted parsed query metadata, bounded by that query's TTL and 10,000 records."""
        row = self.connection.execute(
            "SELECT created_at, expires_at FROM arxiv_query_cache WHERE cache_key=?",
            (_query_cache_key(endpoint, parameters),),
        ).fetchone()
        if row is None or not papers:
            return
        now = time.time()
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            records = []
            for arxiv_id, result in papers.items():
                previous = self.connection.execute(
                    "SELECT result_json FROM arxiv_paper_metadata WHERE arxiv_id=? AND created_at=?",
                    (arxiv_id, row["created_at"]),
                ).fetchone()
                # Old databases stored whole-second timestamps. Keep the higher observed revision
                # on a tie rather than let replay order downgrade latest or renew its expiration.
                if previous is not None and _paper_version(result) < _paper_version(str(previous["result_json"])):
                    continue
                records.append((arxiv_id, result, row["created_at"], row["expires_at"]))
            self.connection.executemany(
                "INSERT INTO arxiv_paper_metadata(arxiv_id, result_json, created_at, expires_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(arxiv_id) DO UPDATE SET result_json=excluded.result_json, "
                "created_at=excluded.created_at, expires_at=excluded.expires_at "
                "WHERE excluded.created_at>=arxiv_paper_metadata.created_at",
                records,
            )
            self.connection.execute("DELETE FROM arxiv_paper_metadata WHERE expires_at<=?", (now,))
            self.connection.execute(
                "DELETE FROM arxiv_paper_metadata WHERE arxiv_id IN "
                "(SELECT arxiv_id FROM arxiv_paper_metadata ORDER BY created_at DESC, arxiv_id LIMIT -1 OFFSET 10000)"
            )

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

    def begin_upstream_request(
        self, scope: str, min_interval_seconds: float, global_min_interval_seconds: float
    ) -> None:
        """Persist an unresolved attempt before HTTP, under the lease, so an owner crash remains visible."""

        with self.scheduler_connection:
            self.scheduler_connection.execute("BEGIN IMMEDIATE")
            self._write_upstream_deadlines(scope, min_interval_seconds, global_min_interval_seconds, time.time())
            self.scheduler_connection.execute(
                "INSERT OR REPLACE INTO arxiv_upstream_intent VALUES (1, ?, ?, ?)",
                (scope, min_interval_seconds, global_min_interval_seconds),
            )

    def recover_upstream_request(self) -> str | None:
        """A newly acquired lease with an intent means the prior owner exited before finalizing HTTP."""

        row = self.scheduler_connection.execute("SELECT * FROM arxiv_upstream_intent WHERE singleton=1").fetchone()
        if row is None:
            return None
        self.record_upstream_start(row["scope"], row["min_interval_seconds"], row["global_interval_seconds"])
        return str(row["scope"])

    def record_upstream_start(
        self, scope: str, min_interval_seconds: float, global_min_interval_seconds: float,
        *, started_at: float | None = None,
    ) -> None:
        """Finalize actual HTTP-start deadlines without shortening cooldown; caller still holds the lease."""

        with self.scheduler_connection:
            self.scheduler_connection.execute("BEGIN IMMEDIATE")
            self._write_upstream_deadlines(
                scope, min_interval_seconds, global_min_interval_seconds,
                time.time() if started_at is None else started_at,
            )
            self.scheduler_connection.execute("DELETE FROM arxiv_upstream_intent WHERE singleton=1")

    def _write_upstream_deadlines(self, scope: str, interval: float, global_interval: float, started_at: float) -> None:
        self.scheduler_connection.executemany(
            """
            INSERT INTO arxiv_access_slots(scope, next_allowed_at) VALUES (?, ?)
            ON CONFLICT(scope) DO UPDATE SET
                next_allowed_at=max(arxiv_access_slots.next_allowed_at, excluded.next_allowed_at)
            """,
            ((scope, started_at + interval), ("any", started_at + global_interval)),
        )

    def cooldown(self, delay_seconds: float, *, scope: str = "any") -> None:
        """Persist a service-specific Retry-After; explicit any/global denial cools every service."""

        if delay_seconds <= 0:
            return
        with self.scheduler_connection:
            self.scheduler_connection.execute(
                "UPDATE arxiv_access_slots SET next_allowed_at=max(next_allowed_at, ?) WHERE scope=? OR ?='any'",
                (time.time() + delay_seconds, scope, scope),
            )

    def egress_route(self, names: tuple[str, ...], *, scope: str = "any") -> str:
        """Select a configured route under the upstream lease; preferences contain no proxy addresses."""
        rows = self.scheduler_connection.execute(
            "SELECT scope, name, failed_until, preferred FROM arxiv_egress_health WHERE scope IN (?, 'any')",
            (scope,),
        ).fetchall()
        available = [name for name in names if all(
            row["failed_until"] <= time.time() for row in rows if row["name"] == name
        )]
        for preference_scope in (scope, "any"):
            for name in available:
                if any(row["scope"] == preference_scope and row["name"] == name and row["preferred"] for row in rows):
                    return name
        return available[0] if available else names[0]

    def fail_egress_route(
        self, name: str, names: tuple[str, ...], cooldown_seconds: float, *, scope: str = "any"
    ) -> str | None:
        """Remember unhealthy exits across service processes, without granting a new upstream allowance."""
        with self.scheduler_connection:
            self.scheduler_connection.execute(
                "INSERT INTO arxiv_egress_health(scope, name, failed_until, preferred) VALUES (?, ?, ?, 0) "
                "ON CONFLICT(scope, name) DO UPDATE SET failed_until=excluded.failed_until, preferred=0",
                (scope, name, time.time() + max(cooldown_seconds, 30 * 60)),
            )
            next_name = self.egress_route(names, scope=scope)
            row = self.scheduler_connection.execute(
                "SELECT max(failed_until) AS failed_until FROM arxiv_egress_health "
                "WHERE name=? AND scope IN (?, 'any')",
                (next_name, scope),
            ).fetchone()
            if next_name == name or (row is not None and (row["failed_until"] or 0) > time.time()):
                return None
            self.scheduler_connection.execute("UPDATE arxiv_egress_health SET preferred=0 WHERE scope=?", (scope,))
            self.scheduler_connection.execute(
                "INSERT INTO arxiv_egress_health(scope, name, failed_until, preferred) VALUES (?, ?, 0, 1) "
                "ON CONFLICT(scope, name) DO UPDATE SET preferred=1", (scope, next_name),
            )
        return next_name

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

            CREATE TABLE IF NOT EXISTS arxiv_paper_metadata (
                arxiv_id TEXT PRIMARY KEY,
                result_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
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

            CREATE TABLE IF NOT EXISTS arxiv_upstream_intent (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                scope TEXT NOT NULL,
                min_interval_seconds REAL NOT NULL,
                global_interval_seconds REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS arxiv_egress_routes (
                name TEXT PRIMARY KEY,
                failed_until REAL NOT NULL,
                preferred INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS arxiv_egress_health (
                scope TEXT NOT NULL,
                name TEXT NOT NULL,
                failed_until REAL NOT NULL,
                preferred INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(scope, name)
            );

            INSERT OR IGNORE INTO arxiv_egress_health(scope, name, failed_until, preferred)
            SELECT 'any', name, failed_until, preferred FROM arxiv_egress_routes;
            """
        )
        self.connection.commit()
        self.scheduler_connection.commit()


def _paper_version(result_json: str) -> int:
    try:
        metadata = json.loads(result_json).get("metadata", {})
        version = metadata.get("arxiv_version_id") or metadata.get("arxiv_metadata_version_id") or ""
        match = re.search(r"v(\d+)$", str(version))
        return int(match.group(1)) if match else 0
    except (ValueError, TypeError, AttributeError):
        return 0


def _query_cache_key(endpoint: str, parameters: dict[str, object]) -> str:
    canonical = json.dumps(
        {"endpoint": endpoint, "parameters": parameters},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(canonical).hexdigest()
