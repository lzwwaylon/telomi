import os
from typing import Optional


def audio_env(key: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(key, default)
