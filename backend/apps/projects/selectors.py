"""Project reads. Every project lookup goes through membership: workspace non-members get 404,
workspace members who aren't on the project get 403 `project_membership_required`."""

from __future__ import annotations

import uuid
from typing import Any

from django.db.models import Count, OuterRef, Q, QuerySet, Subquery

from apps.access import services as access
from apps.access.catalogue import PROJECT_ADMIN_PERMISSION
from apps.common.exceptions import ApiError, not_found

from .models import AccessRequest, Label, Project, ProjectKeyAlias, ProjectMember, Status


def _uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def with_counts(qs: QuerySet[Project]) -> QuerySet[Project]:
    from apps.planning.models import Sprint

    active = Sprint.objects.filter(project=OuterRef("pk"), state="active").values("id")[:1]
    live = Q(tasks__deleted_at__isnull=True)
    return qs.annotate(
        member_count=Count("members", distinct=True),
        open_task_count=Count("tasks", filter=live & ~Q(tasks__status__category="done"), distinct=True),
        done_task_count=Count("tasks", filter=live & Q(tasks__status__category="done"), distinct=True),
        active_sprint_id=Subquery(active),
    )


def access_info(project: Project, user: Any) -> dict[str, Any]:
    """What a non-member may see about a project (403 screen, project directory)."""
    admins = (
        ProjectMember.objects.filter(project=project, role__permissions__code=PROJECT_ADMIN_PERMISSION)
        .select_related("user")
        .order_by("user__name")
    )
    my_request = AccessRequest.objects.filter(project=project, user_id=user.pk, status="pending").first()
    return {
        "id": str(project.pk),
        "key": project.key,
        "name": project.name,
        "hue": project.hue,
        "admins": [{"id": str(m.user_id), "name": m.user.name, "hue": m.user.hue} for m in admins],
        "myRequest": access_request_data(my_request) if my_request else None,
    }


def access_request_data(req: AccessRequest) -> dict[str, Any]:
    from apps.common.utils import iso

    return {
        "id": str(req.pk),
        "projectId": str(req.project_id),
        "userId": str(req.user_id),
        "message": req.message,
        "createdAt": iso(req.created_at),
        "status": req.status,
    }


def _membership_error(project: Project, user: Any) -> ApiError:
    return ApiError(
        403,
        "project_membership_required",
        "You’re not a member of this project.",
        {"canRequestAccess": True, "project": access_info(project, user)},
    )


def project_in_workspace(user: Any, project_id: Any) -> Project:
    """The project if the user belongs to its workspace (project membership NOT required)."""
    project = (
        Project.objects.select_related("workspace").filter(pk=project_id, workspace__deleted_at__isnull=True).first()
        if _uuid(project_id)
        else None
    )
    if project is None or not access.is_workspace_member(user, project.workspace_id):
        raise not_found("Project not found.")
    return project


def project_for(user: Any, project_id: Any) -> Project:
    """The project if the user is a member of it (any role)."""
    project = project_in_workspace(user, project_id)
    if not access.project_permissions(user, project):
        raise _membership_error(project, user)
    return project


def project_by_key(user: Any, ws: Any, key: str) -> Project:
    key = (key or "").upper()
    project = Project.objects.select_related("workspace").filter(workspace=ws, key=key).first()
    if project is None:
        alias = ProjectKeyAlias.objects.filter(workspace=ws, key=key, project__deleted_at__isnull=True).first()
        project = alias.project if alias else None
    if project is None:
        raise not_found("Project not found.")
    if not access.project_permissions(user, project):
        raise _membership_error(project, user)
    return project


def visible_projects(user: Any, ws: Any, *, status: str | None = None) -> QuerySet[Project]:
    """Projects in a workspace the user is a member of (workspace roles grant no visibility)."""
    member_of = ProjectMember.objects.filter(user_id=user.pk).values("project_id")
    qs = Project.objects.filter(workspace=ws, pk__in=member_of)
    if status not in ("archived", "all"):
        qs = qs.filter(status="active")
    elif status == "archived":
        qs = qs.filter(status="archived")
    return with_counts(qs).order_by("created_at")


def project_directory(user: Any, ws: Any) -> list[dict[str, Any]]:
    projects = list(Project.objects.filter(workspace=ws).order_by("name"))
    mine = set(ProjectMember.objects.filter(user_id=user.pk, project__in=projects).values_list("project_id", flat=True))
    out = []
    for p in projects:
        info = access_info(p, user)
        info.update({"isMember": p.pk in mine, "status": p.status})
        out.append(info)
    return out


def statuses_of(project: Project) -> QuerySet[Status]:
    return project.statuses.annotate(
        task_count=Count("tasks", filter=Q(tasks__deleted_at__isnull=True), distinct=True)
    ).order_by("position", "created_at")


def labels_of(project: Project) -> QuerySet[Label]:
    return project.labels.annotate(
        task_count=Count("tasks", filter=Q(tasks__deleted_at__isnull=True), distinct=True)
    ).order_by("name")


def members_of(project: Project) -> QuerySet[ProjectMember]:
    return project.members.select_related("user").order_by("user__name")


def is_project_admin_role(role: Any) -> bool:
    return role.permissions.filter(code=PROJECT_ADMIN_PERMISSION).exists()


def admin_count(project: Project, *, excluding_user: Any = None) -> int:
    qs = ProjectMember.objects.filter(project=project, role__permissions__code=PROJECT_ADMIN_PERMISSION)
    if excluding_user is not None:
        qs = qs.exclude(user_id=excluding_user)
    return qs.values("user_id").distinct().count()
