"""统一设置入口下发的 Provider 凭据。

这里断言的是外部行为：调用方在请求里声明凭据时，服务就用那把 key 作答，与它启动时缓存的设置无关；
候选凭据的校验不会让它成为任何请求会用到的凭据；删除后的旧值不会在长驻服务里继续生效；
响应里不出现任何密钥。
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from conftest import client_for, make_settings
from pydantic import SecretStr

from research_source_service.documents import DocumentService
from research_source_service.http_client import HttpGateway
from research_source_service.models import SearchRequest
from research_source_service.sources import SourceRegistry

STARTUP_KEY = "tvly-startup-key-000000000000"
ROTATED_KEY = "tvly-rotated-key-11111111111"
TYPO_KEY = "tvly-typo-key-2222222222222"
TAVILY_ENV = "SOURCE_SERVICE_TAVILY_API_KEY"


def tavily_recorder(
    seen: list[str],
    reject: set[str] | None = None,
    gate: asyncio.Event | None = None,
    started: asyncio.Event | None = None,
):
    rejected = reject or set()

    async def handler(request: httpx.Request) -> httpx.Response:
        key = request.headers.get("authorization", "").removeprefix("Bearer ")
        seen.append(key)
        if started is not None:
            started.set()
        if gate is not None:
            await gate.wait()
        if key in rejected:
            # Provider 常把被拒的 key 原样写回失败正文。
            return httpx.Response(401, json={"error": f"invalid api key: {key}"})
        return httpx.Response(
            200,
            json={"results": [{"url": "https://example.com/a", "title": "A", "content": "snippet"}]},
        )

    return handler


def search(client, authorization, credential: dict[str, str | None] | None = None):
    return client.post(
        "/v1/search",
        headers=authorization,
        json={
            "schema_version": 1,
            "source_id": "general_web_tavily",
            "query": "agent evaluation",
            "max_results": 1,
            **({"credential": credential} if credential is not None else {}),
        },
    )


def test_the_request_credential_decides_not_the_cached_settings(tmp_path, authorization) -> None:
    seen: list[str] = []
    with client_for(tmp_path, tavily_recorder(seen), tavily_api_key=SecretStr(STARTUP_KEY)) as client:
        assert search(client, authorization).status_code == 200
        assert search(client, authorization, {TAVILY_ENV: ROTATED_KEY}).status_code == 200
        # 同一个长驻服务，没有重启，也没有任何配置更新调用。
        assert search(client, authorization, {TAVILY_ENV: ROTATED_KEY}).status_code == 200

    assert seen == [STARTUP_KEY, ROTATED_KEY, ROTATED_KEY]


def test_a_deleted_credential_cannot_be_answered_from_cached_settings(tmp_path, authorization) -> None:
    seen: list[str] = []
    with client_for(tmp_path, tavily_recorder(seen), tavily_api_key=SecretStr(STARTUP_KEY)) as client:
        rejected = search(client, authorization, {TAVILY_ENV: None})

    assert rejected.status_code == 502
    assert rejected.json()["error"]["code"] == "provider_credentials"
    assert seen == [], "凭据已删除时不会再向 Provider 发出请求"


def test_verifying_a_candidate_never_makes_it_the_credential_in_use(tmp_path, authorization) -> None:
    seen: list[str] = []
    handler = tavily_recorder(seen, reject={TYPO_KEY})
    with client_for(tmp_path, handler, tavily_api_key=SecretStr(STARTUP_KEY)) as client:
        accepted = client.post(
            "/v1/credentials/verify",
            headers=authorization,
            json={"schema_version": 1, "source_id": "general_web_tavily", "credential": {TAVILY_ENV: ROTATED_KEY}},
        )
        assert accepted.status_code == 200, accepted.text
        assert accepted.json() == {"schema_version": 1, "source_id": "general_web_tavily"}

        refused = client.post(
            "/v1/credentials/verify",
            headers=authorization,
            json={"schema_version": 1, "source_id": "general_web_tavily", "credential": {TAVILY_ENV: TYPO_KEY}},
        )
        assert refused.status_code == 502
        assert refused.json()["error"]["code"] == "provider_credentials"
        assert TYPO_KEY not in refused.text, "失败信息不能带出候选凭据"

        # 校验没有改变任何在用凭据：不带 credential 的请求仍然用服务自己的配置。
        assert search(client, authorization).status_code == 200

    assert seen == [ROTATED_KEY, TYPO_KEY, STARTUP_KEY]


def test_unknown_credential_name_is_rejected(tmp_path, authorization) -> None:
    with client_for(tmp_path, tavily_recorder([])) as client:
        response = client.post(
            "/v1/credentials/verify",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "general_web_tavily",
                "credential": {"TELOMI_NOT_A_CREDENTIAL": "value"},
            },
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "unknown_credential"


def test_service_api_token_cannot_be_replaced_through_a_request(tmp_path, authorization) -> None:
    with client_for(tmp_path, tavily_recorder([])) as client:
        response = search(client, authorization, {"SOURCE_SERVICE_API_TOKEN": "x" * 32})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "unknown_credential"
        # 本服务自己的调用凭据没有被换掉。
        assert client.get("/v1/health", headers=authorization).status_code == 200


def test_a_source_without_a_managed_credential_cannot_be_verified(tmp_path, authorization) -> None:
    with client_for(tmp_path, tavily_recorder([])) as client:
        response = client.post(
            "/v1/credentials/verify",
            headers=authorization,
            json={"schema_version": 1, "source_id": "arxiv", "credential": {TAVILY_ENV: ROTATED_KEY}},
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "source_not_registered"


@pytest.mark.asyncio
async def test_an_in_flight_search_finishes_on_the_credential_it_started_with(tmp_path) -> None:
    """轮换发生在一次检索进行中时，那次检索用它开始时的凭据完成，不被取消也不中途换 key。"""
    seen: list[str] = []
    gate = asyncio.Event()
    started = asyncio.Event()
    gateway = HttpGateway(
        httpx.AsyncClient(transport=httpx.MockTransport(tavily_recorder(seen, gate=gate, started=started)))
    )
    settings = make_settings(tmp_path, tavily_api_key=SecretStr(STARTUP_KEY))
    registry = SourceRegistry(
        settings,
        gateway,
        DocumentService(
            allowed_workspace_roots=settings.resolved_workspace_roots(),
            max_bytes=settings.max_document_bytes,
            max_concurrency=settings.document_max_concurrency,
        ),
    )
    try:
        request = SearchRequest(
            source_id="general_web_tavily",
            query="agent evaluation",
            max_results=1,
            credential={TAVILY_ENV: STARTUP_KEY},
        )
        in_flight = asyncio.create_task(registry.search(request))
        # 请求已经发出，Provider 还没有作答。
        await started.wait()
        rotated = SearchRequest(
            source_id="general_web_tavily",
            query="agent evaluation",
            max_results=1,
            credential={TAVILY_ENV: ROTATED_KEY},
        )
        gate.set()
        assert len(await in_flight) == 1
        assert len(await registry.search(rotated)) == 1
    finally:
        registry.close()

    assert seen == [STARTUP_KEY, ROTATED_KEY]


def test_search_errors_do_not_echo_arbitrary_request_keys(tmp_path, authorization) -> None:
    key = "550e8400-e29b-41d4-a716-446655440000"
    with client_for(tmp_path, tavily_recorder([], reject={key})) as client:
        response = search(client, authorization, {TAVILY_ENV: key})
    assert response.status_code == 502
    assert key not in response.text


def test_imported_large_cookie_export_reaches_the_provider(tmp_path, authorization) -> None:
    from test_twitter import COOKIE, payload_for
    from test_twitter_transaction import ONDEMAND_FIXTURE, transaction_home_fixture

    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/home":
            return httpx.Response(200, text=transaction_home_fixture())
        if request.url.host == "abs.twimg.com":
            return httpx.Response(200, text=ONDEMAND_FIXTURE)
        seen.append(request.headers["cookie"])
        return httpx.Response(200, json=payload_for(request.url.path.rsplit("/", 1)[-1], request.url.path))

    # Comments and unrelated entries are normal in exported Netscape cookie files.
    cookie = "# Netscape HTTP Cookie File\n" + "# export metadata\n" * 2000
    cookie += ".x.com\tTRUE\t/\tTRUE\t0\tauth_token\tsession-secret\n"
    cookie += ".x.com\tTRUE\t/\tTRUE\t0\tct0\tcsrf-secret\n"
    cookie += ".x.com\tTRUE\t/\tTRUE\t0\ttwid\tu%3D42\n"
    with client_for(tmp_path, handler) as client:
        response = client.post("/v1/search", headers=authorization, json={
            "source_id": "twitter", "query": "test", "max_results": 1,
            "provider_request": {"operation": "search", "parameters": {"query": "test", "limit": 1}},
            "credential": {"SOURCE_SERVICE_TWITTER_COOKIE": cookie, "SOURCE_SERVICE_TWITTER_COOKIE_FILE": None},
        })
    assert response.status_code == 200, response.text
    assert seen == [COOKIE]


@pytest.mark.asyncio
async def test_gh_subprocess_only_sees_the_captured_token(tmp_path, monkeypatch):
    """删除托管 GitHub 凭据后，长驻服务进程继承的环境 token 不能继续给 gh 使用。"""
    from research_source_service.sources import github as github_module

    fake_gh = tmp_path / "gh"
    fake_gh.write_text('#!/bin/sh\nprintf "%s|%s" "${GH_TOKEN-}" "${GITHUB_TOKEN-}"\n')
    fake_gh.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:{__import__('os').environ['PATH']}")
    monkeypatch.setenv("GH_TOKEN", "ambient-gh")
    monkeypatch.setenv("GITHUB_TOKEN", "ambient-github")

    assert await github_module.run_gh(["noop"], token=None) == "|"
    assert await github_module.run_gh(["noop"], token="captured") == "captured|"
