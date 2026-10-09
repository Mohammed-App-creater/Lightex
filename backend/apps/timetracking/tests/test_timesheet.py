"""Board 39: GET /workspaces/:slug/timesheet (S1)."""

import pytest
from freezegun import freeze_time

from apps.common.testing import UserFactory, add_member, add_project_member, client_for, make_project, make_workspace
from apps.projects.services import delete_project
from apps.tasks.services import create_task, delete_task
from apps.timetracking.models import TimeEntry

pytestmark = pytest.mark.django_db


@pytest.fixture
def prj(ws, owner):
    return make_project(ws, owner, key="PRJ", name="Platform Rebuild")


@pytest.fixture
def inf(ws, owner):
    return make_project(ws, owner, key="INF", name="Infra")


def entry(task, user, minutes, date):
    return TimeEntry.objects.create(
        task=task, project_id=task.project_id, user=user, minutes=minutes, date=date, source="manual"
    )


def sheet(user, query=""):
    return client_for(user).get(f"/api/v1/workspaces/platform/timesheet{query}")


def test_week_snapping_and_shape(owner, prj):
    task = create_task(owner, prj, {"title": "T"})
    entry(task, owner, 60, "2026-10-05")
    entry(task, owner, 30, "2026-10-11")
    entry(task, owner, 45, "2026-10-12")  # next week
    res = sheet(owner, "?filter[week]=2026-10-11")  # a Sunday → its Monday
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["weekStart"] == "2026-10-05"
    assert body["days"] == [f"2026-10-{d:02d}" for d in range(5, 12)]
    assert body["dayTotals"] == [60, 0, 0, 0, 0, 0, 30]
    assert body["totalMinutes"] == 90
    [row] = body["rows"]
    assert row["user"] == {"id": str(owner.id), "name": owner.name, "hue": owner.hue, "avatarUrl": None}
    assert len(row["cells"]) == 7
    assert row["cells"][1] == {"date": "2026-10-06", "minutes": 0, "breakdown": []}
    assert row["totalMinutes"] == 90


def test_week_across_a_month_boundary_and_default_week(owner, prj):
    task = create_task(owner, prj, {"title": "T"})
    entry(task, owner, 60, "2026-09-28")
    entry(task, owner, 60, "2026-10-04")
    body = sheet(owner, "?filter[week]=2026-10-01").json()
    assert body["weekStart"] == "2026-09-28"
    assert body["days"][-1] == "2026-10-04"
    assert body["totalMinutes"] == 120
    with freeze_time("2026-10-01T12:00:00Z"):
        assert sheet(owner).json()["weekStart"] == "2026-09-28"
    res = sheet(owner, "?filter[week]=yesterday")
    assert res.status_code == 422
    assert res.json()["details"]["fields"] == {"filter[week]": "Pick a date"}


def test_breakdown_by_project_and_by_task(owner, prj, inf):
    a = create_task(owner, prj, {"title": "Alpha"})
    b = create_task(owner, prj, {"title": "Beta"})
    c = create_task(owner, inf, {"title": "Cable"})
    day = "2026-10-07"
    entry(a, owner, 120, day)
    entry(b, owner, 180, day)
    entry(c, owner, 90, day)
    body = sheet(owner, "?filter[week]=2026-10-07").json()
    cell = body["rows"][0]["cells"][2]
    assert cell["minutes"] == 390
    assert cell["breakdown"] == [
        {"projectId": str(prj.id), "taskId": None, "key": "PRJ", "name": "Platform Rebuild", "hue": prj.hue,
         "minutes": 300},
        {"projectId": str(inf.id), "taskId": None, "key": "INF", "name": "Infra", "hue": inf.hue, "minutes": 90},
    ]  # fmt: skip
    body = sheet(owner, f"?filter[week]=2026-10-07&filter[project]={prj.id}").json()
    cell = body["rows"][0]["cells"][2]
    assert cell["minutes"] == 300
    assert cell["breakdown"] == [
        {"projectId": str(prj.id), "taskId": str(b.id), "key": b.key, "name": "Beta", "hue": prj.hue, "minutes": 180},
        {"projectId": str(prj.id), "taskId": str(a.id), "key": a.key, "name": "Alpha", "hue": prj.hue, "minutes": 120},
    ]
    # `projects` is never filtered and is name-sorted, with each project's permissions.
    assert [p["key"] for p in body["projects"]] == ["INF", "PRJ"]
    assert "report.view" in body["projects"][0]["my_permissions"]
    assert body["projects"][0]["my_permissions"][0] == "project.view"


