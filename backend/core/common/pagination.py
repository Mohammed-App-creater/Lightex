"""Keyset (cursor) pagination producing the client's list shape: { data, nextCursor }.

The cursor is an opaque base64 token holding the sort values of the last row returned. Ordering
must end in a unique column (the primary key) and every ordered column must be non-null (use
Coalesce annotations for nullable sort fields).
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import uuid
from collections.abc import Callable, Sequence
from decimal import Decimal
from typing import Any

from django.db.models import Q, QuerySet

from .exceptions import ApiError

Order = Sequence[tuple[str, bool]]  # (field or annotation name, descending)


def _encode_value(v: Any) -> Any:
    if isinstance(v, dt.datetime | dt.date):
        return v.isoformat()
    if isinstance(v, uuid.UUID | Decimal):
        return str(v)
    return v


def encode_cursor(values: list[Any]) -> str:
    raw = json.dumps([_encode_value(v) for v in values], separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(token: str, size: int) -> list[Any]:
    try:
        padded = token + "=" * (-len(token) % 4)
        values = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(400, "invalid_cursor", "This page link is no longer valid.") from exc
    if not isinstance(values, list) or len(values) != size:
        raise ApiError(400, "invalid_cursor", "This page link is no longer valid.")
    return values


def parse_limit(raw: Any, default: int, maximum: int) -> int:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(n, maximum))


def _after(order: Order, values: list[Any]) -> Q:
    condition = Q()
    for i, (field, desc) in enumerate(order):
        step = Q(**{f"{field}__{'lt' if desc else 'gt'}": values[i]})
        for j in range(i):
            step &= Q(**{order[j][0]: values[j]})
        condition |= step
    return condition


def paginate_queryset(
    qs: QuerySet,
    params: Any,
    *,
    order: Order,
    serialize: Callable[[list[Any]], list[Any]],
    default_limit: int = 50,
    max_limit: int = 200,
) -> dict[str, Any]:
    limit = parse_limit(params.get("limit"), default_limit, max_limit)
    qs = qs.order_by(*[f"-{f}" if desc else f for f, desc in order])
    cursor = params.get("cursor")
    if cursor:
        qs = qs.filter(_after(order, decode_cursor(cursor, len(order))))
    rows = list(qs[: limit + 1])
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        next_cursor = encode_cursor([getattr(last, f) for f, _ in order])
    return {"data": serialize(rows), "nextCursor": next_cursor}


def paginate_list(items: list[Any], params: Any, *, default_limit: int = 50, max_limit: int = 200) -> dict[str, Any]:
    """For small, already-materialised lists (computed feeds). Cursor is an opaque offset."""
    limit = parse_limit(params.get("limit"), default_limit, max_limit)
    offset = 0
    if params.get("cursor"):
        values = decode_cursor(params["cursor"], 1)
        offset = values[0] if isinstance(values[0], int) and values[0] >= 0 else 0
    page = items[offset : offset + limit]
    nxt = encode_cursor([offset + limit]) if offset + limit < len(items) else None
    return {"data": page, "nextCursor": nxt}
