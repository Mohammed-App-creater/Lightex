"""Domain events (outbox). Services call emit(); the notification pipeline consumes the events."""

from __future__ import annotations

from typing import Any


def emit(
    event_type: str, *, workspace: Any, actor: Any = None, project: Any = None, payload: dict | None = None
) -> None:
    """Recorded by the outbox once the notifications app lands (phase 9)."""
    return None
