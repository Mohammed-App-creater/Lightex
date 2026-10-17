"""Workspace trash: soft-deleted records kept for TRASH_RETENTION_DAYS, listed by kind.

Kinds are registered (`register_trash_kind`): core registers `core.comment`; modules register their own (tracking:
`tracking.task`, `tracking.project`). A kind lists what the user may restore or purge, restores and purges one item,
and purges expired items and whole workspaces. Old bare kinds (`task`) are accepted as aliases.
Every permission check happens inside the kind, through access.can() or the target resolver.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core.accounts.serializers import user_brief
from core.common.exceptions import forbidden, invalid, not_found
from core.common.targets import get_resolver, parse_id, target_types
from core.common.utils import iso

NONE, OWN, ALL = "none", "own", "all"
_RANK = {NONE: 0, OWN: 1, ALL: 2}


class TrashKind:
    """One trashable kind. `access()` is "none", "own" (only what you deleted yourself) or "all"."""

    kind: str = ""
    module: str = ""
    aliases: tuple[str, ...] = ()
    #: Reported in the 403 when the user may see no kind at all.
    permission: str = ""
    position: int = 0

    def access(self, user: Any, workspace: Any) -> str:
        raise NotImplementedError

    def offered(self, user: Any, workspace: Any) -> bool:
        """Listed in the response's `kinds` (the client's filter chips)."""
        return True

    def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
        raise NotImplementedError

    def restore(self, user: Any, item_id: Any) -> None:
        raise NotImplementedError

    def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
        raise NotImplementedError

    def workspace_of(self, item_id: Any) -> Any:
        raise NotImplementedError

    def purge_expired(self, cutoff: dt.datetime, now: dt.datetime, *, skip_workspaces: Any = ()) -> dict[str, int]:
        """Hard-deletes items deleted before `cutoff`, except in `skip_workspaces` (ids, or a values queryset): the
        workspaces where the kind's module is off, since disabling a module never deletes its data."""
        return {}

    def purge_workspace(self, workspace: Any) -> None:
        """Hard-deletes every record of this kind in a workspace that is being purged."""


_KINDS: dict[str, TrashKind] = {}


def register_trash_kind(kind: TrashKind) -> None:
    _KINDS[kind.kind] = kind


def unregister_trash_kind(key: str) -> None:
    _KINDS.pop(key, None)


def _module(kind: TrashKind) -> str:
    return kind.module or kind.kind.split(".", 1)[0]


def kinds(workspace: Any = None) -> list[TrashKind]:
    """Every kind, or with `workspace` only those of modules enabled there (a disabled module's trash is hidden)."""
    out = sorted(_KINDS.values(), key=lambda k: k.position)
    if workspace is None:
        return out
    from core.modules.services import is_enabled

    return [k for k in out if is_enabled(workspace, _module(k))]


def disabled_workspaces(kind: TrashKind) -> Any:
    """Ids (a values queryset) of the workspaces where the kind's module is off; `()` for an always-on module."""
    from core.modules.models import WorkspaceModule
    from core.modules.services import always_on
    from core.workspaces.models import Workspace

    module = _module(kind)
    if always_on(module):
        return ()
    on = WorkspaceModule.objects.filter(module_key=module, enabled=True).values("workspace_id")
    return Workspace.all_objects.exclude(pk__in=on).values("pk")


def kind_for(key: Any) -> TrashKind | None:
    """A registered kind by its namespaced key or a bare alias (`task` → `tracking.task`)."""
    if key in _KINDS:
        return _KINDS[key]
    return next((k for k in _KINDS.values() if key in k.aliases), None)


def purge_at(deleted_at: dt.datetime) -> str | None:
    return iso(deleted_at + dt.timedelta(days=settings.TRASH_RETENTION_DAYS))


