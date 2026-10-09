"""Matrix rows for project-scoped endpoints (extended phase by phase)."""

from __future__ import annotations

from typing import Any


def _row(*args, **kwargs):
    from .test_permission_matrix import Row

    return Row(*args, **kwargs)


def S(w) -> dict[str, Any]:
    return {"slug": w.ws.slug}


def P(w) -> dict[str, Any]:
    return {"project_id": w.project.id}


def PU(user: str):
    return lambda w: {"project_id": w.project.id, "user_id": w.users[user].id}


def T(name: str):
    return lambda w: {"task_id": getattr(w, name).id}


def TR(name: str):
    return lambda w: {"task_ref": str(getattr(w, name).id)}


OUT = ("outsider",)
PUBLIC = "public"
ANY_USER = ("owner", "viewer", "outsider")


def _planning_rows(kind: str, plural: str, perm: str, create: dict, patch: dict) -> list:
    item = lambda w: {"item_id": getattr(w, kind).id}  # noqa: E731
    return [
        _row(f"project-{plural}", "GET", P, allow=("viewer",), deny=("ws_admin", "outsider")),
        _row(
            f"project-{plural}",
            "POST",
            P,
            allow=("manager",),
            deny=("pmember", "viewer", "outsider"),
            body=lambda w: create,
        ),
        _row(f"{kind}-detail", "GET", item, allow=("viewer",), deny=("ws_member", "outsider")),
        _row(
            f"{kind}-detail",
            "PATCH",
            item,
            allow=("manager",),
            deny=("pmember", "viewer", "outsider"),
            body=lambda w: patch,
        ),
        _row(f"{kind}-detail", "DELETE", item, allow=("owner",), deny=("pmember", "viewer", "outsider")),
    ]


