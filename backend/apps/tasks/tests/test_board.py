import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.audit.models import AuditLog
from apps.common import fractional
from apps.common.testing import add_project_member, client_for, make_project
from apps.planning.models import Sprint, SprintScopeChange
from apps.tasks.models import Task, TaskStatusHistory
from apps.tasks.services import create_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def st(project):
    return {s.glyph: s for s in project.statuses.all()}


def test_board_active_sprint_all_and_specific(owner, project, st):
    sprint = Sprint.objects.create(
        project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14", state="active"
    )
    planned = Sprint.objects.create(
        project=project, name="S2", number=2, start_date="2026-10-15", end_date="2026-10-28"
    )
    in_sprint = create_task(owner, project, {"title": "In sprint"})
    create_task(owner, project, {"title": "Sub", "parentId": str(in_sprint.id)})
    create_task(owner, project, {"title": "Backlog item", "sprintId": None, "statusId": str(st["backlog"].id)})
    create_task(owner, project, {"title": "Unscheduled todo", "sprintId": None})
    create_task(owner, project, {"title": "Planned", "sprintId": str(planned.id)})
    client = client_for(owner)
    board = client.get(f"/api/v1/projects/{project.id}/board").json()
    assert board["sprintId"] == str(sprint.id)
    assert [t["title"] for t in board["tasks"]] == ["In sprint"]  # subtasks are not cards
    assert [s["name"] for s in board["statuses"]][:2] == ["Backlog", "Todo"]
    everything = client.get(f"/api/v1/projects/{project.id}/board?filter[sprint]=all").json()
    assert everything["sprintId"] is None
    assert {t["title"] for t in everything["tasks"]} == {"In sprint", "Unscheduled todo", "Planned"}
    specific = client.get(f"/api/v1/projects/{project.id}/board?filter[sprint]={planned.id}").json()
    assert [t["title"] for t in specific["tasks"]] == ["Planned"]
    assert client.get(f"/api/v1/projects/{project.id}/board?filter[sprint]=nope").status_code == 404


def test_board_without_active_sprint_hides_backlog_status(owner, project, st):
    create_task(owner, project, {"title": "Triage", "statusId": str(st["backlog"].id)})
    create_task(owner, project, {"title": "Ready"})
    board = client_for(owner).get(f"/api/v1/projects/{project.id}/board").json()
    assert board["sprintId"] is None
    assert [t["title"] for t in board["tasks"]] == ["Ready"]


def test_board_query_count_is_flat(owner, project):
    for i in range(15):
        create_task(owner, project, {"title": f"T{i}"})
    client = client_for(owner)
    client.get(f"/api/v1/projects/{project.id}/board?filter[sprint]=all")
    with CaptureQueriesContext(connection) as small:
        client.get(f"/api/v1/projects/{project.id}/board?filter[sprint]=all")
    for i in range(15):
        create_task(owner, project, {"title": f"More {i}"})
    with CaptureQueriesContext(connection) as big:
        client.get(f"/api/v1/projects/{project.id}/board?filter[sprint]=all")
    assert len(big.captured_queries) == len(small.captured_queries)


def test_backlog_groups_by_sprint(owner, project):
    active = Sprint.objects.create(
        project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14", state="active"
    )
    planned = Sprint.objects.create(
        project=project, name="S2", number=2, start_date="2026-10-15", end_date="2026-10-28"
    )
    Sprint.objects.create(
        project=project, name="S0", number=0, start_date="2026-09-01", end_date="2026-09-14", state="completed"
    )
    create_task(owner, project, {"title": "A"})
    create_task(owner, project, {"title": "B", "sprintId": str(planned.id)})
    create_task(owner, project, {"title": "C", "sprintId": None})
    data = client_for(owner).get(f"/api/v1/projects/{project.id}/backlog").json()
    assert [g["sprintId"] for g in data["sprints"]] == [str(active.id), str(planned.id)]
    assert [t["title"] for t in data["sprints"][0]["tasks"]] == ["A"]
    assert [t["title"] for t in data["backlog"]] == ["C"]


