"""W1 workload report and ProgressRow.quarter (docs/v2/33-dashboards-presence.md §5.4)."""

import datetime as dt

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.common.testing import UserFactory, add_project_member, client_for, make_project
from apps.planning.models import Milestone, Objective, Sprint
from apps.projects.custom_fields import create_field
from apps.projects.models import ProjectMember
from apps.reports.services import nice_max
from apps.tasks.models import Task, TaskFieldValue
from apps.tasks.services import create_task
from apps.timetracking.models import TimeEntry

pytestmark = pytest.mark.django_db


class W:
    def __init__(self, ws, owner):
        self.owner = owner
        self.project = make_project(ws, owner, key="PRJ", template="scrum")
        self.st = {s.glyph: s for s in self.project.statuses.all()}
        self.alex = owner
        self.sam = add_project_member(self.project, UserFactory(name="Sam Patel"), key="project_member")
        self.zed = add_project_member(self.project, UserFactory(name="zed Quinn"), key="viewer")
        self.sprint = Sprint.objects.create(
            project=self.project,
            name="Sprint 14",
            number=14,
            start_date="2026-10-01",
            end_date="2026-10-14",
            state="active",
        )
        self.url = f"/api/v1/projects/{self.project.pk}/reports/workload"

    def task(self, glyph="todo", who=None, estimate=None, sprint="active", minutes=None, parent=None):
        sprint = self.sprint if sprint == "active" else sprint
        data = {"title": "t", "statusId": str(self.st[glyph].pk), "estimate": estimate}
        if who is not None:
            data["assigneeId"] = str(who.pk)
        if parent is not None:
            data["parentId"] = str(parent.pk)
        elif sprint is None:
            data["sprintId"] = None  # new tasks join the active sprint by default
        t = create_task(self.owner, self.project, data)
        if sprint is not None and parent is None and sprint != self.sprint:
            Task.objects.filter(pk=t.pk).update(sprint=sprint)  # completed sprints can't be picked through the API
        if minutes is not None:
            Task.objects.filter(pk=t.pk).update(time_estimate_minutes=minutes)
        return t

    def completed(self, number, start, end):
        return Sprint.objects.create(
            project=self.project,
            name=f"Sprint {number}",
            number=number,
            start_date=start,
            end_date=end,
            state="completed",
        )

    def get(self, query="", user=None):
        res = client_for(user or self.owner).get(self.url + query)
        assert res.status_code == 200, res.content
        return res.json()


@pytest.fixture
def w(ws, owner):
    return W(ws, owner)


def _rows(body):
    return [(r["user"]["name"], r["inProgress"], r["todo"], r["capacity"], r["unestimated"]) for r in body["rows"]]


def test_no_sprint(w):
    w.sprint.state = "planned"
    w.sprint.save()
    assert w.get() == {
        "sprint": None, "unit": "points", "personField": None, "scale": 0, "rows": [],
        "unassigned": {"inProgress": 0, "todo": 0, "unestimated": 0},
    }  # fmt: skip


def test_points_without_history(w):
    w.task("progress", w.alex, 5)
    w.task("review", w.alex, 1)
    w.task("todo", w.alex, 6)
    w.task("todo", w.sam, 6)
    w.task("todo", w.sam)  # unestimated
    w.task("done", w.sam, 8)  # done and canceled don't count
    w.task("canceled", w.sam, 8)
    w.task("todo", None, 3)
    w.task("backlog", None)
    w.task("todo", w.sam, 9, sprint=None)  # not in the sprint
    parent = w.task("progress", w.sam, 2)
    w.task("todo", w.sam, 1, parent=parent)  # sub-tasks count separately
    body = w.get()
    assert body["sprint"] == {
        "id": str(w.sprint.pk),
        "name": "Sprint 14",
        "number": 14,
        "startDate": "2026-10-01",
        "endDate": "2026-10-14",
    }
    assert body["unit"] == "points" and body["personField"] is None
    assert _rows(body) == [(w.alex.name, 6, 6, None, 0), ("Sam Patel", 2, 7, None, 1)]
    assert body["rows"][0]["user"] == {"id": str(w.alex.pk), "name": w.alex.name, "hue": w.alex.hue, "avatarUrl": None}
    assert body["unassigned"] == {"inProgress": 0, "todo": 3, "unestimated": 1}
    assert body["scale"] == 12


def test_capacity_from_the_last_three_completed_sprints(w):
    s10 = w.completed(10, "2026-08-20", "2026-08-31")
    s11 = w.completed(11, "2026-09-01", "2026-09-14")
    s12 = w.completed(12, "2026-09-15", "2026-09-30")
    old = w.completed(9, "2026-08-01", "2026-08-14")
    w.task("done", w.alex, 9, sprint=old)  # the 4th completed sprint back is ignored
    w.task("done", w.alex, 10, sprint=s10)
    w.task("done", w.alex, 8, sprint=s11)
    w.task("done", w.alex, 12, sprint=s12)
    w.task("canceled", w.alex, 20, sprint=s12)
    w.task("todo", w.alex, 7, sprint=s12)  # not completed
    w.task("done", w.sam, 4, sprint=s12)
    w.task("todo", w.alex, 3)
    body = w.get()
    # alex: (10 + 8 + 12) / 3 = 10; sam: 4 / 3 = 1.33 → 1; zed (no work, a member): 0
    assert _rows(body) == [(w.alex.name, 0, 3, 10, 0), ("Sam Patel", 0, 0, 1, 0), ("zed Quinn", 0, 0, 0, 0)]
    assert body["scale"] == 10


