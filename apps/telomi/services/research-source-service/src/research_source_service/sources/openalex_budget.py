"""Shared, conservative daily admission for OpenAlex's free allowance."""

from __future__ import annotations

import hashlib
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

from ..errors import ServiceError


class OpenAlexBudget:
    def __init__(self, database: Path, api_key: str | None) -> None:
        self.database = database
        self.scope = hashlib.sha256((api_key or "anonymous").encode()).hexdigest()
        # One unit is $0.0001; anonymous allowance is one tenth of an account's.
        self.limit = 10_000 if api_key else 1_000
        database.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS daily_budget "
                "(scope TEXT, day TEXT, spent INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0, "
                "PRIMARY KEY(scope, day))"
            )

    def reserve(self, units: int, operation: str) -> None:
        day = datetime.now(UTC).date().isoformat()
        with closing(sqlite3.connect(self.database, timeout=30)) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("INSERT OR IGNORE INTO daily_budget VALUES (?, ?, 0, 0)", (self.scope, day))
            spent, blocked = connection.execute(
                "SELECT spent, blocked FROM daily_budget WHERE scope=? AND day=?", (self.scope, day)
            ).fetchone()
            if blocked or (units and spent + units > self.limit):
                reset = datetime.combine(datetime.now(UTC).date() + timedelta(days=1), datetime.min.time(), UTC)
                raise ServiceError(
                    "provider_daily_budget_exhausted",
                    "OpenAlex free daily allowance is exhausted; stop this Provider until the next UTC day",
                    provider="openalex",
                    details={
                        "operation": operation, "failure_scope": "provider", "next_action": "handoff",
                        "budget_scope": "shared_local_free_allowance", "reset_at": reset.isoformat(),
                        "spent_usd": spent / 10_000, "limit_usd": self.limit / 10_000,
                    },
                )
            # ponytail: reserve pessimistically even if a request fails; refund only with a reconciled usage ledger.
            connection.execute(
                "UPDATE daily_budget SET spent=spent+? WHERE scope=? AND day=?", (units, self.scope, day)
            )

    def block(self) -> None:
        day = datetime.now(UTC).date().isoformat()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                "INSERT INTO daily_budget VALUES (?, ?, 0, 1) "
                "ON CONFLICT(scope, day) DO UPDATE SET blocked=1", (self.scope, day)
            )
