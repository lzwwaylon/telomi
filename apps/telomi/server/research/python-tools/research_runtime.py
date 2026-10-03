"""Synchronous SDK transport over the run-scoped Prime Source bridge."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, TypedDict


def workspace_path(value: str) -> str:
    """Resolve a Runtime artifact path inside the current Agent workspace."""
    root = Path(os.environ.get("PRIME_AGENT_ARTIFACT_WORKSPACE", "/workspace"))
    if value.startswith("/workspace/"):
        return str(root / value.removeprefix("/workspace/"))
    path = Path(value)
    return str(path if path.is_absolute() else root / path)


class ResearchRuntimeError(RuntimeError):
    """Structured Runtime or Provider failure visible to Worker pipelines."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "research_runtime_error",
        failure_class: str = "provider",
        retryable: bool = False,
        retry_after_ms: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.failure_class = failure_class
        self.retryable = retryable
        self.retry_after_ms = retry_after_ms
        self.details = details or {}


def _runtime_error(value: object, *, http_status: int | None = None) -> ResearchRuntimeError:
    if isinstance(value, dict):
        message = value.get("message")
        code = value.get("code")
        failure_class = value.get("failure_class")
        retryable = value.get("retryable")
        retry_after_ms = value.get("retry_after_ms")
        details = value.get("details")
        return ResearchRuntimeError(
            str(message or f"Runtime operation failed{f' with HTTP {http_status}' if http_status else ''}"),
            code=str(code or "research_runtime_error"),
            failure_class=str(failure_class or "provider"),
            retryable=retryable if isinstance(retryable, bool) else False,
            retry_after_ms=retry_after_ms if isinstance(retry_after_ms, int) else None,
            details=details if isinstance(details, dict) else None,
        )
    message = str(value or f"Runtime operation failed{f' with HTTP {http_status}' if http_status else ''}")
    return ResearchRuntimeError(
        message,
        details={"http_status": http_status} if http_status else None,
    )


def search_source(
    requests: list[dict[str, Any]],
    *,
    source: str | None = None,
) -> list[dict[str, Any]]:
    """Search the Source assigned to this Worker and return candidate rows."""
    if not isinstance(requests, list) or not requests:
        raise ValueError("requests must be a non-empty list")
    results: list[dict[str, Any]] = []
    for request in requests:
        source_id = source or request.get("source")
        if not isinstance(source_id, str) or not source_id:
            raise ValueError("source is required")
        provider_request = request.get("provider_request")
        operation = provider_request.get("operation") if isinstance(provider_request, dict) else "search"
        query = request.get("query")
        if not isinstance(query, str) or not query:
            raise ValueError("query is required")
        started = time.monotonic()
        try:
            response = _post("/v1/search", {
                "schema_version": 1,
                "source_id": source_id,
                "query": query,
                "max_results": request.get("max_results", 20),
                "criterion_ids": ["prime-agent-source-acquisition"],
                "purpose": request.get("purpose", "Prime Agent Provider acquisition"),
                "workspace_dir": os.environ["PRIME_AGENT_ARTIFACT_WORKSPACE"],
                **({"provider_request": provider_request} if isinstance(provider_request, dict) else {}),
                **_temporal_range(),
            })
            rows = response.get("results")
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ResearchRuntimeError(
                    "Runtime returned invalid Provider rows",
                    code="runtime_invalid_search_results",
                    failure_class="validation",
                )
            results.extend(rows)
            cache_values = [
                row["metadata"]["material_cache_hit"]
                for row in rows
                if isinstance(row.get("metadata"), dict)
                and isinstance(row["metadata"].get("material_cache_hit"), bool)
            ]
            _log(
                source_id,
                str(operation),
                query,
                "succeeded",
                len(rows),
                started,
                cache_hit=all(cache_values) if cache_values else None,
            )
        except Exception as error:
            _log(source_id, str(operation), query, "failed", 0, started, str(error))
            raise
    return results


EXECUTION_ID_FILE = "work/.execution-id"


def execution_id() -> str:
    """This kernel's identity towards Runtime: ``root`` for the Search Root, ``sub-…`` for a Provider child.

    Every child mounts its workspace at the same guest path and shares the worker environment, so
    the Runtime writes the child id into ``work/.execution-id`` when it creates the workspace.
    """
    marker = Path(workspace_path(EXECUTION_ID_FILE))
    try:
        value = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return "root"
    return value or "root"


