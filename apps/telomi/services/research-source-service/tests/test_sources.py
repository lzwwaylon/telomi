from __future__ import annotations

import json
import sqlite3
import time
from types import SimpleNamespace

import httpx
import pytest
from conftest import client_for

from research_source_service.arxiv_runtime import ArxivRuntimeStore
from research_source_service.documents import DocumentService
from research_source_service.sources import github as github_module


def test_github_search_uses_authenticated_gh_cli(tmp_path, authorization, monkeypatch) -> None:
    calls: list[list[str]] = []

    async def fake_run_gh(args, *, token, stdout_path=None):
        calls.append(args)
        assert token is None
        assert stdout_path is None
        return json.dumps(
            {
                "items": [
                    {
                        "full_name": "example/agent-runtime",
                        "html_url": "https://github.com/example/agent-runtime",
                        "description": "Reliable agent runtime",
                        "language": "Python",
                        "stargazers_count": 123,
                        "forks_count": 9,
                        "updated_at": "2026-07-17T00:00:00Z",
                        "owner": {"login": "example"},
                    }
                ]
            }
        )

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"GitHub Provider must not make direct HTTP requests: {request.url}")

    with client_for(tmp_path, handler) as client:
        first = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "official open source agent repositories",
                "max_results": 3,
            },
        )
        second = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "official open source agent repositories",
                "max_results": 3,
            },
        )

    assert first.status_code == 200
    assert first.json()["results"][0]["id"] == second.json()["results"][0]["id"]
    assert first.json()["results"][0]["metadata"]["stars"] == 123
    assert (
        calls
        == [
            [
                "api",
                "--method",
                "GET",
                "/search/repositories",
                "-f",
                "q=agent fork:false archived:false is:public",
                "-f",
                "sort=stars",
                "-f",
                "order=desc",
                "-F",
                "per_page=3",
            ]
        ]
        * 2
    )


def test_github_topic_search_uses_curated_github_topics(tmp_path, authorization, monkeypatch) -> None:
    calls: list[list[str]] = []

    async def fake_run_gh(args, *, token, stdout_path=None):
        calls.append(args)
        if "q=text-to-speech is:curated" in args:
            return json.dumps({"items": [{"name": "chatbot", "curated": True}]})
        return json.dumps({"items": [{
            "name": "text-to-speech",
            "display_name": "Text to speech",
            "short_description": "Speech synthesis tools and models",
            "featured": True,
            "curated": True,
            "created_by": "github",
        }]})

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)

    with client_for(tmp_path, lambda request: pytest.fail(f"Unexpected HTTP request: {request.url}")) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "text-to-speech",
                "max_results": 5,
                "provider_request": {
                    "operation": "search_topics",
                    "parameters": {"query": "text-to-speech", "curated_only": True, "limit": 5},
                },
            },
        )

    assert response.status_code == 200
    assert response.json()["results"][0]["metadata"] == {
        "name": "text-to-speech",
        "display_name": "Text to speech",
        "short_description": "Speech synthesis tools and models",
        "featured": True,
        "curated": True,
        "created_by": "github",
    }
    assert calls == [
        [
            "api", "--method", "GET", "/search/topics",
            "-f", "q=text-to-speech is:curated", "-F", "per_page=5",
        ],
        [
            "api", "--method", "GET", "/search/topics",
            "-f", "q=text-to-speech", "-F", "per_page=5",
        ],
    ]


def test_github_repository_search_builds_structured_qualifiers(
    tmp_path, authorization, monkeypatch,
) -> None:
    calls: list[list[str]] = []

    async def fake_run_gh(args, *, token, stdout_path=None):
        calls.append(args)
        return json.dumps({"items": []})

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)

    with client_for(tmp_path, lambda request: pytest.fail(f"Unexpected HTTP request: {request.url}")) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "voice",
                "max_results": 5,
                "provider_request": {
                    "operation": "search_repositories",
                    "parameters": {
                        "query": "voice",
                        "topics": ["text-to-speech", "speech-synthesis"],
                        "language": "Python",
                        "min_stars": 500,
                        "created_after": "2026-01-01",
                        "created_before": "2026-08-31",
                        "pushed_after": "2026-07-01",
                        "sort": "updated",
                        "order": "asc",
                        "limit": 5,
                    },
                },
            },
        )

    assert response.status_code == 200
    assert calls == [[
        "api", "--method", "GET", "/search/repositories",
        "-f", (
            "q=voice topic:text-to-speech topic:speech-synthesis language:Python stars:>=500 "
            "created:2026-01-01..2026-08-31 pushed:>=2026-07-01 "
            "fork:false archived:false is:public"
        ),
        "-f", "sort=updated", "-f", "order=asc", "-F", "per_page=5",
    ]]


def test_github_missing_repository_suggests_ranked_matches(tmp_path, authorization, monkeypatch) -> None:
    calls: list[list[str]] = []
    missing = github_module.ServiceError(
        "github_cli_failed",
        "GitHub CLI failed: gh: Not Found (HTTP 404)",
        provider="github",
    )

    async def fake_run_gh(args, *, token, stdout_path=None):
        calls.append(args)
        assert token is None
        assert stdout_path is None
        path = args[3]
        if path == "/repos/OpenBMB/VoxCPM2":
            raise missing
        if path == "/orgs/OpenBMB/repos":
            return json.dumps(
                [
                    {"full_name": "OpenBMB/unrelated-repository"},
                    {"full_name": "OpenBMB/voxcpm2-demopage"},
                    {"full_name": "OpenBMB/VoxCPM"},
                ]
            )
        if path == "/search/repositories":
            return json.dumps({"items": [{"full_name": "OpenBMB/VoxCPM"}]})
        raise AssertionError(f"Unexpected gh call: {args}")

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)

    with client_for(tmp_path, lambda request: pytest.fail(f"Unexpected HTTP request: {request.url}")) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "repository:OpenBMB/VoxCPM2",
                "max_results": 1,
                "provider_request": {
                    "operation": "get_repository",
                    "parameters": {"repository": "OpenBMB/VoxCPM2"},
                },
            },
        )

    suggestions = ["OpenBMB/VoxCPM", "OpenBMB/voxcpm2-demopage"]
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "github_repository_not_found"
    assert error["retryable"] is False
    assert error["details"]["suggestions"] == suggestions
    assert error["message"] == (
        "GitHub repository 'OpenBMB/VoxCPM2' was not found. "
        "Similar repositories: OpenBMB/VoxCPM, OpenBMB/voxcpm2-demopage. "
        "Call search_repositories(query=VoxCPM2 user:OpenBMB) to obtain an exact repository, "
        "then retry get_repository."
    )
    assert calls == [
        ["api", "--method", "GET", "/repos/OpenBMB/VoxCPM2"],
        ["api", "--method", "GET", "/orgs/OpenBMB/repos", "-F", "per_page=100", "-f", "sort=pushed"],
        [
            "api",
            "--method",
            "GET",
            "/search/repositories",
            "-f",
            "q=VoxCPM2 user:OpenBMB",
            "-F",
            "per_page=10",
        ],
    ]


def test_github_missing_repository_falls_back_to_user_owner(tmp_path, authorization, monkeypatch) -> None:
    calls: list[list[str]] = []
    missing = github_module.ServiceError(
        "github_cli_failed",
        "GitHub CLI failed: gh: Not Found (HTTP 404)",
        provider="github",
    )

    async def fake_run_gh(args, *, token, stdout_path=None):
        calls.append(args)
        path = args[3]
        if path in {"/repos/octocat/Helo-World", "/orgs/octocat/repos"}:
            raise missing
        if path == "/users/octocat/repos":
            return json.dumps([{"full_name": "octocat/Hello-World"}])
        raise AssertionError(f"Unexpected gh call: {args}")

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)

    with client_for(tmp_path, lambda request: pytest.fail(f"Unexpected HTTP request: {request.url}")) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "repository:octocat/Helo-World",
                "max_results": 1,
                "provider_request": {
                    "operation": "get_repository",
                    "parameters": {"repository": "octocat/Helo-World"},
                },
            },
        )

    assert response.status_code == 404
    assert response.json()["error"]["details"]["suggestions"] == ["octocat/Hello-World"]
    assert calls == [
        ["api", "--method", "GET", "/repos/octocat/Helo-World"],
        ["api", "--method", "GET", "/orgs/octocat/repos", "-F", "per_page=100", "-f", "sort=pushed"],
        ["api", "--method", "GET", "/users/octocat/repos", "-F", "per_page=100", "-f", "sort=pushed"],
    ]


def test_github_repository_non_404_failure_is_unchanged(tmp_path, authorization, monkeypatch) -> None:
    calls: list[list[str]] = []
    failure = github_module.ServiceError(
        "github_cli_failed",
        "GitHub CLI failed: upstream unavailable (HTTP 500)",
        retryable=True,
        provider="github",
    )

    async def fake_run_gh(args, *, token, stdout_path=None):
        calls.append(args)
        raise failure

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)

    with client_for(tmp_path, lambda request: pytest.fail(f"Unexpected HTTP request: {request.url}")) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "repository:OpenBMB/VoxCPM2",
                "max_results": 1,
                "provider_request": {
                    "operation": "get_repository",
                    "parameters": {"repository": "OpenBMB/VoxCPM2"},
                },
            },
        )

    assert response.status_code == 502
    error = response.json()["error"]
    assert error["code"] == "github_cli_failed"
    assert error["message"] == "GitHub CLI failed: upstream unavailable (HTTP 500)"
    assert error["retryable"] is True
    assert error["details"] == {}
    assert calls == [["api", "--method", "GET", "/repos/OpenBMB/VoxCPM2"]]


