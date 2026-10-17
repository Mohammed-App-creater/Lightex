"""Target registry: how core services (comments, attachments, notifications, audit, search) refer to module records.

A target is `(target_type, target_id)`: `target_type` is `<module>.<entity>` (for example `tracking.task`) and
`target_id` is the record's UUID. Modules register a resolver per target type in their AppConfig `ready()`:

    register_target_type("tracking.task", TaskTarget())

Core never imports a module; it asks the resolver. Resolvers subclass `TargetResolver`, which documents the protocol
and gives every optional hook a safe default.
"""

from __future__ import annotations

import uuid
from typing import Any

from core.common.exceptions import not_found


class TargetResolver:
    """The resolver protocol. Required: `exists`, `can_view`, `can_comment`, `can_attach`, `describe`, `workspace_of`.

    `describe(id)` returns at least `{"title": str, "link": str}`. Optional hint keys that core copies onto its own
    rows when present: `key` (a human key such as `PRJ-42`), `projectId` and `taskId`.
    """

    #: Shown when a target is missing or invisible.
    not_found_message = "Not found."

    # ── required ──

    def exists(self, workspace: Any, target_id: Any) -> bool:
        raise NotImplementedError

    def can_view(self, user: Any, target_id: Any) -> bool:
        raise NotImplementedError

    def can_comment(self, user: Any, target_id: Any) -> bool:
        raise NotImplementedError

    def can_attach(self, user: Any, target_id: Any) -> bool:
        raise NotImplementedError

    def describe(self, target_id: Any) -> dict[str, Any]:
        raise NotImplementedError

    def workspace_of(self, target_id: Any) -> Any:
        """The target's workspace id, or None when the target doesn't exist (or is soft-deleted)."""
        raise NotImplementedError

    # ── optional ──

    def record_exists(self, target_id: Any) -> bool:
        """Does the record exist at all, soft-deleted included? (`check_orphan_targets`)"""
        return self.workspace_of(target_id) is not None

    def subscribers(self, target_id: Any) -> list[Any]:
        """Users told about activity on the target (for example a task's assignee and reporter)."""
        return []

    def require_view(self, user: Any, target_id: Any) -> None:
        """Raises the module's own 404 / 403 when `user` may not see the target."""
        if self.workspace_of(target_id) is None or not self.can_view(user, target_id):
            raise not_found(self.not_found_message)

    def can_edit_own_comment(self, user: Any, target_id: Any) -> bool:
        return self.can_comment(user, target_id)

    def can_delete_any_comment(self, user: Any, target_id: Any) -> bool:
        return False

    def can_delete_any_attachment(self, user: Any, target_id: Any) -> bool:
        return False

    def mentionable(self, target_id: Any, user_ids: list[str]) -> set[str]:
        """Which of `user_ids` may be mentioned (and therefore notified). Default: active workspace members."""
        from core.workspaces.models import WorkspaceMember

        return set(
            map(
                str,
                WorkspaceMember.objects.filter(
                    workspace_id=self.workspace_of(target_id), user_id__in=user_ids, status="active"
                ).values_list("user_id", flat=True),
            )
        )

    def can_notify(self, user_ids: set[str], target_id: Any) -> set[str]:
        """Which recipients may still be told about the target. Default: those who can view it."""
        from core.accounts.models import User

        users = User.objects.filter(pk__in=user_ids, is_active=True)
        return {str(u.pk) for u in users if self.can_view(u, target_id)}

    def context(self, target_id: Any) -> dict[str, Any]:
        """Merge tags for email, Telegram, SMS and Push templates. `urgent` (bool) marks urgent deliveries."""
        info = self.describe(target_id)
        return {"title": info.get("title", ""), "cta_url": info.get("link", "")}

    def storage_prefix(self, target_id: Any) -> str:
        """The object-storage prefix for the target's attachments (server-generated, never user input)."""
        return f"ws/{self.workspace_of(target_id)}/{self.key}/{target_id}"

    def comment_trash_access(self, user: Any, workspace: Any) -> str:
        """Trash access to deleted comments on this type: "all" (moderator somewhere), "own" or "none"."""
        return "none"

    def trash_scope(self, target_id: Any) -> dict[str, Any] | None:
        """The `project` brief shown on trash items of this target ({id, key, name, hue}), if any."""
        return None

    #: Permission codes reported in 403 details, by action (view, comment, attach, edit_own_comment, …).
    permission_codes: dict[str, str] = {}

    def visible_ids(self, user: Any, workspace: Any = None) -> Any:
        """Ids (or a values queryset) of targets the user can see; None when the resolver can't list them."""
        return None

    #: Filled in by `register_target_type`.
    key: str = ""


_TARGETS: dict[str, TargetResolver] = {}


def register_target_type(key: str, resolver: TargetResolver) -> None:
    module, _, entity = key.partition(".")
    if not module or not entity or "." in entity:
        raise ValueError(f"Target types are <module>.<entity>, got {key!r}")
    resolver.key = key
    _TARGETS[key] = resolver


def unregister_target_type(key: str) -> None:
    _TARGETS.pop(key, None)


def target_types() -> list[str]:
    return list(_TARGETS)


def module_of(key: str) -> str:
    return key.split(".", 1)[0]


def get_resolver(key: str) -> TargetResolver | None:
    return _TARGETS.get(key)


def resolver_for(key: Any) -> TargetResolver:
    """The resolver for `key`, or 404 for an unknown target type."""
    resolver = _TARGETS.get(str(key))
    if resolver is None:
        raise not_found("Unknown target type.")
    return resolver


def parse_id(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None
