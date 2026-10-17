"""Tracking's trash kinds: `tracking.task` and `tracking.project` (comments are core's `core.comment`).

Who sees what (mirrors the client):
  task    → task.delete in the task's project
  project → project.delete in the deleted project (your role there), or workspace project.assign_admin
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from core.access.services import can
from core.audit import trash
from core.audit.services import record
from core.collab.services import delete_target_records
from core.common.targets import parse_id


def brief_project(p: Any) -> dict[str, Any]:
    return {"id": str(p.pk), "key": p.key, "name": p.name, "hue": p.hue}


def _live(user: Any, workspace: Any) -> list[Any]:
    from modules.tracking.projects.models import Project

    return list(Project.objects.filter(workspace=workspace, members__user=user))


def _deleted(workspace: Any) -> list[Any]:
    from modules.tracking.projects.models import Project

    return list(Project.all_objects.filter(workspace=workspace, deleted_at__isnull=False))


def purge_task(task: Any) -> None:
    from modules.tracking.tasks.models import Task

    ids = [task.pk, *Task.all_objects.filter(parent=task).values_list("pk", flat=True)]
    delete_target_records("tracking.task", ids)
    Task.all_objects.filter(pk__in=ids).delete()


def purge_project(project: Any) -> None:
    from modules.tracking.imports.services import delete_project_files
    from modules.tracking.projects.models import ProjectMember
    from modules.tracking.tasks.models import Task

    delete_target_records("tracking.task", list(Task.all_objects.filter(project=project).values_list("pk", flat=True)))
    delete_project_files(project)  # import files: the FK cascade alone would orphan them in storage
    Task.all_objects.filter(project=project, parent__isnull=False).delete()
    Task.all_objects.filter(project=project).delete()
    ProjectMember.objects.filter(project=project).delete()  # role FKs are PROTECT
    project.delete()


class TaskTrash(trash.TrashKind):
    kind = "tracking.task"
    module = "tracking"
    aliases = ("task",)
    permission = "tracking.task.delete"
    position = 10

    def _can(self, user: Any, project: Any) -> bool:
        return can(user, "tracking.task.delete", project)

    def access(self, user: Any, workspace: Any) -> str:
        return trash.ALL if any(self._can(user, p) for p in _live(user, workspace)) else trash.NONE

    def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
        from modules.tracking.tasks.models import Task

        live = {p.pk: p for p in _live(user, workspace)}
        rows = (
            Task.all_objects.filter(project_id__in=list(live), deleted_at__isnull=False)
            .exclude(parent__deleted_at__isnull=False)
            .select_related("deleted_by")
        )
        out = []
        for t in rows:
            project = live[t.project_id]
            if self._can(user, project):
                out.append(trash.item(self, t, t.title, key=t.key, project=brief_project(project)))
        return out

    def _get(self, item_id: Any) -> Any:
        from modules.tracking.tasks.models import Task

        pk = parse_id(item_id)
        return Task.all_objects.select_related("project").filter(pk=pk).first() if pk else None

    def restore(self, user: Any, item_id: Any) -> None:
        from modules.tracking.tasks.services import restore_task

        restore_task(user, self._get(item_id))

    def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
        task = self._get(item_id)
        record(
            workspace=workspace,
            project=task.project_id,
            actor=user,
            action="tracking.task.purged",
            target=task.title,
            entity_id=task.pk,
            entity_key=task.key,
        )
        purge_task(task)

    def workspace_of(self, item_id: Any) -> Any:
        task = self._get(item_id)
        return task.project.workspace_id if task is not None else None

    def purge_expired(self, cutoff: dt.datetime, now: dt.datetime) -> dict[str, int]:
        from modules.tracking.tasks.models import Task

        count = 0
        for task in Task.all_objects.filter(deleted_at__lt=cutoff, parent__isnull=True):
            purge_task(task)
            count += 1
        return {"tasks": count}


class ProjectTrash(trash.TrashKind):
    kind = "tracking.project"
    module = "tracking"
    aliases = ("project",)
    permission = "tracking.project.delete"
    position = 30

    def _can(self, user: Any, workspace: Any, project: Any, ws_admin: bool) -> bool:
        return ws_admin or can(user, "tracking.project.delete", project, include_deleted=True)

    def offered(self, user: Any, workspace: Any) -> bool:
        ws_admin = can(user, "tracking.project.assign_admin", workspace)
        return (
            ws_admin
            or any(can(user, "tracking.project.delete", p) for p in _live(user, workspace))
            or any(self._can(user, workspace, p, ws_admin) for p in _deleted(workspace))
        )

    def access(self, user: Any, workspace: Any) -> str:
        return trash.ALL if self.offered(user, workspace) else trash.NONE

    def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
        from modules.tracking.tasks.models import Task

        ws_admin = can(user, "tracking.project.assign_admin", workspace)
        out = []
        for p in _deleted(workspace):
            if self._can(user, workspace, p, ws_admin):
                count = Task.objects.filter(project=p, parent__isnull=True).count()
                out.append(trash.item(self, p, p.name, key=p.key, hue=p.hue, task_count=count))
        return out

    def _get(self, item_id: Any) -> Any:
        from modules.tracking.projects.models import Project

        pk = parse_id(item_id)
        return Project.all_objects.select_related("workspace").filter(pk=pk).first() if pk else None

    def restore(self, user: Any, item_id: Any) -> None:
        from modules.tracking.projects.services import restore_project

        restore_project(user, self._get(item_id))

    def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
        project = self._get(item_id)
        record(
            workspace=workspace,
            actor=user,
            action="tracking.project.purged",
            target=project.name,
            entity_id=project.pk,
            entity_key=project.key,
        )
        purge_project(project)

    def workspace_of(self, item_id: Any) -> Any:
        project = self._get(item_id)
        return project.workspace_id if project is not None else None

    def purge_expired(self, cutoff: dt.datetime, now: dt.datetime) -> dict[str, int]:
        from modules.tracking.projects.models import Project

        count = 0
        for project in Project.all_objects.filter(deleted_at__lt=cutoff):
            purge_project(project)
            count += 1
        return {"projects": count}

    def purge_workspace(self, workspace: Any) -> None:
        from modules.tracking.projects.models import Project

        for project in Project.all_objects.filter(workspace=workspace):
            purge_project(project)


def register() -> None:
    from core.audit.registry import register_audit_group

    trash.register_trash_kind(TaskTrash())
    trash.register_trash_kind(ProjectTrash())
    # The workspace audit view's entity filter.
    register_audit_group("task", ["tracking.task"])
    register_audit_group(
        "project",
        [f"tracking.{e}" for e in ("project", "status", "label", "objective", "milestone", "epic")],
    )
    register_audit_group("sprint", ["tracking.sprint"])
    register_audit_group("member", ["tracking.project_member"])
    register_audit_group("view", ["tracking.view"])