def test_github_issue_search_and_detail_use_authenticated_gh_cli(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    calls: list[list[str]] = []
    issue = {
        "number": 42,
        "title": "Connection reset during retry",
        "html_url": "https://github.com/example/runtime/issues/42",
        "repository_url": "https://api.github.com/repos/example/runtime",
        "body": "The retry loop resets the connection.",
        "state": "open",
        "comments": 1,
        "user": {"login": "reporter"},
        "labels": [{"name": "bug"}],
        "created_at": "2026-07-20T00:00:00Z",
        "updated_at": "2026-07-21T00:00:00Z",
        "closed_at": None,
    }

    comment = {
        "id": 7,
        "body": "This was fixed by preserving the socket.",
        "user": {"login": "maintainer"},
        "created_at": "2026-07-21T01:00:00Z",
        "updated_at": "2026-07-21T01:00:00Z",
        "html_url": "https://github.com/example/runtime/issues/42#issuecomment-7",
    }

    async def fake_run_gh(args, *, token, stdout_path=None):
        calls.append(args)
        assert token is None
        assert stdout_path is None
        path = args[3]
        if path == "/search/issues":
            return json.dumps({"items": [issue]})
        if path == "/repos/example/runtime/issues/42/comments":
            return json.dumps([comment])
        if path == "/repos/example/runtime/issues/42":
            return json.dumps(issue)
        raise AssertionError(f"Unexpected gh call: {args}")

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"GitHub Provider must not make direct HTTP requests: {request.url}")

    with client_for(tmp_path, handler) as client:
        search = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "unused",
                "max_results": 20,
                "provider_request": {
                    "operation": "search_issues",
                    "parameters": {
                        "query": "connection reset",
                        "repository": "example/runtime",
                        "state": "all",
                        "match": "comments",
                        "limit": 20,
                    },
                },
            },
        )
        detail = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "unused",
                "max_results": 1,
                "provider_request": {
                    "operation": "get_issue",
                    "parameters": {"repository": "example/runtime", "number": 42},
                },
            },
        )

    assert search.status_code == 200
    assert detail.status_code == 200
    result = detail.json()["results"][0]
    assert result["metadata"]["resource_type"] == "issue_discussion"
    assert result["metadata"]["comments"][0]["author"] == "maintainer"
    assert "preserving the socket" in result["metadata"]["comments"][0]["body"]
    assert [call[3] for call in calls] == [
        "/search/issues",
        "/repos/example/runtime/issues/42",
        "/repos/example/runtime/issues/42/comments",
    ]
    assert "q=connection reset is:issue repo:example/runtime in:comments" in calls[0]


def test_github_code_search_reuses_authenticated_gh_cli_without_env_token(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    calls: list[list[str]] = []

    async def fake_run_gh(args, *, token, stdout_path=None):
        calls.append(args)
        assert token is None
        assert stdout_path is None
        return json.dumps(
            {
                "items": [
                    {
                        "html_url": "https://github.com/cli/cli/blob/main/pkg/cmd/auth/status/status.go",
                        "path": "pkg/cmd/auth/status/status.go",
                        "sha": "abc123",
                        "repository": {"full_name": "cli/cli"},
                        "text_matches": [{"fragment": "authentication"}],
                    }
                ]
            }
        )

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected unauthenticated HTTP request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "unused",
                "max_results": 3,
                "provider_request": {
                    "operation": "search_code",
                    "parameters": {
                        "query": "authentication",
                        "repository": "cli/cli",
                        "limit": 3,
                    },
                },
            },
        )

    assert response.status_code == 200
    assert response.json()["results"][0]["metadata"]["resource_type"] == "code"
    assert calls == [
        [
            "api",
            "--method",
            "GET",
            "-H",
            "Accept: application/vnd.github.text-match+json",
            "/search/code",
            "-f",
            "q=authentication repo:cli/cli",
            "-F",
            "per_page=3",
        ]
    ]


def test_github_downloads_stay_inside_workspace(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    workspace = tmp_path / "run"
    workspace.mkdir()
    calls: list[list[str]] = []

    async def fake_run_gh(args, *, token, stdout_path=None):
        calls.append(args)
        if args[:2] == ["repo", "clone"]:
            target = github_module.Path(args[3])
            (target / ".git").mkdir(parents=True)
            (target / "README.md").write_text("# cloned", encoding="utf-8")
        elif args[:2] == ["release", "download"]:
            target = github_module.Path(args[args.index("--dir") + 1])
            (target / "artifact.zip").write_bytes(b"release")
        elif args[0] == "api" and "/commits/" in args[1]:
            # 可变 ref -> commit SHA 的探测, 用于不可变缓存键
            return "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
        elif args[0] == "api":
            assert stdout_path is not None
            stdout_path.write_text("downloaded file", encoding="utf-8")
        return ""

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)
    monkeypatch.setattr(github_module, "checkout_without_missing_blobs", fake_checkout)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    requests = [
        {
            "operation": "clone_repository",
            "parameters": {
                "repository": "example/runtime",
                "ref": "main",
                "full_history": False,
            },
        },
        {
            "operation": "download_release",
            "parameters": {
                "repository": "example/runtime",
                "tag": "v1.0.0",
                "patterns": ["*.zip"],
            },
        },
        {
            "operation": "download_file",
            "parameters": {
                "repository": "example/runtime",
                "path": "docs/guide.md",
                "ref": "main",
            },
        },
    ]
    with client_for(tmp_path, handler) as client:
        responses = [
            client.post(
                "/v1/search",
                headers=authorization,
                json={
                    "schema_version": 1,
                    "source_id": "github",
                    "query": operation["operation"],
                    "max_results": 100,
                    "workspace_dir": str(workspace),
                    "provider_request": operation,
                },
            )
            for operation in requests
        ]

    assert all(response.status_code == 200 for response in responses)
    artifact_paths = [
        result["metadata"]["artifact_path"] for response in responses for result in response.json()["results"]
    ]
    assert all(not path.startswith("/") and ".." not in path.split("/") for path in artifact_paths)
    assert all((workspace / path).exists() for path in artifact_paths)
    clone_calls = [call for call in calls if call[:2] == ["repo", "clone"]]
    assert clone_calls, "clone_repository must issue a gh repo clone"
    assert clone_calls[0][-14:] == [
        "--no-checkout",
        "--filter=blob:limit=1m",
        "--depth=1",
        "--branch",
        "main",
        "--single-branch",
        "--config",
        "core.symlinks=false",
        "--config",
        "filter.lfs.smudge=",
        "--config",
        "filter.lfs.process=",
        "--config",
        "filter.lfs.required=false",
    ]
    # 克隆之前先把可变 ref 解析成 commit SHA, 缓存键才能是不可变的
    assert any(call[0] == "api" and "/commits/" in call[1] for call in calls)


async def fake_checkout(repository) -> None:
    assert (repository / ".git").is_dir()


def test_sparse_checkout_patterns_skip_only_missing_blobs() -> None:
    missing = "abc\n?deadbeef\n?cafe\n"
    listing = (
        "100644 blob abc\tREADME.md\0"
        "100644 blob deadbeef\tUtils/ASR/epoch_00080.pth\0"
        "100644 blob cafe\tData/with space.txt\0"
    )
    assert github_module.sparse_checkout_patterns(missing, listing) == [
        "/*",
        "!/Utils/ASR/epoch_00080.pth",
        "!/Data/with space.txt",
    ]
    assert github_module.sparse_checkout_patterns("", listing) == ["/*"]


def test_github_clone_cache_reuses_material_across_workspaces(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    calls = 0

    async def fake_run_gh(args, *, token, stdout_path=None):
        nonlocal calls
        if args[0] == "api" and "/commits/" in args[1]:
            return "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
        calls += 1
        target = github_module.Path(args[3])
        (target / ".git").mkdir(parents=True)
        (target / "README.md").write_text("# shared clone", encoding="utf-8")
        return ""

    monkeypatch.setattr(github_module, "run_gh", fake_run_gh)
    monkeypatch.setattr(github_module, "checkout_without_missing_blobs", fake_checkout)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    workspaces = [tmp_path / "run-one", tmp_path / "run-two"]
    for workspace in workspaces:
        workspace.mkdir()
    with client_for(tmp_path, handler, material_cache_root=tmp_path / "material-cache") as client:
        responses = [
            client.post(
                "/v1/search",
                headers=authorization,
                json={
                    "schema_version": 1,
                    "source_id": "github",
                    "query": "clone example/runtime",
                    "workspace_dir": str(workspace),
                    "provider_request": {
                        "operation": "clone_repository",
                        "parameters": {"repository": "example/runtime", "full_history": False},
                    },
                },
            )
            for workspace in workspaces
        ]

    assert all(response.status_code == 200 for response in responses)
    assert calls == 1
    for workspace, response in zip(workspaces, responses, strict=True):
        artifact = workspace / response.json()["results"][0]["metadata"]["artifact_path"]
        assert (artifact / "README.md").read_text(encoding="utf-8") == "# shared clone"


def test_github_rejects_unsafe_download_path_before_cli(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    workspace = tmp_path / "run"
    workspace.mkdir()

    async def unexpected_run_gh(*args, **kwargs):
        raise AssertionError("gh must not run for an unsafe path")

    monkeypatch.setattr(github_module, "run_gh", unexpected_run_gh)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "github",
                "query": "unsafe",
                "max_results": 1,
                "workspace_dir": str(workspace),
                "provider_request": {
                    "operation": "download_file",
                    "parameters": {
                        "repository": "example/runtime",
                        "path": "../secret",
                    },
                },
            },
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_github_request"


def test_arxiv_categories_filters_official_taxonomy(tmp_path, authorization) -> None:
    taxonomy = """
    <html><body>
      <div class="columns divided">
        <div class="column is-one-fifth"><h4>cs.SD <span>(Sound)</span></h4></div>
        <div class="column"><p>Computing with sound, analysis, and synthesis.</p></div>
      </div>
      <div class="columns divided">
        <div class="column is-one-fifth"><h4>eess.AS <span>(Audio and Speech Processing)</span></h4></div>
        <div class="column"><p>Processing speech and audio signals.</p></div>
      </div>
    </body></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://arxiv.org/category_taxonomy"
        return httpx.Response(200, text=taxonomy)

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "arxiv",
                "query": "categories:speech",
                "max_results": 25,
                "provider_request": {
                    "operation": "categories",
                    "parameters": {"search": ["speech synthesis"], "max_results": 25},
                },
            },
        )

    assert response.status_code == 200
    results = response.json()["results"]
    assert [result["metadata"]["category_id"] for result in results] == ["cs.SD", "eess.AS"]


def test_arxiv_native_query_parses_atom_metadata(tmp_path, authorization) -> None:
    atom = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom"
          xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
          xmlns:arxiv="http://arxiv.org/schemas/atom">
      <title>ArXiv Query: combined native request</title>
      <id>https://arxiv.org/api/native-query-id</id>
      <updated>2026-07-17T00:00:00Z</updated>
      <link href="https://export.arxiv.org/api/query?search_query=cat%3Acs.AI" rel="self"/>
      <opensearch:totalResults>1</opensearch:totalResults>
      <opensearch:startIndex>0</opensearch:startIndex>
      <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
      <entry>
        <id>http://arxiv.org/abs/2401.00001v2</id>
        <updated>2026-07-01T00:00:00Z</updated>
        <published>2026-06-30T00:00:00Z</published>
        <title>Agent Evaluation</title>
        <summary>A reproducible evaluation.</summary>
        <author><name>Ada Example</name></author>
        <link title="pdf" href="https://arxiv.org/pdf/2401.00001v2" type="application/pdf"/>
        <category term="cs.AI"/>
        <arxiv:primary_category term="cs.AI"/>
        <arxiv:doi>10.1000/example</arxiv:doi>
      </entry>
    </feed>"""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "export.arxiv.org"
        assert request.method == "POST"
        form = httpx.QueryParams(request.content.decode())
        assert form["search_query"] == "cat:cs.AI"
        assert form["id_list"] == "2401.00001v2"
        assert form["start"] == "7"
        assert form["max_results"] == "1"
        assert form["sortBy"] == "lastUpdatedDate"
        assert form["sortOrder"] == "ascending"
        return httpx.Response(200, text=atom, headers={"content-type": "application/atom+xml"})

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "arxiv",
                "query": "unused fallback",
                "max_results": 10,
                "provider_request": {
                    "operation": "query",
                    "parameters": {
                        "search_query": "cat:cs.AI",
                        "id_list": ["2401.00001v2"],
                        "start": 7,
                        "max_results": 1,
                        "sortBy": "lastUpdatedDate",
                        "sortOrder": "ascending",
                        "http_method": "post",
                    },
                },
            },
        )

    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["url"] == "https://arxiv.org/abs/2401.00001v2"
    assert result["authors"] == ["Ada Example"]
    assert result["metadata"]["arxiv_id"] == "2401.00001"
    assert result["metadata"]["author_records"] == [{"name": "Ada Example"}]
    assert result["metadata"]["source_url"] == "https://arxiv.org/src/2401.00001v2"
    assert result["metadata"]["arxiv_feed"]["total_results"] == 1
    assert result["metadata"]["arxiv_feed"]["id"] == "https://arxiv.org/api/native-query-id"
    assert result["metadata"]["arxiv_feed"]["links"][0]["rel"] == "self"
    assert result["metadata"]["arxiv_query"]["id_list"] == ["2401.00001v2"]
    assert result["metadata"]["arxiv_request_method"] == "POST"


