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
    # PRJ-52 is blocked by PRJ-50 (board 32 seed: the satisfied-order arrow).
    assert sorted(t["key"] for t in blocked) == ["PRJ-42", "PRJ-47", "PRJ-52", "PRJ-58", "PRJ-68"]
    # Every PRJ member has a pinned "Blocked" view after their other pins.
    for member in ProjectMember.objects.filter(project=prj):
        view = SavedView.objects.get(owner=member.user, name="Blocked")
        assert view.filters == [{"field": "blocked", "op": "is", "values": ["true"]}]
        last_pin = ViewPin.objects.filter(user=member.user).order_by("-position").first()
        assert last_pin.view_id == view.id
    views = client.get("/api/v1/workspaces/platform/views").json()
    assert next(v for v in views if v["name"] == "Blocked")["count"] == 5
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


@override_settings(DEBUG=True)
def test_seed_has_board32_dates():
    import datetime as dt

    from django.utils import timezone

    from apps.common.management.commands.seed_demo import ANCHOR, PRJ_DATES
    from apps.common.testing import client_for
    from apps.planning.models import Epic

    call_command("seed_demo")
    shift = timezone.now().date() - ANCHOR

    def day(iso):
        return dt.date.fromisoformat(iso) + shift

    prj = Project.objects.get(key="PRJ")
    by_number = {t.number: t for t in Task.all_objects.filter(project=prj)}
    for number, start, due in PRJ_DATES:
        assert (by_number[number].start_date, by_number[number].due_date) == (day(start), day(due)), number
    # Due-only and unscheduled tasks are left as they are.
    for number in (46, 51, 56, 64, 69):
        assert by_number[number].start_date is None and by_number[number].due_date is not None, number
    for number in (36, 45, 47, 55, 68, 70):
        assert (by_number[number].start_date, by_number[number].due_date) == (None, None), number
    assert not Task.objects.filter(project__key__in=["MOB", "INF"], start_date__isnull=False).exists()
    epics = {e.name: (e.start_date, e.due_date) for e in Epic.objects.filter(project__workspace__slug="platform")}
    assert epics["Auth overhaul"] == (day("2026-09-14"), day("2026-10-23"))
    assert epics["Board performance"] == (day("2026-09-21"), day("2026-11-06"))
    assert epics["Sprint engine"] == (day("2026-09-01"), day("2026-10-30"))
    assert epics["Billing v2"] == (day("2026-09-01"), day("2026-11-20"))
    assert epics["Offline mode"] == (None, None)
    assert epics["Edge cache"] == (None, None)
    client = client_for(User.objects.get(email="alex@team.dev"))
    blocked = client.get("/api/v1/workspaces/platform/tasks/PRJ-52").json()
    assert [d["task"]["key"] for d in blocked["dependencies"]["blockedBy"]] == ["PRJ-50"]
    # The tray query: open PRJ tasks with no dates.
    open_ids = "&".join(f"filter[status]={s.id}" for s in prj.statuses.exclude(category="done"))
    tray = client.get(f"/api/v1/projects/{prj.id}/tasks?filter[scheduled]=false&{open_ids}&sort=-priority").json()
    assert sorted(t["key"] for t in tray["data"]) == ["PRJ-36", "PRJ-45", "PRJ-47", "PRJ-55", "PRJ-68", "PRJ-70"]
    window = f"filter[from]={day('2026-09-01')}&filter[to]={day('2026-11-30')}"
    timeline = client.get(f"/api/v1/projects/{prj.id}/tasks?{window}&sort=startDate").json()["data"]
    assert timeline[0]["key"] == "PRJ-60"  # earliest start (Sep 1)


@override_settings(DEBUG=True)
def test_seed_has_board33_dashboards():
    """The mock's ensureExt33 seed; the shared layout packs exactly like the design-default vector (§8.3)."""
    import json
    from pathlib import Path

    from apps.common.testing import client_for
    from apps.dashboards.models import Dashboard
    from apps.dashboards.widgets import pack

    call_command("seed_demo")
    alex, sam = User.objects.get(email="alex@team.dev"), User.objects.get(email="sam@team.dev")
    health = Dashboard.objects.get(name="Sprint 14 health")
    assert (health.project.key, health.owner, health.visibility, health.version) == ("PRJ", alex, "shared", 1)
    widgets = list(health.widgets.order_by("position"))
    assert [(x.type, x.w, x.h) for x in widgets] == [
        ("burndown", 6, 2), ("my_tasks", 3, 2), ("objectives", 3, 2), ("workload", 6, 2), ("velocity", 3, 2),
        ("activity", 3, 2),
    ]  # fmt: skip
    assert widgets[2].config == {"quarter": "Q4"}
    vectors = json.loads((Path(__file__).resolve().parents[2] / "dashboards/tests/pack_vectors.json").read_text())
    default = next(c for c in vectors["cases"] if c["name"].startswith("design default"))
    assert pack([(x.w, x.h) for x in widgets]) == default["rects"]
    focus = Dashboard.objects.get(name="My focus")
    assert (focus.owner, focus.visibility) == (sam, "personal")
    assert [(x.type, x.w, x.h) for x in focus.widgets.order_by("position")] == [("my_tasks", 6, 2), ("activity", 6, 2)]
    assert not Dashboard.objects.filter(project__key="MOB").exists()
    # Sam lists the shared one and his own; Alex sees only the shared one.
    project = health.project
    assert [d["name"] for d in client_for(sam).get(f"/api/v1/projects/{project.pk}/dashboards").json()] == [
        "Sprint 14 health",
        "My focus",
    ]
    assert [d["name"] for d in client_for(alex).get(f"/api/v1/projects/{project.pk}/dashboards").json()] == [
        "Sprint 14 health"
    ]