def test_capacity_with_one_completed_sprint_rounds_half_up(w):
    s = w.completed(13, "2026-09-15", "2026-09-30")
    w.task("done", w.sam, 5, sprint=s)
    body = w.get()
    assert [r["capacity"] for r in body["rows"]] == [0, 5, 0]
    s2 = w.completed(12, "2026-09-01", "2026-09-14")
    assert s2 and [r["capacity"] for r in w.get()["rows"]] == [0, 3, 0]  # 5 / 2 = 2.5 → 3


def test_hours(w):
    s = w.completed(13, "2026-09-15", "2026-09-30")
    a = w.task("progress", w.alex, minutes=300)
    b = w.task("todo", w.sam, minutes=60)
    w.task("todo", w.sam)  # no time estimate
    history = w.task("done", w.alex, sprint=s)
    for task, user, minutes, day in [
        (a, w.alex, 120, "2026-10-02"),  # remaining 180
        (b, w.sam, 90, "2026-10-02"),  # over the estimate: 0 remaining
        (history, w.alex, 240, "2026-09-20"),  # in the completed sprint: capacity
        (history, w.alex, 600, "2026-08-01"),  # outside every completed sprint
    ]:
        TimeEntry.objects.create(task=task, project=w.project, user=user, minutes=minutes, date=day, source="manual")
    assert s
    body = w.get("?filter[unit]=hours")
    assert body["unit"] == "hours"
    assert _rows(body) == [(w.alex.name, 180, 0, 240, 0), ("Sam Patel", 0, 0, 0, 1), ("zed Quinn", 0, 0, 0, 0)]
    assert body["scale"] == 240


def test_person_field(w):
    reviewer = create_field(w.owner, w.project, {"name": "Reviewer", "type": "user"})
    note = create_field(w.owner, w.project, {"name": "Note", "type": "text"})
    a = w.task("todo", w.alex, 4)
    w.task("progress", w.alex, 2)
    TaskFieldValue.objects.create(task=a, field=reviewer, user=w.sam)
    body = w.get(f"?filter[person]={reviewer.pk}")
    assert body["personField"] == {"id": str(reviewer.pk), "name": "Reviewer"}
    assert _rows(body) == [("Sam Patel", 0, 4, None, 0)]
    assert body["unassigned"] == {"inProgress": 2, "todo": 0, "unestimated": 0}
    assert w.get("?filter[person]=assignee")["personField"] is None
    for bad in (note.pk, "nope", "00000000-0000-0000-0000-000000000000"):
        res = client_for(w.owner).get(f"{w.url}?filter[person]={bad}")
        assert res.status_code == 422
        assert res.json()["details"]["fields"] == {"filter[person]": "Pick a person field from this project"}


def test_former_members_with_work_are_kept(w):
    w.task("todo", w.sam, 2)
    ProjectMember.objects.filter(project=w.project, user=w.sam).delete()
    assert _rows(w.get()) == [("Sam Patel", 0, 2, None, 0)]


def test_errors_and_permission(w):
    owner = client_for(w.owner)
    res = owner.get(f"{w.url}?filter[unit]=days")
    assert res.status_code == 422 and res.json()["details"]["fields"] == {"filter[unit]": "Pick points or hours"}
    res = owner.get(f"{w.url}?filter[sprint]=00000000-0000-0000-0000-000000000000")
    assert res.status_code == 404 and res.json()["message"] == "Sprint not found."
    other = Sprint.objects.create(
        project=w.project, name="Next", number=15, start_date="2026-10-15", end_date="2026-10-28"
    )
    w.task("todo", w.sam, 3, sprint=other)
    assert _rows(w.get(f"?filter[sprint]={other.pk}")) == [("Sam Patel", 0, 3, None, 0)]
    assert client_for(w.zed).get(w.url).status_code == 403  # viewer: no report.view


def test_constant_query_count(w):
    def count():
        with CaptureQueriesContext(connection) as ctx:
            w.get()
        return len(ctx.captured_queries)

    s = w.completed(13, "2026-09-15", "2026-09-30")
    for i in range(5):
        w.task("todo" if i % 2 else "progress", w.sam if i % 2 else w.alex, i)
        w.task("done", w.alex, 2, sprint=s)
    small = count()
    for i in range(45):
        w.task("todo" if i % 2 else "progress", w.sam if i % 2 else w.alex, i)
        w.task("done", w.sam, 2, sprint=s)
    assert count() == small


def test_nice_max():
    assert [nice_max(v, 2) for v in (0, -1, 1, 2, 11, 14)] == [0, 0, 2, 2, 12, 14]
    assert [nice_max(v, 120) for v in (1, 120, 121)] == [120, 120, 240]


def test_progress_rows_carry_the_quarter(w):
    Objective.objects.create(project=w.project, title="Ship beta", quarter="Q4", due_date=dt.date(2026, 12, 1))
    Objective.objects.create(project=w.project, title="No quarter")
    Milestone.objects.create(project=w.project, name="Beta", start_date="2026-10-01", due_date="2026-11-01")
    rows = client_for(w.owner).get(f"/api/v1/projects/{w.project.pk}/reports/progress").json()
    assert {(r["kind"], r["name"]): r["quarter"] for r in rows} == {
        ("objective", "Ship beta"): "Q4",
        ("objective", "No quarter"): None,
        ("milestone", "Beta"): None,
    }
