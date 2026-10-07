import datetime as dt

import pytest
from django.core.management import call_command
from django.utils import timezone
from freezegun import freeze_time

from apps.audit.models import AuditLog
from apps.audit.services import record
from apps.audit.trash import purge_expired
from apps.collaboration.models import Attachment, Comment
from apps.collaboration.storage import get_storage
from apps.common.richtext import plain_doc
from apps.common.testing import UserFactory, add_member, add_project_member, client_for, make_project
from apps.projects.models import Project
from apps.tasks.models import Task
from apps.tasks.services import create_task, delete_task
from apps.workspaces.models import Workspace

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ")


# ───────────────────────── audit ─────────────────────────


def test_audit_list_filters_and_shape(owner, ws, project, st=None):
    member = add_project_member(project, key="manager")
    task = create_task(owner, project, {"title": "Audited"})
    statuses = {s.glyph: s for s in project.statuses.all()}
    client_for(member).patch(
        f"/api/v1/tasks/{task.id}", {"statusId": str(statuses["progress"].id), "version": 1}, format="json"
    )
    client = client_for(owner)
    page = client.get("/api/v1/workspaces/platform/audit?limit=2").json()
    assert page["total"] >= 4
    assert len(page["data"]) == 2
    assert page["nextCursor"]
    row = page["data"][0]
    assert set(row) == {
        "id", "actorId", "action", "target", "createdAt", "actorName", "actorKind", "entityType", "entityKey",
        "source", "requestId", "changes",
    }  # fmt: skip
    status_rows = client.get("/api/v1/workspaces/platform/audit?filter[action]=status").json()
    assert [r["action"] for r in status_rows["data"]] == ["task.status_changed"]
    assert status_rows["data"][0]["changes"] == [
        {"field": "Status", "kind": "status", "before": "todo", "after": "progress"}
    ]
    by_actor = client.get(f"/api/v1/workspaces/platform/audit?filter[actor]={member.id}").json()
    assert {r["actorId"] for r in by_actor["data"]} == {str(member.id)}
    tasks = client.get("/api/v1/workspaces/platform/audit?filter[entity]=task").json()
    assert {r["entityType"] for r in tasks["data"]} == {"task"}
    created = client.get("/api/v1/workspaces/platform/audit?filter[action]=created").json()
    assert {"project.created", "task.created", "workspace.created"} <= {r["action"] for r in created["data"]}
    ws_rows = client.get("/api/v1/workspaces/platform/audit?filter[entity]=workspace").json()
    assert {r["entityType"] for r in ws_rows["data"]} == {"workspace"}
    from urllib.parse import quote

    future = quote((timezone.now() + dt.timedelta(days=1)).isoformat())
    assert client.get(f"/api/v1/workspaces/platform/audit?filter[since]={future}").json()["total"] == 0
    for bad in ["filter[action]=bogus", "filter[entity]=bogus", "filter[since]=yesterday", "filter[actor]=nope"]:
        assert client.get(f"/api/v1/workspaces/platform/audit?{bad}").status_code == 422
    updated = client.get("/api/v1/workspaces/platform/audit?filter[action]=updated").json()
    assert all(not r["action"].endswith((".created", ".status_changed")) for r in updated["data"])


def test_audit_requires_audit_view(owner, ws):
    member = add_member(ws, key="member")
    assert client_for(member).get("/api/v1/workspaces/platform/audit").status_code == 403
    assert client_for(add_member(ws, key="admin")).get("/api/v1/workspaces/platform/audit").status_code == 200


def test_audit_never_stores_secrets(owner, ws):
    entry = record(
        workspace=ws,
        actor=owner,
        action="member.updated",
        changes=[
            {"field": "password", "kind": "text", "before": "a", "after": "b"},
            {"field": "Name", "kind": "text", "before": "x", "after": "y"},
        ],
        data={"token": "abc", "nested": {"password_hash": "x"}, "ok": 1},
    )
    assert [c["field"] for c in entry.changes] == ["Name"]
    assert entry.data == {"token": "[redacted]", "nested": {"password_hash": "[redacted]"}, "ok": 1}
    client_for(owner).put("/api/v1/auth/me/password", {"currentPassword": "x", "newPassword": "y"}, format="json")
    assert not AuditLog.objects.filter(changes__icontains="Str0ng").exists()


