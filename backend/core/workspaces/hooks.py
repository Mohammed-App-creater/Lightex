"""Workspace lifecycle hooks modules register in AppConfig.ready().

- `register_member_removed(fn)`: `fn(workspace, user_id)` runs inside `remove_member()`'s transaction, before the
  membership row is deleted (tracking drops project memberships and personal dashboards).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

MemberRemoved = Callable[[Any, Any], None]
_MEMBER_REMOVED: list[MemberRemoved] = []


def register_member_removed(fn: MemberRemoved) -> None:
    if fn not in _MEMBER_REMOVED:
        _MEMBER_REMOVED.append(fn)


def member_removed(workspace: Any, user_id: Any) -> None:
    for fn in _MEMBER_REMOVED:
        fn(workspace, user_id)
