import datetime as dt

import pytest
from freezegun import freeze_time

from apps.audit.models import AuditLog
from apps.common.testing import UserFactory, add_project_member, client_for, make_project
from apps.planning.models import Epic, Milestone, Objective
from apps.planning.selectors import expected_percent, progress
from apps.tasks.models import Task
from apps.tasks.services import create_task, delete_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def st(project):
    return {s.glyph: s for s in project.statuses.all()}


def tasks_in(owner, project, st, glyphs):
    return [create_task(owner, project, {"title": f"T{i}", "statusId": str(st[g].id)}) for i, g in enumerate(glyphs)]


def test_progress_helpers():
    assert progress(0, 0) == {"done": 0, "total": 0, "percent": 0}
    assert progress(1, 3) == {"done": 1, "total": 3, "percent": 33}
    assert expected_percent(dt.date(2026, 10, 1), dt.date(2026, 10, 11), dt.date(2026, 10, 6)) == 50
    assert expected_percent(dt.date(2026, 10, 1), dt.date(2026, 10, 11), dt.date(2026, 9, 1)) == 0
    assert expected_percent(dt.date(2026, 10, 1), dt.date(2026, 10, 11), dt.date(2026, 12, 1)) == 100
    assert expected_percent(dt.date(2026, 10, 1), dt.date(2026, 10, 1), dt.date(2026, 10, 1)) == 100
    assert expected_percent(dt.date(2026, 10, 2), dt.date(2026, 10, 1), dt.date(2026, 9, 1)) == 0


def test_objective_crud_links_and_progress(owner, project, st):
    client = client_for(owner)
    res = client.post(
        f"/api/v1/projects/{project.id}/objectives", {"title": "Ship beta", "dueDate": "2026-12-15"}, format="json"
    )
    assert res.status_code == 201
    objective = res.json()
    assert objective["quarter"] == "Q4"
    assert objective["ownerId"] == str(owner.id)
    assert objective["progress"] == {"done": 0, "total": 0, "percent": 0}
    done, doing, canceled, deleted = tasks_in(owner, project, st, ["done", "progress", "canceled", "done"])
    delete_task(owner, deleted)
    linked = client.post(
        f"/api/v1/objectives/{objective['id']}/tasks",
        {"taskIds": [str(done.id), str(doing.id), str(canceled.id)]},
        format="json",
    ).json()
    assert sorted(linked["taskIds"]) == sorted([str(done.id), str(doing.id), str(canceled.id)])
    # Canceled tasks don't count; only done-category work does.
    assert linked["progress"] == {"done": 1, "total": 2, "percent": 50}
    assert Task.objects.get(pk=done.pk).version == 2
    assert AuditLog.objects.filter(action="task.objective_linked").count() == 3
    # Linking again is a no-op.
    again = client.post(f"/api/v1/objectives/{objective['id']}/tasks", {"taskIds": [str(done.id)]}, format="json")
    assert again.json()["progress"]["total"] == 2
    unlinked = client.delete(f"/api/v1/objectives/{objective['id']}/tasks/{doing.id}")
    assert unlinked.status_code == 200
    assert unlinked.json()["progress"] == {"done": 1, "total": 1, "percent": 100}
    patched = client.patch(
        f"/api/v1/objectives/{objective['id']}",
        {"title": "Ship GA", "status": "achieved", "description": "x"},
        format="json",
    ).json()
    assert patched["title"] == "Ship GA"
    assert patched["status"] == "achieved"
    assert client.get(f"/api/v1/objectives/{objective['id']}").json()["title"] == "Ship GA"
    assert len(client.get(f"/api/v1/projects/{project.id}/objectives").json()) == 1
    assert client.delete(f"/api/v1/objectives/{objective['id']}").status_code == 204
    assert not Objective.objects.exists()
    assert Task.objects.get(pk=done.pk).objectives.count() == 0


def test_objective_validation(owner, ws, project):
    client = client_for(owner)
    assert (
        client.post(
            f"/api/v1/projects/{project.id}/objectives", {"title": "", "dueDate": "x"}, format="json"
        ).status_code
        == 422
    )
    o = client.post(
        f"/api/v1/projects/{project.id}/objectives", {"title": "O", "dueDate": "2026-12-01"}, format="json"
    ).json()
    other = make_project(ws, owner, key="OTH")
    foreign = create_task(owner, other, {"title": "Elsewhere"})
    assert (
        client.post(f"/api/v1/objectives/{o['id']}/tasks", {"taskIds": [str(foreign.id)]}, format="json").status_code
        == 422
    )
    assert client.post(f"/api/v1/objectives/{o['id']}/tasks", {"taskIds": "x"}, format="json").status_code == 422
    assert client.patch(f"/api/v1/objectives/{o['id']}", {"status": "done"}, format="json").status_code == 422
    assert (
        client.patch(f"/api/v1/objectives/{o['id']}", {"ownerId": str(UserFactory().id)}, format="json").status_code
        == 422
    )
    assert client.patch(f"/api/v1/objectives/{o['id']}", {"dueDate": None}, format="json").status_code == 422


