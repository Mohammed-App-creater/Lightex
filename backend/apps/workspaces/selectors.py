"""Workspace reads, always scoped to the requesting user's memberships."""

from __future__ import annotations

from typing import Any

from django.db.models import Count, OuterRef, Q, QuerySet, Subquery

from apps.common.exceptions import not_found

from .models import Invitation, Workspace, WorkspaceMember


def _annotated(user: Any) -> QuerySet[Workspace]:
    my_role = WorkspaceMember.objects.filter(workspace=OuterRef("pk"), user_id=user.pk).values("role_id")[:1]
    return Workspace.objects.annotate(
        member_count=Count("members", filter=Q(members__status="active"), distinct=True),
        my_role_id=Subquery(my_role),
    )


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

    qs = WorkspaceMember.objects.filter(workspace=ws).select_related("user").annotate(sort_name=F("user__name"))
    if q:
        qs = qs.filter(Q(user__name__icontains=q) | Q(user__email__icontains=q))
    if role_ids:
        qs = qs.filter(role_id__in=role_ids)
    return qs


def pending_invitations(ws: Workspace) -> QuerySet[Invitation]:
    return (
        Invitation.objects.filter(workspace=ws, status="pending")
        .select_related("role", "invited_by", "workspace")
        .order_by("-created_at")
    )