def test_arxiv_paper_front_extracts_front_matter_and_caches_it(
    tmp_path,
    authorization,
) -> None:
    requests = 0
    document = """<html><head><title>Fallback title</title><script>ignore me</script></head><body>
      <div class="ds-announcement" id="announcement-banner">
        <a href="https://info.arxiv.org/about">arXiv</a> banner</div>
      <header class="arxiv-html-header"><nav class="html-header-nav">Report Issue Back to Abstract</nav></header>
      <div class="ltx_page_main"><div class="infobox" id="infobox"><a href="https://info.arxiv.org/help/license/index.html">License</a></div>
      <article class="ltx_document">
      <h1 class="ltx_title_document">Front &amp; Matter</h1>
      <div class="ltx_authors">Ada Example
        <span class="ltx_author_notes">Affiliation: Example University</span>
      </div>
      <div class="ltx_note_content">1 Example Laboratory; 2 Research Group</div>
      <section class="ltx_section"><h2>Introduction</h2>
        <p>Code is available at https://github.com/example/project. Contact ada@example.edu.</p>
        <p>Weights: <a href="https://huggingface.co/example/weights">model card</a>.</p>
      </section>
      <section class="ltx_bibliography"><h2>References</h2>
        <p>Cited work https://github.com/cited/work.</p>
      </section>
      </article></div>
      <footer class="ds-site-footer"><a href="https://info.arxiv.org/help">Help</a></footer>
    </body></html>"""

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        assert request.url == "https://arxiv.org/html/2401.00001v2"
        return httpx.Response(200, text=document, headers={"content-type": "text/html"})

    payload = {
        "schema_version": 1,
        "source_id": "arxiv",
        "query": "2401.00001v2",
        "provider_request": {
            "operation": "paper_front",
            "parameters": {"arxiv_id": "2401.00001v2"},
        },
    }
    with client_for(
        tmp_path,
        handler,
        material_cache_root=tmp_path / "material-cache",
    ) as client:
        first = client.post("/v1/search", headers=authorization, json=payload)
        second = client.post("/v1/search", headers=authorization, json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert requests == 1
    metadata = first.json()["results"][0]["metadata"]
    assert metadata["html_available"] is True
    assert metadata["arxiv_id"] == "2401.00001"
    assert metadata["arxiv_version_id"] == "2401.00001v2"
    assert metadata["title_text"] == "Front & Matter"
    assert metadata["author_block_text"] == "Ada Example Affiliation: Example University"
    assert metadata["author_notes"] == ["Affiliation: Example University"]
    assert metadata["footnotes"] == ["1 Example Laboratory; 2 Research Group"]
    assert metadata["emails"] == {"domains": ["example.edu"], "addresses": ["ada@example.edu"]}
    assert "Code is available" in metadata["front_text"]
    assert "https://github.com/example/project" in metadata["pre_bibliography_text"]
    assert "info.arxiv.org" not in metadata["pre_bibliography_text"] and "Report Issue" not in metadata["front_text"]
    assert "https://github.com/cited/work" not in metadata["pre_bibliography_text"]
    assert "(https://huggingface.co/example/weights)" in metadata["pre_bibliography_text"]
    assert metadata["bibliography_detected"] is True
    assert "ignore me" not in metadata["pre_bibliography_text"]


def test_arxiv_paper_front_returns_pdf_fallback_hint_on_404(
    tmp_path,
    authorization,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://arxiv.org/html/2401.00002"
        return httpx.Response(404, text="not found")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "arxiv",
                "query": "2401.00002",
                "provider_request": {
                    "operation": "paper_front",
                    "parameters": {"arxiv_id": "2401.00002"},
                },
            },
        )

    assert response.status_code == 200
    metadata = response.json()["results"][0]["metadata"]
    assert metadata["html_available"] is False
    assert metadata["arxiv_version_id"] == "2401.00002"
    assert "download_pdf" in metadata["hint"]


def test_arxiv_download_pdf_converts_to_readable_markdown(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    upstream_scopes: list[tuple[str, float]] = []
    original_reserve = ArxivRuntimeStore.reserve_upstream_slot

    def reserve(self, scope: str, min_interval_seconds: float) -> float:
        upstream_scopes.append((scope, min_interval_seconds))
        return original_reserve(self, scope, min_interval_seconds)

    monkeypatch.setattr(ArxivRuntimeStore, "reserve_upstream_slot", reserve)
    atom = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
      <opensearch:totalResults>1</opensearch:totalResults>
      <opensearch:startIndex>0</opensearch:startIndex>
      <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
      <entry>
        <id>http://arxiv.org/abs/2401.00001v2</id>
        <updated>2026-07-01T00:00:00Z</updated>
        <published>2026-06-30T00:00:00Z</published>
        <title>Agent Evaluation</title>
        <summary>A reproducible evaluation.</summary>
        <author><name>Ada Example</name></author>
        <link title="pdf" href="https://arxiv.org/pdf/2401.00001v2" type="application/pdf"/>
      </entry>
    </feed>"""
    pdf = b"%PDF-1.4\nreal provider bytes\n%%EOF\n"

    async def parse_with_markdown(self, request):
        assert request.content_type == "application/pdf"
        assert request.source_name == "2401.00001v2.pdf"
        return (
            SimpleNamespace(
                manifest=SimpleNamespace(
                    model_dump=lambda mode: {
                        "schema_version": 2,
                        "parser": "docling",
                        "content_sha256": "a" * 64,
                    }
                )
            ),
            "# Agent Evaluation\n\nConverted paper body.\n",
        )

    monkeypatch.setattr(DocumentService, "parse_with_markdown", parse_with_markdown)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "export.arxiv.org":
            return httpx.Response(200, text=atom, headers={"content-type": "application/atom+xml"})
        if request.url == "https://arxiv.org/pdf/2401.00001v2":
            return httpx.Response(200, content=pdf, headers={"content-type": "application/pdf"})
        raise AssertionError(f"Unexpected provider request: {request.url}")

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with client_for(
        tmp_path,
        handler,
        arxiv_sqlite_path=tmp_path / "arxiv-runtime.sqlite3",
        arxiv_min_start_interval_seconds=0,
        arxiv_main_site_min_start_interval_seconds=0.05,
    ) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "arxiv",
                "query": "2401.00001v2",
                "workspace_dir": str(workspace),
                "provider_request": {
                    "operation": "download_pdf",
                    "parameters": {"arxiv_id": "2401.00001v2"},
                },
            },
        )

    assert response.status_code == 200
    result = response.json()["results"][0]
    pdf_path = workspace / result["metadata"]["pdf_path"]
    markdown_path = workspace / result["metadata"]["markdown_path"]
    assert pdf_path.read_bytes() == pdf
    assert markdown_path.read_text() == "# Agent Evaluation\n\nConverted paper body.\n"
    assert result["metadata"]["resource_type"] == "paper_document"
    assert result["metadata"]["parser_manifest"]["parser"] == "docling"
    assert [scope for scope in upstream_scopes if scope[0] != "any"] == [("api", 0), ("main", 0.05)]


def test_arxiv_pdf_cache_reuses_download_and_conversion_across_workspaces(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    atom = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
      <opensearch:totalResults>1</opensearch:totalResults>
      <opensearch:startIndex>0</opensearch:startIndex>
      <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
      <entry>
        <id>http://arxiv.org/abs/2401.00001v2</id>
        <updated>2026-07-01T00:00:00Z</updated>
        <published>2026-06-30T00:00:00Z</published>
        <title>Agent Evaluation</title>
        <summary>A reproducible evaluation.</summary>
        <author><name>Ada Example</name></author>
        <link title="pdf" href="https://arxiv.org/pdf/2401.00001v2" type="application/pdf"/>
      </entry>
    </feed>"""
    pdf_downloads = 0
    parse_calls = 0

    async def parse_with_markdown(self, request):
        nonlocal parse_calls
        parse_calls += 1
        return (
            SimpleNamespace(
                manifest=SimpleNamespace(
                    model_dump=lambda mode: {
                        "schema_version": 2,
                        "parser": "docling",
                        "content_sha256": "a" * 64,
                    }
                )
            ),
            "# Agent Evaluation\n\nConverted paper body.\n",
        )

    monkeypatch.setattr(DocumentService, "parse_with_markdown", parse_with_markdown)

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal pdf_downloads
        if request.url.host == "export.arxiv.org":
            return httpx.Response(200, text=atom, headers={"content-type": "application/atom+xml"})
        if request.url == "https://arxiv.org/pdf/2401.00001v2":
            pdf_downloads += 1
            return httpx.Response(200, content=b"%PDF-1.4\ncache me\n%%EOF\n")
        raise AssertionError(f"Unexpected provider request: {request.url}")

    workspaces = [tmp_path / "run-one", tmp_path / "run-two"]
    for workspace in workspaces:
        workspace.mkdir()
    with client_for(tmp_path, handler, material_cache_root=tmp_path / "material-cache") as client:
        responses = [
            client.post(
                "/v1/search",
                headers=authorization,
                json={
                    "schema_version": 1,
                    "source_id": "arxiv",
                    "query": "2401.00001v2",
                    "workspace_dir": str(workspace),
                    "provider_request": {
                        "operation": "download_pdf",
                        "parameters": {"arxiv_id": "2401.00001v2"},
                    },
                },
            )
            for workspace in workspaces
        ]

    assert all(response.status_code == 200 for response in responses)
    assert pdf_downloads == 1
    assert parse_calls == 1
    assert responses[1].json()["results"][0]["metadata"]["material_cache_hit"] is True


def test_arxiv_invalid_date_range_fails_before_upstream_request(tmp_path, authorization) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "arxiv",
                "query": "all:agent AND submittedDate:[2026-01 TO 2026-12]",
                "max_results": 5,
            },
        )

    assert response.status_code == 400
    assert response.json()["error"]["failure_class"] == "validation"
    assert calls == 0


