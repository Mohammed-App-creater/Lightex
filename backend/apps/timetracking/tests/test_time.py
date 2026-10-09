"""Board 39: time entries (E1–E3) and the timer (R1–R3)."""

import datetime as dt

import pytest
from freezegun import freeze_time

from apps.audit.models import AuditLog
from apps.common.testing import UserFactory, add_project_member, client_for, make_project, make_workspace
from apps.projects.models import ProjectMember
from apps.tasks.models import Task
from apps.tasks.services import create_task, delete_task
from apps.timetracking.models import RunningTimer, TimeEntry

pytestmark = pytest.mark.django_db

NOW = "2026-10-07T09:00:00Z"
TODAY = "2026-10-07"


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


@pytest.fixture
def task(owner, project):
    return create_task(owner, project, {"title": "Fix flaky board reflow"})


def entries_url(task) -> str:
    return f"/api/v1/tasks/{task.id}/time-entries"


def log(client, task, **body):
    return client.post(entries_url(task), {"minutes": 90, "date": TODAY, **body}, format="json")


# ───────────────────────── entries ─────────────────────────


@freeze_time(NOW, tick=True)
def test_log_list_and_logged_minutes(owner, project, task):
    member = add_project_member(project, key="project_member")
    res = log(client_for(owner), task, note="  Repro + profiling  ")
    assert res.status_code == 201, res.content
    body = res.json()
    assert set(body) == {"id", "taskId", "projectId", "userId", "minutes", "date", "note", "source", "createdAt"}
    assert body["userId"] == str(owner.id)
    assert body["projectId"] == str(project.id)
    assert body["note"] == "Repro + profiling"
    assert body["source"] == "manual"
    log(client_for(member), task, minutes=45, date="2026-10-06", note="x" * 200)
    log(client_for(owner), task, minutes=120, date="2026-10-07")
    listed = client_for(member).get(entries_url(task)).json()
    assert [(e["minutes"], e["date"]) for e in listed] == [(120, TODAY), (90, TODAY), (45, "2026-10-06")]
    assert len(listed[2]["note"]) == 140
    assert client_for(owner).get(f"/api/v1/tasks/{task.id}").json()["loggedMinutes"] == 255
    assert Task.objects.get(pk=task.pk).version == 1  # no version bump
    row = AuditLog.objects.filter(action="task.time_logged").earliest("created_at")
    assert row.data == {"minutes": 90, "date": TODAY, "source": "manual"}
    assert row.task_id == task.id
    assert row.target == task.title


@freeze_time(NOW)
@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"minutes": None}, {"minutes": "Enter a duration"}),
        ({"minutes": "90"}, {"minutes": "Enter a duration"}),
        ({"minutes": 1.5}, {"minutes": "Enter a duration"}),
        ({"minutes": 0}, {"minutes": "Duration must be over 0"}),
        ({"minutes": 1441}, {"minutes": "Max 24h per entry"}),
        ({"date": "07/10/2026"}, {"date": "Pick a date"}),
        ({"date": None}, {"date": "Pick a date"}),
        ({"date": "2026-10-09"}, {"date": "Can’t log future time"}),
        ({"date": "2025-10-06"}, {"date": "Date is too far back"}),
        ({"minutes": -1, "date": "x"}, {"minutes": "Duration must be over 0", "date": "Pick a date"}),
    ],
)
def test_log_validation(owner, task, body, fields):
    res = log(client_for(owner), task, **body)
    assert res.status_code == 422
    assert res.json()["details"]["fields"] == fields


@freeze_time(NOW)
def test_log_date_edges(owner, task):
    client = client_for(owner)
    assert log(client, task, date="2026-10-08").status_code == 201  # UTC today + 1 day
    assert log(client, task, date="2025-10-07").status_code == 201  # today − 365
    assert log(client, task, minutes=1440, note=12).json()["note"] == ""


def test_log_permissions_and_deleted_task(owner, project, task):
    viewer = add_project_member(project, key="viewer")
    res = log(client_for(viewer), task, date=dt.date.today().isoformat())
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "time.log"
    delete_task(owner, task)
    res = log(client_for(owner), task, date=dt.date.today().isoformat())
    assert res.status_code == 409
    assert res.json()["code"] == "task_deleted"
    assert client_for(owner).get(entries_url(task)).status_code == 200  # still readable


