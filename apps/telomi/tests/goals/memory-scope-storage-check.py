"""Native PostgreSQL scope and curation regression checks. No models or external services."""
import asyncio
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "hindsight"))
os.environ.setdefault("HINDSIGHT_API_EMBEDDINGS_MAX_INPUT_TOKENS", "")

import pg0
from hindsight_api import MemoryEngine
from hindsight_api.config import get_config
from hindsight_api.engine.db.postgresql import PostgreSQLBackend
from hindsight_api.engine.memories.pg import writes
from hindsight_api.engine.schema import fq_table
from hindsight_api.migrations import ensure_embedding_dimension, run_migrations
from hindsight_api.models import RequestContext
from hindsight_api.pg0 import EmbeddedPostgres

import telomi_memory_scope as scope

GOAL = ["goal:a"]
GLOBAL = ["goal:a", "scope:global"]
BANK = "scope-bank"
DOC = "pi-task-scope"


async def document(conn, doc=DOC, bank=BANK, tags=GOAL):
    await conn.execute("INSERT INTO documents (id, bank_id, tags) VALUES ($1, $2, $3)", doc, bank, tags)


async def fact(conn, doc=DOC, bank=BANK, tags=GOAL, fact_type="world", sources=None):
    identity = uuid.uuid4()
    await conn.execute("""INSERT INTO memory_units
        (id, bank_id, document_id, text, event_date, fact_type, tags, embedding, source_memory_ids)
        VALUES ($1, $2, $3, 'A remembered statement', now(), $4, $5, '[0.1,0.2,0.3,0.4]', $6)""",
                       identity, bank, doc, fact_type, tags, sources)
    return identity


async def invalidate(conn, identity, bank=BANK):
    assert await writes.invalidate_memory(conn=conn, fq_table=fq_table, bank_id=bank, unit_id=str(identity), reason="Not current")


async def restore(conn, identity, bank=BANK):
    assert await writes.restore_memory(conn=conn, fq_table=fq_table, bank_id=bank, unit_id=str(identity)) is not None


async def unit_tags(conn, identity, table="memory_units"):
    return await conn.fetchval(f"SELECT tags FROM {table} WHERE id = $1", identity)


async def wait_blocked(backend, pid):
    async with backend.acquire() as conn:
        for _ in range(300):
            if await conn.fetchval("SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = $1", pid):
                return
            await asyncio.sleep(.01)
    raise AssertionError("competing transaction did not block on the document scope lock")


async def race(backend, moving_first, archived):
    doc = f"pi-task-race-{moving_first}-{archived}"
    async with backend.acquire() as conn:
        async with conn.transaction():
            await document(conn, doc)
            identity = await fact(conn, doc)
            if archived:
                await invalidate(conn, identity)
    move = restore if archived else invalidate
    destination = "memory_units" if archived else "invalidated_memory_units"
    async with backend.acquire() as first, backend.acquire() as second:
        pid = await second.fetchval("SELECT pg_backend_pid()")

        async def retag(conn):
            # The native update_document transaction updates the document before its live units.
            await conn.execute("UPDATE documents SET tags = $1 WHERE id = $2 AND bank_id = $3", GLOBAL, doc, BANK)
            await conn.execute("UPDATE memory_units SET tags = $1 WHERE document_id = $2 AND bank_id = $3", GLOBAL, doc, BANK)

        async def competing():
            async with second.transaction():
                if moving_first:
                    await retag(second)
                else:
                    await move(second, identity)

        task = None
        try:
            async with first.transaction():
                if moving_first:
                    await move(first, identity)
                else:
                    await retag(first)
                task = asyncio.create_task(competing())
                await wait_blocked(backend, pid)
                assert not task.done(), "the concurrent write cannot pass the owning document transaction"
            await asyncio.wait_for(task, 10)
        finally:
            if task and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert await unit_tags(first, identity, destination) == GLOBAL


