"""Workspace reads, always scoped to the requesting user's memberships."""

from __future__ import annotations

from typing import Any

from django.db.models import Count, Prefetch, Q, QuerySet

from core.common.exceptions import not_found

from .models import Invitation, InvitationRole, Workspace, WorkspaceMember, WorkspaceMemberRole


def _annotated(user: Any) -> QuerySet[Workspace]:
    return Workspace.objects.annotate(
        member_count=Count("members", filter=Q(members__status="active"), distinct=True),
    )


def prime_my_roles(user: Any, workspaces: list[Workspace]) -> None:
    """Loads the user's roles in many workspaces in one query (`myRoleIds` on workspace lists)."""
    from core.access.catalogue import role_precedence_key

    found: dict[Any, list[Any]] = {ws.pk: [] for ws in workspaces}
    links = (
        WorkspaceMemberRole.objects.unscoped()  # explicit ids: the user's own workspaces
        .filter(member__user_id=user.pk, workspace_id__in=list(found))
        .select_related("role")
    )
    for link in links:
        found[link.workspace_id].append(link.role)
    for ws in workspaces:
        ws._my_roles = sorted(found[ws.pk], key=role_precedence_key)  # type: ignore[attr-defined]


def my_roles(user: Any, ws: Workspace) -> list[Any]:
    """The user's roles in `ws`, in precedence order."""
    if not hasattr(ws, "_my_roles"):
        prime_my_roles(user, [ws])
    return ws._my_roles  # type: ignore[attr-defined]


def workspaces_for(user: Any) -> QuerySet[Workspace]:
    member_of = WorkspaceMember.objects.filter(user_id=user.pk, status="active").values("workspace_id")
    return _annotated(user).filter(pk__in=member_of).order_by("created_at")


def workspace_for(user: Any, slug: str) -> Workspace:
    """The workspace if the user is an active member; 404 otherwise (no existence leak)."""
    ws = workspaces_for(user).filter(slug=slug).first()
    if ws is None:
        raise not_found("Workspace not found.")
    return ws


def members(ws: Workspace, *, q: str = "", role_ids: list[str] | None = None) -> QuerySet[WorkspaceMember]:
    from django.db.models import F

    links = WorkspaceMemberRole.objects.for_workspace(ws).select_related("role")
    qs = (
        WorkspaceMember.objects.for_workspace(ws)
        .select_related("user")
        .prefetch_related(Prefetch("role_links", queryset=links))
        .annotate(sort_name=F("user__name"))
    )
    if q:
        qs = qs.filter(Q(user__name__icontains=q) | Q(user__email__icontains=q))
    if role_ids:
        valid = [r for r in role_ids if _is_uuid(r)]
        qs = qs.filter(pk__in=links.filter(role_id__in=valid).values("member_id"))
    return qs


def _is_uuid(value: str) -> bool:
    import uuid

    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def pending_invitations(ws: Workspace) -> QuerySet[Invitation]:
    return (
        Invitation.objects.for_workspace(ws)
        .filter(status="pending")
        .select_related("invited_by", "workspace")
        .prefetch_related(
            Prefetch("role_links", queryset=InvitationRole.objects.for_workspace(ws).select_related("role"))
        )
        .order_by("-created_at")
    )