def test_breakdown_keeps_top_five_but_full_totals(owner, prj):
    tasks = [create_task(owner, prj, {"title": f"T{i}"}) for i in range(7)]
    for i, t in enumerate(tasks):
        entry(t, owner, 10 * (i + 1), "2026-10-07")
    cell = sheet(owner, f"?filter[week]=2026-10-07&filter[project]={prj.id}").json()["rows"][0]["cells"][2]
    assert cell["minutes"] == sum(10 * (i + 1) for i in range(7))
    assert [s["minutes"] for s in cell["breakdown"]] == [70, 60, 50, 40, 30]


def test_rows_only_people_with_time_sorted_by_name(owner, ws, prj):
    zed = add_project_member(prj, UserFactory(name="zed"))
    amy = add_project_member(prj, UserFactory(name="Amy"))
    add_project_member(prj, UserFactory(name="Idle"))
    task = create_task(owner, prj, {"title": "T"})
    for user in (zed, amy, owner):
        entry(task, user, 60, "2026-10-07")
    body = sheet(owner, "?filter[week]=2026-10-07").json()
    assert [r["user"]["name"] for r in body["rows"]] == ["Alex Kim", "Amy", "zed"]
    assert body["dayTotals"][2] == 180


def test_scope_excludes_deleted_tasks_and_invisible_projects(owner, ws, prj, inf):
    member = add_project_member(prj, key="viewer")
    t1 = create_task(owner, prj, {"title": "Live"})
    t2 = create_task(owner, prj, {"title": "Gone"})
    t3 = create_task(owner, inf, {"title": "Hidden from the viewer"})
    for t in (t1, t2, t3):
        entry(t, owner, 60, "2026-10-07")
    delete_task(owner, t2)
    body = sheet(member, "?filter[week]=2026-10-07").json()
    assert [p["key"] for p in body["projects"]] == ["PRJ"]
    assert body["projects"][0]["my_permissions"] == ["project.view"]
    assert body["totalMinutes"] == 60  # viewers see everyone's time, but only in their projects
    # Archived projects stay in scope; soft-deleted ones drop out.
    client_for(owner).post(f"/api/v1/projects/{inf.id}/archive")
    assert sheet(owner, "?filter[week]=2026-10-07").json()["totalMinutes"] == 120
    delete_project(owner, inf, "INF")
    assert [p["key"] for p in sheet(owner, "?filter[week]=2026-10-07").json()["projects"]] == ["PRJ"]


def test_project_filter_resolution(owner, ws, prj, inf):
    member = add_project_member(prj, key="project_member")
    res = sheet(member, f"?filter[project]={inf.id}")
    assert res.status_code == 403
    assert res.json()["code"] == "project_membership_required"
    assert sheet(member, "?filter[project]=nope").status_code == 404
    elsewhere = make_project(make_workspace(member, slug="elsewhere"), member, key="ELS")
    res = sheet(member, f"?filter[project]={elsewhere.id}")
    assert res.status_code == 404
    # A custom role without project.view gets nothing from that project.
    from apps.access.models import Role
    from apps.projects.models import ProjectMember

    blind = Role.objects.create(workspace=ws, name="Blind", scope="project")
    ProjectMember.objects.filter(project=prj, user=member).update(role=blind)
    res = sheet(member, f"?filter[project]={prj.id}")
    assert res.status_code == 403
    assert sheet(member).json()["projects"] == []


def test_workspace_members_only(owner, ws):
    add_member(ws, UserFactory(name="Plain"), "member")
    outsider = UserFactory()
    make_workspace(outsider, slug="theirs")
    assert sheet(outsider).status_code == 404
