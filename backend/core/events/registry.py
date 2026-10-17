"""Event type and handler registries. Modules register in their AppConfig `ready()`.

- `register_event_type(key, label, default_channels, module)` declares an event type users can be notified about. The
  notification preference matrix (keys, labels, defaults) is built from this registry.
- `register_handler(pattern, handler, module=...)` subscribes `handler(event)` to event types matching `pattern`
  (`fnmatch` syntax: `tracking.task.*`, `*`). Handlers must be idempotent: a failed dispatch is retried as a whole.
  The handler's `module` is stored so Stage 3 can skip handlers of disabled modules.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from typing import Any

Handler = Callable[[Any], None]


@dataclass(frozen=True)
class EventType:
    key: str
    label: str
    module: str
    #: Channel → on by default ("in_app", "email", "telegram", "sms", "push").
    default_channels: dict[str, bool] = field(default_factory=dict)
    #: The Telegram, SMS and Push template (templates/channels/<name>.<channel>.txt); "" = in-app and email only.
    channel_template: str = ""
    #: Shown as a row of the notification preference matrix.
    preference: bool = True
    position: int = 0


@dataclass(frozen=True)
class HandlerEntry:
    pattern: str
    handler: Handler
    module: str


_TYPES: dict[str, EventType] = {}
_HANDLERS: list[HandlerEntry] = []


def register_event_type(
    key: str,
    label: str,
    default_channels: dict[str, bool] | None = None,
    module: str | None = None,
    *,
    channel_template: str = "",
    preference: bool = True,
    position: int | None = None,
) -> EventType:
    entry = EventType(
        key=key,
        label=label,
        module=module or key.split(".", 1)[0],
        default_channels=dict(default_channels or {}),
        channel_template=channel_template,
        preference=preference,
        position=len(_TYPES) * 10 if position is None else position,
    )
    _TYPES[key] = entry
    return entry


def unregister_event_type(key: str) -> None:
    _TYPES.pop(key, None)


def event_type(key: str) -> EventType | None:
    return _TYPES.get(key)


def event_types() -> list[EventType]:
    return sorted(_TYPES.values(), key=lambda t: t.position)


def preference_types() -> list[EventType]:
    return [t for t in event_types() if t.preference]


def register_handler(pattern: str, handler: Handler, module: str) -> None:
    entry = HandlerEntry(pattern, handler, module)
    if entry not in _HANDLERS:
        _HANDLERS.append(entry)


def unregister_handler(handler: Handler) -> None:
    _HANDLERS[:] = [h for h in _HANDLERS if h.handler is not handler]


def handlers_for(event_type_key: str) -> list[HandlerEntry]:
    return [h for h in _HANDLERS if fnmatchcase(event_type_key, h.pattern)]
