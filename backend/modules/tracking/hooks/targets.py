"""Tracking's target types: `tracking.task` (comments, attachments, notifications), `tracking.project` and
`tracking.sprint` (notifications)."""

from __future__ import annotations

from typing import Any

from django.conf import settings

from core.access import services as access
from core.common.exceptions import forbidden
from core.common.targets import TargetResolver, parse_id, register_target_type
from core.notifications.emails import base_context

PRIORITY_LABEL = {0: "No priority", 1: "Low", 2: "Medium", 3: "High", 4: "Urgent"}
PRIORITY_COLOR = {0: "#8794B6", 1: "#8794B6", 2: "#3B7BFF", 3: "#E58A00", 4: "#E5484D"}


def _fmt(date: Any) -> str:
    return f"{date:%b} {date.day}" if date else ""


def task_url(task: Any) -> str:
    return f"{settings.FRONTEND_URL}/{task.project.workspace.slug}/tasks/{task.key}"


def task_context(task: Any) -> dict[str, Any]:
    """Email merge tags for a task."""
    return {
        **base_context(task.project.workspace.slug),
        "cta_url": task_url(task),
        "task_key": task.key,
        "task_title": task.title,
        "project_name": task.project.name,
        "workspace_name": task.project.workspace.name,
        "priority": PRIORITY_LABEL.get(task.priority, ""),
        "priority_color": PRIORITY_COLOR.get(task.priority, "#8794B6"),
        "due_date": _fmt(task.due_date),
        "sprint_name": task.sprint.name if task.sprint_id else "No sprint",
    }


def task_channel_context(task: Any) -> dict[str, Any]:
    """Telegram, SMS and Push merge tags for a task (board 38 §6.4)."""
    return {
        **task_context(task),
        "task_id": str(task.pk),
        "project_key": task.project.key,
        "workspace_slug": task.project.workspace.slug,
    }


def project_members(project_id: Any, user_ids: Any) -> set[str]:
    from modules.tracking.projects.models import ProjectMember

    return set(
        map(
            str,
            ProjectMember.objects.filter(project_id=project_id, user_id__in=list(user_ids)).values_list(
                "user_id", flat=True
            ),
        )
    )


class TaskTarget(TargetResolver):
    not_found_message = "Task not found. It may have been deleted, or you may not have access."
    permission_codes = {
        "view": "tracking.project.view",
        "comment": "tracking.comment.create",
        "edit_own_comment": "tracking.comment.edit_own",
        "delete_any_comment": "tracking.comment.delete_any",
        "attach": "tracking.attachment.upload",
        "delete_any_attachment": "tracking.attachment.delete_any",
    }

    def _task(self, target_id: Any) -> Any:
        from modules.tracking.tasks.models import Task

        pk = parse_id(target_id)
        if pk is None:
            return None
        return (
            Task.objects.select_related("project", "project__workspace", "sprint")
            .filter(pk=pk, project__deleted_at__isnull=True, project__workspace__deleted_at__isnull=True)
            .first()
        )

    def _can(self, user: Any, target_id: Any, action: str) -> bool:
        task = self._task(target_id)
        return task is not None and access.can(user, self.permission_codes[action], task.project)

    def record_exists(self, target_id: Any) -> bool:
        from modules.tracking.tasks.models import Task

        return Task.all_objects.filter(pk=parse_id(target_id)).exists()

    def exists(self, workspace: Any, target_id: Any) -> bool:
        task = self._task(target_id)
        return task is not None and str(task.project.workspace_id) == str(getattr(workspace, "pk", workspace))

    def workspace_of(self, target_id: Any) -> Any:
        task = self._task(target_id)
        return task.project.workspace_id if task is not None else None

    def can_view(self, user: Any, target_id: Any) -> bool:
        return self._can(user, target_id, "view")

    def can_comment(self, user: Any, target_id: Any) -> bool:
        return self._can(user, target_id, "comment")

    def can_attach(self, user: Any, target_id: Any) -> bool:
        return self._can(user, target_id, "attach")

    def can_edit_own_comment(self, user: Any, target_id: Any) -> bool:
        return self._can(user, target_id, "edit_own_comment")

    def can_delete_any_comment(self, user: Any, target_id: Any) -> bool:
        return self._can(user, target_id, "delete_any_comment")

    def can_delete_any_attachment(self, user: Any, target_id: Any) -> bool:
        return self._can(user, target_id, "delete_any_attachment")

    def require_view(self, user: Any, target_id: Any) -> None:
        from modules.tracking.tasks.selectors import task_for

        task = task_for(user, target_id)  # 404 unknown / 403 project_membership_required
        if not access.can(user, "tracking.project.view", task.project):
            raise forbidden(details={"permission": "tracking.project.view"})

    def describe(self, target_id: Any) -> dict[str, Any]:
        task = self._task(target_id)
        if task is None:
            return {}
        return {
            "title": task.title,
            "link": task_url(task),
            "key": task.key,
            "projectId": str(task.project_id),
            "taskId": str(task.pk),
        }

    def subscribers(self, target_id: Any) -> list[Any]:
        task = self._task(target_id)
        if task is None:
            return []
        return [u for u in dict.fromkeys([task.reporter_id, task.assignee_id]) if u]

    def mentionable(self, target_id: Any, user_ids: list[str]) -> set[str]:
        task = self._task(target_id)
        return project_members(task.project_id, user_ids) if task is not None else set()

    def can_notify(self, user_ids: set[str], target_id: Any) -> set[str]:
        return self.mentionable(target_id, list(user_ids))

    def context(self, target_id: Any) -> dict[str, Any]:
        task = self._task(target_id)
        if task is None:
            return {}
        return {**task_channel_context(task), "urgent": task.priority == 4}

    def comment_trash_access(self, user: Any, workspace: Any) -> str:
        from modules.tracking.projects.models import Project

        live = list(Project.objects.filter(workspace=workspace, members__user=user))
        if any(access.can(user, "tracking.comment.delete_any", p) for p in live):
            return "all"
        if any(access.can(user, "tracking.comment.edit_own", p) for p in live):
            return "own"
        return "none"

    def trash_scope(self, target_id: Any) -> dict[str, Any] | None:
        task = self._task(target_id)
        if task is None:
            return None
        p = task.project
        return {"id": str(p.pk), "key": p.key, "name": p.name, "hue": p.hue}

    def storage_prefix(self, target_id: Any) -> str:
        task = self._task(target_id)
        return f"ws/{task.project.workspace_id}/p/{task.project_id}/t/{task.pk}"

    def visible_ids(self, user: Any, workspace: Any = None) -> Any:
        from modules.tracking.projects.models import ProjectMember
        from modules.tracking.tasks.models import Task

        projects = ProjectMember.objects.filter(
            user=user, project__deleted_at__isnull=True, project__workspace__deleted_at__isnull=True
        )
        if workspace is not None:
            projects = projects.filter(project__workspace=workspace)
        return Task.objects.filter(project_id__in=projects.values("project_id")).values("id")