async def check(url):
    backend = PostgreSQLBackend()
    await backend.initialize(url, min_size=1, max_size=6)
    memory = object.__new__(MemoryEngine)
    memory._backend = backend
    memory._initialized = True
    memory._operation_validator = None
    memory._bank_stats_cache = SimpleNamespace(invalidate=AsyncMock())
    memory._config_resolver = SimpleNamespace(resolve_full_config=AsyncMock(return_value=SimpleNamespace(enable_auto_consolidation=False)))
    memory.submit_async_graph_maintenance = AsyncMock()
    context = RequestContext(internal=True)
    try:
        async with backend.acquire() as conn:
            await conn.execute("INSERT INTO banks (bank_id) VALUES ($1), ($2)", BANK, "another-bank")
            async with conn.transaction():
                await document(conn, tags=GLOBAL)
                live = await fact(conn)
                retired = await fact(conn)
                await invalidate(conn, retired)
                observation = await fact(conn, doc=None, fact_type="observation", sources=[live])
                await document(conn, bank="another-bank", tags=["goal:b"])
                foreign = await fact(conn, bank="another-bank", tags=["goal:b"])
                await invalidate(conn, foreign, "another-bank")
                foreign_live = await fact(conn, bank="another-bank", tags=["goal:b"])
                await document(conn, doc="custom-document", tags=["item:a", "item:b"])
                custom = await fact(conn, doc="custom-document", tags=["item:a"])
                custom_retired = await fact(conn, doc="custom-document", tags=["item:b"])
                await invalidate(conn, custom_retired)
                loose = await fact(conn, doc=None, tags=["independent"])
                unrelated_observation = await fact(conn, fact_type="observation", tags=["derived-scope"])

        await scope.install_scope_integrity(memory)
        async with backend.acquire() as conn:
            assert await unit_tags(conn, live) == GLOBAL, "repair previously restored Facts through native retag"
            assert await unit_tags(conn, retired, "invalidated_memory_units") == GLOBAL
            assert await unit_tags(conn, foreign, "invalidated_memory_units") == ["goal:b"]
            assert await unit_tags(conn, foreign_live) == ["goal:b"], "native repair must not retag another bank's identical document ID"
            assert await unit_tags(conn, observation) is None, "native repair removes observations derived under stale scope"
            assert await unit_tags(conn, custom) == ["item:a"]
            assert await unit_tags(conn, custom_retired, "invalidated_memory_units") == ["item:b"]
            assert await unit_tags(conn, loose) == ["independent"]
            # Native repair retags all document units; test insert-trigger exclusion on a separate observation below.
            await conn.execute("UPDATE memory_units SET tags = $1 WHERE id = $2", ["derived-scope"], unrelated_observation)
            extra_observation = await fact(conn, fact_type="observation", tags=["own-derived-scope"])
            assert await unit_tags(conn, extra_observation) == ["own-derived-scope"]
            inserted = await fact(conn, tags=["stale"])
            assert await unit_tags(conn, inserted) == GLOBAL

        await scope.install_scope_integrity(memory)
        async with backend.acquire() as conn:
            assert await unit_tags(conn, unrelated_observation) == ["derived-scope"], "idempotent installer skips observations"
            assert await unit_tags(conn, extra_observation) == ["own-derived-scope"]
        assert await memory.update_document(DOC, BANK, tags=GOAL, request_context=context)
        async with backend.acquire() as conn:
            assert await unit_tags(conn, retired, "invalidated_memory_units") == GOAL
            assert await unit_tags(conn, foreign, "invalidated_memory_units") == ["goal:b"]
            assert await unit_tags(conn, foreign_live) == ["goal:b"]
            async with conn.transaction():
                await restore(conn, retired)
            assert await unit_tags(conn, retired) == GOAL
            async with conn.transaction():
                await invalidate(conn, retired)
        assert await memory.update_document(DOC, BANK, tags=GLOBAL, request_context=context)
        async with backend.acquire() as conn:
            assert await unit_tags(conn, retired, "invalidated_memory_units") == GLOBAL
            assert await unit_tags(conn, foreign_live) == ["goal:b"]
            async with conn.transaction():
                await restore(conn, retired)
            assert await unit_tags(conn, retired) == GLOBAL
            async with conn.transaction():
                await invalidate(conn, retired)
        for moving_first in (True, False):
            for archived in (True, False):
                await race(backend, moving_first, archived)

        await memory.delete_document(DOC, BANK, request_context=context)
        async with backend.acquire() as conn:
            assert await unit_tags(conn, retired, "invalidated_memory_units") is None, "native document deletion cascades into the archive"
            assert await unit_tags(conn, foreign, "invalidated_memory_units") == ["goal:b"]
        with patch.object(scope, "get_config", return_value=SimpleNamespace(database_backend="oracle")):
            await scope.install_scope_integrity(None)
        with patch.object(scope, "get_memories", return_value=SimpleNamespace(writes_memory_rows_in_sql=False)):
            await scope.install_scope_integrity(None)
        print("memory scope storage check passed")
    finally:
        await backend.shutdown()


def main():
    name = f"telomi-scope-check-{os.getpid()}"
    server = EmbeddedPostgres(name=name)
    url = asyncio.run(server.start())
    try:
        run_migrations(url)
        ensure_embedding_dimension(url, 4)
        asyncio.run(check(url))
    finally:
        asyncio.run(server.stop())
        pg0.drop(name)


if __name__ == "__main__":
    main()
