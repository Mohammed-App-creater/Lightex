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
