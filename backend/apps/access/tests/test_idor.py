"""IDOR guarantees, generated from the permission-matrix table so every route is covered:

1. A user from workspace B can never read or change anything in workspace A (always 404).
2. A workspace member who isn't on a project can never read or change that project's contents
   (403/404), whatever their workspace role (owner included).
"""

from __future__ import annotations

import pytest
from django.urls import reverse

from apps.common.testing import client_for

from .matrix_world import build_world
from .test_permission_matrix import PUBLIC, all_rows

NO_SCOPE = {
    "auth-me", "auth-change-password", "workspace-list", "permission-catalogue", "my-tasks", "my-recents", "search",
    "notifications", "notifications-unread-count", "notifications-read-all", "notification-preferences",
    "my-timer", "my-timer-stop",
}  # fmt: skip
PROJECT_KWARGS = {
    "project_id", "task_id", "task_ref", "item_id", "comment_id", "attachment_id", "sprint_id", "view_id",
    "field_id", "entry_id",
}  # fmt: skip


def _rows(predicate):
    return [pytest.param(r, id=f"{r.name}-{r.method}") for r in all_rows() if predicate(r)]


def _call(row, user, w):
    url = reverse(row.name, kwargs=row.kwargs(w)) + row.query
    payload = row.body(w) if row.body else None
    method = getattr(client_for(user), row.method.lower())
    return method(url, payload, format="json") if payload is not None else method(url)


def _scoped(row) -> bool:
    return PUBLIC not in row.allow and row.name not in NO_SCOPE


@pytest.mark.django_db
@pytest.mark.parametrize("row", _rows(_scoped))
def test_other_workspace_gets_404(row):
    w = build_world()
    res = _call(row, w.users["outsider"], w)
    assert res.status_code == 404, f"{row.name} {row.method}: {res.status_code} {res.content[:200]!r}"


class _Probe:
    """Stands in for the world when we only need to know which URL kwargs a row uses."""

    id = slug = key = "x"
    version = 1

    def __getattr__(self, name):
        return _Probe()

    @property
    def users(self):
        return {
            name: _Probe() for name in ("owner", "ws_admin", "ws_member", "manager", "pmember", "viewer", "outsider")
        }


def _project_scoped(row) -> bool:
    if not _scoped(row) or "ws_member" in row.allow:
        return False
    return bool(PROJECT_KWARGS & set(row.kwargs(_Probe())))


@pytest.mark.django_db
@pytest.mark.parametrize("row", _rows(_project_scoped))
@pytest.mark.parametrize("actor", ["ws_member", "ws_admin"])
def test_workspace_members_outside_the_project_are_refused(row, actor):
    w = build_world()
    res = _call(row, w.users[actor], w)
    if actor in row.allow:  # e.g. project.assign_admin lets a workspace admin appoint a project admin
        return
    assert res.status_code in (403, 404), f"{row.name} {row.method} as {actor}: {res.status_code} {res.content[:200]!r}"


@pytest.mark.django_db
def test_workspace_owner_without_membership_cannot_read_project_contents():
    from apps.projects.models import ProjectMember

    w = build_world()
    ProjectMember.objects.filter(project=w.project, user=w.users["owner"]).delete()
    owner = client_for(w.users["owner"])
    for path in [
        f"/api/v1/projects/{w.project.id}",
        f"/api/v1/projects/{w.project.id}/tasks",
        f"/api/v1/projects/{w.project.id}/board",
        f"/api/v1/tasks/{w.task.id}",
        f"/api/v1/tasks/{w.task.id}/comments",
        f"/api/v1/projects/{w.project.id}/reports/kpis",
    ]:
        res = owner.get(path)
        assert res.status_code == 403, path
        assert res.json()["code"] == "project_membership_required"
    assert all(r["type"] != "task" for r in owner.get("/api/v1/workspaces/platform/search?q=task").json())
    assert owner.get("/api/v1/search?q=task").json()["data"] == []