def test_move_between_columns_updates_one_row(owner, project, st):
    a = create_task(owner, project, {"title": "A"})
    b = create_task(owner, project, {"title": "B"})
    client = client_for(owner)
    position = fractional.key_between(None, b.position)
    with CaptureQueriesContext(connection) as ctx:
        res = client.post(
            f"/api/v1/tasks/{a.id}/move",
            {"statusId": str(st["progress"].id), "position": position, "version": a.version},
            format="json",
        )
    assert res.status_code == 200, res.content
    assert res.json()["statusId"] == str(st["progress"].id)
    assert res.json()["position"] == position
    assert res.json()["version"] == 2
    updates = [q["sql"] for q in ctx.captured_queries if q["sql"].startswith('UPDATE "tasks_task"')]
    assert len(updates) == 1
    assert Task.objects.get(pk=b.pk).version == 1  # neighbours untouched
    assert TaskStatusHistory.objects.filter(task=a, to_status=st["progress"]).exists()
    assert AuditLog.objects.filter(action="task.status_changed", task=a).exists()


def test_move_reorders_within_column(owner, project):
    tasks = [create_task(owner, project, {"title": f"T{i}"}) for i in range(3)]
    client = client_for(owner)
    last = tasks[2]
    pos = fractional.key_between(None, tasks[0].position)
    client.post(f"/api/v1/tasks/{last.id}/move", {"position": pos, "version": 1}, format="json")
    board = client.get(f"/api/v1/projects/{project.id}/board?filter[sprint]=all").json()
    assert [t["title"] for t in board["tasks"]] == ["T2", "T0", "T1"]


def test_move_conflicts_and_validation(owner, project):
    t = create_task(owner, project, {"title": "T"})
    client = client_for(owner)
    ok = client.post(f"/api/v1/tasks/{t.id}/move", {"position": "V", "version": 1}, format="json")
    assert ok.status_code == 200
    stale = client.post(f"/api/v1/tasks/{t.id}/move", {"position": "W", "version": 1}, format="json")
    assert stale.status_code == 409
    assert stale.json()["code"] == "version_conflict"
    assert stale.json()["details"]["current"]["position"] == "V"
    for bad in ["", "a0", "a b", "x" * 70, 5, None]:
        res = client.post(f"/api/v1/tasks/{t.id}/move", {"position": bad, "version": 2}, format="json")
        assert res.status_code == 422, bad
    assert client.post(f"/api/v1/tasks/{t.id}/move", {"position": "W"}, format="json").status_code == 422


def test_move_into_sprint_tracks_scope_change(owner, project):
    sprint = Sprint.objects.create(
        project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-14", state="active"
    )
    t = create_task(owner, project, {"title": "Late", "sprintId": None, "estimate": 3})
    client = client_for(owner)
    res = client.post(
        f"/api/v1/tasks/{t.id}/move", {"sprintId": str(sprint.id), "position": "V", "version": 1}, format="json"
    )
    assert res.json()["sprintId"] == str(sprint.id)
    change = SprintScopeChange.objects.get(sprint=sprint, task=t)
    assert change.kind == "added"
    assert change.estimate == 3
    back = client.post(f"/api/v1/tasks/{t.id}/move", {"sprintId": None, "position": "V", "version": 2}, format="json")
    assert back.json()["sprintId"] is None
    assert SprintScopeChange.objects.filter(sprint=sprint, task=t, kind="removed").exists()


def test_move_requires_task_move(owner, project):
    t = create_task(owner, project, {"title": "T"})
    viewer = add_project_member(project, key="viewer")
    res = client_for(viewer).post(f"/api/v1/tasks/{t.id}/move", {"position": "V", "version": 1}, format="json")
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "task.move"


def test_long_keys_trigger_rebalance(owner, project, st):
    tasks = [create_task(owner, project, {"title": f"T{i}"}) for i in range(3)]
    Task.objects.filter(pk=tasks[0].pk).update(position="V")
    Task.objects.filter(pk=tasks[1].pk).update(position="V" + "0" * 23 + "1")
    long_key = fractional.key_between("V", "V" + "0" * 23 + "1")
    assert len(long_key) > fractional.REBALANCE_LENGTH
    res = client_for(owner).post(
        f"/api/v1/tasks/{tasks[2].id}/move", {"position": long_key, "version": 1}, format="json"
    )
    assert res.status_code == 200
    rows = list(Task.objects.filter(project=project, status=st["todo"]).order_by("position"))
    assert [r.pk for r in rows] == [tasks[0].pk, tasks[2].pk, tasks[1].pk]
    assert all(len(r.position) <= 3 for r in rows)