def test_arxiv_parser_preserves_legacy_ids_and_skips_entries_missing_required_dates(
    tmp_path,
    authorization,
) -> None:
    atom = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom"
          xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
      <opensearch:totalResults>2</opensearch:totalResults>
      <opensearch:startIndex>0</opensearch:startIndex>
      <opensearch:itemsPerPage>2</opensearch:itemsPerPage>
      <entry>
        <id>http://arxiv.org/abs/hep-th/9901001v3</id>
        <updated>2026-07-01T00:00:00Z</updated>
        <published>1999-01-01T00:00:00Z</published>
        <title>  Legacy   Identifier  </title>
        <summary>Legacy arXiv identifier parsing.</summary>
        <author><name>Legacy Author</name></author>
      </entry>
      <entry>
        <id>http://arxiv.org/abs/2607.00001v1</id>
        <updated>2026-07-01T00:00:00Z</updated>
        <title>Missing published date</title>
      </entry>
    </feed>"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=atom, headers={"content-type": "application/atom+xml"})

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "arxiv",
                "query": "id:hep-th/9901001",
                "max_results": 2,
            },
        )

    assert response.status_code == 200
    assert len(response.json()["results"]) == 1
    result = response.json()["results"][0]
    assert result["title"] == "Legacy Identifier"
    assert result["url"] == "https://arxiv.org/abs/hep-th/9901001v3"
    assert result["metadata"]["arxiv_id"] == "hep-th/9901001"
    assert result["metadata"]["arxiv_version_id"] == "hep-th/9901001v3"
    assert result["metadata"]["pdf_url"] == "https://arxiv.org/pdf/hep-th/9901001v3"
    assert result["metadata"]["source_url"] == "https://arxiv.org/src/hep-th/9901001v3"


def test_arxiv_nonfirst_empty_page_is_retryable(tmp_path, authorization) -> None:
    atom = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom"
          xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
      <opensearch:totalResults>50</opensearch:totalResults>
      <opensearch:startIndex>10</opensearch:startIndex>
      <opensearch:itemsPerPage>0</opensearch:itemsPerPage>
    </feed>"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=atom, headers={"content-type": "application/atom+xml"})

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "arxiv",
                "query": "all:agents",
                "max_results": 10,
                "provider_request": {
                    "operation": "query",
                    "parameters": {"search_query": "all:agents", "start": 10, "max_results": 10},
                },
            },
        )

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "arxiv_unexpected_empty_page"
    assert response.json()["error"]["retryable"] is True


def test_arxiv_rate_limit_persists_retry_after_for_next_request(tmp_path, authorization) -> None:
    starts: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        starts.append(time.monotonic())
        if len(starts) == 1:
            return httpx.Response(429, text="Rate exceeded", headers={"retry-after": "0.05"})
        return httpx.Response(
            200,
            text="""<?xml version='1.0' encoding='UTF-8'?>
            <feed xmlns='http://www.w3.org/2005/Atom'
                  xmlns:opensearch='http://a9.com/-/spec/opensearch/1.1/'>
              <opensearch:totalResults>0</opensearch:totalResults>
              <opensearch:startIndex>0</opensearch:startIndex>
              <opensearch:itemsPerPage>0</opensearch:itemsPerPage>
            </feed>""",
        )

    with client_for(
        tmp_path,
        handler,
        arxiv_sqlite_path=tmp_path / "arxiv-runtime.sqlite3",
        arxiv_min_start_interval_seconds=0,
    ) as client:
        body = {
            "schema_version": 1,
            "source_id": "arxiv",
            "query": "all:retry-after",
            "max_results": 1,
        }
        first = client.post("/v1/search", headers=authorization, json=body)
        second = client.post("/v1/search", headers=authorization, json=body)

    assert first.status_code == 502
    assert second.status_code == 200
    assert starts[1] - starts[0] >= 0.04


def test_arxiv_429_without_retry_after_keeps_evidence_without_bypassing_cooldown(tmp_path, authorization) -> None:
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        return httpx.Response(
            429,
            text="Rate exceeded.",
            headers={"server": "Google Frontend", "x-served-by": "cache-qpg1283-QPG", "via": "1.1 google, 1.1 varnish"},
        )

    sqlite_path = tmp_path / "arxiv-runtime.sqlite3"
    with client_for(
        tmp_path,
        handler,
        arxiv_sqlite_path=sqlite_path,
        arxiv_min_start_interval_seconds=0,
        arxiv_overload_cooldown_seconds=900,
    ) as client:
        first = client.post("/v1/search", headers=authorization, json={
            "schema_version": 1, "source_id": "arxiv", "query": "all:overload", "max_results": 1,
        })

    assert first.status_code == 502
    error = first.json()["error"]
    assert error["code"] == "provider_rate_limit"
    assert error["retry_after_ms"] == 20_000
    assert error["details"]["upstream_headers"]["server"] == "Google Frontend"
    assert error["details"]["upstream_body"] == "Rate exceeded."
    assert len(urls) == 1, "nothing may reach arXiv inside the cooldown the 429 declared"
    rows = [json.loads(line) for line in (sqlite_path.parent / "arxiv-upstream.jsonl").read_text().splitlines()]
    assert [row["kind"] for row in rows] == ["request"]
    assert rows[0]["status"] == 429
    assert rows[0]["cooldown_seconds"] == 20
    assert rows[0]["headers"]["x-served-by"] == "cache-qpg1283-QPG"
    assert rows[0]["query"]["search_query"] == "all:overload"


def test_arxiv_overload_ladder_escalates_then_resets() -> None:
    from research_source_service.sources.arxiv import ArxivSource

    source = ArxivSource(http=None, endpoint="https://export.arxiv.org/api/query", overload_cooldown_seconds=900)  # type: ignore[arg-type]
    blind = lambda: github_module.ServiceError("provider_rate_limit", "429", retryable=True)  # noqa: E731
    assert [source._overload_delay(blind()) for _ in range(5)] == [20, 60, 180, 900, 900]
    stated = github_module.ServiceError("provider_rate_limit", "429", retryable=True, retry_after_ms=45_000)
    assert source._overload_delay(stated) == 45
    source._last_overload_at = 0.0
    assert source._overload_delay(blind()) == 20


@pytest.mark.parametrize("status_code", [429, 503])
def test_arxiv_overload_without_retry_after_uses_persisted_cooldown(
    tmp_path,
    authorization,
    status_code,
) -> None:
    starts: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        starts.append(time.monotonic())
        if len(starts) == 1:
            return httpx.Response(status_code, text="Upstream overloaded")
        return httpx.Response(
            200,
            text="""<?xml version='1.0' encoding='UTF-8'?>
            <feed xmlns='http://www.w3.org/2005/Atom'
                  xmlns:opensearch='http://a9.com/-/spec/opensearch/1.1/'>
              <opensearch:totalResults>0</opensearch:totalResults>
              <opensearch:startIndex>0</opensearch:startIndex>
              <opensearch:itemsPerPage>0</opensearch:itemsPerPage>
            </feed>""",
        )

    with client_for(
        tmp_path,
        handler,
        arxiv_sqlite_path=tmp_path / f"arxiv-overload-{status_code}.sqlite3",
        arxiv_min_start_interval_seconds=0,
        arxiv_overload_cooldown_seconds=0.05,
    ) as client:
        body = {
            "schema_version": 1,
            "source_id": "arxiv",
            "query": "all:overload",
            "max_results": 1,
        }
        first = client.post("/v1/search", headers=authorization, json=body)
        second = client.post("/v1/search", headers=authorization, json=body)

    assert first.status_code == 502
    assert second.status_code == 200
    assert starts[1] - starts[0] >= 0.04


def test_huggingface_models_list_maps_filters_cursor_and_pinned_document(tmp_path, authorization) -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json=[
                {
                    "id": "example/agent-model",
                    "author": "example",
                    "createdAt": "2026-07-01T00:00:00Z",
                    "lastModified": "2026-07-18T00:00:00Z",
                    "sha": "abc123",
                    "downloads": 42,
                    "likes": 7,
                    "pipeline_tag": "text-generation",
                    "library_name": "transformers",
                    "tags": ["transformers", "agent"],
                }
            ],
            headers={
                "link": '<https://huggingface.co/api/models?limit=2&cursor=opaque%3D%3D>; rel="next"',
            },
        )

    with client_for(tmp_path, handler, huggingface_token="hf_test_secret_123456") as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "agent models",
                "max_results": 10,
                "provider_request": {
                    "operation": "models_list",
                    "parameters": {
                        "search": "agent",
                        "filters": ["transformers"],
                        "trained_datasets": ["example/data"],
                        "pipeline_tag": "text-generation",
                        "base_model_relation": "base",
                        "sort": "trending_score",
                        "limit": 2,
                        "cursor": "first-page",
                    },
                },
            },
        )

    assert response.status_code == 200
    assert len(captured) == 1
    assert captured[0].url.path == "/api/models"
    assert captured[0].url.params.get_list("filter") == ["transformers", "dataset:example/data"]
    assert captured[0].url.params["pipeline_tag"] == "text-generation"
    assert captured[0].url.params["base_model_relation"] == "base"
    assert captured[0].url.params["sort"] == "trendingScore"
    assert captured[0].url.params["cursor"] == "first-page"
    assert "sha" in captured[0].url.params.get_list("expand")
    assert captured[0].headers["authorization"] == "Bearer hf_test_secret_123456"
    result = response.json()["results"][0]
    assert result["url"] == "https://huggingface.co/example/agent-model"
    assert result["metadata"]["resource_type"] == "model"
    assert result["metadata"]["document_url"] == "https://huggingface.co/example/agent-model/raw/abc123/README.md"
    assert result["metadata"]["huggingface_page"]["next_cursor"] == "opaque=="


