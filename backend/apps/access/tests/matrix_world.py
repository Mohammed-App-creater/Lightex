"""A small, complete world for the permission matrix: one workspace with a project and one user per
role, plus an outsider who belongs to a different workspace."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from django.utils import timezone

from apps.common.testing import UserFactory, add_member, make_workspace
from apps.common.tokens import new_token

ACTORS = ("owner", "ws_admin", "ws_member", "manager", "pmember", "viewer", "outsider", "anon")


@dataclass
class World:
    ws: Any
    other_ws: Any
    users: dict[str, Any]
    invite: Any
    invite_token: str
    custom_role: Any
    project: Any = None
    extra: dict[str, Any] = field(default_factory=dict)

    def role(self, key: str):
        return self.ws.roles.get(system_key=key)

    def __getattr__(self, name: str) -> Any:
        try:
            return self.__dict__["extra"][name]
        except KeyError as exc:
            raise AttributeError(name) from exc


def build_world() -> World:
    from apps.access.models import Role
    from apps.workspaces.models import Invitation

    owner = UserFactory(name="Owner")
    ws = make_workspace(owner, name="Platform team", slug="platform")
    users = {"owner": owner}
    users["ws_admin"] = add_member(ws, UserFactory(name="WS Admin"), "admin")
    users["ws_member"] = add_member(ws, UserFactory(name="WS Member"), "member")
    users["manager"] = add_member(ws, UserFactory(name="Manager"), "member")
    users["pmember"] = add_member(ws, UserFactory(name="Project Member"), "member")
    users["viewer"] = add_member(ws, UserFactory(name="Viewer"), "member")
    outsider = UserFactory(name="Outsider")
    other_ws = make_workspace(outsider, name="Elsewhere", slug="elsewhere")
    users["outsider"] = outsider

    raw, digest = new_token()
    invite = Invitation.objects.create(
        workspace=ws,
        email="invitee@x.dev",
        role=ws.roles.get(system_key="member"),
        invited_by=owner,
        token_hash=digest,
        expires_at=timezone.now() + timezone.timedelta(days=7),
    )
    custom_role = Role.objects.create(workspace=ws, name="Custom", scope="project")
    world = World(ws=ws, other_ws=other_ws, users=users, invite=invite, invite_token=raw, custom_role=custom_role)
    _add_project(world)
    return world


def _add_project(w: World) -> None:
    from apps.common.testing import make_project
    from apps.projects.models import AccessRequest, Label, ProjectMember, Status

    project = make_project(w.ws, w.users["owner"], key="PRJ", name="Platform Rebuild", template="scrum")
    for actor, key in (("manager", "manager"), ("pmember", "project_member"), ("viewer", "viewer")):
        ProjectMember.objects.create(project=project, user=w.users[actor], role=w.role(key))
    w.project = project
    w.extra["status"] = Status.objects.create(
        project=project, name="QA", category="in_progress", glyph="review", position=9
    )
    w.extra["label"] = Label.objects.create(project=project, name="matrix")
    w.extra["access_request"] = AccessRequest.objects.create(project=project, user=w.users["ws_member"])
    w.extra["status_ids"] = [str(i) for i in project.statuses.order_by("position").values_list("id", flat=True)]
    _add_tasks(w)
    _add_planning(w)


def _add_tasks(w: World) -> None:
    from apps.tasks.services import create_task, delete_task

    w.extra["task"] = create_task(w.users["owner"], w.project, {"title": "Owner task"})
    w.extra["own_task"] = create_task(w.users["pmember"], w.project, {"title": "Member task"})
    gone = create_task(w.users["owner"], w.project, {"title": "Deleted task"})
    delete_task(w.users["owner"], gone)
    w.extra["deleted_task"] = gone


def _add_planning(w: World) -> None:
    from apps.planning.models import Epic, Milestone, Objective

    w.extra["objective"] = Objective.objects.create(project=w.project, title="Ship beta", due_date="2026-12-01")
    w.extra["milestone"] = Milestone.objects.create(
        project=w.project, name="Beta", start_date="2026-10-01", due_date="2026-11-01"
    )
    w.extra["epic"] = Epic.objects.create(project=w.project, name="Billing")
