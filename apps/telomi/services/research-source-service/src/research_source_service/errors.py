from __future__ import annotations

from typing import Any


class ServiceError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 502,
        retryable: bool = False,
        provider: str | None = None,
        details: dict[str, Any] | None = None,
        retry_after_ms: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable
        self.provider = provider
        self.details = details or {}
        self.retry_after_ms = retry_after_ms


def bounded_message(value: object, limit: int = 500) -> str:
    return " ".join(str(value).split())[:limit]