def item(
    kind: TrashKind,
    obj: Any,
    title: str,
    *,
    key: str | None = None,
    hue: int | None = None,
    parent_key: str | None = None,
    task_count: int | None = None,
    project: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "kind": kind.kind,
        "module": kind.module,
        "id": str(obj.pk),
        "title": title,
        "key": key,
        "hue": hue,
        "parentKey": parent_key,
        "taskCount": task_count,
        "project": project,
        "deletedBy": user_brief(obj.deleted_by),
        "deletedAt": iso(obj.deleted_at),
        "purgeAt": purge_at(obj.deleted_at),
    }


def _access(user: Any, workspace: Any) -> dict[str, str]:
    levels = {k.kind: k.access(user, workspace) for k in kinds(workspace)}
    if all(level == NONE for level in levels.values()):
        first = next((k.permission for k in kinds(workspace) if k.permission), "")
        raise forbidden("Trash is for members and admins.", {"permission": first} if first else None)
    return levels


def list_items(user: Any, workspace: Any) -> dict[str, Any]:
    levels = _access(user, workspace)
    items: list[dict[str, Any]] = []
    for k in kinds(workspace):
        items.extend(k.items(user, workspace))
    items.sort(key=lambda i: i["deletedAt"] or "", reverse=True)
    best = max((_RANK[v] for v in levels.values()), default=0)
    return {
        "data": items,
        "scope": ALL if best == _RANK[ALL] else OWN,
        "kinds": [k.kind for k in kinds(workspace) if k.offered(user, workspace)],
        "retentionDays": settings.TRASH_RETENTION_DAYS,
    }