@freeze_time(NOW)
def test_delete_own_any_and_forbidden(owner, project, task):
    member = add_project_member(project, key="project_member")
    other = add_project_member(project, key="project_member")
    viewer = add_project_member(project, key="viewer")
    mine = log(client_for(member), task).json()["id"]
    theirs = log(client_for(other), task).json()["id"]
    res = client_for(member).delete(f"/api/v1/time-entries/{theirs}")
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "time.delete_any"
    assert client_for(viewer).delete(f"/api/v1/time-entries/{mine}").status_code == 403
    assert client_for(member).delete(f"/api/v1/time-entries/{mine}").status_code == 204
    assert client_for(owner).delete(f"/api/v1/time-entries/{theirs}").status_code == 204  # time.delete_any
    assert not TimeEntry.objects.exists()
    row = AuditLog.objects.get(action="task.time_entry_deleted", entity_id=theirs)
    assert row.data == {"minutes": 90, "date": TODAY, "owner": other.name}


@freeze_time(NOW)
def test_delete_visibility_and_deleted_task(owner, project, task):
    entry = log(client_for(owner), task).json()["id"]
    stranger = UserFactory()
    make_workspace(stranger, slug="elsewhere")
    res = client_for(stranger).delete(f"/api/v1/time-entries/{entry}")
    assert res.status_code == 404
    assert res.json()["message"] == "Time entry not found."
    assert client_for(owner).delete("/api/v1/time-entries/nope").status_code == 404
    delete_task(owner, task)
    res = client_for(owner).delete(f"/api/v1/time-entries/{entry}")
    assert res.status_code == 409


# ───────────────────────── timer ─────────────────────────


def test_timer_start_idempotent_switch_and_stop(owner, project, task):
    other = create_task(owner, project, {"title": "Other"})
    with freeze_time("2026-10-07T09:00:00Z"):
        client = client_for(owner)
        assert client.get("/api/v1/me/timer").json() == {"timer": None}
        res = client.post(f"/api/v1/tasks/{task.id}/timer", {"date": TODAY}, format="json")
        assert res.status_code == 201
        assert res.json() == {
            "timer": {
                "taskId": str(task.id),
                "taskKey": task.key,
                "taskTitle": task.title,
                "projectId": str(project.id),
                "startedAt": "2026-10-07T09:00:00Z",
            },
            "stopped": None,
        }
    with freeze_time("2026-10-07T09:05:00Z"):
        client = client_for(owner)
        again = client.post(f"/api/v1/tasks/{task.id}/timer", {}, format="json")
        assert again.status_code == 201
        assert again.json()["timer"]["startedAt"] == "2026-10-07T09:00:00Z"
        assert again.json()["stopped"] is None
    with freeze_time("2026-10-07T09:12:00Z"):
        client = client_for(owner)
        switch = client.post(f"/api/v1/tasks/{other.id}/timer", {"date": "2026-10-06"}, format="json").json()
        assert switch["timer"]["taskId"] == str(other.id)
        assert switch["stopped"]["taskId"] == str(task.id)
        assert switch["stopped"]["minutes"] == 12
        assert switch["stopped"]["source"] == "timer"
        assert switch["stopped"]["date"] == "2026-10-06"
        assert client.get("/api/v1/me/timer").json()["timer"]["taskId"] == str(other.id)
    with freeze_time("2026-10-07T09:12:30Z"):
        client = client_for(owner)
        res = client.post("/api/v1/me/timer/stop", {"note": " done "}, format="json")
        assert res.status_code == 200
        entry = res.json()["entry"]
        assert entry["minutes"] == 1  # 30 s rounds half up
        assert entry["date"] == TODAY  # server UTC date by default
        assert entry["note"] == "done"
    assert not RunningTimer.objects.exists()
    logged = AuditLog.objects.filter(action="task.time_logged")
    assert sorted(r.data["source"] for r in logged) == ["timer", "timer"]
    res = client_for(owner).post("/api/v1/me/timer/stop", {}, format="json")
    assert res.status_code == 404
    assert res.json()["message"] == "No timer is running."


