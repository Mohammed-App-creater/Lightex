import pytest
from django.core.management import CommandError, call_command
from django.test import override_settings

from apps.accounts.models import User
from apps.common.management.commands.seed_demo import DEMO_PASSWORD
from apps.planning.models import Sprint
from apps.projects.models import Project
from apps.tasks.models import Task, TaskStatusHistory
from apps.workspaces.models import Workspace

pytestmark = pytest.mark.django_db


def test_refuses_without_debug():
    with pytest.raises(CommandError):
        call_command("seed_demo")


@override_settings(DEBUG=True)
def test_seed_matches_the_mock_data(capsys):
    call_command("seed_demo")
    out = capsys.readouterr().out
    assert DEMO_PASSWORD in out
    assert Workspace.objects.count() == 2
    assert Project.objects.count() >= 3
    assert Task.objects.count() >= 40
    assert Sprint.objects.filter(state="completed").count() >= 1
    alex = User.objects.get(email="alex@team.dev")
    assert alex.check_password(DEMO_PASSWORD)
    # Every task has a history that ends in its current status.
    for task in Task.objects.all()[:20]:
        last = TaskStatusHistory.objects.filter(task=task).order_by("at", "created_at").last()
        assert last.to_status_id == task.status_id
    with pytest.raises(CommandError):
        call_command("seed_demo")  # already there
    call_command("seed_demo", "--flush")
    assert Workspace.objects.count() == 2


@override_settings(DEBUG=True)
def test_seeded_roles_cover_every_default_role():
    call_command("seed_demo")
    from apps.common.testing import client_for

    expected = {
        "alex@team.dev": ("Owner", "Project Admin"),
        "jordan@team.dev": ("Admin", "Manager"),
        "sam@team.dev": ("Member", "Member"),
        "taylor@team.dev": ("Member", "Viewer"),
    }
    for email, (ws_role, project_role) in expected.items():
        user = User.objects.get(email=email)
        member = user.workspace_memberships.get(workspace__slug="platform")
        assert member.role.name == ws_role
        assert user.project_memberships.get(project__key="PRJ").role.name == project_role
    casey = User.objects.get(email="casey@team.dev")
    res = client_for(casey).get("/api/v1/workspaces/platform/projects/PRJ")
    assert res.status_code == 403
    assert res.json()["code"] == "project_membership_required"


@override_settings(DEBUG=True)
def test_seed_has_board39_data():
    from apps.common.testing import client_for
    from apps.projects.models import CustomField, ProjectMember, SavedView, ViewPin
    from apps.timetracking.models import RunningTimer, TimeEntry

    call_command("seed_demo")
    alex = User.objects.get(email="alex@team.dev")
    prj = Project.objects.get(key="PRJ")
    fields = list(CustomField.objects.filter(project=prj).order_by("position"))
    assert [(f.name, f.type, f.required) for f in fields] == [
        ("Browser", "select", False),
        ("Found in", "text", True),
        ("Accounts affected", "number", False),
        ("QA sign-off", "date", False),
        ("QA owner", "user", False),
    ]
    assert [o.name for o in fields[0].options.order_by("position")] == ["Chrome", "Safari", "Firefox", "Edge"]
    client = client_for(alex)
    task = client.get("/api/v1/workspaces/platform/tasks/PRJ-42").json()
    by_name = {f.name: str(f.id) for f in fields}
    assert task["customFields"][by_name["Found in"]] == "v2.3.1"
    assert task["customFields"][by_name["Accounts affected"]] == 1240
    assert task["customFields"][by_name["QA owner"]] == str(User.objects.get(name="Riley Chen").id)
    assert task["isBlocked"] is True
    assert [b["key"] for b in task["openBlockers"]] == ["PRJ-48"]
    assert task["timeEstimateMinutes"] == 360
    assert task["loggedMinutes"] == 255
    assert [d["task"]["key"] for d in task["dependencies"]["blocks"]] == ["PRJ-47", "PRJ-68"]
    blocked = client.get(f"/api/v1/projects/{prj.id}/tasks?filter[blocked]=true").json()["data"]
    assert sorted(t["key"] for t in blocked) == ["PRJ-42", "PRJ-47", "PRJ-58", "PRJ-68"]
    # Every PRJ member has a pinned "Blocked" view after their other pins.
    for member in ProjectMember.objects.filter(project=prj):
        view = SavedView.objects.get(owner=member.user, name="Blocked")
        assert view.filters == [{"field": "blocked", "op": "is", "values": ["true"]}]
        last_pin = ViewPin.objects.filter(user=member.user).order_by("-position").first()
        assert last_pin.view_id == view.id
    views = client.get("/api/v1/workspaces/platform/views").json()
    assert next(v for v in views if v["name"] == "Blocked")["count"] == 4
    assert TimeEntry.objects.filter(project__key__in=["PRJ", "MOB", "INF"]).count() > 3
    assert TimeEntry.objects.filter(date__week_day__in=[1, 7]).exclude(task__key="PRJ-42").count() == 0
    assert not RunningTimer.objects.exists()
    sheet = client.get("/api/v1/workspaces/platform/timesheet").json()
    assert sheet["totalMinutes"] > 0


def test_board39_seed_prefers_fixture_collections():
    from apps.common.management.commands.seed_demo import board39_from_fixture

    data = {
        "tasks": [{"id": "t1", "customFields": {"f": "x"}, "timeEstimateMinutes": 30}, {"id": "t2"}],
        "customFields": [{"id": "f"}],
        "dependencies": [{"id": "d"}],
        "timeEntries": [{"id": "e"}],
    }
    ext = board39_from_fixture(data)
    assert ext["taskValues"] == {"t1": {"f": "x"}}
    assert ext["timeEstimates"] == {"t1": 30}
    assert ext["fill"] is False
    assert [len(ext[k]) for k in ("customFields", "dependencies", "timeEntries")] == [1, 1, 1]
