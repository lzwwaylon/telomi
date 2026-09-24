#!/usr/bin/env python3
"""Render one Provider module's public API as deterministic Markdown."""

from __future__ import annotations

import argparse
import importlib
import inspect
import re
from types import ModuleType
from typing import Any, get_type_hints, is_typeddict


MODULE_NAME = re.compile(r"^tools\.[a-z][a-z0-9_]*$")


def render(module_name: str) -> str:
    if not MODULE_NAME.fullmatch(module_name):
        raise ValueError("module must be a tools.<provider> module")
    module = importlib.import_module(module_name)
    exports = _exports(module)
    lines = [
        f"# {module_name.removeprefix('tools.')} Provider API",
        "",
        f"Generated from `{module_name}.__all__`, Python signatures, and docstrings.",
        "The Python module is authoritative; do not edit this reference manually.",
        "",
    ]
    for name in exports:
        value = getattr(module, name)
        lines.extend([f"## `{name}`", "", _declaration(name, value), ""])
        if is_typeddict(value):
            required = value.__required_keys__
            lines.extend(["### Fields", ""])
            for field, annotation in get_type_hints(value).items():
                status = "required" if field in required else "optional"
                lines.append(f"- `{field}: {inspect.formatannotation(annotation)}` ({status})")
            lines.append("")
            continue
        documentation = inspect.getdoc(value)
        if documentation:
            lines.extend(["### Documentation", "", *[f"    {line}" if line else "" for line in documentation.splitlines()], ""])
    return "\n".join(lines)


def _exports(module: ModuleType) -> list[str]:
    exports = getattr(module, "__all__", None)
    if not isinstance(exports, list) or any(not isinstance(name, str) or not name for name in exports):
        raise ValueError(f"{module.__name__}.__all__ must be a list of names")
    if len(exports) != len(set(exports)):
        raise ValueError(f"{module.__name__}.__all__ contains duplicate names")
    missing = [name for name in exports if not hasattr(module, name)]
    if missing:
        raise ValueError(f"{module.__name__} is missing exports: {', '.join(missing)}")
    return exports


def _declaration(name: str, value: Any) -> str:
    if inspect.isclass(value):
        return f"Class: `{name}`"
    if callable(value):
        try:
            signature = inspect.signature(value)
        except (TypeError, ValueError):
            signature = "(...)"
        return f"Signature: `{name}{signature}`"
    return f"Value: `{name}`"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("module")
    print(render(parser.parse_args().module), end="")