def _refs(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise invalid({"items": "Pick at least one item"})
    out = []
    for r in raw[:200]:
        kind = kind_for(r.get("kind")) if isinstance(r, dict) else None
        if kind is None or not isinstance(r.get("id"), str):
            raise invalid({"items": "Each item needs a kind and an id"})
        out.append({"kind": kind.kind, "id": r["id"]})
    return out


def _visible(user: Any, workspace: Any, refs: list[dict[str, str]]) -> None:
    listed = {(i["kind"], i["id"]) for i in list_items(user, workspace)["data"]}
    for r in refs:
        if (r["kind"], r["id"]) not in listed:
            raise not_found("That item isn’t in the Trash any more.", {"item": r})


def workspace_of_item(raw_kind: Any, item_id: Any) -> Any:
    kind = kind_for(raw_kind)
    if kind is None:
        raise not_found("Unknown trash type.")
    workspace_id = kind.workspace_of(item_id)
    if workspace_id is None:
        raise not_found("That item isn’t in the Trash any more.")
    return workspace_id


@transaction.atomic
def restore(user: Any, workspace: Any, raw: Any) -> list[dict[str, str]]:
    refs = _refs(raw)
    _visible(user, workspace, refs)
    for r in refs:
        _KINDS[r["kind"]].restore(user, r["id"])
    return refs


@transaction.atomic
def purge(user: Any, workspace: Any, raw: Any) -> list[dict[str, str]]:
    refs = _refs(raw)
    _visible(user, workspace, refs)
    for r in refs:
        _KINDS[r["kind"]].purge(user, workspace, r["id"])
    return refs


def purge_workspace(ws: Any) -> None:
    """Hard-deletes a workspace in dependency order (roles are protected while in use)."""
    from core.access.models import Role
    from core.collab.models import Attachment, Comment
    from core.collab.services import delete_files
    from core.workspaces.models import Invitation, WorkspaceMember

    for k in kinds():
        k.purge_workspace(ws)
    attachments = Attachment.all_objects.filter(workspace=ws)
    delete_files(attachments)
    attachments.delete()
    Comment.all_objects.filter(workspace=ws).delete()
    WorkspaceMember.objects.filter(workspace=ws).delete()
    Invitation.objects.filter(workspace=ws).delete()
    Role.objects.filter(workspace=ws).delete()
    ws.delete()


def purge_expired(now: dt.datetime | None = None) -> dict[str, int]:
    """Permanently removes everything deleted more than TRASH_RETENTION_DAYS ago."""
    from core.collab.models import Attachment
    from core.collab.services import delete_files
    from core.events.models import DomainEvent
    from core.workspaces.models import Workspace

    now = now or timezone.now()
    cutoff = now - dt.timedelta(days=settings.TRASH_RETENTION_DAYS)
    counts: dict[str, int] = {}
    with transaction.atomic():
        for k in kinds():
            counts.update(k.purge_expired(cutoff, now, skip_workspaces=disabled_workspaces(k)))
        old_files = Attachment.all_objects.filter(deleted_at__lt=cutoff)
        delete_files(old_files)
        counts["attachments"] = old_files.delete()[0]
        stale_uploads = Attachment.all_objects.filter(status="pending", created_at__lt=now - dt.timedelta(days=1))
        delete_files(stale_uploads)
        counts["uploads"] = stale_uploads.delete()[0]
        counts["workspaces"] = 0
        for ws in Workspace.all_objects.filter(deleted_at__lt=cutoff):
            purge_workspace(ws)
            counts["workspaces"] += 1
        counts["events"] = DomainEvent.objects.filter(processed_at__lt=cutoff).delete()[0]
        from core.channels.services import purge_channels

        counts.update(purge_channels(now))
    return counts


# ───────────────────────── core.comment ─────────────────────────


class CommentTrash(TrashKind):
    """Deleted comments whose target still exists. The target's resolver decides: `can_delete_any_comment`, or
    `can_edit_own_comment` for comments you wrote and deleted yourself."""

    kind = "core.comment"
    module = "core"
    aliases = ("comment",)
    position = 20

    def _allowed(self, user: Any, comment: Any) -> bool:
        resolver = get_resolver(comment.target_type)
        if resolver is None:
            return False
        if resolver.can_delete_any_comment(user, comment.target_id):
            return True
        return (
            comment.author_id == user.pk
            and comment.deleted_by_id == user.pk
            and resolver.can_edit_own_comment(user, comment.target_id)
        )

    def access(self, user: Any, workspace: Any) -> str:
        best = NONE
        for key in target_types():
            resolver = get_resolver(key)
            level = resolver.comment_trash_access(user, workspace) if resolver is not None else NONE
            if _RANK[level] > _RANK[best]:
                best = level
        return best

    def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
        from core.collab.models import Comment

        out = []
        rows = Comment.all_objects.filter(workspace=workspace, deleted_at__isnull=False).select_related("deleted_by")
        for c in rows:
            resolver = get_resolver(c.target_type)
            if resolver is None or resolver.workspace_of(c.target_id) is None or not self._allowed(user, c):
                continue
            info = resolver.describe(c.target_id)
            out.append(
                item(
                    self,
                    c,
                    c.body_text[:160] or "Comment",
                    parent_key=info.get("key"),
                    project=resolver.trash_scope(c.target_id),
                )
            )
        return out

    def _get(self, item_id: Any) -> Any:
        from core.collab.models import Comment

        pk = parse_id(item_id)
        return Comment.all_objects.filter(pk=pk).first() if pk else None

    def restore(self, user: Any, item_id: Any) -> None:
        from core.collab.services import restore_comment

        restore_comment(user, self._get(item_id))

    def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
        from core.collab.services import purge_comment

        purge_comment(user, self._get(item_id))

    def workspace_of(self, item_id: Any) -> Any:
        comment = self._get(item_id)
        return comment.workspace_id if comment is not None else None

    def purge_expired(self, cutoff: dt.datetime, now: dt.datetime, *, skip_workspaces: Any = ()) -> dict[str, int]:
        from core.collab.models import Comment

        rows = Comment.all_objects.filter(deleted_at__lt=cutoff).exclude(workspace_id__in=skip_workspaces)
        return {"comments": rows.delete()[0]}


register_trash_kind(CommentTrash())