@freeze_time("2026-10-11")
def test_milestone_progress_expected_and_risk(owner, project, st):
    client = client_for(owner)
    res = client.post(
        f"/api/v1/projects/{project.id}/milestones",
        {"name": "Beta launch", "startDate": "2026-10-01", "dueDate": "2026-10-21"},
        format="json",
    )
    assert res.status_code == 201
    m = res.json()
    assert m["progress"]["expected"] == 50
    assert m["progress"]["atRisk"] is True  # nothing done, half the window gone
    done, doing = tasks_in(owner, project, st, ["done", "todo"])
    linked = client.patch(
        f"/api/v1/milestones/{m['id']}", {"taskIds": [str(done.id), str(doing.id)]}, format="json"
    ).json()
    assert linked["progress"]["percent"] == 50
    assert linked["progress"]["atRisk"] is False
    assert Task.objects.get(pk=done.pk).milestone_id is not None
    # Replacing the set unlinks the others.
    client.patch(f"/api/v1/milestones/{m['id']}", {"taskIds": [str(done.id)]}, format="json")
    assert Task.objects.get(pk=doing.pk).milestone_id is None
    completed = client.patch(f"/api/v1/milestones/{m['id']}", {"completed": True}, format="json").json()
    assert completed["progress"]["percent"] == 100
    assert completed["completedAt"] is not None
    reopened = client.patch(f"/api/v1/milestones/{m['id']}", {"completed": False}, format="json").json()
    assert reopened["completedAt"] is None


def test_milestone_dates_and_delete(owner, project, st):
    with freeze_time("2026-10-07"):
        m = (
            client_for(owner)
            .post(f"/api/v1/projects/{project.id}/milestones", {"name": "M", "dueDate": "2026-11-01"}, format="json")
            .json()
        )
    assert m["startDate"] == "2026-10-07"
    client = client_for(owner)
    assert client.post(f"/api/v1/projects/{project.id}/milestones", {"name": "M"}, format="json").status_code == 422
    bad = client.post(
        f"/api/v1/projects/{project.id}/milestones",
        {"name": "M", "startDate": "2026-12-01", "dueDate": "2026-11-01"},
        format="json",
    )
    assert bad.status_code == 422
    # Pulling the due date before the start drags the start with it.
    moved = client.patch(
        f"/api/v1/milestones/{m['id']}", {"dueDate": "2026-10-01", "name": "Renamed"}, format="json"
    ).json()
    assert moved["startDate"] == moved["dueDate"] == "2026-10-01"
    assert client.patch(f"/api/v1/milestones/{m['id']}", {"startDate": "2026-12-01"}, format="json").status_code == 422
    task = create_task(owner, project, {"title": "T", "milestoneId": m["id"]})
    epic = Epic.objects.create(project=project, name="E", milestone_id=m["id"])
    assert client.get(f"/api/v1/milestones/{m['id']}").json()["taskIds"] == [str(task.id)]
    assert client.delete(f"/api/v1/milestones/{m['id']}").status_code == 204
    assert Task.objects.get(pk=task.pk).milestone_id is None
    epic.refresh_from_db()
    assert epic.milestone_id is None
    assert not Milestone.objects.exists()


def test_epic_crud_rules(owner, ws, project, st):
    client = client_for(owner)
    ms = Milestone.objects.create(project=project, name="M", start_date="2026-10-01", due_date="2026-11-01")
    res = client.post(
        f"/api/v1/projects/{project.id}/epics",
        {"name": "Billing", "hue": 200, "milestoneId": str(ms.id), "description": "Payments"},
        format="json",
    )
    assert res.status_code == 201
    epic = res.json()
    assert epic["ownerId"] == str(owner.id)
    assert epic["milestoneId"] == str(ms.id)
    assert client.post(f"/api/v1/projects/{project.id}/epics", {"name": "billing"}, format="json").status_code == 422
    other = make_project(ws, owner, key="OTH")
    foreign_ms = Milestone.objects.create(project=other, name="X", start_date="2026-10-01", due_date="2026-11-01")
    bad = client.post(
        f"/api/v1/projects/{project.id}/epics",
        {"name": "New", "milestoneId": str(foreign_ms.id), "hue": 999, "ownerId": str(UserFactory().id)},
        format="json",
    )
    assert set(bad.json()["details"]["fields"]) == {"milestoneId", "hue", "ownerId"}
    done, todo = tasks_in(owner, project, st, ["done", "todo"])
    for t in (done, todo):
        client.patch(f"/api/v1/tasks/{t.id}", {"epicId": epic["id"], "version": 1}, format="json")
    assert client.get(f"/api/v1/epics/{epic['id']}").json()["progress"] == {"done": 1, "total": 2, "percent": 50}
    archived = client.patch(f"/api/v1/epics/{epic['id']}", {"archived": True, "name": "Payments"}, format="json").json()
    assert archived["archivedAt"] is not None
    assert archived["name"] == "Payments"
    assert client.patch(f"/api/v1/epics/{epic['id']}", {"archived": False}, format="json").json()["archivedAt"] is None
    assert client.delete(f"/api/v1/epics/{epic['id']}").status_code == 204
    assert Task.objects.get(pk=done.pk).epic_id is None
    assert len(client.get(f"/api/v1/projects/{project.id}/epics").json()) == 0


def test_planning_permissions(owner, project):
    member = add_project_member(project, key="project_member")
    c = client_for(member)
    assert c.get(f"/api/v1/projects/{project.id}/objectives").status_code == 200
    assert (
        c.post(
            f"/api/v1/projects/{project.id}/objectives", {"title": "x", "dueDate": "2026-12-01"}, format="json"
        ).status_code
        == 403
    )
    assert c.post(f"/api/v1/projects/{project.id}/epics", {"name": "x"}, format="json").status_code == 403
    assert (
        c.post(
            f"/api/v1/projects/{project.id}/milestones", {"name": "x", "dueDate": "2026-12-01"}, format="json"
        ).status_code
        == 403
    )
    epic = Epic.objects.create(project=project, name="E")
    assert c.patch(f"/api/v1/epics/{epic.id}", {"name": "Y"}, format="json").status_code == 403
    outsider = UserFactory()
    assert client_for(outsider).get(f"/api/v1/epics/{epic.id}").status_code == 404
