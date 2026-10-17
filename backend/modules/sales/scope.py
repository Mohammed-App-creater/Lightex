"""Data scope for sales records (docs/sales/api.md §3).

Lists and searches go through `core.access.services.visible_to()`, the one place a data scope is applied to a
queryset. Single records are checked with `in_scope()` (built on `visible_to()` too). Out-of-scope records answer
404, exactly like records that don't exist, so their existence never leaks; a record in view scope but outside the
action's scope (say `edit` narrower than `view`) answers 403 `forbidden` with `details.permission`.

Changing an owner (companies and contacts have no `assign` code): it needs the record's edit code with scope `team`
or `all`; the new owner must be an active workspace member and, with `team`, the caller or someone sharing a team
with them.
"""

from __future__ import annotations

from typing import Any

from django.db.models import QuerySet

from core.access import services as access
from core.access.catalogue import ALL, TEAM
from core.common.exceptions import forbidden, invalid, not_found


def scope_of(user: Any, workspace: Any, code: str) -> str | None:
    """The user's data scope for `code` (`own`, `team`, `all`), or None without a grant."""
    return access.my_data_scopes(user, workspace).get(code)


def visible(qs: QuerySet, user: Any, code: str, workspace: Any) -> QuerySet:
    return access.visible_to(qs, user, code, workspace)


def in_scope(user: Any, obj: Any, code: str, *, manager: str = "objects") -> bool:
    model = type(obj)
    qs = getattr(model, manager).for_workspace(obj.workspace_id).filter(pk=obj.pk)
    return visible(qs, user, code, obj.workspace_id).exists()


def ids_in_scope(user: Any, workspace: Any, model: Any, ids: list[Any], code: str) -> set[str]:
    """Which of `ids` the user reaches under `code` (one query; `canEdit` / `canDelete` on a page)."""
    if not ids:
        return set()
    qs = model.objects.for_workspace(workspace).filter(pk__in=ids)
    return {str(pk) for pk in visible(qs, user, code, workspace).values_list("pk", flat=True)}


def require_visible(user: Any, obj: Any, code: str, message: str) -> None:
    """404 when the record is outside the user's `code` scope (as if it didn't exist)."""
    if not in_scope(user, obj, code):
        raise not_found(message)


def require_in_scope(user: Any, obj: Any, code: str) -> None:
    """403 when the user may see the record but `code` doesn't reach it."""
    if not in_scope(user, obj, code):
        raise forbidden(details={"permission": code})


def teammates(user: Any, workspace: Any) -> set[str]:
    from core.teams.models import TeamMember

    wid = getattr(workspace, "pk", workspace)
    mine = TeamMember.objects.for_workspace(wid).filter(user_id=user.pk, team__deleted_at__isnull=True)
    mates = TeamMember.objects.for_workspace(wid).filter(team_id__in=mine.values("team_id"))
    return {str(u) for u in mates.values_list("user_id", flat=True)} | {str(user.pk)}


def check_owner_change(user: Any, workspace: Any, code: str, owner_id: Any) -> Any:
    """Validates handing a record to `owner_id` under edit code `code`; returns the new owner (a User)."""
    from core.accounts.models import User
    from core.workspaces.models import WorkspaceMember

    if str(owner_id) == str(user.pk):
        return user
    scope = scope_of(user, workspace, code)
    if scope not in (TEAM, ALL):
        raise forbidden("You can only own records yourself.", {"permission": code, "scope": TEAM})
    member = WorkspaceMember.objects.for_workspace(workspace).filter(user_id=owner_id, status="active").exists()
    if not member:
        raise invalid({"ownerId": "Pick a member of this workspace"})
    if scope == TEAM and str(owner_id) not in teammates(user, workspace):
        raise invalid({"ownerId": "Pick someone in your team"})
    return User.objects.get(pk=owner_id)
