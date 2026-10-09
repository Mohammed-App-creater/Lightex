"""Workspace trash: soft-deleted tasks, comments and projects, kept for TRASH_RETENTION_DAYS.

Who sees what (mirrors the client):
  task    → task.delete in the task's project
  comment → comment.delete_any in the project, or comment.edit_own for comments you wrote and deleted
  project → project.delete in the deleted project (your role there), or workspace project.assign_admin
Every check goes through access.can().
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.access.services import can
from apps.accounts.serializers import user_brief
from apps.collaboration.models import Attachment, Comment
from apps.common.exceptions import forbidden, invalid, not_found
from apps.common.utils import iso
from apps.projects.models import Project
from apps.tasks.models import Task

from .services import record

KINDS = ("task", "comment", "project")


def _purge_at(deleted_at: dt.datetime) -> str | None:
    return iso(deleted_at + dt.timedelta(days=settings.TRASH_RETENTION_DAYS))


def _brief_project(p: Project) -> dict[str, Any]:
    return {"id": str(p.pk), "key": p.key, "name": p.name, "hue": p.hue}


class Access:
    def __init__(self, user: Any, workspace: Any) -> None:
        self.user = user
        self.workspace = workspace
        self.live = list(Project.objects.filter(workspace=workspace, members__user=user))
        self.ws_admin = can(user, "project.assign_admin", workspace)
        self.deleted = list(Project.all_objects.filter(workspace=workspace, deleted_at__isnull=False))

    def project_perm(self, project: Any, code: str) -> bool:
        return can(self.user, code, project)

    def task(self, project: Any) -> bool:
        return self.project_perm(project, "task.delete")

    def comment(self, project: Any, comment: Comment) -> bool:
        if self.project_perm(project, "comment.delete_any"):
            return True
        return (
            self.project_perm(project, "comment.edit_own")
            and comment.author_id == self.user.pk
            and comment.deleted_by_id == self.user.pk
        )

    def project(self, project: Any) -> bool:
        return self.ws_admin or can(self.user, "project.delete", project, include_deleted=True)

    @property
    def broad(self) -> bool:
        return (
            any(self.task(p) or self.project_perm(p, "comment.delete_any") for p in self.live)
            or self.ws_admin
            or any(self.project(p) for p in self.deleted)
            or any(self.project_perm(p, "project.delete") for p in self.live)
        )

    @property
    def any(self) -> bool:
        return self.broad or any(self.project_perm(p, "comment.edit_own") for p in self.live)

    @property
    def kinds(self) -> list[str]:
        out = ["task", "comment"]
        if (
            self.ws_admin
            or any(self.project_perm(p, "project.delete") for p in self.live)
            or any(self.project(p) for p in self.deleted)
        ):
            out.append("project")
        return out


def _access(user: Any, workspace: Any) -> Access:
    acc = Access(user, workspace)
    if not acc.any:
        raise forbidden("Trash is for members and admins.", {"permission": "task.delete"})
    return acc


def _item(
    kind: str,
    obj: Any,
    title: str,
    *,
    key: str | None = None,
    hue: int | None = None,
    parent_key: str | None = None,
    task_count: int | None = None,
    project: Any = None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "id": str(obj.pk),
        "title": title,
        "key": key,
        "hue": hue,
        "parentKey": parent_key,
        "taskCount": task_count,
        "project": _brief_project(project) if project is not None else None,
        "deletedBy": user_brief(obj.deleted_by),
        "deletedAt": iso(obj.deleted_at),
        "purgeAt": _purge_at(obj.deleted_at),
    }


def list_items(user: Any, workspace: Any) -> dict[str, Any]:
    acc = _access(user, workspace)
    live_ids = [p.pk for p in acc.live]
    by_id = {p.pk: p for p in acc.live}
    items: list[dict[str, Any]] = []
    tasks = (
        Task.all_objects.filter(project_id__in=live_ids, deleted_at__isnull=False)
        .exclude(parent__deleted_at__isnull=False)
        .select_related("deleted_by")
    )
    for t in tasks:
        project = by_id[t.project_id]
        if acc.task(project):
            items.append(_item("task", t, t.title, key=t.key, project=project))
    comments = Comment.all_objects.filter(
        task__project_id__in=live_ids, deleted_at__isnull=False, task__deleted_at__isnull=True
    ).select_related("task", "deleted_by")
    for c in comments:
        project = by_id[c.task.project_id]
        if acc.comment(project, c):
            items.append(_item("comment", c, c.body_text[:160] or "Comment", parent_key=c.task.key, project=project))
    for p in acc.deleted:
        if acc.project(p):
            count = Task.objects.filter(project=p, parent__isnull=True).count()
            items.append(_item("project", p, p.name, key=p.key, hue=p.hue, task_count=count))
    items.sort(key=lambda i: i["deletedAt"] or "", reverse=True)
    return {
        "data": items,
        "scope": "all" if acc.broad else "own",
        "kinds": acc.kinds,
        "retentionDays": settings.TRASH_RETENTION_DAYS,
    }


def _refs(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise invalid({"items": "Pick at least one item"})
    out = []
    for r in raw[:200]:
        if not isinstance(r, dict) or r.get("kind") not in KINDS or not isinstance(r.get("id"), str):
            raise invalid({"items": "Each item needs a kind and an id"})
        out.append({"kind": r["kind"], "id": r["id"]})
    return out


def _visible(user: Any, workspace: Any, refs: list[dict[str, str]]) -> None:
    listed = {(i["kind"], i["id"]) for i in list_items(user, workspace)["data"]}
    for r in refs:
        if (r["kind"], r["id"]) not in listed:
            raise not_found("That item isn’t in the Trash any more.", {"item": r})


@transaction.atomic
def restore(user: Any, workspace: Any, raw: Any) -> list[dict[str, str]]:
    from apps.collaboration.services import restore_comment
    from apps.projects.services import restore_project
    from apps.tasks.services import restore_task

    refs = _refs(raw)
    _visible(user, workspace, refs)
    for r in refs:
        if r["kind"] == "task":
            restore_task(user, Task.all_objects.select_related("project").get(pk=r["id"]))
        elif r["kind"] == "comment":
            restore_comment(user, Comment.all_objects.select_related("task", "task__project").get(pk=r["id"]))
        else:
            restore_project(user, Project.all_objects.select_related("workspace").get(pk=r["id"]))
    return refs


def _delete_files(attachments: Any) -> None:
    from apps.collaboration.storage import get_storage

    storage = get_storage()
    keys = list(attachments.values_list("storage_key", flat=True))

    def remove() -> None:
        for key in keys:
            storage.delete(key)

    transaction.on_commit(remove)


def purge_task(task: Task) -> None:
    ids = [task.pk, *Task.all_objects.filter(parent=task).values_list("pk", flat=True)]
    _delete_files(Attachment.all_objects.filter(task_id__in=ids))
    Task.all_objects.filter(pk__in=ids).delete()


def purge_project(project: Project) -> None:
    from apps.imports.services import delete_project_files
    from apps.projects.models import ProjectMember

    _delete_files(Attachment.all_objects.filter(task__project=project))
    delete_project_files(project)  # import files: the FK cascade alone would orphan them in storage
    Task.all_objects.filter(project=project, parent__isnull=False).delete()
    Task.all_objects.filter(project=project).delete()
    ProjectMember.objects.filter(project=project).delete()  # role FKs are PROTECT
    project.delete()


def purge_workspace(ws: Any) -> None:
    """Hard-deletes a workspace in dependency order (roles are protected while in use)."""
    from apps.access.models import Role
    from apps.workspaces.models import Invitation, WorkspaceMember

    for project in Project.all_objects.filter(workspace=ws):
        purge_project(project)
    WorkspaceMember.objects.filter(workspace=ws).delete()
    Invitation.objects.filter(workspace=ws).delete()
    Role.objects.filter(workspace=ws).delete()
    ws.delete()


@transaction.atomic
def purge(user: Any, workspace: Any, raw: Any) -> list[dict[str, str]]:
    refs = _refs(raw)
    _visible(user, workspace, refs)
    for r in refs:
        if r["kind"] == "task":
            task = Task.all_objects.select_related("project").get(pk=r["id"])
            record(
                workspace=workspace,
                project=task.project_id,
                actor=user,
                action="task.purged",
                target=task.title,
                entity_id=task.pk,
                entity_key=task.key,
            )
            purge_task(task)
        elif r["kind"] == "comment":
            comment = Comment.all_objects.select_related("task").get(pk=r["id"])
            record(
                workspace=workspace,
                project=comment.task.project_id,
                actor=user,
                action="comment.purged",
                target=comment.task.title,
                entity_id=comment.pk,
            )
            comment.delete()
        else:
            project = Project.all_objects.get(pk=r["id"])
            record(
                workspace=workspace,
                actor=user,
                action="project.purged",
                target=project.name,
                entity_id=project.pk,
                entity_key=project.key,
            )
            purge_project(project)
    return refs


def purge_expired(now: dt.datetime | None = None) -> dict[str, int]:
    """Permanently removes everything deleted more than TRASH_RETENTION_DAYS ago."""
    from apps.notifications.models import DomainEvent
    from apps.workspaces.models import Workspace

    now = now or timezone.now()
    cutoff = now - dt.timedelta(days=settings.TRASH_RETENTION_DAYS)
    counts = {"tasks": 0, "comments": 0, "attachments": 0, "projects": 0, "workspaces": 0, "uploads": 0, "events": 0}
    with transaction.atomic():
        for task in Task.all_objects.filter(deleted_at__lt=cutoff, parent__isnull=True):
            purge_task(task)
            counts["tasks"] += 1
        counts["comments"] = Comment.all_objects.filter(deleted_at__lt=cutoff).delete()[0]
        old_files = Attachment.all_objects.filter(deleted_at__lt=cutoff)
        _delete_files(old_files)
        counts["attachments"] = old_files.delete()[0]
        stale_uploads = Attachment.all_objects.filter(status="pending", created_at__lt=now - dt.timedelta(days=1))
        _delete_files(stale_uploads)
        counts["uploads"] = stale_uploads.delete()[0]
        for project in Project.all_objects.filter(deleted_at__lt=cutoff):
            purge_project(project)
            counts["projects"] += 1
        for ws in Workspace.all_objects.filter(deleted_at__lt=cutoff):
            purge_workspace(ws)
            counts["workspaces"] += 1
        counts["events"] = DomainEvent.objects.filter(processed_at__lt=cutoff).delete()[0]
    return counts
