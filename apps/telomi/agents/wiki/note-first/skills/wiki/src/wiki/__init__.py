"""Task-local Wiki API. Data is staged read-only; no process or network bridge."""
import json
import unicodedata
from functools import lru_cache
from pathlib import Path

# Match String.trim() from the original TypeScript API, not Python's broader strip().
_JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


@lru_cache(maxsize=1)
def _data():
    return json.loads((Path(__file__).resolve().parents[2] / "dataset.json").read_text())


def _normalize(value):
    return unicodedata.normalize("NFKC", value).lower()


def _term(value):
    if not isinstance(value, str) or not value.strip(_JS_WHITESPACE) or len(value) > 200:
        raise ValueError("Wiki search: each query or term must be non-empty text of at most 200 codepoints")
    return _normalize(value)


def _excerpt(value, needles):
    normalized = _normalize(value)
    positions = [normalized.find(needle) for needle in needles if needle in normalized]
    hit = min(positions) if positions else 0
    # Map a normalized offset back to original text, preserving spelling and casing.
    low, high = 0, len(value)
    while low < high:
        mid = (low + high + 1) // 2
        if len(_normalize(value[:mid])) <= hit:
            low = mid
        else:
            high = mid - 1
    start = max(0, low - 60)
    return value[start:start + 240]


def search(query=None, *, terms=None, mode="any", scope="all", kind=None, page_ref=None, offset=0, limit=12) -> dict:
    """Discover exact phrases with explicit any/all semantics; excerpts are not full reads."""
    if (query is None) == (terms is None):
        raise ValueError("Wiki search: provide exactly one of query or terms")
    if terms is not None and (not isinstance(terms, list) or not 1 <= len(terms) <= 12):
        raise ValueError("Wiki search: terms must contain 1 to 12 phrases")
    needles = list(dict.fromkeys([_term(query)] if query is not None else [_term(value) for value in terms]))
    if mode not in ("any", "all"):
        raise ValueError("Wiki search: mode must be any or all")
    if scope not in ("all", "body"):
        raise ValueError("Wiki search: scope must be all or body")
    if type(offset) is not int or not 0 <= offset <= 9007199254740991:
        raise ValueError("Wiki search: offset must be a non-negative safe integer")
    if type(limit) is not int or not 1 <= limit <= 40:
        raise ValueError("Wiki search: limit must be an integer from 1 to 40")
    if kind is not None and kind not in ("entity", "concept"):
        raise ValueError("Wiki search: kind must be entity or concept")
    rows = _data()["search_rows"]
    if page_ref is not None and (not isinstance(page_ref, str) or not any(row["page_ref"] == page_ref for row in rows)):
        raise ValueError("Wiki search: unknown page_ref")
    matches = []
    # ponytail: linear scan is sufficient here; index when measured corpus growth warrants it.
    for row in rows:
        if kind is not None and row["kind"] != kind or page_ref is not None and row["page_ref"] != page_ref:
            continue
        fields = [("body", row["body"])] if scope == "body" else [
            ("title", row["title"]), ("description", row["description"]),
            ("heading", row["heading"]), ("body", row["body"]),
            *[("source", value) for value in row["source_titles"]],
        ]
        normalized = [(field, _normalize(value)) for field, value in fields]
        matched_terms = [needle for needle in needles if any(needle in value for _, value in normalized)]
        if not matched_terms or mode == "all" and len(matched_terms) != len(needles):
            continue
        matched_fields = list(dict.fromkeys(field for field, value in normalized if any(needle in value for needle in needles)))
        hit_fields = [(field, value) for field, value in fields if any(needle in _normalize(value) for needle in matched_terms)]
        snippet_value = next((value for field, value in hit_fields if field == "body"), hit_fields[0][1])
        matches.append({"section_ref": row["section_ref"], "page_ref": row["page_ref"], "title": row["title"], "heading": row["heading"],
                        "matched_fields": matched_fields, "matched_terms": matched_terms, "snippet": _excerpt(snippet_value, matched_terms)})
    return {"total": len(matches), "offset": offset, "limit": limit,
            "next_offset": offset + limit if offset + limit < len(matches) else None, "matches": matches[offset:offset + limit]}


def read(ref: str) -> str:
    """Return canonical page, section or evidence text. Print it to establish delivery."""
    if not isinstance(ref, str) or ref not in _data()["reads"]:
        raise ValueError(f"Note-first output: unknown read reference {ref}")
    return _data()["reads"][ref]


def overview(ref: str) -> dict:
    """Return page metadata, chapters and directed relations; this is not a body read."""
    if not isinstance(ref, str) or ref not in _data()["overviews"]:
        raise ValueError(f"Wiki overview: expected an available P alias, received {ref}")
    # Return an independent value so in-kernel edits cannot change later navigation.
    return json.loads(json.dumps(_data()["overviews"][ref]))
