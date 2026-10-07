import pytest
from freezegun import freeze_time

from apps.common.testing import add_project_member, client_for, make_project
from apps.planning.models import Milestone, Objective, Sprint
from apps.planning.sprints import complete_sprint, start_sprint
from apps.tasks.models import Task
from apps.tasks.services import create_task, update_task

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def st(project):
    return {s.glyph: s for s in project.statuses.all()}


def move(owner, task, status, when):
    with freeze_time(when):
        task = Task.objects.get(pk=task.pk)
        return update_task(owner, task, {"statusId": str(status.id), "version": task.version})


def get(owner, url, when="2026-10-04 12:00:00"):
    with freeze_time(when):
        res = client_for(owner).get(url)
    assert res.status_code == 200, res.content
    return res.json()


def test_burndown_replays_scope_and_status(owner, project, st):
    sprint = Sprint.objects.create(project=project, name="S1", number=1, start_date="2026-10-01", end_date="2026-10-05")
    with freeze_time("2026-09-30 09:00:00"):
        a = create_task(owner, project, {"title": "A", "sprintId": str(sprint.id), "estimate": 3})
        create_task(owner, project, {"title": "B", "sprintId": str(sprint.id), "estimate": 2})
        c = create_task(owner, project, {"title": "C", "sprintId": str(sprint.id)})
    with freeze_time("2026-10-01 09:00:00"):
        start_sprint(owner, sprint, {})
    move(owner, a, st["done"], "2026-10-02 10:00:00")
    with freeze_time("2026-10-03 10:00:00"):
        create_task(owner, project, {"title": "D", "estimate": 5})  # joins the active sprint: scope change
    move(owner, c, st["canceled"], "2026-10-03 12:00:00")
    data = get(owner, f"/api/v1/projects/{project.id}/reports/burndown")
    assert data["sprint"]["name"] == "S1"
    assert [p["remaining"] for p in data["points"]] == [6, 3, 7, 7, None]
    assert [p["ideal"] for p in data["points"]] == [6, 4, 3, 2, 0]
    assert [p["date"] for p in data["points"]][0] == "2026-10-01"
    # Completed sprint: carry-over leaves the scope at completion but the history still replays.
    with freeze_time("2026-10-05 18:00:00"):
        complete_sprint(owner, Sprint.objects.get(pk=sprint.pk), "backlog")
    later = get(
        owner, f"/api/v1/projects/{project.id}/reports/burndown?filter[sprint]={sprint.id}", "2026-10-10 12:00:00"
    )
    assert [p["remaining"] for p in later["points"]] == [6, 3, 7, 7, 7]
    empty = get(owner, f"/api/v1/projects/{project.id}/reports/burndown")
    assert empty == {"sprint": None, "points": []}


def test_cycle_time_and_throughput(owner, project, st):
    with freeze_time("2026-09-01 09:00:00"):
        tasks = [create_task(owner, project, {"title": f"T{i}"}) for i in range(4)]
    # T0: 0.5 days, T1: 2.5 days, T2: 10 days in progress; T3 canceled (never counts).
    for i, (start, end) in enumerate(
        [
            ("2026-09-21 09:00", "2026-09-21 21:00"),
            ("2026-09-22 09:00", "2026-09-24 21:00"),
            ("2026-09-14 09:00", "2026-09-24 09:00"),
        ]
    ):
        move(owner, tasks[i], st["progress"], start)
        move(owner, tasks[i], st["done"], end)
    move(owner, tasks[3], st["canceled"], "2026-09-23 09:00")
    url = f"/api/v1/projects/{project.id}/reports"
    ct = get(owner, f"{url}/cycle-time?filter[range]=last90")
    assert ct["total"] == 3
    assert {b["label"]: b["count"] for b in ct["bins"]} == {
        "<1d": 1,
        "1–2d": 0,
        "2–3d": 1,
        "3–5d": 0,
        "5–8d": 0,
        "8d+": 1,
    }
    assert ct["medianDays"] == 2.5
    assert ct["insufficient"] is True
    tp = get(owner, f"{url}/throughput?filter[range]=last2")
    assert len(tp["points"]) == 4
    by_week = {p["week"]: p["done"] for p in tp["points"]}
    assert by_week["2026-09-21"] == 3
    custom = get(owner, f"{url}/throughput?filter[range]=custom&filter[from]=2026-09-14&filter[to]=2026-09-27")
    assert [p["week"] for p in custom["points"]] == ["2026-09-14", "2026-09-21"]
    assert (
        get(owner, f"{url}/cycle-time?filter[range]=custom&filter[from]=2026-09-01&filter[to]=2026-09-21")["total"] == 1
    )
    with freeze_time("2026-10-04"):
        client = client_for(owner)
        assert client.get(f"{url}/cycle-time?filter[range]=bogus").status_code == 422
        assert client.get(f"{url}/throughput?filter[range]=custom").status_code == 422
        assert (
            client.get(f"{url}/velocity?filter[range]=custom&filter[from]=2026-10-02&filter[to]=2026-10-01").status_code
            == 422
        )


