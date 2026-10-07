import pytest

from apps.access import catalogue
from apps.access.models import Role
from apps.audit.models import AuditLog
from apps.common.testing import UserFactory, add_member, client_for, role
from apps.projects.models import Project, ProjectMember
from apps.workspaces.models import Invitation, WorkspaceMember

pytestmark = pytest.mark.django_db


def test_permission_catalogue(owner, ws):
    client = client_for(owner)
    res = client.get("/api/v1/permissions")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == len(catalogue.PERMISSIONS)
    assert set(data[0]) == {"key", "scope", "group", "label", "description"}
    ws_only = client.get("/api/v1/permissions?scope=workspace").json()
    assert {p["scope"] for p in ws_only} == {"workspace"}
    assert len(client.get("/api/v1/permissions?filter[scope]=project").json()) == len(catalogue.PROJECT_CODES)


def test_list_roles_with_counts(owner, ws):
    add_member(ws, key="member")
    res = client_for(owner).get("/api/v1/workspaces/platform/roles")
    assert res.status_code == 200
    by_key = {r["name"] + r["scope"]: r for r in res.json()}
    assert by_key["Ownerworkspace"]["memberCount"] == 1
    assert by_key["Memberworkspace"]["memberCount"] == 1
    assert by_key["Ownerworkspace"]["isSystem"] is True
    assert set(by_key["Ownerworkspace"]) == {
        "id",
        "workspaceId",
        "name",
        "description",
        "scope",
        "isSystem",
        "permissions",
        "memberCount",
    }
    project_roles = client_for(owner).get("/api/v1/workspaces/platform/roles?filter[scope]=project").json()
    assert {r["scope"] for r in project_roles} == {"project"}
    assert len(project_roles) == 4


def test_create_custom_role_one_scope(owner, ws):
    client = client_for(owner)
    res = client.post(
        "/api/v1/workspaces/platform/roles",
        {
            "name": "Triage",
            "description": "Bug triage",
            "scope": "project",
            "permissions": ["task.move", "project.view"],
        },
        format="json",
    )
    assert res.status_code == 201
    body = res.json()
    assert body["permissions"] == ["project.view", "task.move"]
    assert body["isSystem"] is False
    mixed = client.post(
        "/api/v1/workspaces/platform/roles",
        {"name": "Mixed", "scope": "project", "permissions": ["task.move", "workspace.update"]},
        format="json",
    )
    assert mixed.status_code == 422
    dup = client.post(
        "/api/v1/workspaces/platform/roles", {"name": "triage", "scope": "project", "permissions": []}, format="json"
    )
    assert dup.status_code == 422
    assert (
        client.post("/api/v1/workspaces/platform/roles", {"name": "X", "scope": "nope"}, format="json").status_code
        == 422
    )
    assert (
        client.post("/api/v1/workspaces/platform/roles", {"name": "", "scope": "project"}, format="json").status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/workspaces/platform/roles", {"name": "Y", "scope": "project", "permissions": "x"}, format="json"
        ).status_code
        == 422
    )
    assert AuditLog.objects.filter(action="role.created").count() == 1


def test_no_escalation_through_custom_roles(owner, ws):
    admin = add_member(ws, key="admin")
    client = client_for(admin)
    res = client.post(
        "/api/v1/workspaces/platform/roles",
        {"name": "Super", "scope": "workspace", "permissions": ["workspace.view", "workspace.delete"]},
        format="json",
    )
    assert res.status_code == 403
    ok = client.post(
        "/api/v1/workspaces/platform/roles",
        {"name": "Helper", "scope": "workspace", "permissions": ["workspace.view"]},
        format="json",
    )
    assert ok.status_code == 201
    up = client.patch(
        f"/api/v1/roles/{ok.json()['id']}", {"permissions": ["workspace.view", "workspace.delete"]}, format="json"
    )
    assert up.status_code == 403


def test_members_cannot_manage_roles(owner, ws):
    member = add_member(ws, key="member")
    client = client_for(member)
    assert client.get("/api/v1/workspaces/platform/roles").status_code == 200
    assert (
        client.post("/api/v1/workspaces/platform/roles", {"name": "X", "scope": "project"}, format="json").status_code
        == 403
    )
    assert (
        client.patch(
            f"/api/v1/roles/{role(ws, 'viewer').id}", {"permissions": ["project.view"]}, format="json"
        ).status_code
        == 403
    )


def test_roles_of_other_workspaces_are_404(owner, ws):
    from apps.common.testing import make_workspace

    other = make_workspace(UserFactory(), name="Other", slug="other")
    client = client_for(owner)
    target = role(other, "viewer")
    assert client.patch(f"/api/v1/roles/{target.id}", {"name": "Pwned"}, format="json").status_code == 404
    assert client.delete(f"/api/v1/roles/{target.id}").status_code == 404
    assert client.put(f"/api/v1/roles/{target.id}/permissions", {"permissions": []}, format="json").status_code == 404


