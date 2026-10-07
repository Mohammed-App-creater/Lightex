"""Tiptap / ProseMirror JSON: validation, sanitising and text extraction.

Stored content is untrusted. Only an allow-list of node and mark types survives, attributes are
filtered per type, link targets are limited to http(s) and mailto, and sizes are bounded. The
API never renders this JSON to HTML.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .exceptions import invalid

MAX_DEPTH = 24
MAX_NODES = 5000
MAX_TEXT = 20000
MAX_BYTES = 200_000

_NODE_ATTRS: dict[str, dict[str, Any]] = {
    "doc": {},
    "paragraph": {},
    "text": {},
    "heading": {"level": int},
    "bulletList": {},
    "orderedList": {"start": int},
    "listItem": {},
    "taskList": {},
    "taskItem": {"checked": bool},
    "codeBlock": {"language": str},
    "blockquote": {},
    "hardBreak": {},
    "horizontalRule": {},
    "mention": {"id": str, "label": str},
}
_MARK_ATTRS: dict[str, dict[str, Any]] = {
    "bold": {},
    "italic": {},
    "strike": {},
    "underline": {},
    "code": {},
    "link": {"href": str},
}
_SAFE_HREF = re.compile(r"^(https?://|mailto:)[^\s<>\"']+$", re.IGNORECASE)
_LANG = re.compile(r"^[A-Za-z0-9#+.-]{0,32}$")


class _Budget:
    nodes = 0


def _clean_attrs(raw: Any, allowed: dict[str, Any], node_type: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not allowed:
        return None
    out: dict[str, Any] = {}
    for key, kind in allowed.items():
        value = raw.get(key)
        if value is None:
            continue
        if kind is int and isinstance(value, int) and not isinstance(value, bool):
            if node_type == "heading":
                value = min(max(value, 1), 4)
            out[key] = max(0, min(value, 10_000))
        elif kind is bool and isinstance(value, bool):
            out[key] = value
        elif kind is str and isinstance(value, str):
            if key == "href":
                if not _SAFE_HREF.match(value.strip()):
                    continue
                value = value.strip()[:2000]
            elif key == "language":
                if not _LANG.match(value):
                    continue
            else:
                value = value[:200]
            out[key] = value
    return out or None


def _clean_marks(raw: Any) -> list[dict[str, Any]] | None:
    if not isinstance(raw, list):
        return None
    out = []
    for mark in raw[:10]:
        if not isinstance(mark, dict) or mark.get("type") not in _MARK_ATTRS:
            continue
        m: dict[str, Any] = {"type": mark["type"]}
        attrs = _clean_attrs(mark.get("attrs"), _MARK_ATTRS[mark["type"]], mark["type"])
        if mark["type"] == "link" and not attrs:
            continue  # a link without a safe href is dropped, its text is kept
        if attrs:
            m["attrs"] = attrs
        out.append(m)
    return out or None


def _clean_node(node: Any, depth: int, budget: _Budget) -> dict[str, Any] | None:
    if depth > MAX_DEPTH or not isinstance(node, dict):
        return None
    node_type = node.get("type")
    if node_type not in _NODE_ATTRS:
        return None
    budget.nodes += 1
    if budget.nodes > MAX_NODES:
        raise invalid({"body": "This document is too large."})
    out: dict[str, Any] = {"type": node_type}
    if node_type == "text":
        text = node.get("text")
        if not isinstance(text, str) or not text:
            return None
        out["text"] = text[:MAX_TEXT]
        marks = _clean_marks(node.get("marks"))
        if marks:
            out["marks"] = marks
        return out
    attrs = _clean_attrs(node.get("attrs"), _NODE_ATTRS[node_type], node_type)
    if node_type == "mention" and not (attrs and attrs.get("id")):
        return None
    if attrs:
        out["attrs"] = attrs
    content = node.get("content")
    if isinstance(content, list):
        children = [c for c in (_clean_node(child, depth + 1, budget) for child in content) if c]
        if children:
            out["content"] = children
    return out


def sanitize_doc(raw: Any, *, field: str = "description", allow_null: bool = True) -> dict[str, Any] | None:
    """Returns a cleaned document, None for null input, or raises 422."""
    if raw is None:
        if allow_null:
            return None
        raise invalid({field: "Write something first"})
    if not isinstance(raw, dict) or raw.get("type") != "doc":
        raise invalid({field: "Expected a rich-text document."})
    if len(json.dumps(raw, separators=(",", ":"))) > MAX_BYTES:
        raise invalid({field: "This document is too large."})
    cleaned = _clean_node(raw, 0, _Budget())
    return cleaned or {"type": "doc"}


def doc_text(doc: dict[str, Any] | None, *, mention_prefix: bool = True) -> str:
    """Plain text of a document (search, notification quotes, comment length checks)."""
    if not doc:
        return ""
    parts: list[str] = []

    def walk(node: dict[str, Any]) -> None:
        t = node.get("type")
        if t == "text":
            parts.append(node.get("text", ""))
        elif t == "mention":
            label = (node.get("attrs") or {}).get("label", "")
            parts.append(f"@{label}" if mention_prefix else label)
        elif t in ("hardBreak",):
            parts.append(" ")
        children = node.get("content") or []
        for child in children:
            walk(child)
        if t in ("paragraph", "heading", "listItem", "codeBlock", "blockquote", "taskItem"):
            parts.append(" ")

    walk(doc)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def mention_ids(doc: dict[str, Any] | None) -> list[str]:
    out: list[str] = []

    def walk(node: dict[str, Any]) -> None:
        if node.get("type") == "mention":
            mid = (node.get("attrs") or {}).get("id")
            if isinstance(mid, str) and mid not in out:
                out.append(mid)
        for child in node.get("content") or []:
            walk(child)

    if doc:
        walk(doc)
    return out


def plain_doc(text: str) -> dict[str, Any]:
    return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}
