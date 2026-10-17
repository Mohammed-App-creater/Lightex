"""Platform Stage 4 (stage4-contract.md §2): project responses carry `myDataScopes`, the same workspace-level map as
the workspace response (data scope applies to workspace permissions only)."""

import pytest

from core.access import catalogue
from core.common.testing import UserFactory, add_member, client_for, role
from core.modules.registry import ModuleDefinition, register_module, unregister_module
from core.modules.services import set_module_enabled
from modules.tracking.projects.models import Project, ProjectMember

pytestmark = pytest.mark.django_db

CODE = "scopedmod.deal.view"


@pytest.fixture
def scoped_module():
    register_module(
        ModuleDefinition(
            key="scopedmod",
            name="Scoped",
            permissions=(catalogue.workspace_permission(CODE, "Deals", "View deals", "See deals", scopable=True),),
            default_role_grants={"owner": [CODE], "member": {CODE: "team"}},
        )
    )
    yield
    unregister_module("scopedmod")


def test_project_responses_carry_the_workspace_map(scoped_module, owner, ws):
    set_module_enabled(owner, ws, "scopedmod", True)
    member = add_member(ws, UserFactory())
    project = Project.objects.create(workspace=ws, key="WEB", name="Web")
    for user, key in ((owner, "project_admin"), (member, "viewer")):
        ProjectMember.objects.create(project=project, user=user, role=role(ws, key))
    res = client_for(owner).get(f"/api/v1/tracking/workspaces/platform/projects/{project.key}")
    assert res.status_code == 200, res.json()
    assert res.json()["myDataScopes"] == {CODE: "all"}
    listed = client_for(member).get("/api/v1/tracking/workspaces/platform/projects").json()
    rows = listed["data"] if isinstance(listed, dict) else listed
    assert rows[0]["myDataScopes"] == {CODE: "team"}
    assert client_for(member).get("/api/v1/workspaces/platform").json()["myDataScopes"] == {CODE: "team"}