ROWS = [
    # ── projects ──
    _row("workspace-projects", "GET", S, allow=("owner", "ws_member"), deny=("outsider", "anon")),
    _row(
        "workspace-projects",
        "POST",
        S,
        allow=("owner", "ws_admin"),
        deny=("ws_member", "manager", "outsider"),
        body=lambda w: {"name": "New", "key": "NEW"},
    ),
    _row(
        "workspace-project-by-key",
        "GET",
        lambda w: {"slug": w.ws.slug, "key": "PRJ"},
        allow=("owner", "manager", "viewer"),
        deny=("ws_admin", "ws_member", "outsider"),
    ),
    _row("workspace-project-directory", "GET", S, allow=("owner", "ws_member"), deny=("outsider", "anon")),
    _row("project-detail", "GET", P, allow=("owner", "viewer"), deny=("ws_admin", "ws_member", "outsider")),
    _row(
        "project-detail",
        "PATCH",
        P,
        allow=("owner", "manager"),
        deny=("pmember", "viewer", "ws_admin", "outsider"),
        body=lambda w: {"description": "x"},
    ),
    _row(
        "project-detail",
        "DELETE",
        P,
        allow=("owner",),
        deny=("manager", "pmember", "ws_admin", "outsider"),
        body=lambda w: {"confirm": "nope"},
    ),
    _row("project-archive", "POST", P, allow=("owner",), deny=("manager", "viewer", "ws_admin", "outsider")),
    _row("project-unarchive", "POST", P, allow=("owner",), deny=("manager", "viewer", "ws_admin", "outsider")),
    # ── members ──
    _row("project-members", "GET", P, allow=("owner", "viewer"), deny=("ws_member", "outsider")),
    _row(
        "project-members",
        "POST",
        P,
        allow=("owner", "ws_admin"),
        deny=("manager", "viewer", "ws_member", "outsider"),
        body=lambda w: {"userId": str(w.users["ws_member"].id), "roleId": str(w.role("project_admin").id)},
    ),
    _row(
        "project-member-detail",
        "PATCH",
        PU("pmember"),
        allow=("owner",),
        deny=("manager", "viewer", "ws_admin", "outsider"),
        body=lambda w: {"roleId": str(w.role("viewer").id)},
    ),
    _row(
        "project-member-detail",
        "DELETE",
        PU("viewer"),
        allow=("owner",),
        deny=("manager", "pmember", "ws_admin", "outsider"),
    ),
    # ── access requests ──
    _row(
        "project-access-requests",
        "GET",
        P,
        allow=("owner",),
        deny=("manager", "viewer", "ws_member", "outsider"),
    ),
    _row(
        "project-access-requests",
        "POST",
        P,
        allow=("ws_member", "ws_admin"),
        deny=("outsider", "anon"),
        body=lambda w: {},
    ),
    _row("project-access-request-mine", "DELETE", P, allow=("ws_member",), deny=("outsider", "anon")),
    _row(
        "project-access-request-deny",
        "POST",
        lambda w: {"project_id": w.project.id, "request_id": w.access_request.id},
        allow=("owner",),
        deny=("manager", "ws_admin", "ws_member", "outsider"),
    ),
    # ── statuses ──
    _row("project-statuses", "GET", P, allow=("viewer",), deny=("ws_admin", "outsider")),
    _row(
        "project-statuses",
        "POST",
        P,
        allow=("owner", "manager"),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {"name": "Blocked", "category": "in_progress"},
    ),
    _row(
        "project-statuses-reorder",
        "POST",
        P,
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {"ids": w.status_ids},
    ),
    _row(
        "project-status-detail",
        "PATCH",
        lambda w: {"project_id": w.project.id, "status_id": w.status.id},
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {"name": "QA2"},
    ),
    _row(
        "project-status-detail",
        "DELETE",
        lambda w: {"project_id": w.project.id, "status_id": w.status.id},
        allow=("owner",),
        deny=("pmember", "viewer", "outsider"),
    ),
    # ── labels ──
    _row("project-labels", "GET", P, allow=("viewer",), deny=("ws_member", "outsider")),
    _row(
        "project-labels",
        "POST",
        P,
        allow=("pmember",),
        deny=("viewer", "ws_member", "outsider"),
        body=lambda w: {"name": "new"},
    ),
    _row(
        "project-label-detail",
        "PATCH",
        lambda w: {"project_id": w.project.id, "label_id": w.label.id},
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {"name": "renamed"},
    ),
    _row(
        "project-label-detail",
        "DELETE",
        lambda w: {"project_id": w.project.id, "label_id": w.label.id},
        allow=("manager",),
        deny=("pmember", "outsider"),
    ),
    # ── tasks ──
    _row("project-tasks", "GET", P, allow=("viewer", "owner"), deny=("ws_admin", "ws_member", "outsider")),
    _row(
        "project-tasks",
        "POST",
        P,
        allow=("pmember", "manager"),
        deny=("viewer", "ws_member", "outsider"),
        body=lambda w: {"title": "New"},
    ),
    _row(
        "project-tasks-bulk",
        "POST",
        P,
        allow=("manager",),
        deny=("pmember", "viewer", "ws_admin", "outsider"),
        body=lambda w: {"ids": [str(w.task.id)], "patch": {"priority": 2}},
    ),
    _row("project-activity", "GET", P, allow=("viewer",), deny=("ws_member", "outsider")),
    _row(
        "workspace-tasks",
        "GET",
        S,
        allow=("ws_member", "viewer"),
        deny=("outsider", "anon"),
        query="?filter[assignee]=me",
    ),
    _row(
        "workspace-task-by-key",
        "GET",
        lambda w: {"slug": w.ws.slug, "key": w.task.key},
        allow=("viewer",),
        deny=("ws_admin", "ws_member", "outsider"),
    ),
    _row("workspace-activity", "GET", S, allow=("ws_member", "viewer"), deny=("outsider", "anon")),
    _row("task-restore", "POST", T("deleted_task"), allow=("manager", "owner"), deny=("pmember", "viewer", "outsider")),
    _row("task-subtasks", "GET", T("task"), allow=("viewer",), deny=("ws_admin", "outsider")),
    _row(
        "task-subtasks",
        "POST",
        T("task"),
        allow=("pmember",),
        deny=("viewer", "ws_member", "outsider"),
        body=lambda w: {"title": "Sub"},
    ),
    _row(
        "task-objectives",
        "PUT",
        T("task"),
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {"objectiveIds": []},
    ),
    _row(
        "task-labels",
        "PUT",
        T("task"),
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {"labelIds": []},
    ),
    _row("task-activity", "GET", T("task"), allow=("viewer",), deny=("ws_member", "outsider")),
    _row("task-detail", "GET", TR("task"), allow=("viewer",), deny=("ws_admin", "ws_member", "outsider")),
    _row(
        "task-detail",
        "PATCH",
        TR("task"),
        allow=("manager",),
        deny=("pmember", "viewer", "ws_admin", "outsider"),
        body=lambda w: {"title": "Edited", "version": w.task.version},
    ),
    _row("task-detail", "DELETE", TR("task"), allow=("manager",), deny=("pmember", "viewer", "outsider")),
    _row("my-tasks", "GET", allow=("owner", "viewer", "outsider"), deny=("anon",)),
    _row("my-recents", "GET", allow=("owner", "viewer", "outsider"), deny=("anon",)),
    # ── board ──
    _row("project-board", "GET", P, allow=("viewer", "owner"), deny=("ws_admin", "ws_member", "outsider")),
    _row("project-backlog", "GET", P, allow=("viewer",), deny=("ws_admin", "outsider")),
    _row(
        "task-move",
        "POST",
        T("task"),
        allow=("pmember", "manager"),
        deny=("viewer", "ws_admin", "outsider"),
        body=lambda w: {"position": "V", "version": w.task.version},
    ),
    # ── planning ──
    *_planning_rows(
        "objective", "objectives", "objective.manage", {"title": "O", "dueDate": "2026-12-01"}, {"title": "O2"}
    ),
    *_planning_rows(
        "milestone", "milestones", "milestone.manage", {"name": "M", "dueDate": "2026-12-01"}, {"name": "M2"}
    ),
    *_planning_rows("epic", "epics", "epic.manage", {"name": "E"}, {"name": "E2"}),
    _row(
        "objective-tasks",
        "POST",
        lambda w: {"item_id": w.objective.id},
        allow=("manager",),
        deny=("pmember", "viewer", "ws_admin", "outsider"),
        body=lambda w: {"taskIds": [str(w.task.id)]},
    ),
    _row(
        "objective-task-detail",
        "DELETE",
        lambda w: {"item_id": w.objective.id, "task_id": w.task.id},
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
    ),
    # ── sprints ──
    *_planning_rows("sprint", "sprints", "sprint.manage", {}, {"name": "Renamed"}),
    _row(
        "sprint-start",
        "POST",
        lambda w: {"item_id": w.sprint.id},
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {},
    ),
    _row(
        "sprint-complete",
        "POST",
        lambda w: {"item_id": w.sprint.id},
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {"moveOpenTasksTo": "backlog"},
    ),
    _row("sprint-board", "GET", lambda w: {"sprint_id": w.sprint.id}, allow=("viewer",), deny=("ws_admin", "outsider")),
    _row("project-active-sprint", "GET", P, allow=("viewer",), deny=("ws_member", "outsider")),
    # ── collaboration ──
    _row("task-comments", "GET", T("task"), allow=("viewer",), deny=("ws_admin", "outsider")),
    _row(
        "task-comments",
        "POST",
        T("task"),
        allow=("pmember",),
        deny=("viewer", "ws_member", "outsider"),
        body=lambda w: {
            "body": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "x"}]}]}
        },
    ),
    _row(
        "comment-detail",
        "PATCH",
        lambda w: {"comment_id": w.comment.id},
        allow=("owner",),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {
            "body": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "y"}]}]}
        },
    ),
    _row(
        "comment-detail",
        "DELETE",
        lambda w: {"comment_id": w.comment.id},
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
    ),
    _row("task-attachments", "GET", T("task"), allow=("viewer",), deny=("ws_admin", "outsider")),
    _row(
        "task-attachments",
        "POST",
        T("task"),
        allow=("pmember",),
        deny=("viewer", "outsider"),
        body=lambda w: {"uploadId": "00000000-0000-0000-0000-000000000000"},
    ),
    _row(
        "task-attachment-upload-url",
        "POST",
        T("task"),
        allow=("pmember",),
        deny=("viewer", "ws_member", "outsider"),
        body=lambda w: {"fileName": "a.png", "size": 10, "mimeType": "image/png"},
    ),
    _row(
        "attachment-detail",
        "DELETE",
        lambda w: {"attachment_id": w.attachment.id},
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
    ),
    _row(
        "attachment-confirm",
        "POST",
        lambda w: {"attachment_id": w.pending.id},
        allow=("owner",),
        deny=("viewer", "outsider"),
    ),
    _row(
        "attachment-download-url",
        "GET",
        lambda w: {"attachment_id": w.attachment.id},
        allow=("viewer",),
        deny=("ws_member", "outsider"),
    ),
    _row("storage-local-upload", "PUT", lambda w: {"token": "x"}, allow=(PUBLIC,)),
    _row("storage-local-download", "GET", lambda w: {"token": "x"}, allow=(PUBLIC,)),
    # ── notifications ──
    _row("notifications", "GET", allow=ANY_USER, deny=("anon",)),
    _row("notifications-unread-count", "GET", allow=ANY_USER, deny=("anon",)),
    _row("notifications-read-all", "POST", allow=ANY_USER, deny=("anon",), body=lambda w: {}),
    _row(
        "notification-read",
        "POST",
        lambda w: {"notification_id": w.notification.id},
        allow=("owner",),
        deny=("pmember", "outsider", "anon"),
        body=lambda w: {"read": True},
    ),
    _row("notification-preferences", "GET", allow=ANY_USER, deny=("anon",)),
    _row(
        "notification-preferences",
        "PUT",
        allow=("viewer",),
        deny=("anon",),
        body=lambda w: {"events": {}, "emailDelivery": "instant"},
    ),
    # ── search, audit, trash ──
    _row("search", "GET", allow=ANY_USER, deny=("anon",), query="?q=board"),
    _row("workspace-search", "GET", S, allow=("ws_member", "viewer"), deny=("outsider", "anon"), query="?q=task"),
    _row("workspace-audit", "GET", S, allow=("owner", "ws_admin"), deny=("ws_member", "manager", "outsider")),
    _row("workspace-trash", "GET", S, allow=("owner", "manager", "pmember"), deny=("viewer", "ws_member", "outsider")),
    _row(
        "workspace-trash-restore",
        "POST",
        S,
        allow=("owner", "manager"),
        deny=("viewer", "pmember", "outsider"),
        body=lambda w: {"items": [{"kind": "task", "id": str(w.deleted_task.id)}]},
    ),
    _row(
        "workspace-trash-purge",
        "POST",
        S,
        allow=("manager",),
        deny=("viewer", "pmember", "outsider"),
        body=lambda w: {"items": [{"kind": "task", "id": str(w.deleted_task.id)}]},
    ),
    _row(
        "trash-item-restore",
        "POST",
        lambda w: {"kind": "task", "item_id": w.deleted_task.id},
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
    ),
    # ── reports ──
    *[
        _row(f"report-{name}", "GET", P, allow=("pmember", "manager"), deny=("viewer", "ws_admin", "outsider"))
        for name in ("kpis", "burndown", "velocity", "cycle-time", "throughput", "progress")
    ],
    _row("project-summary", "GET", P, allow=("viewer",), deny=("ws_admin", "outsider")),
    # ── custom fields, dependencies, time (board 39) ──
    _row("project-custom-fields", "GET", P, allow=("viewer",), deny=("ws_admin", "outsider")),
    _row(
        "project-custom-fields",
        "POST",
        P,
        allow=("owner", "manager"),
        deny=("pmember", "viewer", "ws_admin", "outsider"),
        body=lambda w: {"name": "Found in", "type": "text"},
    ),
    _row(
        "project-custom-fields-order",
        "PUT",
        P,
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
        body=lambda w: {"ids": [str(w.field.id)]},
    ),
    _row(
        "custom-field-detail",
        "PATCH",
        lambda w: {"field_id": w.field.id},
        allow=("manager",),
        deny=("pmember", "viewer", "ws_member", "outsider"),
        body=lambda w: {"required": True},
    ),
    _row(
        "custom-field-detail",
        "DELETE",
        lambda w: {"field_id": w.field.id},
        allow=("owner",),
        deny=("pmember", "viewer", "outsider"),
    ),
    _row("task-dependencies", "GET", T("task"), allow=("viewer",), deny=("ws_member", "outsider")),
    _row(
        "task-dependencies",
        "POST",
        T("task"),
        allow=("manager",),
        deny=("pmember", "viewer", "ws_admin", "outsider"),
        body=lambda w: {"relation": "blocks", "taskId": str(w.own_task.id)},
    ),
    _row(
        "task-dependency-detail",
        "DELETE",
        lambda w: {"task_id": w.task.id, "dependency_id": w.dependency.id},
        allow=("manager",),
        deny=("pmember", "viewer", "outsider"),
    ),
    _row("task-time-entries", "GET", T("task"), allow=("viewer",), deny=("ws_member", "outsider")),
    _row(
        "task-time-entries",
        "POST",
        T("task"),
        allow=("pmember", "manager"),
        deny=("viewer", "ws_member", "outsider"),
        body=lambda w: {"minutes": 30, "date": w.entry.date.isoformat()},
    ),
    _row(
        "time-entry-detail",
        "DELETE",
        lambda w: {"entry_id": w.entry.id},
        allow=("pmember", "manager"),
        deny=("viewer", "ws_member", "outsider"),
    ),
    _row(
        "task-timer", "POST", T("task"), allow=("pmember",), deny=("viewer", "ws_member", "outsider"), body=lambda w: {}
    ),
    _row("my-timer", "GET", allow=ANY_USER, deny=("anon",)),
    _row("my-timer-stop", "POST", allow=("owner",), deny=("anon",), body=lambda w: {}),
    _row("workspace-timesheet", "GET", S, allow=("ws_member", "viewer"), deny=("outsider", "anon")),
    # ── saved views ──
    _row("workspace-views", "GET", S, allow=("ws_member", "viewer"), deny=("outsider", "anon")),
    _row(
        "workspace-views",
        "POST",
        S,
        allow=("pmember",),
        deny=("ws_member", "outsider"),
        body=lambda w: {
            "projectId": str(w.project.id),
            "name": "Mine",
            "filters": [{"field": "priority", "op": "is", "values": ["1"]}],
        },
    ),
    _row("workspace-views-order", "PUT", S, allow=("viewer",), deny=("outsider", "anon"), body=lambda w: {"ids": []}),
    _row(
        "view-detail",
        "PATCH",
        lambda w: {"view_id": w.view.id},
        allow=("owner", "viewer"),
        deny=("ws_member", "outsider"),
        body=lambda w: {"pinned": True},
    ),
    _row(
        "view-detail",
        "DELETE",
        lambda w: {"view_id": w.view.id},
        allow=("owner",),
        deny=("viewer", "ws_member", "outsider"),
    ),
]
