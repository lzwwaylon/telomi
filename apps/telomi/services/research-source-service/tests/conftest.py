from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import AliasChoices, SecretStr

from research_source_service.app import create_app
from research_source_service.config import Settings

TOKEN = "test-source-token-123456789"


@pytest.fixture(autouse=True)
def isolated_service_environment(monkeypatch) -> None:
    """Tests supply their own settings, never a developer's cache or credentials."""
    aliases = {
        alias.casefold()
        for field in Settings.model_fields.values()
        for alias in (
            field.validation_alias.choices
            if isinstance(field.validation_alias, AliasChoices)
            else [field.validation_alias]
        )
        if isinstance(alias, str)
    }
    for name in tuple(os.environ):
        if name.upper().startswith("SOURCE_SERVICE_") or name.casefold() in aliases:
            monkeypatch.delenv(name)


def make_settings(tmp_path: Path, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "api_token": SecretStr(TOKEN),
        "workspace_roots": (tmp_path,),
        "arxiv_sqlite_path": tmp_path / "arxiv-runtime.sqlite3",
        "arxiv_min_start_interval_seconds": 0,
        "arxiv_main_site_min_start_interval_seconds": 0,
        "arxiv_global_min_start_interval_seconds": 0,
        "arxiv_overload_cooldown_seconds": 0,
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def authorization() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def client_for(
    tmp_path: Path,
    handler,
    **settings_overrides: object,
) -> TestClient:
    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport)
    app = create_app(make_settings(tmp_path, **settings_overrides), http_client)
    return TestClient(app)
