"""Tracking's workspace hooks: a removed member leaves every project of the workspace."""

from __future__ import annotations

from typing import Any

from core.workspaces.hooks import register_member_removed


def remove_project_memberships(ws: Any, user_id: Any) -> None:
    from modules.tracking.dashboards.models import Dashboard
    from modules.tracking.projects.models import AccessRequest, ProjectMember

    ProjectMember.objects.filter(project__workspace=ws, user_id=user_id).delete()
    Dashboard.objects.filter(project__workspace=ws, owner_id=user_id, visibility="personal").delete()
    AccessRequest.objects.filter(project__workspace=ws, user_id=user_id, status="pending").update(status="withdrawn")


def register() -> None:
    register_member_removed(remove_project_memberships)