def test_system_roles_locked_core(owner, ws):
    client = client_for(owner)
    manager = role(ws, "manager")
    assert client.patch(f"/api/v1/roles/{manager.id}", {"name": "Boss"}, format="json").status_code == 403
    assert client.patch(f"/api/v1/roles/{manager.id}", {"description": "x"}, format="json").status_code == 403
    keep = [c for c in catalogue.ROLE_DEF_BY_KEY["manager"].permissions if c != "task.delete"]
    res = client.patch(f"/api/v1/roles/{manager.id}", {"permissions": keep}, format="json")
    assert res.status_code == 200
    assert "task.delete" not in res.json()["permissions"]
    core = client.put(f"/api/v1/roles/{manager.id}/permissions", {"permissions": ["task.create"]}, format="json")
    assert core.status_code == 422  # project.view is a core permission
    owner_role = role(ws, "owner")
    assert (
        client.put(
            f"/api/v1/roles/{owner_role.id}/permissions", {"permissions": ["workspace.view"]}, format="json"
        ).status_code
        == 422
    )
    assert client.delete(f"/api/v1/roles/{manager.id}").status_code == 403
    # Same name, no-op.
    assert client.patch(f"/api/v1/roles/{manager.id}", {"name": "Manager"}, format="json").status_code == 200


def test_rename_custom_role(owner, ws):
    client = client_for(owner)
    custom = client.post(
        "/api/v1/workspaces/platform/roles", {"name": "QA", "scope": "project", "permissions": []}, format="json"
    ).json()
    res = client.patch(f"/api/v1/roles/{custom['id']}", {"name": "Quality", "description": "Testers"}, format="json")
    assert res.json()["name"] == "Quality"
    assert res.json()["description"] == "Testers"
    assert client.patch(f"/api/v1/roles/{custom['id']}", {"name": "Viewer"}, format="json").status_code == 422
    assert client.patch(f"/api/v1/roles/{custom['id']}", {"name": " "}, format="json").status_code == 422


def test_delete_role_in_use_requires_reassignment(owner, ws):
    client = client_for(owner)
    custom = client.post(
        "/api/v1/workspaces/platform/roles",
        {"name": "Helper", "scope": "workspace", "permissions": ["workspace.view"]},
        format="json",
    ).json()
    user = UserFactory()
    WorkspaceMember.objects.create(workspace=ws, user=user, role_id=custom["id"])
    Invitation.objects.create(
        workspace=ws, email="p@x.dev", role_id=custom["id"], token_hash="h" * 64, expires_at="2099-01-01T00:00:00Z"
    )
    res = client.delete(f"/api/v1/roles/{custom['id']}")
    assert res.status_code == 409
    assert res.json()["code"] == "role_in_use"
    assert res.json()["details"]["memberCount"] == 1
    assert (
        client.delete(
            f"/api/v1/roles/{custom['id']}", {"reassignTo": str(role(ws, "viewer").id)}, format="json"
        ).status_code
        == 422
    )
    assert client.delete(f"/api/v1/roles/{custom['id']}", {"reassignTo": "nope"}, format="json").status_code == 422
    ok = client.delete(f"/api/v1/roles/{custom['id']}", {"reassignTo": str(role(ws, "member").id)}, format="json")
    assert ok.status_code == 204
    assert WorkspaceMember.objects.get(user=user).role == role(ws, "member")
    assert Invitation.objects.get(email="p@x.dev").role == role(ws, "member")
    assert not Role.objects.filter(pk=custom["id"]).exists()


def test_delete_unused_project_role(owner, ws):
    client = client_for(owner)
    custom = client.post(
        "/api/v1/workspaces/platform/roles", {"name": "QA", "scope": "project", "permissions": []}, format="json"
    ).json()
    project = Project.objects.create(workspace=ws, key="PRJ", name="P")
    member = add_member(ws)
    ProjectMember.objects.create(project=project, user=member, role_id=custom["id"])
    assert client.delete(f"/api/v1/roles/{custom['id']}").status_code == 409
    assert (
        client.delete(
            f"/api/v1/roles/{custom['id']}", {"reassignTo": str(role(ws, "viewer").id)}, format="json"
        ).status_code
        == 204
    )
    assert ProjectMember.objects.get(user=member).role == role(ws, "viewer")


def test_last_owner_is_protected_through_roles(owner, ws):
    client = client_for(owner)
    custom = client.post(
        "/api/v1/workspaces/platform/roles",
        {"name": "Co-owner", "scope": "workspace", "permissions": list(catalogue.WORKSPACE_ORDER)},
        format="json",
    ).json()
    WorkspaceMember.objects.filter(user=owner).update(role_id=custom["id"])
    res = client.patch(f"/api/v1/roles/{custom['id']}", {"permissions": ["workspace.view"]}, format="json")
    assert res.status_code == 409
    assert res.json()["code"] == "last_owner"
    deleted = client.delete(f"/api/v1/roles/{custom['id']}", {"reassignTo": str(role(ws, "admin").id)}, format="json")
    assert deleted.status_code == 409
    assert (
        client.delete(
            f"/api/v1/roles/{custom['id']}", {"reassignTo": str(role(ws, "owner").id)}, format="json"
        ).status_code
        == 204
    )


def test_unknown_role_is_404(owner, ws):
    import uuid

    assert client_for(owner).patch(f"/api/v1/roles/{uuid.uuid4()}", {"name": "X"}, format="json").status_code == 404