def search_general_web(
    query: str,
    *,
    max_results: int = 10,
) -> list[dict[str, Any]]:
    """Search the public web for discovery and website location. Search Root only.

    Results are routing leads (id, title, url, snippet, published_at, metadata), not evidence;
    delegate original-source acquisition to a Provider child.
    """
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query is required")
    if not isinstance(max_results, int) or not 1 <= max_results <= 50:
        raise ValueError("max_results must be an integer from 1 to 50")
    response = _post("/v1/root-search", {
        "agent_session_id": execution_id(),
        "query": query.strip(),
        "max_results": max_results,
    })
    rows = response.get("results")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ResearchRuntimeError(
            "Runtime returned invalid general web rows",
            code="runtime_invalid_search_results",
            failure_class="validation",
        )
    return rows


def knowledge_search(query: str, *, limit: int = 10) -> dict[str, Any]:
    """Search saved knowledge and return a receipt; read_handoff loads the complete result on demand."""
    if execution_id() != "root":
        raise ValueError("knowledge_search is available only to the Search Root")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query is required")
    if not isinstance(limit, int) or not 1 <= limit <= 20:
        raise ValueError("limit must be an integer from 1 to 20")
    return _post("/v1/knowledge-search", {
        "agent_session_id": "root",
        "query": query.strip(),
        "limit": limit,
    })


def read_sources(question: str) -> dict[str, Any]:
    """Ask the Note Agent to read original Sources and return its verified Cue Notes."""
    if execution_id() != "root":
        raise ValueError("read_sources is available only to the Search Root")
    if not isinstance(question, str) or not question.strip():
        raise ValueError("question is required")
    return _post("/v1/deep-search", {
        "agent_session_id": "root",
        "question": question.strip(),
    })


# Historical Sessions and Cases retain the old callable and transport names.
deep_search = read_sources


def external_search(question: str) -> dict[str, Any]:
    """Acquire and verify missing evidence, returning a receipt for the complete result."""
    if execution_id() != "root":
        raise ValueError("external_search is available only to the Search Root")
    if not isinstance(question, str) or not question.strip():
        raise ValueError("question is required")
    return _post("/v1/external-search", {"agent_session_id": "root", "question": question.strip()})


def write_answer(evidence_refs: list[str], requirements: list[str]) -> dict[str, Any]:
    """Delegate synthesis: both arguments are lists of strings, e.g. write_answer([\"N1\"], [\"Explain the mechanism\"])."""
    if execution_id() != "root":
        raise ValueError("write_answer is available only to the Search Root")
    for values, name, maximum, allow_empty in [
        (evidence_refs, "evidence_refs", 256, True),
        (requirements, "requirements", 50, False),
    ]:
        if not isinstance(values, list):
            # Preserve the SDK's established validation exception for malformed arguments.
            raise ValueError(f"{name} must be list[str], e.g. ['Explain the requested part'] for requirements")  # noqa: TRY004
        if (len(values) > maximum
                or (not allow_empty and not values)
                or any(not isinstance(value, str) or not value.strip() or len(value) > 20_000 for value in values)
                or len(set(values)) != len(values)):
            raise ValueError(f"Invalid {name}")
    return _post("/v1/write-answer", {
        "agent_session_id": "root", "evidence_refs": evidence_refs, "requirements": requirements,
    })