def test_velocity_uses_commitment_snapshots(owner, project, st):
    for n in (1, 2, 3, 4):
        sprint = Sprint.objects.create(
            project=project, name=f"S{n}", number=n, start_date=f"2026-0{n + 4}-01", end_date=f"2026-0{n + 4}-14"
        )
        with freeze_time(f"2026-0{n + 4}-01 09:00:00"):
            done = create_task(owner, project, {"title": f"done{n}", "sprintId": str(sprint.id), "estimate": n})
            create_task(owner, project, {"title": f"open{n}", "sprintId": str(sprint.id), "estimate": 2})
            start_sprint(owner, sprint, {})
        move(owner, done, st["done"], f"2026-0{n + 4}-05 09:00:00")
        with freeze_time(f"2026-0{n + 4}-14 18:00:00"):
            complete_sprint(owner, Sprint.objects.get(pk=sprint.pk), "backlog")
    url = f"/api/v1/projects/{project.id}/reports/velocity"
    data = get(owner, url + "?filter[range]=last2")
    assert data["points"] == [
        {"sprint": "S3", "committed": 5, "completed": 3},
        {"sprint": "S4", "committed": 6, "completed": 4},
    ]
    assert data["insufficient"] is True
    assert data["completedSprints"] == 4
    six = get(owner, url)
    assert [p["sprint"] for p in six["points"]] == ["S1", "S2", "S3", "S4"]
    assert six["insufficient"] is False
    custom = get(owner, url + "?filter[range]=custom&filter[from]=2026-06-01&filter[to]=2026-07-31")
    assert [p["sprint"] for p in custom["points"]] == ["S2", "S3"]


def test_kpis_progress_and_summary(owner, project, st):
    sprint = Sprint.objects.create(
        project=project, name="Sprint 14", number=14, start_date="2026-10-01", end_date="2026-10-14"
    )
    with freeze_time("2026-09-30 09:00:00"):
        a = create_task(
            owner, project, {"title": "A", "sprintId": str(sprint.id), "estimate": 3, "dueDate": "2026-10-01"}
        )
        create_task(owner, project, {"title": "B", "sprintId": str(sprint.id), "estimate": 2, "dueDate": "2026-09-28"})
    with freeze_time("2026-10-01 09:00:00"):
        start_sprint(owner, sprint, {})
    move(owner, a, st["progress"], "2026-10-02 09:00:00")
    move(owner, a, st["done"], "2026-10-03 09:00:00")
    with freeze_time("2026-10-03 12:00:00"):
        create_task(owner, project, {"title": "Late", "estimate": 5, "dueDate": "2026-10-08"})
    url = f"/api/v1/projects/{project.id}"
    k = get(owner, f"{url}/reports/kpis")
    assert k["sprint"] == {
        "name": "Sprint 14",
        "number": 14,
        "startDate": "2026-10-01",
        "endDate": "2026-10-14",
        "dayIndex": 4,
        "lengthDays": 14,
    }
    assert (k["completedThisSprint"], k["plannedThisSprint"]) == (1, 3)
    assert k["avgCycleTimeDays"] == 1.0
    assert k["p85CycleTimeDays"] == 1.0
    assert k["overdueCount"] == 1
    assert k["oldestOverdueKey"] == "PRJ-2"
    assert k["scopeChangePts"] == 5
    assert k["completedSprints"] == 0
    s = get(owner, f"{url}/summary")
    assert s == {"openTasks": 2, "doneThisSprint": 1, "cycleTimeDays": 1.0, "dueThisWeek": 2}
    with freeze_time("2026-09-01"):
        Objective.objects.create(project=project, title="Ship beta", due_date="2026-11-01")
    Milestone.objects.create(
        project=project,
        name="Beta",
        start_date="2026-10-01",
        due_date="2026-10-11",
        completed_at="2026-10-02T00:00:00Z",
    )
    rows = get(owner, f"{url}/reports/progress")
    assert [(r["kind"], r["name"]) for r in rows] == [("objective", "Ship beta"), ("milestone", "Beta")]
    assert rows[0]["expected"] == 54  # 33 of 61 days elapsed
    assert rows[1]["percent"] == 100
    assert rows[1]["expected"] == 30
    assert rows[1]["dueDate"] == "2026-10-11"


def test_no_active_sprint_kpis(owner, project):
    k = get(owner, f"/api/v1/projects/{project.id}/reports/kpis")
    assert k["sprint"] is None
    assert k["avgCycleTimeDays"] == 0
    assert get(owner, f"/api/v1/projects/{project.id}/summary")["doneThisSprint"] == 0


def test_reports_need_report_view(owner, project):
    viewer = add_project_member(project, key="viewer")
    with freeze_time("2026-10-04"):
        client = client_for(viewer)
        assert client.get(f"/api/v1/projects/{project.id}/reports/kpis").status_code == 403
        assert client.get(f"/api/v1/projects/{project.id}/summary").status_code == 200
        assert client.get(f"/api/v1/projects/{project.id}/reports/burndown?filter[sprint]=nope").status_code == 403
    member = add_project_member(project, key="project_member")
    with freeze_time("2026-10-04"):
        res = client_for(member).get(f"/api/v1/projects/{project.id}/reports/burndown?filter[sprint]=nope")
    assert res.status_code == 404
