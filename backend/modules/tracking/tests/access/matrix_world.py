"""A small, complete world for the permission matrix: one workspace with a project and one user per
role, plus an outsider who belongs to a different workspace."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from django.utils import timezone

from core.common.testing import UserFactory, add_member, make_workspace
from core.common.tokens import new_token

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
    from core.access.models import Role
    from core.workspaces.models import Invitation

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
    from modules.tracking.projects.models import AccessRequest, Label, ProjectMember, Status
    from modules.tracking.testing import make_project

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
    _add_collaboration(w)
    _add_notifications(w)
    _add_views(w)
    _add_board39(w)
    _add_board40(w)
    _add_board33(w)
    _add_board37(w)


def _add_tasks(w: World) -> None:
    from modules.tracking.tasks.services import create_task, delete_task

    w.extra["task"] = create_task(w.users["owner"], w.project, {"title": "Owner task"})
    w.extra["own_task"] = create_task(w.users["pmember"], w.project, {"title": "Member task"})
    gone = create_task(w.users["owner"], w.project, {"title": "Deleted task"})
    delete_task(w.users["owner"], gone)
    w.extra["deleted_task"] = gone


def _add_planning(w: World) -> None:
    from modules.tracking.planning.models import Epic, Milestone, Objective

    w.extra["objective"] = Objective.objects.create(project=w.project, title="Ship beta", due_date="2026-12-01")
    w.extra["milestone"] = Milestone.objects.create(
        project=w.project, name="Beta", start_date="2026-10-01", due_date="2026-11-01"
    )
    w.extra["epic"] = Epic.objects.create(project=w.project, name="Billing")
    from modules.tracking.planning.models import Sprint

    w.extra["sprint"] = Sprint.objects.create(
        project=w.project, name="Sprint 1", number=1, start_date="2026-10-01", end_date="2026-10-14"
    )


def _add_collaboration(w: World) -> None:
    from core.collab.models import Attachment, Comment
    from core.common.richtext import plain_doc

    owner = w.users["owner"]
    w.extra["comment"] = Comment.objects.create(
        workspace=w.task.project.workspace,
        target_type="tracking.task",
        target_id=w.task.pk,
        author=owner,
        body=plain_doc("hi"),
        body_text="hi",
    )
    base = f"ws/{w.ws.pk}/p/{w.project.pk}/t/{w.task.pk}/"
    w.extra["attachment"] = Attachment.objects.create(
        workspace=w.task.project.workspace, target_type="tracking.task", target_id=w.task.pk,
        uploader=owner, file_name="a.png", size=10, mime_type="image/png", kind="image",
        storage_key=base + "ready", status="ready",
    )  # fmt: skip
    w.extra["pending"] = Attachment.objects.create(
        workspace=w.task.project.workspace, target_type="tracking.task", target_id=w.task.pk,
        uploader=owner, file_name="b.png", size=10, mime_type="image/png", kind="image",
        storage_key=base + "pending",
    )  # fmt: skip


def _add_notifications(w: World) -> None:
    from core.notifications.models import Notification

    w.extra["notification"] = Notification.objects.create(
        recipient=w.users["owner"], workspace=w.ws, project=w.project, task=w.task, type="assigned"
    )


def _add_views(w: World) -> None:
    from modules.tracking.projects.models import SavedView

    w.extra["view"] = SavedView.objects.create(
        workspace=w.ws, project=w.project, owner=w.users["owner"], name="Shared", visibility="project",
        filters=[{"field": "priority", "op": "is", "values": ["3"]}],
    )  # fmt: skip


def _add_board39(w: World) -> None:
    """Custom field, dependency, time entry and a running timer (board 39)."""
    from core.common.utils import today
    from modules.tracking.projects.custom_fields import create_field
    from modules.tracking.tasks.services import add_dependency, create_task
    from modules.tracking.timetracking.models import RunningTimer
    from modules.tracking.timetracking.services import log_time

    owner = w.users["owner"]
    w.extra["field"] = create_field(
        owner,
        w.project,
        {"name": "Browser", "type": "select", "options": [{"name": "Chrome", "color": "var(--low)"}]},
    )
    blocker = create_task(owner, w.project, {"title": "Blocker"})
    w.extra["dependency"] = add_dependency(owner, w.task, {"relation": "blocked_by", "taskId": str(blocker.id)})
    w.extra["entry"] = log_time(w.users["pmember"], w.task, {"minutes": 30, "date": today().isoformat()})
    RunningTimer.objects.create(user=owner, task=w.task, started_at=w.task.created_at)


def _add_board40(w: World) -> None:
    """A finished import (with an error report) started by the owner (board 40)."""
    import uuid

    from django.utils import timezone

    from modules.tracking.imports.models import ImportJob

    job_id = uuid.uuid4()
    base = f"ws/{w.ws.pk}/p/{w.project.pk}/imports/{job_id}"
    w.extra["import_job"] = ImportJob.objects.create(
        pk=job_id, workspace=w.ws, project=w.project, created_by=w.users["owner"], source="csv",
        file_name="tasks.csv", file_size=10, source_key=f"{base}/source.csv", report_key=f"{base}/report.csv",
        status="completed", phase="finishing", finished_at=timezone.now(), expires_at=timezone.now(),
    )  # fmt: skip


def _add_board33(w: World) -> None:
    """A shared dashboard (the owner's) and a personal one (the project member's) (board 33)."""
    from modules.tracking.dashboards.models import Dashboard

    w.extra["dashboard"] = Dashboard.objects.create(
        project=w.project, owner=w.users["owner"], name="Sprint health", visibility="shared"
    )
    w.extra["personal_dashboard"] = Dashboard.objects.create(
        project=w.project, owner=w.users["pmember"], name="My focus", visibility="personal"
    )


def _add_board37(w: World) -> None:
    """A GitHub integration tracking one repository for every project, and a manual PR link on the task (board 37)."""
    from django.utils import timezone

    from modules.tracking.integrations.models import Integration, Repository
    from modules.tracking.tasks.models import ExternalLink

    integration = Integration.objects.create(
        workspace=w.ws, provider="github", auth_kind="github_app", base_url="https://github.com",
        account_external_id="51234567", account_login="platform-team", account_kind="organization",
        account_url="https://github.com/platform-team", status="active", connected_at=timezone.now(),
        last_synced_at=timezone.now(),
    )  # fmt: skip
    repo = Repository.objects.create(
        integration=integration, workspace=w.ws, external_id="712004001", full_path="platform-team/web",
        owner_path="platform-team", name="web", web_url="https://github.com/platform-team/web",
    )  # fmt: skip
    w.extra["integration"] = integration
    w.extra["repository"] = repo
    w.extra["dev_link"] = ExternalLink.objects.create(
        task=w.task, workspace=w.ws, provider="github", type="pull_request", external_id="712004001#214",
        url="https://github.com/platform-team/web/pull/214", repository=repo, base_url="https://github.com",
        repo_external_id="712004001", repo_full_path="platform-team/web", number=214, title="PRJ-1 Fix",
        state="open", link_source="manual",
    )  # fmt: skip