def read_handoff(receipt: dict[str, Any]) -> dict[str, Any]:
    """Read one frozen result into a Python variable without printing it into model context."""
    if (os.environ.get("PRIME_INVESTIGATION_HANDOFF_MODE") == "inline"
            and isinstance(receipt, dict) and "result_ref" not in receipt):
        return receipt  # Historical Replay keeps its original inline protocol.
    if (not isinstance(receipt, dict) or receipt.get("schema_version") != 1
            or not isinstance(receipt.get("operation"), str)
            or not re.fullmatch(r"[a-z_]+", receipt["operation"])
            or not isinstance(receipt.get("result_ref"), str)
            or not re.fullmatch(r"inputs/handoff/" + receipt["operation"] + r"-[a-f0-9-]+\.json", receipt["result_ref"])
            or not isinstance(receipt.get("sha256"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", receipt["sha256"])
            or type(receipt.get("byte_length")) is not int or receipt["byte_length"] < 1):
        raise ResearchRuntimeError("Invalid handoff receipt", code="runtime_invalid_handoff", failure_class="validation")
    root = Path(os.environ["PRIME_AGENT_ARTIFACT_WORKSPACE"]).resolve(strict=True)
    path = root
    for part in Path(receipt["result_ref"]).parts:
        path = path / part
        if path.is_symlink():
            raise ResearchRuntimeError("Handoff symlinks are forbidden", code="runtime_invalid_handoff", failure_class="validation")
    if not path.is_file() or path.stat().st_nlink != 1:
        raise ResearchRuntimeError("Handoff must be one regular file", code="runtime_invalid_handoff", failure_class="validation")
    data = path.read_bytes()
    if len(data) != receipt["byte_length"] or hashlib.sha256(data).hexdigest() != receipt["sha256"]:
        raise ResearchRuntimeError("Handoff bytes changed", code="runtime_invalid_handoff", failure_class="validation")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ResearchRuntimeError("Handoff must contain an object", code="runtime_invalid_handoff", failure_class="validation")
    return value


def github_read(question: str, repository: str, ref: str, paths: list[str]) -> dict[str, Any]:
    """Historical frozen Replay compatibility; production investigations use external_search."""
    if execution_id() != "root":
        raise ValueError("github_read is available only to the Search Root")
    if not isinstance(question, str) or not question.strip():
        raise ValueError("question is required")
    if not isinstance(repository, str) or not repository.strip():
        raise ValueError("repository is required")
    if not isinstance(ref, str) or not ref.strip():
        raise ValueError("ref is required")
    if not isinstance(paths, list) or not paths or any(not isinstance(path, str) for path in paths):
        raise ValueError("paths must be a non-empty list of strings")
    return _post("/v1/github-read", {
        "agent_session_id": "root", "question": question.strip(),
        "repository": repository.strip(), "ref": ref.strip(), "paths": paths,
    })


def report_provider_fallback(
    from_source: str,
    to_source: str,
    *,
    evidence_need_id: str,
    scope: str,
    required_evidence_types: list[str],
    from_execution_id: str,
) -> None:
    """Record a bounded handoff of one unmet Evidence Need before creating its replacement child.

    Runtime checks the failed execution, immutable need scope, native evidence compatibility,
    visited Providers and remaining route budget. A rejected route must be reported as a gap.
    """
    if execution_id() != "root":
        raise ValueError("report_provider_fallback is available only to the Search Root")
    if not isinstance(from_source, str) or not from_source.strip():
        raise ValueError("from_source is required")
    if not isinstance(to_source, str) or not to_source.strip() or to_source == from_source:
        raise ValueError("to_source must name a different Provider")
    for name, value, limit in [
        ("evidence_need_id", evidence_need_id, 64),
        ("scope", scope, 4_000),
        ("from_execution_id", from_execution_id, 200),
    ]:
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError(f"{name} must be non-empty text up to {limit} characters")
    if (
        not isinstance(required_evidence_types, list)
        or not required_evidence_types
        or len(required_evidence_types) > 16
        or any(not isinstance(value, str) or not value.strip() or len(value) > 100 for value in required_evidence_types)
    ):
        raise ValueError("required_evidence_types must contain 1 to 16 non-empty evidence types")
    _post("/v1/provider-fallback", {
        "agent_session_id": "root",
        "from_source_id": from_source.strip(),
        "to_source_id": to_source.strip(),
        "evidence_need_id": evidence_need_id.strip(),
        "scope": scope.strip(),
        "required_evidence_types": list(dict.fromkeys(value.strip() for value in required_evidence_types)),
        "from_execution_id": from_execution_id.strip(),
    })


class BrowserStep(TypedDict):
    args: list[str]
    exitCode: int
    output: str
    truncated: bool


def browser(*args: str) -> BrowserStep:
    """Run one read-only Browser command, e.g. ``browser("open", url)`` or ``browser("snapshot", "-i")``.

    Runtime owns the Browser session of this execution; state-changing actions are rejected.
    Raises when the command exits non-zero.
    """
    steps = _browser_program([list(args)])
    step = steps[0]
    if step["exitCode"] != 0:
        raise ResearchRuntimeError(
            step["output"].strip() or f"browser command exited {step['exitCode']}",
            code="browser_command_failed",
            details={"args": step["args"], "exit_code": step["exitCode"]},
        )
    return step


def browser_program(program: list[list[str]]) -> list[BrowserStep]:
    """Run up to 32 read-only Browser commands in order, stopping at the first failure.

    Returns every executed step so the caller can read outputs and see where a program stopped.
    """
    if not isinstance(program, list) or not program or len(program) > 32:
        raise ValueError("program must hold 1 to 32 commands")
    return _browser_program(program)


def _browser_program(program: list[list[str]]) -> list[BrowserStep]:
    for command in program:
        if not isinstance(command, list) or not command or any(not isinstance(item, str) for item in command):
            raise ValueError("each browser command is a non-empty list of strings")
    response = _post("/v1/browser", {"agent_session_id": execution_id(), "program": program})
    steps = response.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ResearchRuntimeError("Runtime returned no browser steps", code="runtime_invalid_response", failure_class="validation")
    return steps  # type: ignore[return-value]


def materialize_source(source: dict[str, Any], *, title: str | None = None) -> dict[str, Any]:
    """Retain Browser evidence as converted local material and return the record for the Candidate Ledger.

    ``source`` is ``{"kind": "current_page"}``, ``{"kind": "element", "ref": "@e42"}`` or
    ``{"kind": "url", "url": "https://…"}``. Pass the returned dict unchanged to
    ``CandidateLedger.add(materials=[...])``.
    """
    if not isinstance(source, dict) or source.get("kind") not in {"current_page", "element", "url"}:
        raise ValueError("source.kind must be current_page, element, or url")
    payload: dict[str, Any] = {"agent_session_id": execution_id(), "source": source}
    if title is not None:
        payload["title"] = str(title)
    return _post("/v1/browser/materialize", payload)


def read_skill(path: str) -> str:
    """Read a staged Skill file or reference by its ``skills/...`` path and return its text.

    Runtime reads the bytes and records a receipt (path, content hash) for this execution, which
    is how an Evolution proves a reference was actually consulted.
    """
    if not isinstance(path, str) or not path.startswith("skills/"):
        raise ValueError("path must be a workspace-relative skills/... path")
    response = _post("/v1/skill-read", {"agent_session_id": execution_id(), "path": path})
    text = response.get("text")
    if not isinstance(text, str):
        raise ResearchRuntimeError("Runtime returned no skill text", code="runtime_invalid_response", failure_class="validation")
    return text


def _post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    identity = execution_id()
    if payload.get("agent_session_id", identity) != identity:
        raise ValueError("agent_session_id must match this execution")
    payload = {**payload, "agent_session_id": identity}
    request = urllib.request.Request(
        os.environ["PRIME_AGENT_SOURCE_URL"].rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['PRIME_AGENT_SOURCE_TOKEN']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        with error:
            detail = error.read().decode("utf-8", errors="replace")[:2000]
        try:
            payload = json.loads(detail)
        except json.JSONDecodeError:
            payload = None
        error_value = payload.get("error") if isinstance(payload, dict) else None
        raise _runtime_error(
            error_value or f"Source Provider HTTP {error.code}: {detail}",
            http_status=error.code,
        ) from error
    except urllib.error.URLError as error:
        raise ResearchRuntimeError(
            f"Runtime request failed: {error.reason}",
            code="runtime_request_failed",
            retryable=True,
        ) from error
    if not isinstance(value, dict):
        raise ResearchRuntimeError(
            "Runtime returned a non-object response",
            code="runtime_invalid_response",
            failure_class="validation",
        )
    return value


def _temporal_range() -> dict[str, Any]:
    start = os.environ.get("PRIME_AGENT_TEMPORAL_START")
    end = os.environ.get("PRIME_AGENT_TEMPORAL_END")
    return {"temporal_range": {"start_date": start, "end_date": end}} if start and end else {}


def log_tool_failure(source: str, operation: str, query: str, error: object) -> None:
    """Record a Tool-side failure that was contained (skipped or degraded) so it can be diagnosed later.

    Logging itself must never fail a Tool call, so a missing or unwritable log is ignored.
    """
    try:
        _log(source, operation, query, "contained", 0, time.monotonic(), str(error)[:500])
    except (KeyError, OSError):
        pass


def _log(
    source: str,
    operation: str,
    query: str,
    status: str,
    count: int,
    started: float,
    error: str | None = None,
    cache_hit: bool | None = None,
) -> None:
    entry = {
        "source": source,
        "operation": operation,
        "query": query,
        "status": status,
        "result_count": count,
        "duration_ms": round((time.monotonic() - started) * 1000),
        **({"material_cache_hit": cache_hit} if cache_hit is not None else {}),
        **({"error": error} if error else {}),
    }
    path = Path(os.environ["PRIME_AGENT_SOURCE_LOG"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
