import pytest
from freezegun import freeze_time

from apps.audit.models import AuditLog
from apps.common.testing import add_project_member, client_for, make_project
from apps.planning.models import Sprint, SprintScopeChange
from apps.tasks.models import Task
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def st(project):
    return {s.glyph: s for s in project.statuses.all()}


@freeze_time("2026-10-07")
def test_create_sprints_with_defaults(owner, project):
    client = client_for(owner)
    first = client.post(f"/api/v1/projects/{project.id}/sprints", {}, format="json").json()
    assert first["name"] == "Sprint 1"
    assert first["number"] == 1
    assert (first["startDate"], first["endDate"]) == ("2026-10-07", "2026-10-20")
    assert first["state"] == "planned"
    assert first["progress"] == {"done": 0, "total": 0, "percent": 0, "points": 0, "donePoints": 0}
    second = client.post(
        f"/api/v1/projects/{project.id}/sprints", {"name": "Hardening", "goal": "Stabilise"}, format="json"
    ).json()
    assert second["number"] == 2
    assert second["startDate"] == "2026-10-21"
    bad = client.post(
        f"/api/v1/projects/{project.id}/sprints", {"startDate": "2026-11-10", "endDate": "2026-11-01"}, format="json"
    )
    assert bad.status_code == 422
    listed = client.get(f"/api/v1/projects/{project.id}/sprints").json()
    assert [s["number"] for s in listed] == [1, 2]


def test_update_and_delete_rules(owner, project):
    client = client_for(owner)
    sprint = client.post(f"/api/v1/projects/{project.id}/sprints", {}, format="json").json()
    patched = client.patch(
        f"/api/v1/sprints/{sprint['id']}", {"name": "Renamed", "goal": "G", "endDate": "2030-01-01"}, format="json"
    )
    assert patched.json()["name"] == "Renamed"
    assert client.patch(f"/api/v1/sprints/{sprint['id']}", {"endDate": "2000-01-01"}, format="json").status_code == 422
    assert client.patch(f"/api/v1/sprints/{sprint['id']}", {"startDate": None}, format="json").status_code == 422
    task = create_task(owner, project, {"title": "T", "sprintId": sprint["id"]})
    assert client.delete(f"/api/v1/sprints/{sprint['id']}").status_code == 204
    assert Task.objects.get(pk=task.pk).sprint_id is None
    active = Sprint.objects.create(
        project=project, name="A", number=5, start_date="2026-10-01", end_date="2026-10-14", state="active"
    )
    res = client.delete(f"/api/v1/sprints/{active.id}")
    assert res.status_code == 409
    assert res.json()["code"] == "sprint_not_planned"


def test_start_sprint_rules_and_snapshot(owner, project, st):
    client = client_for(owner)
    s1 = client.post(f"/api/v1/projects/{project.id}/sprints", {}, format="json").json()
    s2 = client.post(f"/api/v1/projects/{project.id}/sprints", {}, format="json").json()
    empty = client.post(f"/api/v1/sprints/{s1['id']}/start", {}, format="json")
    assert empty.status_code == 409
    assert empty.json()["code"] == "sprint_empty"
    create_task(owner, project, {"title": "A", "sprintId": s1["id"], "estimate": 3})
    create_task(owner, project, {"title": "B", "sprintId": s1["id"], "estimate": 5})
    create_task(owner, project, {"title": "C", "sprintId": s2["id"]})
    started = client.post(
        f"/api/v1/sprints/{s1['id']}/start",
        {"goal": "Ship it", "startDate": "2026-10-01", "endDate": "2026-10-14"},
        format="json",
    )
    assert started.status_code == 200
    body = started.json()
    assert body["state"] == "active"
    assert body["goal"] == "Ship it"
    assert body["progress"]["points"] == 8
    sprint = Sprint.objects.get(pk=s1["id"])
    assert (sprint.committed_points, sprint.committed_count) == (8, 2)
    second = client.post(f"/api/v1/sprints/{s2['id']}/start", {}, format="json")
    assert second.json()["code"] == "sprint_active"
    again = client.post(f"/api/v1/sprints/{s1['id']}/start", {}, format="json")
    assert again.json()["code"] == "sprint_not_planned"
    assert client.get(f"/api/v1/projects/{project.id}/active-sprint").json()["id"] == s1["id"]
    assert AuditLog.objects.filter(action="sprint.started").exists()
    # Tasks added after the start are scope changes.
    late = create_task(owner, project, {"title": "Late", "estimate": 2})
    assert late.sprint_id == sprint.pk
    assert SprintScopeChange.objects.filter(sprint=sprint, task=late, kind="added").exists()


