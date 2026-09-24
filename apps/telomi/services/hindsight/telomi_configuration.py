"""Hindsight's native application with an admission boundary for safe replacement."""
import argparse
import contextvars
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import os

from fastapi import APIRouter, Header, HTTPException
from hindsight_api import MemoryEngine
from hindsight_api.api.http import create_app
from hindsight_api.config import get_config
from hindsight_api.extensions import load_extension, DefaultExtensionContext
from hindsight_api.extensions.http import HttpExtension
from hindsight_api.extensions.operation_validator import OperationValidatorExtension
from hindsight_api.extensions.tenant import TenantExtension
from hindsight_api.worker.exceptions import DeferOperation
import uvicorn

_draining = False
_active = 0
_admitted = contextvars.ContextVar("telomi_memory_admitted", default=False)


@asynccontextmanager
async def admitted():
    global _active
    token = _admitted.set(True)
    _active += 1
    try:
        yield
    finally:
        _active -= 1
        _admitted.reset(token)


class ManagedMemoryEngine(MemoryEngine):
    async def execute_task(self, task_dict):
        # Covers consolidation, graph maintenance and imports as well as retain.
        # Native validator hooks do not cover every worker operation.
        if _draining and not _admitted.get():
            raise DeferOperation(
                datetime.now(timezone.utc) + timedelta(milliseconds=get_config().worker_poll_interval_ms),
                "User Memory configuration is applying",
            )
        async with admitted():
            return await super().execute_task(task_dict)


class AdmissionBoundary:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"].startswith(("/ext/telomi-configuration/", "/health")):
            return await self.app(scope, receive, send)
        if _draining:
            await send({"type": "http.response.start", "status": 503, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": b'{"error":"User Memory configuration is applying; retry shortly"}'})
            return
        async with admitted():
            await self.app(scope, receive, send)


class ConfigurationBoundary(HttpExtension):
    def get_router(self, memory):
        router = APIRouter()

        @router.post("/telomi-configuration/{action}")
        async def boundary(action: str, authorization: str = Header(default="")):
            global _draining
            if authorization != f"Bearer {os.environ['TELOMI_MEMORY_CONTROL_TOKEN']}":
                raise HTTPException(status_code=401)
            if action == "drain":
                _draining = True
            elif action == "resume":
                _draining = False
            elif action != "status":
                raise HTTPException(status_code=404)
            return {"draining": _draining, "activeOperations": _active}

        return router


def build_app(memory):
    # The HTTP application accepts the boundary directly; the umbrella
    # `hindsight_api.api.create_app` does not, and Telomi never mounts MCP.
    return create_app(memory=memory, initialize_memory=True, http_extension=ConfigurationBoundary({}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    config = get_config()
    config.configure_logging()
    tenant = load_extension("TENANT", TenantExtension)
    memory = ManagedMemoryEngine(
        operation_validator=load_extension("OPERATION_VALIDATOR", OperationValidatorExtension),
        tenant_extension=tenant,
        run_migrations=config.run_migrations_on_startup,
    )
    if tenant:
        tenant.set_context(DefaultExtensionContext(database_url=config.database_url, memory_engine=memory))
    app = build_app(memory)
    # Same graceful shutdown budget as hindsight-api; replacements drain before signaling.
    uvicorn.run(AdmissionBoundary(app), host=args.host, port=args.port, log_level=config.log_level,
                timeout_graceful_shutdown=5, timeout_keep_alive=30, ws="wsproto")


if __name__ == "__main__":
    main()