# ───────────────────────── trash ─────────────────────────


def test_trash_lists_and_restores_tasks_comments_projects(owner, ws, project):
    client = client_for(owner)
    task = create_task(owner, project, {"title": "Remove legacy cookies"})
    sub = create_task(owner, project, {"title": "Sub", "parentId": str(task.id)})
    delete_task(owner, task)
    live = create_task(owner, project, {"title": "Live"})
    comment_id = client.post(
        f"/api/v1/tasks/{live.id}/comments", {"body": plain_doc("Duplicate of PRJ-90")}, format="json"
    ).json()["id"]
    client.delete(f"/api/v1/comments/{comment_id}")
    doomed = make_project(ws, owner, key="LA", name="Legacy API")
    create_task(owner, doomed, {"title": "Inside"})
    client.delete(f"/api/v1/projects/{doomed.id}", {"confirm": "LA"}, format="json")
    data = client.get("/api/v1/workspaces/platform/trash").json()
    assert data["scope"] == "all"
    assert data["kinds"] == ["task", "comment", "project"]
    assert data["retentionDays"] == 30
    kinds = {(i["kind"], i["title"]) for i in data["data"]}
    assert kinds == {("task", "Remove legacy cookies"), ("comment", "Duplicate of PRJ-90"), ("project", "Legacy API")}
    project_item = next(i for i in data["data"] if i["kind"] == "project")
    assert project_item["taskCount"] == 1
    assert project_item["deletedBy"]["id"] == str(owner.id)
    task_item = next(i for i in data["data"] if i["kind"] == "task")
    assert task_item["key"] == task.key
    assert task_item["purgeAt"] > task_item["deletedAt"]
    restored = client.post(
        "/api/v1/workspaces/platform/trash/restore",
        {"items": [{"kind": i["kind"], "id": i["id"]} for i in data["data"]]},
        format="json",
    )
    assert restored.status_code == 200
    assert len(restored.json()["restored"]) == 3
    assert Task.objects.filter(pk=sub.pk).exists()
    assert Comment.objects.filter(pk=comment_id).exists()
    assert Project.objects.filter(pk=doomed.pk).exists()
    assert client.get("/api/v1/workspaces/platform/trash").json()["data"] == []


def test_trash_purge(owner, ws, project):
    client = client_for(owner)
    task = create_task(owner, project, {"title": "Bye"})
    attachment = Attachment.objects.create(
        task=task,
        uploader=owner,
        file_name="a.txt",
        size=1,
        mime_type="text/plain",
        kind="text",
        storage_key="k/purge",
        status="ready",
    )
    get_storage().put("k/purge", b"x", "text/plain")
    delete_task(owner, task)
    res = client.post(
        "/api/v1/workspaces/platform/trash/purge", {"items": [{"kind": "task", "id": str(task.id)}]}, format="json"
    )
    assert res.json() == {"purged": [{"kind": "task", "id": str(task.id)}]}
    assert not Task.all_objects.filter(pk=task.pk).exists()
    assert not Attachment.all_objects.filter(pk=attachment.pk).exists()
    assert get_storage().head("k/purge") is None
    again = client.post(
        "/api/v1/workspaces/platform/trash/purge", {"items": [{"kind": "task", "id": str(task.id)}]}, format="json"
    )
    assert again.status_code == 404
    assert client.post("/api/v1/workspaces/platform/trash/purge", {"items": []}, format="json").status_code == 422
    assert (
        client.post(
            "/api/v1/workspaces/platform/trash/purge", {"items": [{"kind": "x", "id": "1"}]}, format="json"
        ).status_code
        == 422
    )
    assert AuditLog.objects.filter(action="task.purged").exists()


