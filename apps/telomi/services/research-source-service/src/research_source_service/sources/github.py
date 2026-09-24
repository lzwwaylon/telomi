from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import uuid
from datetime import date
from difflib import get_close_matches
from pathlib import Path
from typing import Any, NoReturn
from urllib.parse import quote, urlencode

from ..errors import ServiceError, bounded_message
from ..http_client import redact_secrets
from ..material_cache import MaterialCache
from ..models import SearchRequest, SearchResult
from ..security import safe_workspace_dir
from .base import SourceSpec, secret, stable_search_id

CLONE_BLOB_LIMIT = "1m"  # ponytail: fixed knob, make it a config field if a source needs bigger blobs

REPOSITORY = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")
TOPIC = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,49})$")
MATERIALIZING_OPERATIONS = {"clone_repository", "download_release", "download_file"}
REPOSITORY_OPERATIONS = {"get_repository", "get_issue", *MATERIALIZING_OPERATIONS}
OPERATIONS = {
    "search_topics",
    "search_repositories",
    "get_repository",
    "search_code",
    "search_issues",
    "get_issue",
    *MATERIALIZING_OPERATIONS,
}


class GitHubSource:
    # GitHub access must stay behind `gh`. The local product deliberately relies on
    # `gh auth` for Keychain credentials, host selection, and account switching.
    # Do not replace these calls with HttpGateway requests or require Workers to
    # receive GitHub tokens through their environment.
    def __init__(
        self,
        token: str | None,
        allowed_workspace_roots: tuple[Path, ...] = (),
        max_download_bytes: int = 50 * 1024 * 1024,
        material_cache: MaterialCache | None = None,
    ) -> None:
        self.token = token
        self.allowed_workspace_roots = allowed_workspace_roots
        self.max_download_bytes = max_download_bytes
        self.material_cache = material_cache

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        if request.provider_request is None:
            return await self._search_repositories(
                {"query": request.query, "limit": min(request.max_results, 100)}
            )
        operation = request.provider_request.operation
        if operation not in OPERATIONS:
            raise validation(f"Unsupported GitHub operation '{operation}'")
        parameters = strict_parameters(operation, request.provider_request.parameters)
        if operation == "search_topics":
            return await self._search_topics(parameters)
        if operation == "search_repositories":
            return await self._search_repositories(parameters)
        if operation == "search_code":
            return await self._search_code(parameters)
        if operation == "search_issues":
            return await self._search_issues(parameters)
        repository = required_repository(parameters.get("repository"))
        try:
            if operation == "get_repository":
                return [parse_repository(await self._get(f"/repos/{quote(repository, safe='/')}"))]
            if operation == "get_issue":
                return [await self._get_issue(parameters)]
            workspace = self._workspace(request)
            if operation == "clone_repository":
                return [await self._clone_repository(parameters, workspace)]
            if operation == "download_release":
                return await self._download_release(parameters, workspace)
            return [await self._download_file(parameters, workspace)]
        except ServiceError as error:
            if operation not in REPOSITORY_OPERATIONS or github_error_status(error) != 404:
                raise
            await self._raise_repository_not_found(operation, repository, error)

    async def _search_topics(self, parameters: dict[str, Any]) -> list[SearchResult]:
        query = required_text(parameters.get("query"), "query", 2_000)
        curated_only = boolean(parameters.get("curated_only", False), "curated_only")
        limit = result_limit(parameters.get("limit"))
        payload = await self._get(
            "/search/topics",
            params={
                "q": f"{query} is:curated" if curated_only else query,
                "per_page": limit,
            },
        )
        rows = list_items(payload)
        if curated_only and not any(row.get("name") == query for row in rows):
            exact_rows = list_items(await self._get(
                "/search/topics",
                params={"q": query, "per_page": limit},
            ))
            rows = [row for row in exact_rows if row.get("name") == query] + rows
        return [result for row in rows if (result := parse_topic(row)) is not None][:limit]

    async def _search_repositories(self, parameters: dict[str, Any]) -> list[SearchResult]:
        topics = [
            topic_name(value)
            for value in text_list(parameters.get("topics", []), "topics", 20, 50)
        ]
        raw_query = parameters.get("query", "")
        if not isinstance(raw_query, str) or len(raw_query) > 2_000:
            raise validation("GitHub query must be a string up to 2000 characters")
        query = normalize_query(raw_query) if raw_query.strip() else ""
        if not query and not topics:
            raise validation("GitHub query may be empty only when topics are provided")
        language = optional_text(parameters.get("language"), "language", 100)
        min_stars = optional_nonnegative_integer(parameters.get("min_stars"), "min_stars")
        created_after = optional_date(parameters.get("created_after"), "created_after")
        created_before = optional_date(parameters.get("created_before"), "created_before")
        pushed_after = optional_date(parameters.get("pushed_after"), "pushed_after")
        if created_after and created_before and created_after > created_before:
            raise validation("GitHub created_after must not be later than created_before")
        sort = enum_value(parameters.get("sort", "stars"), "sort", {"stars", "updated", "forks"})
        order = enum_value(parameters.get("order", "desc"), "order", {"desc", "asc"})
        limit = result_limit(parameters.get("limit"))
        qualifiers = [
            query,
            *(f"topic:{topic}" for topic in topics),
            f"language:{language}" if language else None,
            f"stars:>={min_stars}" if min_stars is not None else None,
            (
                f"created:{created_after}..{created_before}"
                if created_after and created_before
                else f"created:>={created_after}"
                if created_after
                else f"created:<={created_before}"
                if created_before
                else None
            ),
            f"pushed:>={pushed_after}" if pushed_after else None,
            "fork:false",
            "archived:false",
            "is:public",
        ]
        payload = await self._get(
            "/search/repositories",
            params={
                "q": " ".join(value for value in qualifiers if value),
                "sort": sort,
                "order": order,
                "per_page": limit,
            },
        )
        return [
            result
            for row in list_items(payload)
            if (result := parse_repository(row)) is not None
        ][:limit]

    async def _search_code(self, parameters: dict[str, Any]) -> list[SearchResult]:
        query = required_text(parameters.get("query"), "query", 2_000)
        repository = optional_repository(parameters.get("repository"))
        limit = result_limit(parameters.get("limit"))
        qualified_query = " ".join(filter(None, (query, f"repo:{repository}" if repository else None)))
        payload = await self._get(
            "/search/code",
            headers={"Accept": "application/vnd.github.text-match+json"},
            params={"q": qualified_query, "per_page": limit},
        )
        return [
            result
            for row in list_items(payload)
            if (result := parse_code_result(row)) is not None
        ][:limit]

    async def _search_issues(self, parameters: dict[str, Any]) -> list[SearchResult]:
        query = required_text(parameters.get("query"), "query", 2_000)
        repository = optional_repository(parameters.get("repository"))
        state = enum_value(parameters.get("state", "all"), "state", {"open", "closed", "all"})
        match = optional_enum(parameters.get("match"), "match", {"title", "body", "comments"})
        limit = result_limit(parameters.get("limit"))
        qualifiers = [
            "is:issue",
            f"repo:{repository}" if repository else None,
            f"state:{state}" if state != "all" else None,
            f"in:{match}" if match else None,
        ]
        payload = await self._get(
            "/search/issues",
            params={
                "q": " ".join([query, *(value for value in qualifiers if value)]),
                "per_page": limit,
            },
        )
        return [
            result
            for row in list_items(payload)
            if (result := parse_issue(row)) is not None
        ][:limit]

    async def _get_issue(self, parameters: dict[str, Any]) -> SearchResult:
        repository = required_repository(parameters.get("repository"))
        number = positive_integer(parameters.get("number"), "number")
        prefix = f"/repos/{quote(repository, safe='/')}/issues/{number}"
        issue = await self._get(prefix)
        comments: list[dict[str, Any]] = []
        page = 1
        while True:
            rows = await self._get_list(
                f"{prefix}/comments",
                params={"per_page": 100, "page": page},
            )
            comments.extend(rows)
            if len(rows) < 100:
                break
            page += 1
        return parse_issue(issue, comments=comments)

    async def _resolve_commit(self, repository: str, ref: str | None) -> str | None:
        """Resolve a mutable ref to a commit SHA, or let callers use their ref-based cache key."""
        try:
            output = await run_gh(
                ["api", f"repos/{repository}/commits/{ref or 'HEAD'}", "--jq", ".sha"],
                token=self.token,
            )
        except ServiceError as error:
            if github_error_status(error) == 404:
                raise
            return None
        except Exception:
            return None
        commit = output.strip()
        return commit if len(commit) == 40 and all(c in "0123456789abcdef" for c in commit) else None

    async def _raise_repository_not_found(
        self,
        operation: str,
        repository: str,
        error: ServiceError,
    ) -> NoReturn:
        owner, name = repository.split("/", 1)
        candidates: dict[str, str] = {}
        listing_params: dict[str, object] = {"per_page": 100, "sort": "pushed"}
        calls = 1
        try:
            rows = await self._get_list(f"/orgs/{quote(owner, safe='')}/repos", params=listing_params)
        except ServiceError as listing_error:
            rows = []
            if github_error_status(listing_error) == 404:
                calls += 1
                try:
                    rows = await self._get_list(f"/users/{quote(owner, safe='')}/repos", params=listing_params)
                except ServiceError:
                    pass
        for row in rows:
            if isinstance(full_name := row.get("full_name"), str):
                candidates.setdefault(full_name.rpartition("/")[2].casefold(), full_name)
        if calls < 2:
            try:
                payload = await self._get(
                    "/search/repositories",
                    params={"q": f"{name} user:{owner}", "per_page": 10},
                )
                for row in list_items(payload):
                    if isinstance(full_name := row.get("full_name"), str):
                        candidates.setdefault(full_name.rpartition("/")[2].casefold(), full_name)
            except ServiceError:
                pass
        requested_name = name.casefold()
        matches = get_close_matches(requested_name, candidates, n=5, cutoff=0.6)
        if requested_name in matches:
            matches.insert(0, matches.pop(matches.index(requested_name)))
        suggestions = [candidates[match] for match in matches]
        recovery_parameters = {"query": f"{name} user:{owner}"}
        similar = f" Similar repositories: {', '.join(suggestions)}." if suggestions else ""
        details: dict[str, Any] = {
            "circuit_scope": "request",
            "failure_scope": "request",
            "github_status": 404,
            "operation": operation,
            "repository": repository,
            "recovery": {
                "operation": "search_repositories",
                "parameters": recovery_parameters,
                "then": operation,
            },
        }
        if suggestions:
            details["suggestions"] = suggestions
        raise ServiceError(
            "github_repository_not_found",
            f"GitHub repository '{repository}' was not found.{similar} "
            f"Call search_repositories(query={name} user:{owner}) to obtain an exact repository, "
            f"then retry {operation}.",
            status_code=404,
            retryable=False,
            provider="github",
            details=details,
        ) from error

    async def _clone_repository(
        self,
        parameters: dict[str, Any],
        workspace: Path,
    ) -> SearchResult:
        repository = required_repository(parameters.get("repository"))
        ref = optional_ref(parameters.get("ref"), "ref")
        full_history = boolean(parameters.get("full_history", False), "full_history")
        key = digest_key(ref or "default", str(full_history))
        target = workspace / "artifacts" / "github" / "repositories" / repository / key
        # Resolve mutable refs before caching so unchanged commits reuse immutable cache entries.
        commit = await self._resolve_commit(repository, ref)
        if commit:
            cache_key = json.dumps(
                {"repository": repository, "commit": commit, "full_history": full_history},
                sort_keys=True,
            )
        else:
            cache_key = json.dumps(
                {"repository": repository, "ref": ref, "full_history": full_history},
                sort_keys=True,
            )
        cache_hit = False
        if not (target / ".git").is_dir():
            if target.exists():
                raise validation("GitHub clone destination already exists but is incomplete")
            cache_hit = bool(
                self.material_cache
                and self.material_cache.restore_tree("github-clone-v1", cache_key, target)
            )
            acquired = False
            if not cache_hit and self.material_cache:
                # Let one provider process download while peers restore its result from CAS.
                if self.material_cache.begin_acquire("github-clone-v1", cache_key):
                    acquired = True
                else:
                    cache_hit = bool(
                        self.material_cache.restore_tree("github-clone-v1", cache_key, target)
                    )
            if not cache_hit:
                temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
                temporary.parent.mkdir(parents=True, exist_ok=True)
                # Partial clone without checkout: blobs above the limit stay on the server, and
                # checkout_without_missing_blobs keeps them out of the working tree so model
                # weights and datasets never land on disk. Agents read code, not weights.
                args = [
                    "repo", "clone", repository, str(temporary), "--",
                    "--no-checkout", f"--filter=blob:limit={CLONE_BLOB_LIMIT}",
                ]
                if not full_history:
                    args.append("--depth=1")
                if ref:
                    args.extend(["--branch", ref, "--single-branch"])
                args.extend([
                    "--config", "core.symlinks=false",
                    "--config", "filter.lfs.smudge=",
                    "--config", "filter.lfs.process=",
                    "--config", "filter.lfs.required=false",
                ])
                try:
                    await run_gh(args, token=self.token)
                    await checkout_without_missing_blobs(temporary)
                    temporary.rename(target)
                    if self.material_cache:
                        self.material_cache.store_tree(
                            "github-clone-v1", cache_key, target, immutable=bool(commit)
                        )
                except BaseException:
                    shutil.rmtree(temporary, ignore_errors=True)
                    raise
                finally:
                    if acquired and self.material_cache:
                        self.material_cache.end_acquire("github-clone-v1", cache_key)
            elif acquired and self.material_cache:
                self.material_cache.end_acquire("github-clone-v1", cache_key)
        url = f"https://github.com/{repository}"
        return SearchResult(
            id=stable_search_id("github", f"{url}#clone:{key}"),
            title=f"{repository} repository clone",
            url=url,
            snippet=f"GitHub repository cloned at {ref or 'default branch'}",
            metadata={
                "repository": repository,
                "resource_type": "repository_clone",
                "artifact_path": relative_artifact(workspace, target),
                "ref": ref,
                "full_history": full_history,
                "material_cache_hit": cache_hit,
                "resolved_commit": commit,
                "provider_implementation": "github_cli_clone_v1",
                "reliability_tier": "platform_primary",
            },
        )

    async def _download_release(
        self,
        parameters: dict[str, Any],
        workspace: Path,
    ) -> list[SearchResult]:
        repository = required_repository(parameters.get("repository"))
        tag = optional_ref(parameters.get("tag"), "tag")
        patterns = text_list(parameters.get("patterns", []), "patterns", 20, 256)
        archive = optional_enum(parameters.get("archive"), "archive", {"zip", "tar.gz"})
        if not tag and not patterns and not archive:
            raise validation("GitHub download_release requires tag, patterns, or archive")
        key = digest_key(tag or "latest", json.dumps(patterns), archive or "")
        target = workspace / "artifacts" / "github" / "releases" / repository / key
        cache_key = json.dumps(
            {"repository": repository, "tag": tag, "patterns": patterns, "archive": archive},
            sort_keys=True,
        )
        cache_hit = False
        files = regular_files(target)
        if not files:
            if target.exists():
                raise validation("GitHub release destination already exists but is incomplete")
            cache_hit = bool(
                self.material_cache
                and self.material_cache.restore_tree("github-release-v1", cache_key, target)
            )
            if not cache_hit:
                temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
                temporary.mkdir(parents=True, exist_ok=False)
                args = ["release", "download"]
                if tag:
                    args.append(tag)
                args.extend(["--repo", repository, "--dir", str(temporary), "--skip-existing"])
                for pattern in patterns:
                    args.extend(["--pattern", pattern])
                if archive:
                    args.append(f"--archive={archive}")
                try:
                    await run_gh(args, token=self.token)
                    enforce_download_budget(temporary, self.max_download_bytes)
                    temporary.rename(target)
                    if self.material_cache:
                        self.material_cache.store_tree("github-release-v1", cache_key, target)
                except BaseException:
                    shutil.rmtree(temporary, ignore_errors=True)
                    raise
            files = regular_files(target)
        if not files:
            raise ServiceError(
                "github_download_empty",
                "GitHub release download produced no files",
                provider="github",
            )
        base_url = (
            f"https://github.com/{repository}/releases/tag/{quote(tag, safe='')}"
            if tag
            else f"https://github.com/{repository}/releases/latest"
        )
        return [
            SearchResult(
                id=stable_search_id("github", f"{base_url}#asset:{path.relative_to(target).as_posix()}"),
                title=path.name,
                url=base_url,
                snippet=f"Downloaded GitHub release file {path.name}",
                metadata={
                    "repository": repository,
                    "resource_type": "release_download",
                    "artifact_path": relative_artifact(workspace, path),
                    "byte_length": path.stat().st_size,
                    "tag": tag,
                    "material_cache_hit": cache_hit,
                    "provider_implementation": "github_cli_release_download_v1",
                    "reliability_tier": "platform_primary",
                },
            )
            for path in files
        ]

    async def _download_file(
        self,
        parameters: dict[str, Any],
        workspace: Path,
    ) -> SearchResult:
        repository = required_repository(parameters.get("repository"))
        path = repository_path(parameters.get("path"))
        ref = optional_ref(parameters.get("ref"), "ref")
        key = digest_key(repository, path, ref or "default")
        target_dir = workspace / "artifacts" / "github" / "files" / key
        target = target_dir / Path(path).name
        cache_key = json.dumps({"repository": repository, "path": path, "ref": ref}, sort_keys=True)
        cache_hit = False
        if not target.is_file():
            if target_dir.exists():
                raise validation("GitHub file destination already exists but is incomplete")
            cache_hit = bool(
                self.material_cache
                and self.material_cache.restore_tree("github-file-v1", cache_key, target_dir)
            )
            if not cache_hit:
                target_dir.mkdir(parents=True, exist_ok=False)
                temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
                endpoint = f"repos/{quote(repository, safe='/')}/contents/{quote(path, safe='/')}"
                if ref:
                    endpoint = f"{endpoint}?{urlencode({'ref': ref})}"
                try:
                    await run_gh(
                        [
                            "api",
                            "-H",
                            "Accept: application/vnd.github.raw+json",
                            endpoint,
                        ],
                        token=self.token,
                        stdout_path=temporary,
                    )
                    if temporary.stat().st_size > self.max_download_bytes:
                        raise ServiceError(
                            "github_download_too_large",
                            f"GitHub file exceeds max bytes of {self.max_download_bytes}",
                            status_code=413,
                            provider="github",
                        )
                    temporary.rename(target)
                    if self.material_cache:
                        self.material_cache.store_tree("github-file-v1", cache_key, target_dir)
                except BaseException:
                    shutil.rmtree(target_dir, ignore_errors=True)
                    raise
        url = f"https://github.com/{repository}/blob/{quote(ref or 'HEAD', safe='')}/{quote(path, safe='/')}"
        return SearchResult(
            id=stable_search_id("github", f"{url}#file:{key}"),
            title=path,
            url=url,
            snippet=f"Downloaded GitHub repository file {path}",
            metadata={
                "repository": repository,
                "resource_type": "repository_file",
                "path": path,
                "ref": ref,
                "artifact_path": relative_artifact(workspace, target),
                "byte_length": target.stat().st_size,
                "material_cache_hit": cache_hit,
                "provider_implementation": "github_cli_file_download_v1",
                "reliability_tier": "platform_primary",
            },
        )

    async def _get(
        self,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        params: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        payload = await self._gh_json(path, headers=headers, params=params)
        if not isinstance(payload, dict):
            raise ServiceError(
                "github_cli_invalid_json",
                "GitHub CLI returned a non-object JSON response",
                provider="github",
            )
        return payload

    async def _gh_json(
        self,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        params: dict[str, object] | None = None,
    ) -> object:
        args = ["api", "--method", "GET"]
        for name, value in (headers or {}).items():
            args.extend(["-H", f"{name}: {value}"])
        args.append(path)
        for name, value in (params or {}).items():
            flag = "-F" if isinstance(value, (bool, int)) else "-f"
            args.extend([flag, f"{name}={str(value).lower() if isinstance(value, bool) else value}"])
        try:
            payload = json.loads(await run_gh(args, token=self.token))
        except json.JSONDecodeError as error:
            raise ServiceError(
                "github_cli_invalid_json",
                "GitHub CLI returned invalid JSON",
                provider="github",
            ) from error
        return payload

    async def _get_list(
        self,
        path: str,
        *,
        params: dict[str, object] | None = None,
    ) -> list[dict[str, Any]]:
        payload = await self._gh_json(path, params=params)
        if not isinstance(payload, list) or any(not isinstance(row, dict) for row in payload):
            raise ServiceError(
                "github_cli_invalid_json",
                "GitHub CLI returned an invalid list response",
                provider="github",
            )
        return payload

    def _workspace(self, request: SearchRequest) -> Path:
        if not request.workspace_dir:
            raise validation("workspace_dir is required for GitHub download operations")
        return safe_workspace_dir(request.workspace_dir, self.allowed_workspace_roots)


def sparse_checkout_patterns(missing_objects: str, tree_listing: str) -> list[str]:
    """Everything except the paths whose blobs the partial clone left on the server."""
    missing = {line[1:] for line in missing_objects.splitlines() if line.startswith("?")}
    patterns = ["/*"]
    for entry in tree_listing.split("\0"):
        if not entry:
            continue
        info, path = entry.split("\t", 1)
        if info.split()[2] in missing:
            patterns.append(f"!/{path}")
    return patterns


async def checkout_without_missing_blobs(repository: Path) -> None:
    # `git ls-tree -l` would lazily fetch the missing blobs just to report sizes; rev-list does not.
    missing = await run_git(["rev-list", "--objects", "--missing=print", "HEAD"], cwd=repository)
    listing = await run_git(["ls-tree", "-r", "-z", "HEAD"], cwd=repository)
    patterns = sparse_checkout_patterns(missing, listing)
    await run_git(["sparse-checkout", "set", "--no-cone", "--stdin"], cwd=repository, stdin="\n".join(patterns))
    await run_git(["checkout", "--quiet", "HEAD"], cwd=repository)


async def run_git(args: list[str], *, cwd: Path, stdin: str | None = None) -> str:
    process = await asyncio.create_subprocess_exec(
        "git",
        *args,
        cwd=cwd,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    try:
        stdout, stderr = await process.communicate(stdin.encode("utf-8") if stdin is not None else None)
    except asyncio.CancelledError:
        process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        detail = redact_secrets(bounded_message(stderr.decode("utf-8", errors="replace")))
        raise ServiceError(
            "github_clone_failed",
            f"git {args[0]} failed: {detail or f'exit {process.returncode}'}",
            provider="github",
        )
    return stdout.decode("utf-8", errors="replace")


async def run_gh(
    args: list[str],
    *,
    token: str | None,
    stdout_path: Path | None = None,
) -> str:
    # Ambient tokens must not outlive a deleted managed credential; only the
    # captured request token may authenticate gh.
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"}
    }
    environment.update({"GH_PROMPT_DISABLED": "1", "NO_COLOR": "1"})
    if token:
        environment["GH_TOKEN"] = token
    output = stdout_path.open("xb") if stdout_path else asyncio.subprocess.PIPE
    try:
        try:
            process = await asyncio.create_subprocess_exec(
                "gh",
                *args,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=output,
                stderr=asyncio.subprocess.PIPE,
                env=environment,
            )
        except FileNotFoundError as error:
            raise ServiceError(
                "github_cli_unavailable",
                "GitHub CLI executable 'gh' is unavailable",
                provider="github",
            ) from error
        try:
            stdout, stderr = await process.communicate()
        except asyncio.CancelledError:
            process.kill()
            await process.wait()
            raise
    finally:
        if stdout_path:
            output.close()
    if process.returncode != 0:
        validation_details = github_search_validation_details(stdout)
        if validation_details:
            raise ServiceError(
                "github_search_validation_failed",
                "GitHub Search validation failed",
                status_code=422,
                retryable=False,
                provider="github",
                details={"circuit_scope": "request", **validation_details},
            )
        detail = redact_secrets(bounded_message(stderr.decode("utf-8", errors="replace")))
        authentication_details = github_authentication_details(stdout, detail)
        if authentication_details:
            raise ServiceError(
                "github_authentication_failed",
                "GitHub authentication failed",
                status_code=401,
                retryable=False,
                provider="github",
                details={"circuit_scope": "provider", **authentication_details},
            )
        rate_limited = bool(re.search(r"\b(?:rate.?limit|rate exceeded|too many requests)\b", detail, re.IGNORECASE))
        retryable = rate_limited or bool(re.search(r"\b(?:timeout|temporar|try again)\b", detail, re.IGNORECASE))
        raise ServiceError(
            "provider_rate_limit" if rate_limited else "github_cli_failed",
            f"GitHub CLI failed: {detail or f'exit {process.returncode}'}",
            retryable=retryable,
            provider="github",
            retry_after_ms=github_retry_after_ms(detail) if rate_limited else None,
        )
    return "" if stdout_path else stdout.decode("utf-8", errors="replace")


def github_search_validation_details(stdout: bytes | None) -> dict[str, Any] | None:
    if not stdout:
        return None
    try:
        payload = json.loads(stdout)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or str(payload.get("status")) != "422":
        return None
    raw_errors = payload.get("errors")
    if not isinstance(raw_errors, list):
        return None
    errors = []
    for raw_error in raw_errors[:20]:
        if not isinstance(raw_error, dict) or raw_error.get("resource") != "Search":
            continue
        error = {
            key: redact_secrets(bounded_message(value))
            for key in ("message", "resource", "field", "code")
            if isinstance((value := raw_error.get(key)), str) and value.strip()
        }
        if error:
            errors.append(error)
    if not errors:
        return None
    message = payload.get("message")
    return {
        "github_status": 422,
        **({"message": redact_secrets(bounded_message(message))} if isinstance(message, str) else {}),
        "errors": errors,
    }


def github_authentication_details(stdout: bytes | None, stderr: str) -> dict[str, Any] | None:
    payload: object = None
    if stdout:
        try:
            payload = json.loads(stdout)
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    status = payload.get("status") if isinstance(payload, dict) else None
    message = payload.get("message") if isinstance(payload, dict) else None
    authentication_error = str(status) == "401" or bool(
        re.search(r"\b(?:bad credentials|not logged in|authentication required|HTTP 401)\b", stderr, re.IGNORECASE)
    )
    if not authentication_error:
        return None
    return {
        "github_status": 401,
        **({"message": redact_secrets(bounded_message(message))} if isinstance(message, str) else {}),
    }


def github_error_status(error: ServiceError) -> int | None:
    status = error.details.get("github_status")
    if isinstance(status, int):
        return status
    match = re.search(r"\bHTTP\s+(\d{3})\b", error.message, re.IGNORECASE)
    return int(match.group(1)) if match else None


def github_retry_after_ms(detail: str) -> int:
    match = re.search(
        r"retry[- ]after\s*:?\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)?\b",
        detail,
        re.IGNORECASE,
    )
    return round(float(match.group(1)) * 1_000) if match else 60_000


def parse_repository(row: dict[str, Any]) -> SearchResult | None:
    url = row.get("html_url")
    full_name = row.get("full_name")
    if not isinstance(url, str) or not url.startswith("https://github.com/") or not isinstance(full_name, str):
        return None
    owner_row = row.get("owner")
    owner = owner_row.get("login") if isinstance(owner_row, dict) else None
    metadata: dict[str, object] = {
        "repository": full_name,
        "resource_type": "repository",
        "provider_implementation": "github_gh_api_v3",
        "reliability_tier": "platform_primary",
    }
    for source, target in (
        ("language", "language"),
        ("stargazers_count", "stars"),
        ("forks_count", "forks"),
        ("updated_at", "updated_at"),
        ("created_at", "created_at"),
        ("pushed_at", "pushed_at"),
        ("archived", "archived"),
        ("default_branch", "default_branch"),
        ("open_issues_count", "open_issues"),
        ("license", "license"),
        ("topics", "topics"),
    ):
        if row.get(source) is not None:
            metadata[target] = row[source]
    if isinstance(owner, str):
        metadata["owner"] = owner
    return SearchResult(
        id=stable_search_id("github", url),
        title=full_name,
        url=url,
        snippet=row.get("description") if isinstance(row.get("description"), str) else "",
        authors=[owner] if isinstance(owner, str) else None,
        metadata=metadata,
    )


def parse_code_result(row: dict[str, Any]) -> SearchResult | None:
    url = row.get("html_url")
    path = row.get("path")
    repository_row = row.get("repository")
    repository = repository_row.get("full_name") if isinstance(repository_row, dict) else None
    if not all(isinstance(value, str) and value for value in (url, path, repository)):
        return None
    fragments = [
        match.get("fragment", "")
        for match in row.get("text_matches", [])
        if isinstance(match, dict) and isinstance(match.get("fragment"), str)
    ]
    return SearchResult(
        id=stable_search_id("github", url),
        title=f"{repository}:{path}",
        url=url,
        snippet="\n".join(fragments),
        metadata={
            "repository": repository,
            "path": path,
            "sha": row.get("sha"),
            "resource_type": "code",
            "provider_implementation": "github_gh_api_code_search_v3",
            "reliability_tier": "platform_primary",
        },
    )


def parse_issue(
    row: dict[str, Any],
    *,
    comments: list[dict[str, Any]] | None = None,
) -> SearchResult | None:
    url = row.get("html_url")
    title = row.get("title")
    number = row.get("number")
    repository_url = row.get("repository_url")
    repository = (
        repository_url.removeprefix("https://api.github.com/repos/")
        if isinstance(repository_url, str)
        else repository_from_html_url(url)
    )
    if not isinstance(url, str) or not isinstance(title, str) or not isinstance(number, int) or not repository:
        return None
    author_row = row.get("user")
    author = author_row.get("login") if isinstance(author_row, dict) else None
    normalized_comments = [
        {
            "id": comment.get("id"),
            "author": comment.get("user", {}).get("login") if isinstance(comment.get("user"), dict) else None,
            "body": comment.get("body") if isinstance(comment.get("body"), str) else "",
            "created_at": comment.get("created_at"),
            "updated_at": comment.get("updated_at"),
            "url": comment.get("html_url"),
        }
        for comment in comments or []
    ]
    body = row.get("body") if isinstance(row.get("body"), str) else ""
    metadata: dict[str, Any] = {
        "repository": repository,
        "issue_number": number,
        "body": body,
        "comments_count": row.get("comments"),
        "state": row.get("state"),
        "labels": [
            label.get("name")
            for label in row.get("labels", [])
            if isinstance(label, dict) and isinstance(label.get("name"), str)
        ],
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "closed_at": row.get("closed_at"),
        "resource_type": "issue_discussion" if comments is not None else "issue",
        "provider_implementation": "github_gh_api_issue_v2",
        "reliability_tier": "platform_primary",
    }
    if comments is not None:
        metadata["comments"] = normalized_comments
    return SearchResult(
        id=stable_search_id("github", url),
        title=title,
        url=url,
        snippet=body,
        authors=[author] if isinstance(author, str) else None,
        metadata=metadata,
    )


def parse_topic(row: dict[str, Any]) -> SearchResult | None:
    name = row.get("name")
    if not isinstance(name, str) or not name:
        return None
    url = f"https://github.com/topics/{name}"
    metadata = {
        key: row[key]
        for key in ("name", "display_name", "short_description", "featured", "curated", "created_by")
        if row.get(key) is not None
    }
    return SearchResult(
        id=stable_search_id("github", url),
        title=row.get("display_name") if isinstance(row.get("display_name"), str) else name,
        url=url,
        snippet=row.get("short_description") if isinstance(row.get("short_description"), str) else "",
        metadata=metadata,
    )


def normalize_query(value: str) -> str:
    value = re.sub(r"\bopen[\s-]+source\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(
        r"\b(?:github|repositories|repository|repos|repo|official|implementations|implementation)\b",
        " ",
        value,
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", value).strip() or value.strip()


def strict_parameters(operation: str, value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise validation("GitHub parameters must be an object")
    allowed = {
        "search_topics": {"query", "limit", "curated_only"},
        "search_repositories": {
            "query", "topics", "language", "min_stars", "created_after", "created_before",
            "pushed_after", "sort", "order", "limit",
        },
        "get_repository": {"repository"},
        "search_code": {"query", "repository", "limit"},
        "search_issues": {"query", "repository", "state", "match", "limit"},
        "get_issue": {"repository", "number"},
        "clone_repository": {"repository", "ref", "full_history"},
        "download_release": {"repository", "tag", "patterns", "archive"},
        "download_file": {"repository", "path", "ref"},
    }[operation]
    unknown = set(value) - allowed
    if unknown:
        raise validation(f"Unsupported GitHub {operation} parameter '{sorted(unknown)[0]}'")
    return value


def required_repository(value: object) -> str:
    result = required_text(value, "repository", 140)
    if not REPOSITORY.fullmatch(result):
        raise validation("GitHub repository must use OWNER/REPO form")
    return result


def optional_repository(value: object) -> str | None:
    return None if value is None else required_repository(value)


def repository_path(value: object) -> str:
    result = required_text(value, "path", 4_096)
    if result.startswith("/") or any(part in {"", ".", ".."} for part in result.split("/")):
        raise validation("GitHub path must be a safe relative repository path")
    return result


def required_text(value: object, name: str, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise validation(f"GitHub {name} must be a non-empty string up to {max_length} characters")
    return value.strip()


def optional_text(value: object, name: str, max_length: int) -> str | None:
    return None if value is None else required_text(value, name, max_length)


def topic_name(value: object) -> str:
    result = required_text(value, "topic", 50)
    if not TOPIC.fullmatch(result):
        raise validation("GitHub topic must contain only letters, numbers, and hyphens")
    return result


def optional_date(value: object, name: str) -> str | None:
    if value is None:
        return None
    result = required_text(value, name, 10)
    try:
        parsed = date.fromisoformat(result)
    except ValueError:
        raise validation(f"GitHub {name} must use YYYY-MM-DD") from None
    if parsed.isoformat() != result:
        raise validation(f"GitHub {name} must use YYYY-MM-DD")
    return result


def optional_nonnegative_integer(value: object, name: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise validation(f"GitHub {name} must be a non-negative integer")
    return value


def optional_ref(value: object, name: str) -> str | None:
    if value is None:
        return None
    result = required_text(value, name, 255)
    if result.startswith("-") or any(ord(character) < 32 or ord(character) == 127 for character in result):
        raise validation(f"GitHub {name} is invalid")
    return result


def positive_integer(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise validation(f"GitHub {name} must be a positive integer")
    return value


def result_limit(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 100:
        raise validation("GitHub limit must be between 1 and 100")
    return value


def boolean(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        raise validation(f"GitHub {name} must be a boolean")
    return value


def enum_value(value: object, name: str, allowed: set[str]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise validation(f"GitHub {name} must be one of {', '.join(sorted(allowed))}")
    return value


def optional_enum(value: object, name: str, allowed: set[str]) -> str | None:
    return None if value is None else enum_value(value, name, allowed)


def text_list(value: object, name: str, max_items: int, max_length: int) -> list[str]:
    if not isinstance(value, list) or len(value) > max_items:
        raise validation(f"GitHub {name} must be an array with at most {max_items} items")
    return list(dict.fromkeys(required_text(item, name, max_length) for item in value))


def list_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("items")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def repository_from_html_url(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    match = re.match(r"^https://github\.com/([^/]+/[^/]+)/issues/\d+$", value)
    return match.group(1) if match else None


def digest_key(*values: str) -> str:
    return hashlib.sha256("\0".join(values).encode()).hexdigest()[:16]


def relative_artifact(workspace: Path, target: Path) -> str:
    resolved = target.resolve(strict=True)
    if not resolved.is_relative_to(workspace):
        raise validation("GitHub artifact escaped the workspace")
    return resolved.relative_to(workspace).as_posix()


def regular_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(path for path in root.rglob("*") if path.is_file() and not path.is_symlink())


def enforce_download_budget(root: Path, max_bytes: int) -> None:
    total = sum(path.stat().st_size for path in regular_files(root))
    if total > max_bytes:
        raise ServiceError(
            "github_download_too_large",
            f"GitHub download exceeds max bytes of {max_bytes}",
            status_code=413,
            provider="github",
            details={"received": total, "maximum": max_bytes},
        )


def validation(message: str) -> ServiceError:
    return ServiceError(
        "invalid_github_request",
        message,
        status_code=400,
        provider="github",
    )


SPECS = (
    SourceSpec(
        id="github",
        credentialed=True,
        build=lambda deps: GitHubSource(
            secret(deps.settings.github_token),
            deps.settings.resolved_workspace_roots(),
            deps.settings.max_document_bytes,
            deps.material_cache,
        ),
        max_concurrency=lambda settings: settings.github_max_concurrency,
    ),
)