class ProjectTarget(TargetResolver):
    not_found_message = "Project not found."
    permission_codes = {"view": "tracking.project.view"}

    def _project(self, target_id: Any) -> Any:
        from modules.tracking.projects.models import Project

        pk = parse_id(target_id)
        if pk is None:
            return None
        return Project.objects.select_related("workspace").filter(pk=pk, workspace__deleted_at__isnull=True).first()

    def record_exists(self, target_id: Any) -> bool:
        from modules.tracking.projects.models import Project

        return Project.all_objects.filter(pk=parse_id(target_id)).exists()

    def exists(self, workspace: Any, target_id: Any) -> bool:
        project = self._project(target_id)
        return project is not None and str(project.workspace_id) == str(getattr(workspace, "pk", workspace))

    def workspace_of(self, target_id: Any) -> Any:
        project = self._project(target_id)
        return project.workspace_id if project is not None else None

    def can_view(self, user: Any, target_id: Any) -> bool:
        project = self._project(target_id)
        return project is not None and access.can(user, "tracking.project.view", project)

    def can_comment(self, user: Any, target_id: Any) -> bool:
        return False

    def can_attach(self, user: Any, target_id: Any) -> bool:
        return False

    def describe(self, target_id: Any) -> dict[str, Any]:
        project = self._project(target_id)
        if project is None:
            return {}
        return {
            "title": project.name,
            "link": f"{settings.FRONTEND_URL}/{project.workspace.slug}/projects/{project.key}/board",
            "key": project.key,
            "projectId": str(project.pk),
        }

    def mentionable(self, target_id: Any, user_ids: list[str]) -> set[str]:
        return project_members(target_id, user_ids)

    def can_notify(self, user_ids: set[str], target_id: Any) -> set[str]:
        return project_members(target_id, user_ids)


class SprintTarget(TargetResolver):
    not_found_message = "Sprint not found."

    def _sprint(self, target_id: Any) -> Any:
        from modules.tracking.planning.models import Sprint

        pk = parse_id(target_id)
        if pk is None:
            return None
        return (
            Sprint.objects.select_related("project", "project__workspace")
            .filter(pk=pk, project__deleted_at__isnull=True)
            .first()
        )

    def exists(self, workspace: Any, target_id: Any) -> bool:
        sprint = self._sprint(target_id)
        return sprint is not None and str(sprint.project.workspace_id) == str(getattr(workspace, "pk", workspace))

    def workspace_of(self, target_id: Any) -> Any:
        sprint = self._sprint(target_id)
        return sprint.project.workspace_id if sprint is not None else None

    def can_view(self, user: Any, target_id: Any) -> bool:
        sprint = self._sprint(target_id)
        return sprint is not None and access.can(user, "tracking.project.view", sprint.project)

    def can_comment(self, user: Any, target_id: Any) -> bool:
        return False

    def can_attach(self, user: Any, target_id: Any) -> bool:
        return False

    def describe(self, target_id: Any) -> dict[str, Any]:
        sprint = self._sprint(target_id)
        if sprint is None:
            return {}
        project = sprint.project
        return {
            "title": sprint.name,
            "link": f"{settings.FRONTEND_URL}/{project.workspace.slug}/projects/{project.key}/board",
            "projectId": str(project.pk),
        }

    def can_notify(self, user_ids: set[str], target_id: Any) -> set[str]:
        sprint = self._sprint(target_id)
        return project_members(sprint.project_id, user_ids) if sprint is not None else set()


def register() -> None:
    register_target_type("tracking.task", TaskTarget())
    register_target_type("tracking.project", ProjectTarget())
    register_target_type("tracking.sprint", SprintTarget())
