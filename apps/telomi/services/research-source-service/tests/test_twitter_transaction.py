from __future__ import annotations

import base64

import httpx
import pytest

from research_source_service.http_client import HttpGateway
from research_source_service.sources.twitter_transaction import TwitterTransactionSigner


def transaction_home_fixture() -> str:
    key = base64.b64encode(bytes(range(64))).decode()
    rows = "C".join(
        " ".join(str((row + column) % 256) for column in range(11))
        for row in range(16)
    )
    frames = "".join(
        f'<div id="loading-x-anim-{index}"><svg><g></g>'
        f'<path d="M0 0 0 0C{rows}"></path></svg></div>'
        for index in range(4)
    )
    return (
        '<html><head><meta name="twitter-site-verification" '
        f'content="{key}"></head><body>{frames}'
        '<script>var assets={,123:"ondemand.s",123:"deadbeef"}</script>'
        "</body></html>"
    )


ONDEMAND_FIXTURE = "(a[1], 16),(b[2], 16),(c[3], 16),(d[4], 16)"


@pytest.mark.asyncio
async def test_signer_bootstraps_anonymously_and_reuses_the_context(monkeypatch) -> None:
    requests: list[httpx.Request] = []
    random_values = iter((1, 2))
    monkeypatch.setattr(
        "x_client_transaction.transaction.random.randint",
        lambda _start, _end: next(random_values),
    )
    monkeypatch.setattr("x_client_transaction.transaction.time.time", lambda: 1_800_000_000)

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/home":
            return httpx.Response(200, text=transaction_home_fixture())
        if request.url.host == "abs.twimg.com":
            return httpx.Response(200, text=ONDEMAND_FIXTURE)
        raise AssertionError(f"Unexpected request: {request.url}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        signer = TwitterTransactionSigner(HttpGateway(client), "https://x.com")
        first = await signer.header_for(
            "GET",
            "https://x.com/i/api/graphql/query-id/Followers?variables=ignored",
        )
        second = await signer.header_for(
            "GET",
            "https://x.com/i/api/graphql/query-id/Followers?variables=changed",
        )

    assert first
    assert second
    assert first != second
    assert [request.url.path for request in requests] == [
        "/home",
        "/responsive-web/client-web/ondemand.s.deadbeefa.js",
    ]
    assert all("cookie" not in request.headers for request in requests)
    assert all("authorization" not in request.headers for request in requests)
