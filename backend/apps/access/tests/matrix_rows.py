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
]
