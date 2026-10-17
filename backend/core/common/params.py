"""Query-string helpers for the client's conventions: filter[field]=v (repeatable), sort, q, cursor."""

from __future__ import annotations

from typing import Any

from rest_framework.request import Request


def filter_values(request: Request, key: str) -> list[str]:
    return [v for v in request.query_params.getlist(f"filter[{key}]") if v != ""]


def filter_value(request: Request, key: str, default: str | None = None) -> str | None:
    values = filter_values(request, key)
    return values[0] if values else default


def body(request: Request) -> dict[str, Any]:
    data = request.data
    return data if isinstance(data, dict) else {}