def test_complete_sprint_carries_over_open_tasks(owner, project, st):
    client = client_for(owner)
    active = Sprint.objects.create(
        project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14", state="active"
    )
    nxt = Sprint.objects.create(project=project, name="S2", number=2, start_date="2026-10-15", end_date="2026-10-28")
    done = create_task(owner, project, {"title": "Done", "statusId": str(st["done"].id)})
    canceled = create_task(owner, project, {"title": "Dropped", "statusId": str(st["canceled"].id)})
    open_task = create_task(owner, project, {"title": "Open", "statusId": str(st["progress"].id)})
    sub = create_task(owner, project, {"title": "Sub", "parentId": str(open_task.id)})
    bad = client.post(f"/api/v1/sprints/{active.id}/complete", {"moveOpenTasksTo": "nope"}, format="json")
    assert bad.status_code == 422
    res = client.post(f"/api/v1/sprints/{active.id}/complete", {"moveOpenTasksTo": str(nxt.id)}, format="json")
    assert res.status_code == 200
    assert res.json()["state"] == "completed"
    assert res.json()["completedAt"] is not None
    assert Task.objects.get(pk=open_task.pk).sprint_id == nxt.pk
    assert Task.objects.get(pk=sub.pk).sprint_id == nxt.pk
    assert Task.objects.get(pk=open_task.pk).version == 2
    assert Task.objects.get(pk=done.pk).sprint_id == active.pk
    assert Task.objects.get(pk=canceled.pk).sprint_id == active.pk
    entry = AuditLog.objects.get(action="sprint.completed")
    assert entry.data == {"sprint": "S1", "moved": 2}
    assert client.post(f"/api/v1/sprints/{active.id}/complete", {}, format="json").json()["code"] == "sprint_not_active"
    assert client.get(f"/api/v1/projects/{project.id}/active-sprint").json() is None


def test_complete_to_backlog(owner, project, st):
    active = Sprint.objects.create(
        project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14", state="active"
    )
    t = create_task(owner, project, {"title": "Open"})
    res = client_for(owner).post(f"/api/v1/sprints/{active.id}/complete", {"moveOpenTasksTo": "backlog"}, format="json")
    assert res.status_code == 200
    assert Task.objects.get(pk=t.pk).sprint_id is None


def test_sprint_board_and_progress(owner, project, st):
    sprint = Sprint.objects.create(
        project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14", state="active"
    )
    create_task(owner, project, {"title": "Done", "statusId": str(st["done"].id), "estimate": 3})
    create_task(owner, project, {"title": "Open", "estimate": 5})
    create_task(owner, project, {"title": "Elsewhere", "sprintId": None})
    client = client_for(owner)
    board = client.get(f"/api/v1/sprints/{sprint.id}/board").json()
    assert board["sprintId"] == str(sprint.id)
    assert {t["title"] for t in board["tasks"]} == {"Done", "Open"}
    detail = client.get(f"/api/v1/sprints/{sprint.id}").json()
    assert detail["progress"] == {"done": 1, "total": 2, "percent": 50, "points": 8, "donePoints": 3}


def test_sprint_permissions(owner, project):
    member = add_project_member(project, key="project_member")
    sprint = Sprint.objects.create(project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14")
    c = client_for(member)
    assert c.get(f"/api/v1/projects/{project.id}/sprints").status_code == 200
    assert c.post(f"/api/v1/projects/{project.id}/sprints", {}, format="json").status_code == 403
    assert c.post(f"/api/v1/sprints/{sprint.id}/start", {}, format="json").status_code == 403
    assert c.patch(f"/api/v1/sprints/{sprint.id}", {"name": "x"}, format="json").status_code == 403
