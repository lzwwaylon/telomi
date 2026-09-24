from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


class ProviderGate:
    def __init__(self, max_concurrency: int, min_interval_seconds: float = 0) -> None:
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._start_lock = asyncio.Lock()
        self._min_interval = min_interval_seconds
        self._last_started = 0.0

    async def run(self, operation: Callable[[], Awaitable[T]]) -> T:
        async with self._semaphore:
            async with self._start_lock:
                delay = self._last_started + self._min_interval - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                self._last_started = time.monotonic()
            return await operation()
