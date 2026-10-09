"""The SSE stream body (docs/v2/33-dashboards-presence.md §2.3, §2.5, §2.6).

`stream_events()` is the generator behind `GET /workspaces/:slug/stream`:

1. **Prelude.** Subscribe (so nothing committed from now on is missed), write `retry`, `hello` and the replay after
   `Last-Event-ID`, then close the thread's database connection: an idle stream holds none.
2. **Loop.** Wait on the subscription queue for up to `SSE_HEARTBEAT_SECONDS`; write `: ping` after that much
   silence, otherwise the event. Durable events already sent by the replay are skipped.
3. **End** with `reconnect` on lifetime (`SSE_MAX_LIFETIME_SECONDS` plus jitter), token expiry (less than 30 s left),
   `access.changed` for this user, or process shutdown. A full queue ends with `reset` (`slow_consumer`) and
   `reconnect`. The slot and the subscription are released in `finally`.
"""

from __future__ import annotations

import queue
import random
import secrets
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from django.conf import settings
from django.db import connection
from django.db.models import Q
from django.utils import timezone

from apps.access import services as access
from apps.common.utils import iso

from .hub import WAKE, Slot, hub
from .models import RealtimeEvent
from .protocol import TARGET, VOLATILE_TYPES, control, frame, ping, retry

TOKEN_MARGIN_SECONDS = 30
RETRY_AFTER_RECONNECT_MS = 500
RETRY_AFTER_OVERFLOW_MS = 1000


@dataclass
class StreamContext:
    workspace_id: str
    user_id: str
    project_ids: frozenset[str]
    token_exp: float | None
    last_event_id: str | None
    slot: Slot
    connection_id: str = field(default_factory=lambda: f"c_{secrets.token_hex(4)}")


def visible_project_ids(user: Any, workspace: Any) -> frozenset[str]:
    """Projects of the workspace where the user has `project.view` (archived included, soft-deleted excluded)."""
    from apps.projects.models import ProjectMember

    ids = list(
        ProjectMember.objects.filter(
            user_id=user.pk, project__workspace=workspace, project__deleted_at__isnull=True
        ).values_list("project_id", flat=True)
    )
    perms = access.prefetch_project_permissions(user, ids)
    return frozenset(str(pid) for pid, codes in perms.items() if "project.view" in codes)


def _row_event(row: RealtimeEvent) -> dict[str, Any]:
    return {**row.payload, "id": str(row.pk), TARGET: str(row.user_id) if row.user_id else None}


def replay(ctx: StreamContext) -> tuple[list[dict[str, Any]], str | None]:
    """Retained durable events after the cursor that match the connection, or a `reset` reason (§2.6)."""
    raw = ctx.last_event_id
    if raw is None:
        return [], None
    if not raw.isdigit():
        return [], "unknown_cursor"
    cursor = int(raw)
    with connection.cursor() as c:
        c.execute(
            "SELECT (SELECT MIN(id) FROM realtime_realtimeevent), "
            "COALESCE(pg_sequence_last_value(pg_get_serial_sequence('realtime_realtimeevent', 'id')), 0)"
        )
        oldest, last = c.fetchone()
    if oldest is None:
        oldest = last + 1
    if cursor < oldest - 1 or cursor > last:
        return [], "unknown_cursor"
    limit = settings.REALTIME_REPLAY_LIMIT
    rows = list(
        RealtimeEvent.objects.filter(workspace_id=ctx.workspace_id, id__gt=cursor)
        .exclude(type__in=VOLATILE_TYPES)
        .filter(Q(user_id=ctx.user_id) | Q(user__isnull=True, project_id__in=list(ctx.project_ids)))
        .order_by("id")[: limit + 1]
    )
    if len(rows) > limit:
        return [], "gap"
    return [_row_event(r) for r in rows], None


def _reconnect(reason: str, retry_ms: int) -> bytes:
    return frame(control("reconnect", {"reason": reason, "retryMs": retry_ms}))


def stream_events(ctx: StreamContext) -> Iterator[bytes]:
    sub = None
    try:
        sub = hub.subscribe(ctx.workspace_id, ctx.project_ids, ctx.user_id)
        events, reset_reason = replay(ctx)
        heartbeat = settings.SSE_HEARTBEAT_SECONDS
        lifetime = settings.SSE_MAX_LIFETIME_SECONDS + random.uniform(0, settings.SSE_LIFETIME_JITTER_SECONDS)  # noqa: S311
        hello = {
            "connectionId": ctx.connection_id,
            "serverTime": iso(timezone.now()),
            "heartbeatSec": heartbeat,
            "maxLifetimeSec": settings.SSE_MAX_LIFETIME_SECONDS,
            "projects": sorted(ctx.project_ids),
            "replayed": len(events),
        }
        if sub.degraded:
            hello["degraded"] = True
        yield retry() + frame(control("hello", hello))
        if reset_reason:
            yield frame(control("reset", {"reason": reset_reason}))
        last_sent = 0
        written = 0
        max_events = settings.SSE_TEST_MAX_EVENTS
        for event in events:
            last_sent = int(event["id"])
            written += 1
            yield frame(event)
        if not connection.in_atomic_block:
            connection.close()  # idle streams hold no database connection
        started = last_write = time.monotonic()

        while True:
            if max_events is not None and written >= max_events:
                return
            now = time.monotonic()
            reason = None
            if hub.closing:
                yield _reconnect("shutdown", secrets.choice(range(1000, 5001)))
                return
            if now - started >= lifetime:
                reason = "lifetime"
            elif ctx.token_exp is not None and ctx.token_exp - time.time() < TOKEN_MARGIN_SECONDS:
                reason = "token_expiry"
            if reason:
                yield _reconnect(reason, RETRY_AFTER_RECONNECT_MS)
                return
            if sub.overflowed:
                # The protocol's reconnect reasons are fixed (§2.4); the reset says why.
                yield frame(control("reset", {"reason": "slow_consumer"})) + _reconnect(
                    "lifetime", RETRY_AFTER_OVERFLOW_MS
                )
                return
            while sub.controls:
                yield frame(sub.controls.popleft())
                last_write = time.monotonic()
            wait = min(heartbeat - (now - last_write), lifetime - (now - started))
            if ctx.token_exp is not None:
                wait = min(wait, ctx.token_exp - TOKEN_MARGIN_SECONDS - time.time())
            try:
                item = sub.queue.get(timeout=max(0.001, wait))
            except queue.Empty:
                if time.monotonic() - last_write >= heartbeat:
                    yield ping()
                    last_write = time.monotonic()
                continue
            if item is WAKE or sub.overflowed:
                continue
            if item.get("id") is not None:
                if int(item["id"]) <= last_sent:
                    continue  # already sent by the replay
                last_sent = int(item["id"])
            yield frame(item)
            written += 1
            last_write = time.monotonic()
            if item.get("type") == "access.changed" and item.get(TARGET) == ctx.user_id:
                yield _reconnect("access_changed", RETRY_AFTER_RECONNECT_MS)
                return
    finally:
        if sub is not None:
            hub.unsubscribe(sub)
        ctx.slot.release()