def test_huggingface_model_tags_exposes_provider_filter_catalog(tmp_path, authorization) -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "pipeline_tag": [
                    {"id": "text-to-speech", "label": "Text-to-Speech", "type": "pipeline_tag"},
                    {"id": "any-to-any", "label": "Any-to-Any", "type": "pipeline_tag"},
                    {"id": "text-generation", "label": "Text Generation", "type": "pipeline_tag"},
                ]
            },
        )

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "speech",
                "max_results": 10,
                "provider_request": {
                    "operation": "model_tags",
                    "parameters": {"tag_type": "pipeline_tag", "search": "speech", "limit": 10},
                },
            },
        )

    assert response.status_code == 200
    assert [request.url.path for request in captured] == ["/api/models-tags-by-type"]
    assert [row["metadata"]["tag_id"] for row in response.json()["results"]] == ["text-to-speech"]


def test_huggingface_paper_operations_map_native_responses(tmp_path, authorization) -> None:
    captured: list[httpx.Request] = []
    paper = {
        "paper": {
            "id": "2607.01234",
            "authors": [{"name": "Ada Example"}],
            "publishedAt": "2026-07-11T00:00:00Z",
            "submittedOnDailyAt": "2026-07-12T00:00:00Z",
            "summary": "A primary paper summary.",
            "upvotes": 21,
        },
        "title": "Reliable Research Agents",
        "numComments": 3,
        "ai_keywords": ["agents", "evaluation"],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path == "/api/papers/search":
            assert request.url.params["q"] == "research agents"
            return httpx.Response(200, json=[paper])
        if request.url.path == "/api/daily_papers":
            assert request.url.params["week"] == "2026-W28"
            assert request.url.params["sort"] == "publishedAt"
            return httpx.Response(200, json=[paper])
        if request.url.path == "/api/papers/2607.01234":
            return httpx.Response(200, json=paper)
        raise AssertionError(f"Unexpected provider request: {request.url}")

    requests = [
        {
            "operation": "papers_search",
            "parameters": {"query": "research agents", "limit": 5},
        },
        {
            "operation": "papers_list",
            "parameters": {"week": "2026-W28", "sort": "published_at", "page": 2, "limit": 5},
        },
        {
            "operation": "papers_info",
            "parameters": {"paper_id": "2607.01234"},
        },
    ]
    with client_for(tmp_path, handler) as client:
        responses = [
            client.post(
                "/v1/search",
                headers=authorization,
                json={
                    "schema_version": 1,
                    "source_id": "huggingface",
                    "query": "paper lookup",
                    "max_results": 10,
                    "provider_request": provider_request,
                },
            )
            for provider_request in requests
        ]

    assert all(response.status_code == 200 for response in responses)
    assert len(captured) == 3
    for response in responses:
        result = response.json()["results"][0]
        assert result["title"] == "Reliable Research Agents"
        assert result["authors"] == ["Ada Example"]
        assert result["metadata"]["paper_id"] == "2607.01234"
        assert result["metadata"]["pdf_url"] == "https://arxiv.org/pdf/2607.01234"
        assert result["metadata"]["document_url"] == "https://huggingface.co/papers/2607.01234.md"
        assert result["metadata"]["submitted_at"] == "2026-07-12T00:00:00Z"


def test_huggingface_paper_preview_and_download_bundle(tmp_path, authorization) -> None:
    paper = {
        "id": "2607.01234",
        "title": "Reliable Research Agents",
        "authors": [{"name": "Ada Example"}],
        "publishedAt": "2026-07-11T00:00:00Z",
        "summary": "A primary paper summary.",
        "ai_summary": "A compact generated overview.",
        "ai_keywords": ["agents", "evaluation"],
        "githubRepo": "https://github.com/example/reliable-agents",
        "projectPage": "https://example.org/reliable-agents",
        "linkedModels": [{"id": "example/reliable-agent-model"}],
    }
    markdown = (
        b"# Reliable Research Agents\n\n## Abstract\n\nFull abstract.\n\n"
        b"## 1 Introduction\n\nDetailed paper body.\n"
    )
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        if request.url.path == "/api/papers/2607.01234":
            return httpx.Response(200, json=paper)
        if request.url.path == "/papers/2607.01234.md":
            return httpx.Response(200, content=markdown, headers={"content-type": "text/markdown"})
        raise AssertionError(f"Unexpected provider request: {request.url}")

    second_workspace = tmp_path / "second-workspace"
    second_workspace.mkdir()
    with client_for(tmp_path, handler, material_cache_root=tmp_path / "material-cache") as client:
        preview = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "preview 2607.01234",
                "provider_request": {
                    "operation": "papers_preview",
                    "parameters": {"paper_id": "2607.01234"},
                },
            },
        )
        downloaded = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "download 2607.01234",
                "workspace_dir": str(tmp_path),
                "provider_request": {
                    "operation": "papers_download",
                    "parameters": {"paper_id": "2607.01234"},
                },
            },
        )
        cached = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "download 2607.01234",
                "workspace_dir": str(second_workspace),
                "provider_request": {
                    "operation": "papers_download",
                    "parameters": {"paper_id": "2607.01234"},
                },
            },
        )

    assert preview.status_code == 200
    preview_metadata = preview.json()["results"][0]["metadata"]
    assert preview_metadata["front_excerpt"].endswith("Detailed paper body.\n")
    assert preview_metadata["headings"] == ["Reliable Research Agents", "Abstract", "1 Introduction"]
    assert preview_metadata["document_byte_length"] == len(markdown)

    assert downloaded.status_code == 200
    result = downloaded.json()["results"][0]
    bundle = tmp_path / result["metadata"]["artifact_path"]
    assert bundle.is_dir()
    assert (bundle / "paper.md").read_bytes() == markdown
    metadata = json.loads((bundle / "metadata.json").read_text())
    assert metadata["provider_id"] == "huggingface"
    assert metadata["paper_id"] == "2607.01234"
    assert metadata["github_repo"] == "https://github.com/example/reliable-agents"
    assert metadata["project_page"] == "https://example.org/reliable-agents"
    assert metadata["native"]["linkedModels"] == [{"id": "example/reliable-agent-model"}]
    assert result["metadata"]["markdown_path"].endswith("/paper.md")
    assert result["metadata"]["metadata_path"].endswith("/metadata.json")
    assert cached.status_code == 200
    cached_result = cached.json()["results"][0]
    assert cached_result["metadata"]["material_cache_hit"] is True
    cached_bundle = second_workspace / cached_result["metadata"]["artifact_path"]
    assert (cached_bundle / "paper.md").read_bytes() == markdown
    assert json.loads((cached_bundle / "metadata.json").read_text())["github_repo"] == (
        "https://github.com/example/reliable-agents"
    )
    assert requests == [
        "/api/papers/2607.01234",
        "/papers/2607.01234.md",
        "/api/papers/2607.01234",
        "/papers/2607.01234.md",
    ]


def test_huggingface_datasets_and_spaces_use_resource_paths(tmp_path, authorization) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/datasets":
            assert request.url.params.get_list("filter") == ["language:zh"]
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "example/chinese-corpus",
                        "author": "example",
                        "sha": "dataset-sha",
                        "downloads": 100,
                    }
                ],
            )
        if request.url.path == "/api/spaces":
            assert request.url.params.get_list("models") == ["example/agent-model"]
            assert request.url.params["linked"] == "true"
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "example/agent-demo",
                        "author": "example",
                        "sha": "space-sha",
                        "sdk": "gradio",
                    }
                ],
            )
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        dataset_response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "Chinese corpora",
                "provider_request": {
                    "operation": "datasets_list",
                    "parameters": {"filters": ["language:zh"], "limit": 10},
                },
            },
        )
        space_response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "agent demos",
                "provider_request": {
                    "operation": "spaces_list",
                    "parameters": {"models": ["example/agent-model"], "linked": True, "limit": 10},
                },
            },
        )

    assert dataset_response.status_code == 200
    dataset = dataset_response.json()["results"][0]
    assert dataset["url"] == "https://huggingface.co/datasets/example/chinese-corpus"
    assert dataset["metadata"]["resource_type"] == "dataset"
    assert dataset["metadata"]["document_url"].endswith("/raw/dataset-sha/README.md")
    assert space_response.status_code == 200
    space = space_response.json()["results"][0]
    assert space["url"] == "https://huggingface.co/spaces/example/agent-demo"
    assert space["metadata"]["resource_type"] == "space"
    assert space["metadata"]["document_url"].endswith("/raw/space-sha/README.md")


