"""Deterministic native ASGI/worker admission check. No models or database calls."""
import asyncio
import os
from pathlib import Path
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "hindsight"))
import telomi_configuration as boundary
from fastapi import FastAPI
import httpx


async def check():
    os.environ["TELOMI_MEMORY_CONTROL_TOKEN"] = "local-test"
    entered = asyncio.Event()
    finish = asyncio.Event()
    app = FastAPI()
    app.include_router(boundary.ConfigurationBoundary({}).get_router(None), prefix="/ext")

    @app.post("/operation")
    async def operation():
        entered.set()
        await finish.wait()
        return {"preserved": True}

    transport = httpx.ASGITransport(app=boundary.AdmissionBoundary(app))
    async with httpx.AsyncClient(transport=transport, base_url="http://local") as client:
        async def control(action):
            response = await client.post(f"/ext/telomi-configuration/{action}", headers={"authorization": "Bearer local-test"})
            assert response.status_code == 200
            return response.json()

        assert (await client.post("/ext/telomi-configuration/drain")).status_code == 401
        running = asyncio.create_task(client.post("/operation"))
        await entered.wait()
        assert (await control("drain"))["activeOperations"] == 1
        assert (await client.post("/operation")).status_code == 503
        finish.set()
        assert (await running).json() == {"preserved": True}
        assert (await control("status"))["activeOperations"] == 0
        await control("resume")

        entered.clear()
        finish.clear()

        async def native_execution(self, task):
            entered.set()
            await finish.wait()
            return task["type"]

        # Substitute the external native executor, exercising the public worker entrypoint.
        with patch.object(boundary.MemoryEngine, "execute_task", native_execution):
            memory = object.__new__(boundary.ManagedMemoryEngine)
            running = asyncio.create_task(memory.execute_task({"type": "consolidation"}))
            await entered.wait()
            assert (await control("drain"))["activeOperations"] == 1
            try:
                await memory.execute_task({"type": "graph_maintenance"})
                raise AssertionError("new worker work was admitted during drain")
            except boundary.DeferOperation:
                pass
            finish.set()
            assert await running == "consolidation"
            assert (await control("status"))["activeOperations"] == 0
            await control("resume")
            assert await memory.execute_task({"type": "import_documents"}) == "import_documents"
    # The real application factory must accept the boundary; an engine stub keeps this offline.
    native = boundary.build_app(MagicMock())
    assert "/health" in {getattr(route, "path", None) for route in native.routes}
    print("native HTTP and worker admission passed")


asyncio.run(check())
