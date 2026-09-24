"""Deterministic lifecycle check of the managed User Memory database. No models, network or real database."""
import os
from pathlib import Path
import signal
import sys
import threading
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "hindsight"))
import telomi_configuration as service
import telomi_database


class FakeDatabase:
    stopped = False

    def stop(self):
        FakeDatabase.stopped = True


def reused_instance_is_owned():
    os.environ["TELOMI_MEMORY_DATABASE_DIR"] = "/data/user-memory/postgres"
    running = MagicMock(running=True, data_dir="/data/user-memory/postgres", uri="postgresql://reused")
    with patch.object(telomi_database, "Pg0") as pg0:
        pg0.return_value.info.return_value = running
        url, database = telomi_database.start_managed_database("pg0://telomi-test:5432")
    assert url == "postgresql://reused"
    assert database is pg0.return_value, "a reused instance must still be stopped with the service"
    pg0.return_value.start.assert_not_called()


async def app(scope, receive, send):
    if scope["type"] != "lifespan":
        return
    while True:
        message = await receive()
        if message["type"] == "lifespan.startup":
            await send({"type": "lifespan.startup.complete"})
        elif message["type"] == "lifespan.shutdown":
            await send({"type": "lifespan.shutdown.complete"})
            return


def sigterm_stops_database():
    config = MagicMock(log_level="warning", run_migrations_on_startup=False)
    # A SIGTERM like the one Telomi sends on shutdown, once uvicorn is serving.
    threading.Timer(1.0, os.kill, (os.getpid(), signal.SIGTERM)).start()
    with patch.object(sys, "argv", ["telomi_configuration.py", "--host", "127.0.0.1", "--port", "0"]), \
            patch.object(service, "start_managed_database", return_value=("postgresql://fake", FakeDatabase())), \
            patch.object(service, "get_config", return_value=config), \
            patch.object(service, "load_extension", return_value=None), \
            patch.object(service, "ManagedMemoryEngine"), \
            patch.object(service, "build_app", return_value=app):
        try:
            service.main()
        except SystemExit:
            pass
    assert FakeDatabase.stopped, "SIGTERM must stop the managed database"


reused_instance_is_owned()
sigterm_stops_database()
print("ok")
