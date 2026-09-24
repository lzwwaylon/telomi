import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable


class TranscriptionJobStore:
    """Persistent state authority for long-form ASR jobs."""

    def __init__(
        self,
        root: Path,
        *,
        retention_sec: float = 24 * 60 * 60,
        now: Callable[[], float] = time.time,
    ):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.retention_sec = retention_sec
        self.now = now
        self.lock = threading.RLock()
        self.connection = sqlite3.connect(
            self.root / "jobs.sqlite3", timeout=30, check_same_thread=False
        )
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS transcription_jobs (
                id TEXT PRIMARY KEY,
                idempotency_key TEXT NOT NULL,
                status TEXT NOT NULL,
                input_path TEXT NOT NULL,
                request_json TEXT NOT NULL,
                result_json TEXT,
                error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                heartbeat_at REAL NOT NULL
            )
            """
        )
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS transcription_jobs_idempotency "
            "ON transcription_jobs(idempotency_key, created_at DESC)"
        )
        self.connection.commit()
        self._recover_interrupted_jobs()
        self.cleanup()

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    def create(
        self,
        idempotency_key: str,
        input_path: str,
        request: dict[str, Any],
    ) -> dict[str, Any]:
        self.cleanup()
        with self.lock:
            existing = self.connection.execute(
                """
                SELECT * FROM transcription_jobs
                WHERE idempotency_key=? AND status IN ('queued','running','cancelling','succeeded')
                ORDER BY created_at DESC LIMIT 1
                """,
                (idempotency_key,),
            ).fetchone()
            if existing:
                return {**self._state(existing), "reused": True}
            job_id = f"asr_{uuid.uuid4().hex}"
            timestamp = self.now()
            self.connection.execute(
                """
                INSERT INTO transcription_jobs (
                    id, idempotency_key, status, input_path, request_json,
                    created_at, updated_at, heartbeat_at
                ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    idempotency_key,
                    input_path,
                    json.dumps(request, ensure_ascii=False, separators=(",", ":")),
                    timestamp,
                    timestamp,
                    timestamp,
                ),
            )
            self.connection.commit()
            return {**self.get(job_id), "reused": False}

    def get(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            row = self.connection.execute(
                "SELECT * FROM transcription_jobs WHERE id=?", (job_id,)
            ).fetchone()
            if not row:
                raise KeyError(job_id)
            return self._state(row)

    def summary(self) -> dict[str, Any]:
        with self.lock:
            counts = {
                str(row["status"]): int(row["count"])
                for row in self.connection.execute(
                    "SELECT status, COUNT(*) AS count FROM transcription_jobs GROUP BY status"
                ).fetchall()
            }
            active = self.connection.execute(
                """
                SELECT * FROM transcription_jobs
                WHERE status IN ('queued','running','cancelling')
                ORDER BY created_at
                """
            ).fetchall()
        timestamp = self.now()
        return {
            "counts": counts,
            "active": [
                {
                    "id": str(row["id"]),
                    "status": str(row["status"]),
                    "heartbeat_age_sec": max(
                        0.0, round(timestamp - float(row["heartbeat_at"]), 1)
                    ),
                }
                for row in active
            ],
            "retention_sec": self.retention_sec,
        }

    def mark_running(self, job_id: str) -> None:
        self._update(job_id, "running")

    def heartbeat(self, job_id: str) -> None:
        timestamp = self.now()
        with self.lock:
            self.connection.execute(
                "UPDATE transcription_jobs SET heartbeat_at=?, updated_at=? WHERE id=?",
                (timestamp, timestamp, job_id),
            )
            self.connection.commit()

    def request_cancel(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            state = self.get(job_id)
            if state["status"] in {"queued", "running"}:
                self._update(job_id, "cancelling")
            return self.get(job_id)

    def succeed(self, job_id: str, result: dict[str, Any]) -> None:
        timestamp = self.now()
        with self.lock:
            self.connection.execute(
                """
                UPDATE transcription_jobs
                SET status='succeeded', result_json=?, error=NULL,
                    updated_at=?, heartbeat_at=?
                WHERE id=?
                """,
                (
                    json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                    timestamp,
                    timestamp,
                    job_id,
                ),
            )
            self.connection.commit()

    def fail(self, job_id: str, error: str) -> None:
        self._update(job_id, "failed", error=error)

    def mark_cancelled(self, job_id: str) -> None:
        self._update(job_id, "cancelled", error="cancelled by client")

    def cleanup(self) -> None:
        cutoff = self.now() - self.retention_sec
        with self.lock:
            rows = self.connection.execute(
                "SELECT input_path FROM transcription_jobs "
                "WHERE status IN ('succeeded','failed','cancelled') AND updated_at<?",
                (cutoff,),
            ).fetchall()
            self.connection.execute(
                "DELETE FROM transcription_jobs "
                "WHERE status IN ('succeeded','failed','cancelled') AND updated_at<?",
                (cutoff,),
            )
            self.connection.commit()
        for row in rows:
            self._delete_managed_input(str(row["input_path"]))

    def _recover_interrupted_jobs(self) -> None:
        timestamp = self.now()
        with self.lock:
            rows = self.connection.execute(
                "SELECT input_path FROM transcription_jobs "
                "WHERE status IN ('queued','running','cancelling')"
            ).fetchall()
            self.connection.execute(
                """
                UPDATE transcription_jobs
                SET status='failed', error='sidecar restarted before transcription finished',
                    updated_at=?, heartbeat_at=?
                WHERE status IN ('queued','running','cancelling')
                """,
                (timestamp, timestamp),
            )
            self.connection.commit()
        for row in rows:
            self._delete_managed_input(str(row["input_path"]))

    def _update(self, job_id: str, status: str, *, error: str | None = None) -> None:
        timestamp = self.now()
        with self.lock:
            cursor = self.connection.execute(
                """
                UPDATE transcription_jobs
                SET status=?, error=?, updated_at=?, heartbeat_at=? WHERE id=?
                """,
                (status, error, timestamp, timestamp, job_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(job_id)
            self.connection.commit()

    def _state(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": str(row["id"]),
            "status": str(row["status"]),
            "input_path": str(row["input_path"]),
            "request": json.loads(str(row["request_json"])),
            "result": json.loads(str(row["result_json"]))
            if row["result_json"] is not None
            else None,
            "error": str(row["error"]) if row["error"] is not None else None,
            "created_at": float(row["created_at"]),
            "updated_at": float(row["updated_at"]),
            "heartbeat_at": float(row["heartbeat_at"]),
            "poll_after_ms": 2_000,
        }

    def _delete_managed_input(self, raw_path: str) -> None:
        path = Path(raw_path).resolve()
        if not path.is_relative_to(self.root):
            return
        try:
            path.unlink(missing_ok=True)
            path.parent.rmdir()
        except OSError:
            pass
