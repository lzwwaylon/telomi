from __future__ import annotations

import importlib
import pkgutil
from functools import cache

from .base import SourceSpec


@cache
def discover_specs() -> tuple[SourceSpec, ...]:
    """收集 `sources/` 下每个模块的 `SPECS`，按 id 排序；同一 id 登记两次是编程错误。"""
    package = __name__.rsplit(".", 1)[0]
    specs: dict[str, SourceSpec] = {}
    for module_info in pkgutil.iter_modules(importlib.import_module(package).__path__):
        module = importlib.import_module(f"{package}.{module_info.name}")
        for spec in getattr(module, "SPECS", ()):
            if spec.id in specs:
                raise RuntimeError(f"research source '{spec.id}' is registered twice")
            specs[spec.id] = spec
    return tuple(specs[source_id] for source_id in sorted(specs))
