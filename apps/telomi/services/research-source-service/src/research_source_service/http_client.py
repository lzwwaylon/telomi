from __future__ import annotations

import json
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import httpx

from .errors import ServiceError, bounded_message

USER_AGENT = "Telomi-ResearchSourceService/1.0"
PERMANENT_STATUSES = {401, 402, 403, 432, 433}
VALIDATION_STATUSES = {400, 404, 409, 422}
RETRYABLE_STATUSES = {408, 425, 429, 500, 502, 503, 504}


class HttpGateway:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client

    async def request_json(
        self,
        provider: str,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, object] | None = None,
        body: Mapping[str, object] | None = None,
    ) -> dict[str, Any]:
        response = await self.request(provider, method, url, headers=headers, params=params, body=body)
        try:
            payload = response.json()
        except json.JSONDecodeError as error:
            raise ServiceError(
                "invalid_provider_response",
                f"{provider} returned invalid JSON",
                provider=provider,
            ) from error
        if not isinstance(payload, dict):
            raise ServiceError(
                "invalid_provider_response",
                f"{provider} returned a non-object JSON response",
                provider=provider,
            )
        return payload

    async def request_text(
        self,
        provider: str,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, object] | None = None,
        body: Mapping[str, object] | None = None,
        form: Mapping[str, object] | None = None,
    ) -> str:
        response = await self.request(
            provider,
            method,
            url,
            headers=headers,
            params=params,
            body=body,
            form=form,
        )
        return response.text

    async def request(
        self,
        provider: str,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, object] | None = None,
        body: Mapping[str, object] | None = None,
        form: Mapping[str, object] | None = None,
        follow_redirects: bool = False,
    ) -> httpx.Response:
        try:
            response = await self.client.request(
                method,
                url,
                headers={"Accept": "*/*", "User-Agent": USER_AGENT, **(headers or {})},
                params=params,
                json=body,
                data=form,
                follow_redirects=follow_redirects,
            )
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            raise ServiceError(
                "provider_timeout" if isinstance(error, httpx.TimeoutException) else "provider_network_error",
                f"{provider} request failed: {bounded_message(error)}",
                retryable=True,
                provider=provider,
            ) from error
        if response.is_success:
            return response
        raise provider_http_error(provider, response)


UPSTREAM_HEADER_KEYS = (
    "server", "via", "x-served-by", "x-cache", "age", "date", "retry-after",
    "ratelimit", "ratelimit-reset", "x-ratelimit-remaining", "x-timer", "cf-ray", "content-type",
)


def upstream_details(response: httpx.Response) -> dict[str, object]:
    """Evidence kept on every upstream failure: who answered (edge or origin) and what it said."""
    headers = {key: response.headers[key] for key in UPSTREAM_HEADER_KEYS if key in response.headers}
    return {
        "upstream_status": response.status_code,
        "upstream_headers": headers,
        "upstream_body": redact_secrets(" ".join(response.text.split()))[:300],
    }


def provider_http_error(provider: str, response: httpx.Response) -> ServiceError:
    detail = response_detail(response)
    if response.status_code in PERMANENT_STATUSES:
        return ServiceError(
            "provider_credentials",
            f"{provider} cannot serve this request with current credentials (HTTP {response.status_code}): {detail}",
            status_code=502,
            provider=provider,
            details={
                "circuit_scope": "provider",
                "failure_scope": "provider",
                **upstream_details(response),
            },
        )
    if response.status_code in VALIDATION_STATUSES:
        return ServiceError(
            "provider_rejected_request",
            f"{provider} rejected the request (HTTP {response.status_code}): {detail}",
            status_code=400,
            provider=provider,
            details=upstream_details(response),
        )
    return ServiceError(
        "provider_rate_limit" if response.status_code == 429 else "provider_error",
        f"{provider} returned HTTP {response.status_code}: {detail}",
        retryable=response.status_code in RETRYABLE_STATUSES or response.status_code >= 500,
        provider=provider,
        details=upstream_details(response),
        retry_after_ms=provider_retry_after_ms(response.headers) if response.status_code == 429 else None,
    )


def provider_retry_after_ms(headers: Mapping[str, str]) -> int | None:
    retry_after = retry_after_ms(headers.get("retry-after"))
    if retry_after is not None:
        return retry_after
    rate_limit = headers.get("ratelimit")
    if rate_limit:
        match = re.search(r"(?:^|;)\s*t=(\d+(?:\.\d+)?)\s*(?:;|$)", rate_limit)
        if match:
            return max(0, round(float(match.group(1)) * 1_000))
    return retry_after_ms(headers.get("ratelimit-reset"))


def retry_after_ms(value: str | None) -> int | None:
    if not value:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", value):
        return max(0, round(float(value) * 1_000))
    try:
        parsed = datetime.fromisoformat(value.replace("GMT", "+00:00"))
    except ValueError:
        from email.utils import parsedate_to_datetime

        try:
            parsed = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return max(0, round((parsed - datetime.now(UTC)).total_seconds() * 1_000))


def response_detail(response: httpx.Response) -> str:
    text = response.text
    try:
        payload = response.json()
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, str):
                text = error
            elif isinstance(error, dict) and isinstance(error.get("message"), str):
                text = error["message"]
            elif isinstance(payload.get("message"), str):
                text = payload["message"]
    except json.JSONDecodeError:
        pass
    return redact_secrets(" ".join(text.split()))[:500] or "unknown provider error"


def redact_secrets(value: str) -> str:
    value = re.sub(r"\b(?:tvly|exa|fc|hf_)-[A-Za-z0-9_-]{8,}\b", "[redacted-api-key]", value)
    value = re.sub(r"\bhf_[A-Za-z0-9_-]{8,}\b", "[redacted-api-key]", value)
    value = re.sub(
        r"(?i)(authorization\s*:\s*bearer\s+|x-api-key\s*:\s*)[^\s,;]+",
        r"\1[redacted]",
        value,
    )
    value = re.sub(r"(?i)(cookie\s*:\s*)[^\r\n]+", r"\1[redacted]", value)
    return re.sub(
        r"(?i)\b(auth_token|ct0)=([^;\s]+)",
        r"\1=[redacted]",
        value,
    )
