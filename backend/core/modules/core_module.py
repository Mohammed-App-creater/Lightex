"""Core's own module definition: the `core.*` permissions, core's notification event types and the default roles.

Core is always on and has no `WorkspaceModule` row.
"""

from __future__ import annotations

from typing import Any

from core.access.catalogue import CORE, CORE_PERMISSIONS

from .registry import EventTypeDef, ModuleDefinition


def _first(name: Any) -> str:
    return str(name or "").split(" ")[0]


def _comment_line(verb: str):
    def line(ctx: dict[str, Any]) -> str:
        actor = _first(ctx.get("actor_name") or ctx.get("author_name") or ctx.get("assigner_name"))
        return f"{ctx.get('task_key') or ''} · {actor} {verb}"

    return line


EVENT_TYPES = (
    EventTypeDef(
        "core.comment.mentioned",
        "Mentioned",
        {"in_app": True, "email": True, "telegram": True, "sms": False, "push": True},
        channel_template="mentioned",
        email_templates=("mentioned",),
        channel_summary=_comment_line("mentioned you"),
        position=10,
    ),
    EventTypeDef(
        "core.comment.created",
        "New comment",
        {"in_app": True, "email": False, "telegram": True, "sms": False, "push": True},
        channel_template="comment",
        channel_summary=_comment_line("commented"),
        position=30,
    ),
    EventTypeDef("core.workspace.access_requested", "Workspace access requests", preference=False),
    EventTypeDef("core.member.invited", "Invitations", preference=False),
)

DEFINITION = ModuleDefinition(
    key=CORE,
    name="Core",
    description="Workspaces, members, roles, comments, attachments, notifications, search, audit and trash.",
    is_core=True,
    permissions=tuple(CORE_PERMISSIONS),
    event_types=EVENT_TYPES,
    target_types=("core.user",),
    toggleable=False,
)