def test_timer_caps_at_a_day_and_validates_dates(owner, task):
    with freeze_time("2026-10-05T08:00:00Z"):
        client_for(owner).post(f"/api/v1/tasks/{task.id}/timer", {}, format="json")
    with freeze_time("2026-10-07T08:00:00Z"):
        client = client_for(owner)
        res = client.post("/api/v1/me/timer/stop", {"date": "2026-10-09"}, format="json")
        assert res.status_code == 422
        assert res.json()["details"]["fields"] == {"date": "Can’t log future time"}
        assert RunningTimer.objects.exists()  # kept
        res = client.post("/api/v1/me/timer/stop", {"date": "2026-10-05"}, format="json")
        assert res.json()["entry"]["minutes"] == 1440


def test_switch_with_a_bad_date_keeps_the_old_timer(owner, project, task):
    other = create_task(owner, project, {"title": "Other"})
    with freeze_time(NOW):
        client = client_for(owner)
        client.post(f"/api/v1/tasks/{task.id}/timer", {}, format="json")
        res = client.post(f"/api/v1/tasks/{other.id}/timer", {"date": "nope"}, format="json")
        assert res.status_code == 422
        assert RunningTimer.objects.get().task_id == task.id


def test_stop_after_losing_time_log_discards(owner, project, task):
    member = add_project_member(project, key="project_member")
    with freeze_time(NOW):
        client_for(member).post(f"/api/v1/tasks/{task.id}/timer", {}, format="json")
    ProjectMember.objects.filter(project=project, user=member).update(
        role=project.workspace.roles.get(system_key="viewer")
    )
    with freeze_time("2026-10-07T10:00:00Z"):
        res = client_for(member).post("/api/v1/me/timer/stop", {}, format="json")
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "time.log"
    assert res.json()["message"] == "You can’t log time on this project any more. The timer was discarded."
    assert not RunningTimer.objects.exists()
    assert not TimeEntry.objects.exists()
    assert not AuditLog.objects.filter(action="task.time_logged").exists()


def test_stop_on_deleted_task_discards(owner, task):
    with freeze_time(NOW):
        client_for(owner).post(f"/api/v1/tasks/{task.id}/timer", {}, format="json")
    delete_task(owner, task)
    res = client_for(owner).post("/api/v1/me/timer/stop", {}, format="json")
    assert res.status_code == 409
    assert res.json()["message"] == "This task was deleted. The timer was discarded."
    assert not RunningTimer.objects.exists()


def test_switch_discards_a_timer_that_cannot_be_logged(owner, project, task):
    other = create_task(owner, project, {"title": "Other"})
    with freeze_time(NOW):
        client = client_for(owner)
        client.post(f"/api/v1/tasks/{task.id}/timer", {}, format="json")
        delete_task(owner, task)
        res = client.post(f"/api/v1/tasks/{other.id}/timer", {}, format="json")
    assert res.json()["stopped"] is None
    assert not TimeEntry.objects.exists()


def test_get_timer_drops_stale_timers(owner, project, task):
    member = add_project_member(project, key="project_member")
    RunningTimer.objects.create(user=member, task=task, started_at=task.created_at)
    assert client_for(member).get("/api/v1/me/timer").json()["timer"]["taskKey"] == task.key
    ProjectMember.objects.filter(project=project, user=member).delete()
    assert client_for(member).get("/api/v1/me/timer").json() == {"timer": None}
    assert not RunningTimer.objects.exists()
    RunningTimer.objects.create(user=owner, task=task, started_at=task.created_at)
    delete_task(owner, task)
    assert client_for(owner).get("/api/v1/me/timer").json() == {"timer": None}


def test_timer_permissions(owner, project, task):
    viewer = add_project_member(project, key="viewer")
    res = client_for(viewer).post(f"/api/v1/tasks/{task.id}/timer", {}, format="json")
    assert res.status_code == 403
    delete_task(owner, task)
    res = client_for(owner).post(f"/api/v1/tasks/{task.id}/timer", {}, format="json")
    assert res.status_code == 409
    assert res.json()["code"] == "task_deleted"


def test_archived_project_refuses_time_writes(owner, project, task):
    client = client_for(owner)
    client.post(f"/api/v1/projects/{project.id}/archive")
    assert log(client, task, date=dt.date.today().isoformat()).status_code == 403
    assert client.post(f"/api/v1/tasks/{task.id}/timer", {}, format="json").status_code == 403
    assert client.get(entries_url(task)).status_code == 200