def test_huggingface_exact_info_and_dataset_leaderboard_use_native_paths(tmp_path, authorization) -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path == "/api/models/openai/whisper-large-v3":
            return httpx.Response(
                200,
                json={
                    "id": "openai/whisper-large-v3",
                    "author": "openai",
                    "sha": "model-sha",
                    "downloads": 5_000_000,
                    "pipeline_tag": "automatic-speech-recognition",
                    "library_name": "transformers",
                    "cardData": {"license": "apache-2.0", "language": ["en"]},
                },
            )
        if request.url.path == "/api/datasets/SWE-bench/SWE-bench_Verified/revision/main":
            return httpx.Response(
                200,
                json={
                    "id": "SWE-bench/SWE-bench_Verified",
                    "author": "SWE-bench",
                    "sha": "dataset-sha",
                    "description": "A verified benchmark dataset.",
                },
            )
        if request.url.path == "/api/datasets/SWE-bench/SWE-bench_Verified/leaderboard":
            return httpx.Response(
                200,
                json=[
                    {
                        "rank": 1,
                        "modelId": "example/top-model",
                        "value": 82.4,
                        "verified": True,
                        "filename": ".eval_results/top-model.yaml",
                        "lower_is_better": False,
                        "source": {"url": "https://huggingface.co/example/top-model"},
                        "author": {"name": "example"},
                    },
                    {
                        "rank": 2,
                        "modelId": "example/runner-up",
                        "value": 81.0,
                        "verified": False,
                        "filename": ".eval_results/runner-up.yaml",
                        "lower_is_better": False,
                        "source": {"url": "https://huggingface.co/example/runner-up"},
                        "author": {"name": "example"},
                    },
                ],
            )
        raise AssertionError(f"Unexpected provider request: {request.url}")

    provider_requests = [
        {"operation": "models_info", "parameters": {"repo_id": "openai/whisper-large-v3"}},
        {
            "operation": "datasets_info",
            "parameters": {"repo_id": "SWE-bench/SWE-bench_Verified", "revision": "main"},
        },
        {
            "operation": "datasets_leaderboard",
            "parameters": {"dataset_id": "SWE-bench/SWE-bench_Verified", "limit": 5},
        },
    ]
    with client_for(tmp_path, handler) as client:
        responses = [
            client.post(
                "/v1/search",
                headers=authorization,
                json={
                    "schema_version": 1,
                    "source_id": "huggingface",
                    "query": request["operation"],
                    "max_results": 5,
                    "provider_request": request,
                },
            )
            for request in provider_requests
        ]

    assert all(response.status_code == 200 for response in responses)
    assert captured[0].url.path == "/api/models/openai/whisper-large-v3"
    assert "sha" in captured[0].url.params.get_list("expand")
    assert captured[1].url.path.endswith("/revision/main")
    model = responses[0].json()["results"][0]
    assert model["metadata"]["repo_id"] == "openai/whisper-large-v3"
    assert model["metadata"]["card_data"]["license"] == "apache-2.0"
    assert model["metadata"]["document_url"].endswith("/raw/model-sha/README.md")
    dataset = responses[1].json()["results"][0]
    assert dataset["snippet"] == "A verified benchmark dataset."
    leaderboard_rows = responses[2].json()["results"]
    assert len({row["url"] for row in leaderboard_rows}) == 2
    leaderboard = leaderboard_rows[0]
    assert leaderboard["title"] == "example/top-model"
    assert leaderboard["url"] == "https://huggingface.co/example/top-model"
    assert leaderboard["metadata"]["dataset_id"] == "SWE-bench/SWE-bench_Verified"
    assert leaderboard["metadata"]["leaderboard_url"].endswith("/SWE-bench_Verified#leaderboard")
    assert leaderboard["metadata"]["rank"] == 1
    assert leaderboard["metadata"]["score"] == 82.4
    assert leaderboard["metadata"]["verified"] is True


def test_huggingface_info_follows_canonical_repo_redirect(tmp_path, authorization) -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path == "/api/models/Remsky/kokoro-inno-clone-tuner":
            return httpx.Response(
                307,
                headers={"location": "/api/models/remsky/kokoro-inno-clone-tuner"},
            )
        if request.url.path == "/api/models/remsky/kokoro-inno-clone-tuner":
            return httpx.Response(
                200,
                json={
                    "id": "remsky/kokoro-inno-clone-tuner",
                    "author": "remsky",
                    "sha": "model-sha",
                    "pipeline_tag": "text-to-speech",
                },
            )
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "repo_id=Remsky/kokoro-inno-clone-tuner",
                "provider_request": {
                    "operation": "models_info",
                    "parameters": {"repo_id": "Remsky/kokoro-inno-clone-tuner"},
                },
            },
        )

    assert response.status_code == 200
    assert [request.url.path for request in captured] == [
        "/api/models/Remsky/kokoro-inno-clone-tuner",
        "/api/models/remsky/kokoro-inno-clone-tuner",
    ]
    assert response.json()["results"][0]["metadata"]["repo_id"] == "remsky/kokoro-inno-clone-tuner"


def test_huggingface_model_card_downloads_pinned_readme_to_workspace(tmp_path, authorization) -> None:
    sha = "0123456789abcdef0123456789abcdef01234567"
    readme = b"---\nlicense: mit\n---\n# Whisper large v3\n\nModel card body.\n"
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path == "/api/models/openai/whisper-large-v3":
            return httpx.Response(200, json={"id": "openai/whisper-large-v3", "sha": sha})
        if request.url.path == f"/openai/whisper-large-v3/raw/{sha}/README.md":
            return httpx.Response(200, content=readme, headers={"content-type": "text/markdown"})
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "openai/whisper-large-v3 model card",
                "workspace_dir": str(tmp_path),
                "provider_request": {
                    "operation": "models_card",
                    "parameters": {"repo_id": "openai/whisper-large-v3"},
                },
            },
        )

    assert response.status_code == 200
    result = response.json()["results"][0]
    artifact = tmp_path / result["metadata"]["artifact_path"]
    assert artifact.name == "README.md"
    assert artifact.read_bytes() == readme
    assert result["metadata"]["resource_type"] == "model_card"
    assert result["metadata"]["repo_id"] == "openai/whisper-large-v3"
    assert result["metadata"]["sha"] == sha
    assert result["metadata"]["byte_length"] == len(readme)
    assert captured[0].url.path == "/api/models/openai/whisper-large-v3"
    assert captured[1].url.path.endswith(f"/raw/{sha}/README.md")


def test_huggingface_model_card_uses_canonical_repo_id(tmp_path, authorization) -> None:
    requested_repo_id = "Audio8/audio8-TTS-0.1b-ONNX-INT8"
    canonical_repo_id = "Audio8/audio8-TTS-0.1B-ONNX-INT8"
    sha = "0123456789abcdef0123456789abcdef01234567"
    readme = b"# Canonical model card\n"
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path == f"/api/models/{requested_repo_id}":
            return httpx.Response(307, headers={"Location": f"/api/models/{canonical_repo_id}"})
        if request.url.path == f"/api/models/{canonical_repo_id}":
            return httpx.Response(200, json={"id": canonical_repo_id, "sha": sha})
        if request.url.path == f"/{canonical_repo_id}/raw/{sha}/README.md":
            return httpx.Response(
                307,
                headers={"Location": f"/{canonical_repo_id}/resolve/{sha}/README.md"},
            )
        if request.url.path == f"/{canonical_repo_id}/resolve/{sha}/README.md":
            return httpx.Response(200, content=readme, headers={"content-type": "text/markdown"})
        raise AssertionError(f"Unexpected provider request: {request.url}")

    cache_root = tmp_path / "material-cache"
    with client_for(tmp_path, handler, material_cache_root=cache_root) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": f"{requested_repo_id} model card",
                "workspace_dir": str(tmp_path),
                "provider_request": {
                    "operation": "models_card",
                    "parameters": {"repo_id": requested_repo_id},
                },
            },
        )

    assert response.status_code == 200
    result = response.json()["results"][0]
    assert (tmp_path / result["metadata"]["artifact_path"]).read_bytes() == readme
    assert result["url"] == f"https://huggingface.co/{canonical_repo_id}"
    assert result["metadata"]["repo_id"] == canonical_repo_id
    assert result["metadata"]["requested_repo_id"] == requested_repo_id
    assert result["metadata"]["document_url"] == (
        f"https://huggingface.co/{canonical_repo_id}/raw/{sha}/README.md"
    )
    with sqlite3.connect(cache_root / "catalog.sqlite") as database:
        cache_key = database.execute(
            "SELECT key FROM acquisitions WHERE namespace='huggingface-model-card-v1'"
        ).fetchone()[0]
    assert cache_key == f"{canonical_repo_id}@{sha}"
    assert [request.url.path for request in captured] == [
        f"/api/models/{requested_repo_id}",
        f"/api/models/{canonical_repo_id}",
        f"/{canonical_repo_id}/raw/{sha}/README.md",
        f"/{canonical_repo_id}/resolve/{sha}/README.md",
    ]


def test_huggingface_model_card_cache_reuses_material_across_workspaces(tmp_path, authorization) -> None:
    sha = "0123456789abcdef0123456789abcdef01234567"
    readme = b"# Shared model card\n"
    raw_downloads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal raw_downloads
        if request.url.path == f"/openai/whisper-large-v3/raw/{sha}/README.md":
            raw_downloads += 1
            return httpx.Response(200, content=readme, headers={"content-type": "text/markdown"})
        raise AssertionError(f"Unexpected provider request: {request.url}")

    workspaces = [tmp_path / "run-one", tmp_path / "run-two"]
    for workspace in workspaces:
        workspace.mkdir()
    with client_for(tmp_path, handler, material_cache_root=tmp_path / "material-cache") as client:
        responses = [
            client.post(
                "/v1/search",
                headers=authorization,
                json={
                    "schema_version": 1,
                    "source_id": "huggingface",
                    "query": "openai/whisper-large-v3 model card",
                    "workspace_dir": str(workspace),
                    "provider_request": {
                        "operation": "models_card",
                        "parameters": {"repo_id": "openai/whisper-large-v3", "revision": sha},
                    },
                },
            )
            for workspace in workspaces
        ]

    assert all(response.status_code == 200 for response in responses)
    assert raw_downloads == 1
    assert responses[0].json()["results"][0]["metadata"]["material_cache_hit"] is False
    assert responses[1].json()["results"][0]["metadata"]["material_cache_hit"] is True


@pytest.mark.parametrize("operation", ["models_card", "models_info"])
@pytest.mark.parametrize(
    "repo_id",
    [
        "Audio8/audio8-TTS-0.1b-ONNX-INT8",
        "Audio8/audio8-TTS-0.1B-ONX-INT8",
    ],
)
def test_huggingface_unknown_model_repo_suggests_similar_ids(tmp_path, authorization, operation, repo_id) -> None:
    author_repos = [
        "Audio8/unrelated-vision-model",
        "Audio8/audio8-TTS-0.1B-ONNX-FP16",
        "Audio8/audio8-TTS-0.1B-ONNX-INT8",
        "Audio8/totally-different",
        "Audio8/audio8-TTS-0.1B-ONNX",
    ]
    suggestions = [
        "Audio8/audio8-TTS-0.1B-ONNX-INT8",
        "Audio8/audio8-TTS-0.1B-ONNX",
        "Audio8/audio8-TTS-0.1B-ONNX-FP16",
    ]
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if request.url.path == f"/api/models/{repo_id}":
            return httpx.Response(404, json={"error": "Repository Not Found"})
        if request.url.path == "/api/models":
            assert dict(request.url.params) == {"author": "Audio8", "limit": "100"}
            return httpx.Response(200, json=[{"id": repo_id} for repo_id in author_repos])
        raise AssertionError(f"Unexpected provider request: {request.url}")

    payload = {
        "schema_version": 1,
        "source_id": "huggingface",
        "query": repo_id,
        "provider_request": {
            "operation": operation,
            "parameters": {"repo_id": repo_id},
        },
    }
    if operation == "models_card":
        payload["workspace_dir"] = str(tmp_path)

    with client_for(tmp_path, handler) as client:
        response = client.post("/v1/search", headers=authorization, json=payload)

    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "huggingface_repository_not_found_or_inaccessible"
    assert error["retryable"] is False
    assert error["details"]["suggestions"] == suggestions
    assert "Similar repo ids: " + ", ".join(suggestions) in error["message"]
    assert "Call models_list(" in error["message"]
    assert [request.url.path for request in captured] == [f"/api/models/{repo_id}", "/api/models"]