def test_trash_visibility_by_role(owner, ws, project):
    member = add_project_member(project, key="project_member")
    viewer = add_project_member(project, key="viewer")
    theirs = create_task(owner, project, {"title": "Owner task"})
    delete_task(owner, theirs)
    live = create_task(owner, project, {"title": "Live"})
    mine = (
        client_for(member).post(f"/api/v1/tasks/{live.id}/comments", {"body": plain_doc("mine")}, format="json").json()
    )
    client_for(member).delete(f"/api/v1/comments/{mine['id']}")
    other = (
        client_for(owner)
        .post(f"/api/v1/tasks/{live.id}/comments", {"body": plain_doc("owner's")}, format="json")
        .json()
    )
    client_for(owner).delete(f"/api/v1/comments/{other['id']}")
    member_view = client_for(member).get("/api/v1/workspaces/platform/trash").json()
    assert member_view["scope"] == "own"
    assert [i["title"] for i in member_view["data"]] == ["mine"]
    assert member_view["kinds"] == ["task", "comment"]
    # Members can't restore what they can't see.
    res = client_for(member).post(
        "/api/v1/workspaces/platform/trash/restore", {"items": [{"kind": "task", "id": str(theirs.id)}]}, format="json"
    )
    assert res.status_code == 404
    assert client_for(viewer).get("/api/v1/workspaces/platform/trash").status_code == 403
    outsider = UserFactory()
    assert client_for(outsider).get("/api/v1/workspaces/platform/trash").status_code == 404


def test_workspace_admin_sees_deleted_projects_only(owner, ws, project):
    admin = add_member(ws, key="admin")
    client_for(owner).delete(f"/api/v1/projects/{project.id}", {"confirm": "PRJ"}, format="json")
    data = client_for(admin).get("/api/v1/workspaces/platform/trash").json()
    assert [i["kind"] for i in data["data"]] == ["project"]
    assert data["kinds"] == ["task", "comment", "project"]


def test_restore_project_with_taken_key(owner, ws, project):
    client = client_for(owner)
    client.delete(f"/api/v1/projects/{project.id}", {"confirm": "PRJ"}, format="json")
    make_project(ws, owner, key="PRJ", name="Replacement")
    res = client.post(
        "/api/v1/workspaces/platform/trash/restore",
        {"items": [{"kind": "project", "id": str(project.id)}]},
        format="json",
    )
    assert res.status_code == 409
    assert res.json()["code"] == "key_taken"


def test_single_item_restore_endpoint(owner, project):
    task = create_task(owner, project, {"title": "One"})
    delete_task(owner, task)
    client = client_for(owner)
    res = client.post(f"/api/v1/trash/task/{task.id}/restore")
    assert res.json() == {"restored": [{"kind": "task", "id": str(task.id)}]}
    assert client.post(f"/api/v1/trash/bogus/{task.id}/restore").status_code == 404
    import uuid

    assert client.post(f"/api/v1/trash/task/{uuid.uuid4()}/restore").status_code == 404
    assert client_for(UserFactory()).post(f"/api/v1/trash/task/{task.id}/restore").status_code == 404


def test_purge_expired_after_30_days(owner, ws, project):
    with freeze_time("2026-09-01 10:00:00"):
        old_task = create_task(owner, project, {"title": "Old"})
        delete_task(owner, old_task)
        stale = Attachment.objects.create(
            task=create_task(owner, project, {"title": "Upload"}), uploader=owner, file_name="a.png", size=1,
            mime_type="image/png", kind="image", storage_key="k/stale",
        )  # fmt: skip
        doomed_ws = Workspace.objects.create(slug="gone", name="Gone", deleted_at=timezone.now())
    recent = create_task(owner, project, {"title": "Recent"})
    delete_task(owner, recent)
    with freeze_time("2026-10-07 10:00:00"):
        counts = purge_expired()
    assert counts["tasks"] == 1
    assert counts["uploads"] == 1
    assert counts["workspaces"] == 1
    assert not Task.all_objects.filter(pk=old_task.pk).exists()
    assert Task.all_objects.filter(pk=recent.pk).exists()
    assert not Attachment.all_objects.filter(pk=stale.pk).exists()
    assert not Workspace.all_objects.filter(pk=doomed_ws.pk).exists()
    call_command("purge_trash")
