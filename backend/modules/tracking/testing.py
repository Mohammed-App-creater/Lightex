"""Tracking test factories: projects and project members built through the real services."""

from __future__ import annotations

from typing import Any

from core.accounts.models import User
from core.common.testing import UserFactory, add_member, role


def add_project_member(project: Any, user: User | None = None, key: str = "project_member", ws_key: str = "member"):
    from core.workspaces.models import WorkspaceMember
    from modules.tracking.projects.models import ProjectMember

    user = user or UserFactory()
    if not WorkspaceMember.objects.filter(workspace=project.workspace, user=user).exists():
        add_member(project.workspace, user, ws_key)
    ProjectMember.objects.update_or_create(project=project, user=user, defaults={"role": role(project.workspace, key)})
    return user


def make_project(
    ws: Any, creator: User | None = None, key: str = "PRJ", name: str = "Platform Rebuild", template: str = "scrum"
):
    from core.workspaces.models import WorkspaceMember
    from modules.tracking.projects.services import create_project

    if creator is None:
        creator = WorkspaceMember.objects.filter(workspace=ws, role__system_key="owner").first().user
    return create_project(creator, ws, {"name": name, "key": key, "template": template})
