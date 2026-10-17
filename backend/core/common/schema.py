"""Small helpers for OpenAPI response shapes (drf-spectacular) of views that build their payloads by hand.

`shape("TrashItem", {...})` returns a Serializer class whose component name is exactly `TrashItem`; use it once per
name (a second class with the same name is a component collision) and instantiate it as needed (`TrashItem()`,
`TrashItem(many=True)`). `page_of("AuditPage", AuditEntry)` is the client's list shape `{ data, nextCursor }`.
"""

from __future__ import annotations

from typing import Any

from rest_framework import serializers


def shape(name: str, fields: dict[str, Any], doc: str = "") -> type[serializers.Serializer]:
    return type(f"{name}Serializer", (serializers.Serializer,), {**fields, "__doc__": doc or None})


def page_of(name: str, item: type[serializers.Serializer], **extra: Any) -> type[serializers.Serializer]:
    return shape(name, {"data": item(many=True), "nextCursor": serializers.CharField(allow_null=True), **extra})


def api_paths_only(endpoints: list[Any]) -> list[Any]:
    """drf-spectacular preprocessing hook: document the API under /api/v1 only (not the root /health probe)."""
    return [e for e in endpoints if e[0].startswith("/api/v1/")]
