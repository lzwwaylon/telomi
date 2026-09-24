"""Keeps the embedded User Memory database inside Telomi's data directory.

Hindsight resolves a ``pg0://`` URL by starting pg0 under ``~/.pg0/instances``. Telomi starts the
same instance itself with ``TELOMI_MEMORY_DATABASE_DIR`` as its data directory and hands Hindsight
the resolved ``postgresql://`` URL, so a copy of the stopped data directory is a complete backup.
"""
import os
import time

from hindsight_api.pg0 import DEFAULT_DATABASE, DEFAULT_PASSWORD, DEFAULT_USERNAME, parse_pg0_url
from pg0 import Pg0

START_ATTEMPTS = 3


def start_managed_database(url: str) -> tuple[str, Pg0 | None]:
    """The URL Hindsight should use, and the instance to stop on exit when this call started it."""
    data_dir = os.environ.get("TELOMI_MEMORY_DATABASE_DIR", "").strip()
    parsed = parse_pg0_url(url)
    if not parsed.is_pg0 or not data_dir:
        return url, None
    database = Pg0(
        name=parsed.instance_name,
        port=parsed.port,
        username=DEFAULT_USERNAME if parsed.username is None else parsed.username,
        password=DEFAULT_PASSWORD if parsed.password is None else parsed.password,
        database=DEFAULT_DATABASE,
        data_dir=data_dir,
    )
    info = database.info()
    if info.running:
        # An instance left running by an earlier process is reused, but never one serving other files.
        if not info.data_dir or os.path.realpath(info.data_dir) != os.path.realpath(data_dir):
            raise RuntimeError(
                f"pg0 instance {parsed.instance_name} is running from {info.data_dir}, not {data_dir}; stop it first"
            )
        return info.uri, None
    os.makedirs(os.path.dirname(data_dir), exist_ok=True)
    for attempt in range(1, START_ATTEMPTS + 1):
        try:
            return database.start().uri, database
        except Exception:
            # Same tolerance as Hindsight's own embedded start: a just-released port can still be in use.
            if attempt == START_ATTEMPTS:
                raise
            time.sleep(2 * attempt)
    raise AssertionError("unreachable")