@pytest.mark.parametrize(
    ("operation", "repo_id", "list_operation", "search", "author"),
    [
        ("models_info", "cohereforai/cohere-transcribe", "models_list", "cohere-transcribe", "cohereforai"),
        ("datasets_info", "example/missing-dataset", "datasets_list", "missing-dataset", "example"),
    ],
)
def test_huggingface_exact_repo_401_is_request_scoped_and_actionable(
    tmp_path,
    authorization,
    operation,
    repo_id,
    list_operation,
    search,
    author,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "Invalid username or password."})

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": repo_id,
                "provider_request": {
                    "operation": operation,
                    "parameters": {"repo_id": repo_id},
                },
            },
        )

    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "huggingface_repository_not_found_or_inaccessible"
    assert error["failure_class"] == "validation"
    assert error["retryable"] is False
    assert error["details"] == {
        "circuit_scope": "request",
        "failure_scope": "request",
        "upstream_status": 401,
        "operation": operation,
        "repo_id": repo_id,
        "recovery": {
            "operation": list_operation,
            "parameters": {"search": search, "author": author},
            "then": operation,
        },
    }
    assert f"{list_operation}(search={search}, author={author})" in error["message"]
    assert f"retry {operation}" in error["message"]


def test_huggingface_list_401_remains_provider_scoped_credentials_failure(tmp_path, authorization) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "Invalid username or password."})

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "canary",
                "provider_request": {
                    "operation": "models_list",
                    "parameters": {"search": "canary", "author": "nvidia"},
                },
            },
        )

    assert response.status_code == 502
    error = response.json()["error"]
    assert error["code"] == "provider_credentials"
    assert error["failure_class"] == "permanent"
    assert error["retryable"] is False
    assert error["details"]["circuit_scope"] == "provider"
    assert error["details"]["failure_scope"] == "provider"
    assert error["details"]["upstream_status"] == 401
    assert "upstream_headers" in error["details"]


def test_huggingface_invalid_operation_fails_before_upstream_request(tmp_path, authorization) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "anything",
                "provider_request": {
                    "operation": "run_job",
                    "parameters": {},
                },
            },
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_provider_request"
    assert response.json()["error"]["details"]["supported_operations"] == [
        "papers_list",
        "papers_search",
        "papers_info",
        "papers_preview",
        "papers_download",
        "models_info",
        "models_card",
        "model_tags",
        "models_list",
        "datasets_info",
        "datasets_leaderboard",
        "datasets_list",
        "spaces_list",
    ]
    assert calls == 0


def test_huggingface_unknown_model_tag_returns_catalog_guidance(tmp_path, authorization) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/models":
            return httpx.Response(200, json=[])
        if request.url.path == "/api/models-tags-by-type":
            return httpx.Response(
                200,
                json={
                    "pipeline_tag": [
                        {"id": "text-to-speech", "label": "Text-to-Speech"},
                        {"id": "text-generation", "label": "Text Generation"},
                    ],
                    "language": [{"id": "zh", "label": "Chinese"}],
                },
            )
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "speech",
                "provider_request": {
                    "operation": "models_list",
                    "parameters": {"pipeline_tag": "text-to-speach", "limit": 10},
                },
            },
        )

    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "huggingface_model_tag_not_found"
    assert "text-to-speech" in error["message"]
    assert "Replace pipeline_tag='text-to-speach' with 'text-to-speech' (Text-to-Speech)" in error["message"]
    assert error["details"]["available_tags"] == ["text-generation", "text-to-speech"]
    parameter = error["details"]["parameters"][0]
    assert parameter["path"] == "pipeline_tag"
    assert parameter["received"] == "text-to-speach"
    assert parameter["expected"] == {"type": "tag_id", "tag_type": "pipeline_tag"}
    assert parameter["suggestions"][0] == {
        "value": "text-to-speech",
        "label": "Text-to-Speech",
        "tag_type": "pipeline_tag",
    }
    assert error["details"]["recovery"] == {
        "action": "repair_parameters",
        "patches": [{"path": "pipeline_tag", "value": "text-to-speech"}],
        "lookups": [],
    }


def test_huggingface_tag_errors_return_complete_generic_recovery(tmp_path, authorization) -> None:
    catalog = {
        "pipeline_tag": [
            {"id": "text-to-speech", "label": "Text-to-Speech"},
            {"id": "text-generation", "label": "Text Generation"},
        ],
        "language": [
            {"id": "zh", "label": "Chinese"},
            {"id": "en", "label": "English"},
            {"id": "ja", "label": "Japanese"},
        ],
        "license": [
            {"id": "apache-2.0", "label": "Apache 2.0"},
            {"id": "mit", "label": "MIT"},
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/models-tags-by-type":
            return httpx.Response(200, json=catalog)
        if request.url.path == "/api/models":
            return httpx.Response(200, json=[])
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        search_response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "languages",
                "provider_request": {
                    "operation": "model_tags",
                    "parameters": {
                        "tag_type": "language",
                        "search": "Chinese English",
                        "limit": 10,
                    },
                },
            },
        )
        filter_response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "languages",
                "provider_request": {
                    "operation": "models_list",
                    "parameters": {
                        "pipeline_tag": "text-to-speech",
                        "filters": ["language:zh", "language:en"],
                        "limit": 10,
                    },
                },
            },
        )

    assert search_response.status_code == 400
    search_error = search_response.json()["error"]
    assert "model_tags(tag_type='language', search='Chinese')" in search_error["message"]
    assert "model_tags(tag_type='language', search='English')" in search_error["message"]
    assert search_error["details"]["parameters"][0]["path"] == "search"
    assert search_error["details"]["parameters"][0]["expected"] == {
        "type": "tag_search",
        "tag_type": "language",
    }
    assert search_error["details"]["parameters"][0]["suggestions"][:2] == [
        {"value": "zh", "label": "Chinese", "tag_type": "language"},
        {"value": "en", "label": "English", "tag_type": "language"},
    ]
    assert search_error["details"]["recovery"] == {
        "action": "retry_operations",
        "calls": [
            {"operation": "model_tags", "parameters": {"tag_type": "language", "search": "Chinese"}},
            {"operation": "model_tags", "parameters": {"tag_type": "language", "search": "English"}},
        ],
    }

    assert filter_response.status_code == 400
    filter_error = filter_response.json()["error"]
    assert "Replace filters[0]='language:zh' with 'zh' (Chinese)" in filter_error["message"]
    assert "Replace filters[1]='language:en' with 'en' (English)" in filter_error["message"]
    assert filter_error["details"]["parameters"] == [
        {
            "path": "filters[0]",
            "received": "language:zh",
            "expected": {"type": "tag_id", "tag_type": "language"},
            "suggestions": [{"value": "zh", "label": "Chinese", "tag_type": "language"}],
        },
        {
            "path": "filters[1]",
            "received": "language:en",
            "expected": {"type": "tag_id", "tag_type": "language"},
            "suggestions": [{"value": "en", "label": "English", "tag_type": "language"}],
        },
    ]
    assert filter_error["details"]["recovery"] == {
        "action": "repair_parameters",
        "patches": [
            {"path": "filters[0]", "value": "zh"},
            {"path": "filters[1]", "value": "en"},
        ],
        "lookups": [],
    }


def test_huggingface_model_tag_search_miss_lists_available_tags(tmp_path, authorization) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/models-tags-by-type"
        return httpx.Response(
            200,
            json={
                "pipeline_tag": [
                    {"id": "text-to-speech", "label": "Text-to-Speech"},
                    {"id": "text-generation", "label": "Text Generation"},
                ],
            },
        )

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "speach",
                "provider_request": {
                    "operation": "model_tags",
                    "parameters": {"tag_type": "pipeline_tag", "search": "speach", "limit": 10},
                },
            },
        )

    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "huggingface_model_tag_not_found"
    assert error["details"]["available_tags"] == ["text-generation", "text-to-speech"]
    assert error["details"]["parameters"][0]["suggestions"][0]["value"] == "text-to-speech"
    assert error["details"]["recovery"]["calls"][0]["parameters"]["search"] == "Text-to-Speech"
    assert "model_tags(tag_type='pipeline_tag', search='Text-to-Speech')" in error["message"]


@pytest.mark.parametrize(
    ("tag_type", "search", "expected_value", "expected_label"),
    [
        ("pipeline_tag", "Text-to-Speach", "text-to-speech", "Text-to-Speech"),
        ("language", "Chnese", "zh", "Chinese"),
        ("library", "Transformr", "transformers", "Transformers"),
        ("license", "Apach 2.0", "apache-2.0", "Apache 2.0"),
        ("other", "Safetensrs", "safetensors", "Safetensors"),
    ],
)
def test_huggingface_tag_recovery_uses_ids_and_labels_for_every_catalog_type(
    tmp_path,
    authorization,
    tag_type,
    search,
    expected_value,
    expected_label,
) -> None:
    catalog = {
        "pipeline_tag": [{"id": "text-to-speech", "label": "Text-to-Speech"}],
        "language": [{"id": "zh", "label": "Chinese"}],
        "library": [{"id": "transformers", "label": "Transformers"}],
        "license": [{"id": "apache-2.0", "label": "Apache 2.0"}],
        "other": [{"id": "safetensors", "label": "Safetensors"}],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/models-tags-by-type"
        return httpx.Response(200, json=catalog)

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": search,
                "provider_request": {
                    "operation": "model_tags",
                    "parameters": {"tag_type": tag_type, "search": search, "limit": 10},
                },
            },
        )

    assert response.status_code == 400
    parameter = response.json()["error"]["details"]["parameters"][0]
    assert parameter["expected"] == {"type": "tag_search", "tag_type": tag_type}
    assert parameter["suggestions"][0] == {
        "value": expected_value,
        "label": expected_label,
        "tag_type": tag_type,
    }


