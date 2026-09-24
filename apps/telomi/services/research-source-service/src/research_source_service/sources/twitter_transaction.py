from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from bs4 import BeautifulSoup
from x_client_transaction import ClientTransaction
from x_client_transaction.utils import get_ondemand_file_url

from ..errors import ServiceError, bounded_message
from ..http_client import HttpGateway

MAX_HOME_BYTES = 2 * 1024 * 1024
MAX_ONDEMAND_BYTES = 8 * 1024 * 1024
DEFAULT_CONTEXT_TTL_SECONDS = 10 * 60
ONDEMAND_PATH = re.compile(
    r"^/responsive-web/client-web/ondemand\.s\.[0-9a-f]+a\.js$"
)

BOOTSTRAP_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/javascript;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/138.0.0.0 Safari/537.36"
    ),
}


@dataclass(frozen=True)
class TransactionContext:
    generator: ClientTransaction
    loaded_at: float


class TwitterTransactionSigner:
    def __init__(
        self,
        http: HttpGateway,
        endpoint: str,
        *,
        ttl_seconds: float = DEFAULT_CONTEXT_TTL_SECONDS,
    ) -> None:
        self.http = http
        self.endpoint = endpoint
        self.ttl_seconds = ttl_seconds
        self._context: TransactionContext | None = None
        self._lock = asyncio.Lock()

    async def header_for(self, method: str, url: str) -> str:
        path = self._target_path(url)
        context = await self._get_context()
        try:
            return context.generator.generate_transaction_id(
                method=method.upper(),
                path=path,
            )
        except Exception as error:
            raise self._bootstrap_error("could not generate a transaction ID", error) from error

    async def invalidate(self) -> None:
        async with self._lock:
            self._context = None

    async def _get_context(self) -> TransactionContext:
        now = time.monotonic()
        current = self._context
        if current is not None and now - current.loaded_at < self.ttl_seconds:
            return current
        async with self._lock:
            now = time.monotonic()
            current = self._context
            if current is not None and now - current.loaded_at < self.ttl_seconds:
                return current
            self._context = await self._bootstrap(now)
            return self._context

    async def _bootstrap(self, loaded_at: float) -> TransactionContext:
        try:
            home_response = await self.http.request(
                "twitter",
                "GET",
                f"{self.endpoint}/home",
                headers=BOOTSTRAP_HEADERS,
            )
            self._validate_size(home_response, MAX_HOME_BYTES, "X home page")
            home = BeautifulSoup(home_response.content, "html.parser")
            ondemand_url = get_ondemand_file_url(response=home)
            self._validate_ondemand_url(ondemand_url)
            ondemand_response = await self.http.request(
                "twitter",
                "GET",
                ondemand_url,
                headers={**BOOTSTRAP_HEADERS, "Referer": f"{self.endpoint}/home"},
            )
            self._validate_size(ondemand_response, MAX_ONDEMAND_BYTES, "X ondemand asset")
            generator = ClientTransaction(
                home_page_response=home,
                ondemand_file_response=ondemand_response.text,
            )
        except ServiceError:
            raise
        except Exception as error:
            raise self._bootstrap_error("could not initialize the transaction signer", error) from error
        return TransactionContext(generator=generator, loaded_at=loaded_at)

    def _target_path(self, url: str) -> str:
        expected = urlsplit(self.endpoint)
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != expected.hostname
            or parsed.port is not None
            or parsed.username is not None
            or parsed.password is not None
            or not parsed.path.startswith("/i/api/")
        ):
            raise ServiceError(
                "invalid_twitter_transaction_target",
                "Twitter transaction IDs may only be generated for the configured X API origin",
                status_code=400,
                provider="twitter",
            )
        return parsed.path

    def _validate_ondemand_url(self, url: str) -> None:
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "abs.twimg.com"
            or parsed.port is not None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or not ONDEMAND_PATH.fullmatch(parsed.path)
        ):
            raise ServiceError(
                "twitter_transaction_bootstrap_error",
                "X returned an invalid transaction bootstrap asset URL",
                retryable=True,
                provider="twitter",
            )

    def _validate_size(self, response, maximum: int, label: str) -> None:
        content_length = response.headers.get("content-length")
        if (
            content_length
            and content_length.isdecimal()
            and int(content_length) > maximum
        ) or len(response.content) > maximum:
            raise ServiceError(
                "twitter_transaction_bootstrap_error",
                f"{label} exceeded the configured response size limit",
                retryable=True,
                provider="twitter",
            )

    @staticmethod
    def _bootstrap_error(context: str, error: Exception) -> ServiceError:
        return ServiceError(
            "twitter_transaction_bootstrap_error",
            f"Twitter {context}: {bounded_message(error, 200)}",
            retryable=True,
            provider="twitter",
        )