def test_huggingface_spaces_rejects_download_sort_before_upstream_request(tmp_path, authorization) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "spaces",
                "provider_request": {
                    "operation": "spaces_list",
                    "parameters": {"sort": "downloads", "limit": 10},
                },
            },
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_provider_request"
    assert "trending_score" in response.json()["error"]["message"]
    assert calls == 0


@pytest.mark.parametrize(
    ("source_id", "settings", "filter_key"),
    [
        ("general_web_firecrawl", {"firecrawl_api_key": "firecrawl-test-secret"}, "excludeDomains"),
        ("general_web_tavily", {"tavily_api_key": "tavily-test-secret"}, "exclude_domains"),
        ("general_web_exa", {"exa_api_key": "exa-test-secret"}, "excludeDomains"),
    ],
)
def test_general_web_does_not_exclude_specialized_provider_domains(
    tmp_path,
    authorization,
    source_id,
    settings,
    filter_key,
) -> None:
    request_body: dict[str, object] = {}
    rows = [
        {"title": "GitHub", "url": "https://github.com/example/project", "content": "GitHub result"},
        {
            "title": "GitHub raw",
            "url": "https://raw.githubusercontent.com/example/project/main/README.md",
            "content": "Raw result",
        },
        {"title": "arXiv", "url": "https://export.arxiv.org/abs/2601.00001", "content": "arXiv result"},
        {"title": "Hugging Face", "url": "https://huggingface.co/example/model", "content": "HF result"},
        {"title": "Allowed", "url": "https://example.com/research", "content": "Allowed result"},
        {"title": "GitHub Pages", "url": "https://example.github.io/research", "content": "Allowed project site"},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        request_body.update(json.loads(request.content))
        if source_id == "general_web_firecrawl":
            web_rows = [{**row, "description": row["content"]} for row in rows]
            return httpx.Response(200, json={"success": True, "data": {"web": web_rows, "images": []}})
        if source_id == "general_web_exa":
            exa_rows = [{**row, "highlights": [row["content"]]} for row in rows]
            return httpx.Response(200, json={"results": exa_rows})
        return httpx.Response(200, json={"results": rows})

    with client_for(tmp_path, handler, **settings) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={"schema_version": 1, "source_id": source_id, "query": "speech recognition", "max_results": 10},
        )

    assert response.status_code == 200
    assert filter_key not in request_body
    assert [result["url"] for result in response.json()["results"]] == [
        "https://github.com/example/project",
        "https://raw.githubusercontent.com/example/project/main/README.md",
        "https://export.arxiv.org/abs/2601.00001",
        "https://huggingface.co/example/model",
        "https://example.com/research",
        "https://example.github.io/research",
    ]


def test_general_web_backend_performs_one_attempt_without_internal_fallback(tmp_path, authorization) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host or "")
        if request.url.host == "api.firecrawl.dev":
            return httpx.Response(503, json={"error": "temporarily unavailable"})
        raise AssertionError(f"Unexpected provider: {request.url}")

    with client_for(
        tmp_path,
        handler,
        firecrawl_api_key="firecrawl-test-secret",
        tavily_api_key="tavily-test-secret",
        exa_api_key=None,
    ) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "general_web_firecrawl",
                "query": "agent runtime",
                "max_results": 5,
            },
        )

    assert response.status_code == 502
    assert response.json()["error"]["retryable"] is True
    assert calls == ["api.firecrawl.dev"]


def test_github_cli_rate_limit_returns_structured_retry_after(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/bin/sh\necho 'HTTP 403: API rate limit exceeded. Retry after 12 seconds.' >&2\nexit 1\n",
        encoding="utf-8",
    )
    gh.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{github_module.os.environ['PATH']}")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"GitHub Provider must not make direct HTTP requests: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={"schema_version": 1, "source_id": "github", "query": "agents", "max_results": 3},
        )

    assert response.status_code == 502
    assert response.json()["error"]["failure_class"] == "rate_limit"
    assert response.json()["error"]["retry_after_ms"] == 12_000


def test_github_search_validation_preserves_structured_gh_error(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    validation_message = (
        "The listed users and repositories cannot be searched either because the resources do not exist or "
        "you do not have permission to view them."
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gh = bin_dir / "gh"
    github_error = {
        "message": "Validation Failed",
        "errors": [
            {
                "message": validation_message,
                "resource": "Search",
                "field": "q",
                "code": "invalid",
            }
        ],
        "status": "422",
    }
    gh.write_text(
        "#!/bin/sh\n"
        "cat <<'JSON'\n"
        f"{json.dumps(github_error)}\n"
        "JSON\n"
        "echo 'gh: Validation Failed (HTTP 422)' >&2\n"
        "exit 1\n",
        encoding="utf-8",
    )
    gh.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{github_module.os.environ['PATH']}")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"GitHub Provider must not make direct HTTP requests: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={"schema_version": 1, "source_id": "github", "query": "org:fair speech recognition", "max_results": 5},
        )

    assert response.status_code == 422
    assert response.json()["error"] == {
        "code": "github_search_validation_failed",
        "message": "GitHub Search validation failed",
        "failure_class": "validation",
        "retryable": False,
        "provider": "github",
        "request_id": response.json()["error"]["request_id"],
        "retry_after_ms": None,
        "details": {
            "circuit_scope": "request",
            "github_status": 422,
            "message": "Validation Failed",
            "errors": [
                {
                    "message": validation_message,
                    "resource": "Search",
                    "field": "q",
                    "code": "invalid",
                }
            ],
        },
    }


def test_github_authentication_failure_is_provider_scoped(
    tmp_path,
    authorization,
    monkeypatch,
) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/bin/sh\n"
        'echo \'{"message":"Bad credentials","status":"401"}\'\n'
        "echo 'gh: Bad credentials (HTTP 401)' >&2\n"
        "exit 1\n",
        encoding="utf-8",
    )
    gh.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{github_module.os.environ['PATH']}")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"GitHub Provider must not make direct HTTP requests: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={"schema_version": 1, "source_id": "github", "query": "whisper", "max_results": 5},
        )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "github_authentication_failed"
    assert response.json()["error"]["failure_class"] == "permanent"
    assert response.json()["error"]["retryable"] is False
    assert response.json()["error"]["details"] == {
        "circuit_scope": "provider",
        "github_status": 401,
        "message": "Bad credentials",
    }


def test_huggingface_rate_limit_reset_header_is_structured(tmp_path, authorization) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="Rate exceeded", headers={"ratelimit": '"api";r=0;t=45'})

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "huggingface",
                "query": "agents",
                "provider_request": {
                    "operation": "models_list",
                    "parameters": {"search": "agents"},
                },
            },
        )

    assert response.status_code == 502
    assert response.json()["error"]["failure_class"] == "rate_limit"
    assert response.json()["error"]["retry_after_ms"] == 45_000


def test_tavily_is_an_independent_source(tmp_path, authorization) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["query"] == "agent runtime"
        return httpx.Response(
            200,
            json={
                "request_id": "req_1",
                "results": [
                    {
                        "title": "Agent Runtime",
                        "url": "https://example.com/agent-runtime",
                        "content": "Runtime architecture",
                        "score": 0.9,
                    }
                ],
            },
        )

    with client_for(tmp_path, handler, tavily_api_key="tavily-test-secret") as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={"schema_version": 1, "source_id": "general_web_tavily", "query": "agent runtime", "max_results": 5},
        )

    assert response.status_code == 200
    assert response.json()["results"][0]["metadata"]["general_web_backend"] == "tavily"


def test_user_documents_search_stays_within_workspace(tmp_path, authorization) -> None:
    workspace = tmp_path / "goal" / "wiki" / "runs" / "run-1"
    attachments = tmp_path / "goal" / "attachments"
    workspace.mkdir(parents=True)
    attachments.mkdir(parents=True)
    (attachments / "notes.md").write_text("Agent runtime evaluation methodology", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "user_documents",
                "query": "evaluation methodology",
                "max_results": 10,
                "workspace_dir": str(workspace),
            },
        )
        rejected = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "user_documents",
                "query": "anything",
                "workspace_dir": "/",
            },
        )

    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["title"] == "notes.md"
    assert result["metadata"]["artifact_path"] == "attachments/notes.md"
    assert rejected.status_code == 403
    assert rejected.json()["error"]["code"] == "workspace_outside_allowed_roots"


def test_user_documents_lists_text_and_parseable_files_only(tmp_path, authorization) -> None:
    """未识别的二进制原件只保存不作为来源；源码和文件夹内的文件按文本直接读。"""
    workspace = tmp_path / "goal" / "wiki" / "runs" / "run-1"
    attachments = tmp_path / "goal" / "attachments"
    folder = attachments / "f1_project" / "src"
    workspace.mkdir(parents=True)
    folder.mkdir(parents=True)
    (folder / "runtime.py").write_text("# evaluation methodology helper", encoding="utf-8")
    # The binary would match by file name; only its kind keeps it out of the results.
    (attachments / "evaluation-firmware.bin").write_bytes(b"evaluation" + bytes(range(256)))
    (attachments / "paper.pdf").write_bytes(b"%PDF-1.7 evaluation methodology")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={
                "schema_version": 1,
                "source_id": "user_documents",
                "query": "evaluation paper",
                "max_results": 10,
                "workspace_dir": str(workspace),
            },
        )

    assert response.status_code == 200
    paths = sorted(result["metadata"]["artifact_path"] for result in response.json()["results"])
    assert paths == ["attachments/f1_project/src/runtime.py", "attachments/paper.pdf"]


def test_workspace_dir_inside_service_tree_is_rejected(tmp_path) -> None:
    """下载绝不能落进服务自己的包目录 - 那会污染代码树。

    这个不变量不依赖 allowed_roots 配置: 即使调用方把服务目录配成允许的根,
    也必须被拒绝。历史上曾经有 37MB 的仓库克隆落在
    services/research-source-service/artifacts/ 下。
    """
    from research_source_service.errors import ServiceError
    from research_source_service.security import _SERVICE_TREE, safe_workspace_dir

    inside = _SERVICE_TREE / "src"  # 已存在的目录, 测试不制造副作用

    # 即使把服务目录本身列为允许的根, 也要拒绝
    with pytest.raises(ServiceError) as caught:
        safe_workspace_dir(str(inside), (_SERVICE_TREE,))
    assert caught.value.code == "workspace_inside_service_tree"

    # 正常的外部 workspace 不受影响
    outside = tmp_path / "run"
    outside.mkdir()
    assert safe_workspace_dir(str(outside), (tmp_path,)) == outside.resolve()
