import pytest

from apps.audit.models import AuditLog
from apps.common.testing import (
    UserFactory,
    add_member,
    add_project_member,
    client_for,
    make_project,
    make_workspace,
    role,
)
from apps.projects.models import AccessRequest, Project, ProjectKeyAlias, ProjectMember, Status

pytestmark = pytest.mark.django_db


@pytest.fixture
def project(ws, owner):
    return make_project(ws, owner, key="PRJ", template="scrum")


def test_create_project_from_template(owner, ws):
    client = client_for(owner)
    res = client.post(
        "/api/v1/workspaces/platform/projects",
        {"name": "Bug Hunt", "key": "bug", "description": "Triage", "template": "bugs"},
        format="json",
    )
    assert res.status_code == 201
    body = res.json()
    assert body["key"] == "BUG"
    assert body["template"] == "bugs"
    assert body["memberCount"] == 1
    assert body["openTaskCount"] == 0
    assert body["activeSprintId"] is None
    assert "project.delete" in body["my_permissions"]
    assert body["myRoleId"] == str(role(ws, "project_admin").id)
    statuses = client.get(f"/api/v1/projects/{body['id']}/statuses").json()
    assert [s["name"] for s in statuses] == ["Triage", "Confirmed", "Fixing", "Verifying", "Fixed", "Won’t fix"]
    assert [s["category"] for s in statuses] == ["todo", "todo", "in_progress", "in_progress", "done", "done"]
    assert statuses[0]["taskCount"] == 0
    labels = client.get(f"/api/v1/projects/{body['id']}/labels").json()
    assert sorted(lb["name"] for lb in labels) == ["backend", "bug", "design", "frontend"]
    assert AuditLog.objects.filter(action="project.created", entity_key="BUG").exists()


@pytest.mark.parametrize(("template", "count"), [("simple", 3), ("scrum", 6), ("kanban", 5), ("bugs", 6)])
def test_each_template(owner, ws, template, count):
    p = make_project(ws, owner, key="TPL", template=template)
    assert p.statuses.count() == count
    assert p.statuses.filter(category="done").exists()


def test_create_project_validation(owner, ws, project):
    client = client_for(owner)
    res = client.post(
        "/api/v1/workspaces/platform/projects", {"name": "x", "key": "TOOLONG1", "template": "nope"}, format="json"
    )
    assert res.status_code == 422
    assert set(res.json()["details"]["fields"]) == {"name", "key", "template"}
    dup = client.post("/api/v1/workspaces/platform/projects", {"name": "Dup", "key": "prj"}, format="json")
    assert dup.json()["details"]["fields"]["key"].startswith("PRJ is already used")


def test_project_list_shows_only_my_projects(owner, ws, project):
    other = make_project(ws, owner, key="OTH", name="Other")
    member = add_project_member(other, key="viewer")
    res = client_for(member).get("/api/v1/workspaces/platform/projects")
    assert [p["key"] for p in res.json()] == ["OTH"]
    assert res.json()[0]["my_permissions"] == ["project.view"]
    # The workspace owner who isn't a member of a project doesn't see it either.
    ProjectMember.objects.filter(project=other, user=owner).delete()
    keys = [p["key"] for p in client_for(owner).get("/api/v1/workspaces/platform/projects").json()]
    assert keys == ["PRJ"]


def test_archived_filter(owner, ws, project):
    client = client_for(owner)
    assert client.post(f"/api/v1/projects/{project.id}/archive").json()["status"] == "archived"
    assert client.get("/api/v1/workspaces/platform/projects").json() == []
    archived = client.get("/api/v1/workspaces/platform/projects?filter[status]=archived").json()
    assert [p["key"] for p in archived] == ["PRJ"]
    assert archived[0]["my_permissions"] == [
        "project.view",
        "project.archive",
        "project.delete",
        "project.manage_members",
        "report.view",
    ]
    assert len(client.get("/api/v1/workspaces/platform/projects?filter[status]=all").json()) == 1
    # Archived projects are read-only.
    assert client.patch(f"/api/v1/projects/{project.id}", {"name": "Renamed"}, format="json").status_code == 403
    assert client.post(f"/api/v1/projects/{project.id}/unarchive").json()["status"] == "active"
    assert AuditLog.objects.filter(action="project.archived").exists()


def test_get_by_key_and_membership_errors(owner, ws, project):
    client = client_for(owner)
    res = client.get("/api/v1/workspaces/platform/projects/prj")
    assert res.status_code == 200
    assert res.json()["id"] == str(project.id)
    admin = add_member(ws, key="admin")
    denied = client_for(admin).get("/api/v1/workspaces/platform/projects/PRJ")
    assert denied.status_code == 403
    body = denied.json()
    assert body["code"] == "project_membership_required"
    assert body["details"]["canRequestAccess"] is True
    assert body["details"]["project"]["admins"] == [{"id": str(owner.id), "name": owner.name, "hue": owner.hue}]
    assert body["details"]["project"]["myRequest"] is None
    assert client_for(admin).get(f"/api/v1/projects/{project.id}").json()["code"] == "project_membership_required"
    stranger = client_for(UserFactory())
    assert stranger.get("/api/v1/workspaces/platform/projects/PRJ").status_code == 404
    assert stranger.get(f"/api/v1/projects/{project.id}").status_code == 404
    assert client.get("/api/v1/workspaces/platform/projects/NOPE").status_code == 404


def test_key_change_keeps_old_key_reserved(owner, ws, project):
    client = client_for(owner)
    res = client.patch(f"/api/v1/projects/{project.id}", {"key": "plt", "name": "Platform", "hue": 120}, format="json")
    assert res.status_code == 200
    assert res.json()["key"] == "PLT"
    assert res.json()["hue"] == 120
    assert set(ProjectKeyAlias.objects.filter(project=project).values_list("key", flat=True)) == {"PRJ", "PLT"}
    # Old URLs keep working, and the retired key can't be reused (task keys stay unique).
    assert client.get("/api/v1/workspaces/platform/projects/PRJ").json()["key"] == "PLT"
    reuse = client.post("/api/v1/workspaces/platform/projects", {"name": "Reuse", "key": "PRJ"}, format="json")
    assert reuse.status_code == 422
    bad = client.patch(f"/api/v1/projects/{project.id}", {"key": "1", "name": "x", "hue": 999}, format="json")
    assert bad.status_code == 422
    entry = AuditLog.objects.filter(action="project.updated").latest("created_at")
    assert {c["field"] for c in entry.changes} == {"Key", "Name", "Color"}


def test_delete_project_soft_and_restore(owner, ws, project):
    from apps.projects.services import restore_project

    client = client_for(owner)
    assert client.delete(f"/api/v1/projects/{project.id}", {"confirm": "nope"}, format="json").status_code == 422
    assert client.delete(f"/api/v1/projects/{project.id}", {"confirm": "PRJ"}, format="json").status_code == 204
    assert not Project.objects.filter(pk=project.pk).exists()
    assert Project.all_objects.get(pk=project.pk).deleted_by == owner
    assert client.get(f"/api/v1/projects/{project.id}").status_code == 404
    # The key is free again while the project sits in the trash…
    newer = make_project(ws, owner, key="PRJ", name="Newer")
    deleted = Project.all_objects.get(pk=project.pk)
    from apps.common.exceptions import ApiError

    with pytest.raises(ApiError) as exc:  # …so restoring collides
        restore_project(owner, deleted)
    assert exc.value.code == "key_taken"
    client.patch(f"/api/v1/projects/{newer.id}", {"key": "NEW"}, format="json")
    ProjectKeyAlias.objects.filter(project=newer, key="PRJ").delete()
    restored = restore_project(owner, Project.all_objects.get(pk=project.pk))
    assert restored.deleted_at is None
    assert restore_project(owner, restored) is restored


def test_member_management(owner, ws, project):
    client = client_for(owner)
    user = add_member(ws, key="member")
    res = client.post(
        f"/api/v1/projects/{project.id}/members",
        {"userId": str(user.id), "roleId": str(role(ws, "viewer").id)},
        format="json",
    )
    assert res.status_code == 201
    assert set(res.json()) == {"projectId", "userId", "roleId", "user", "addedAt"}
    members = client.get(f"/api/v1/projects/{project.id}/members").json()
    assert {m["userId"] for m in members} == {str(owner.id), str(user.id)}
    up = client.patch(
        f"/api/v1/projects/{project.id}/members/{user.id}", {"roleId": str(role(ws, "manager").id)}, format="json"
    )
    assert up.json()["roleId"] == str(role(ws, "manager").id)
    # Re-adding updates the role.
    client.post(
        f"/api/v1/projects/{project.id}/members",
        {"userId": str(user.id), "roleId": str(role(ws, "viewer").id)},
        format="json",
    )
    assert ProjectMember.objects.get(project=project, user=user).role == role(ws, "viewer")
    stranger = UserFactory()
    assert (
        client.post(
            f"/api/v1/projects/{project.id}/members",
            {"userId": str(stranger.id), "roleId": str(role(ws, "viewer").id)},
            format="json",
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/v1/projects/{project.id}/members",
            {"userId": str(user.id), "roleId": str(role(ws, "member").id)},
            format="json",
        ).status_code
        == 422
    )
    assert client.delete(f"/api/v1/projects/{project.id}/members/{user.id}").status_code == 204
    assert client.delete(f"/api/v1/projects/{project.id}/members/{user.id}").status_code == 404
    assert AuditLog.objects.filter(action="project_member.added").exists()
    assert AuditLog.objects.filter(action="project_member.removed").exists()


def test_project_never_loses_its_last_admin(owner, ws, project):
    client = client_for(owner)
    res = client.patch(
        f"/api/v1/projects/{project.id}/members/{owner.id}", {"roleId": str(role(ws, "manager").id)}, format="json"
    )
    assert res.status_code == 409
    assert res.json()["code"] == "last_project_admin"
    assert client.delete(f"/api/v1/projects/{project.id}/members/{owner.id}").status_code == 409
    second = add_project_member(project, key="project_admin")
    assert (
        client.patch(
            f"/api/v1/projects/{project.id}/members/{owner.id}", {"roleId": str(role(ws, "manager").id)}, format="json"
        ).status_code
        == 200
    )
    # `second` is now the only admin and can't leave.
    assert client_for(second).delete(f"/api/v1/projects/{project.id}/members/{second.id}").status_code == 409


def test_members_can_leave_but_not_remove_others(owner, ws, project):
    viewer = add_project_member(project, key="viewer")
    other = add_project_member(project, key="viewer")
    assert client_for(viewer).delete(f"/api/v1/projects/{project.id}/members/{other.id}").status_code == 403
    assert client_for(viewer).delete(f"/api/v1/projects/{project.id}/members/{viewer.id}").status_code == 204


def test_assign_admin_without_reading_the_project(owner, ws, project):
    ws_admin = add_member(ws, key="admin")
    target = add_member(ws, key="member")
    client = client_for(ws_admin)
    res = client.post(
        f"/api/v1/projects/{project.id}/members",
        {"userId": str(target.id), "roleId": str(role(ws, "project_admin").id)},
        format="json",
    )
    assert res.status_code == 201
    # …but only admin roles, and the workspace admin still can't read the project.
    other = add_member(ws, key="member")
    viewer_role = {"userId": str(other.id), "roleId": str(role(ws, "viewer").id)}
    assert client.post(f"/api/v1/projects/{project.id}/members", viewer_role, format="json").status_code == 403
    assert client.get(f"/api/v1/projects/{project.id}").status_code == 403
    assert client.get(f"/api/v1/projects/{project.id}/members").status_code == 403


def test_access_requests(owner, ws, project):
    member = add_member(ws, key="member")
    client = client_for(member)
    res = client.post(f"/api/v1/projects/{project.id}/access-requests", {"message": "Please"}, format="json")
    assert res.status_code == 201
    assert res.json()["status"] == "pending"
    assert (
        client.post(f"/api/v1/projects/{project.id}/access-requests", {}, format="json").json()["id"]
        == res.json()["id"]
    )
    info = client.get("/api/v1/workspaces/platform/projects/PRJ").json()["details"]["project"]
    assert info["myRequest"]["id"] == res.json()["id"]
    pending = client_for(owner).get(f"/api/v1/projects/{project.id}/access-requests").json()
    assert pending[0]["user"]["id"] == str(member.id)
    # Adding the member approves the request.
    client_for(owner).post(
        f"/api/v1/projects/{project.id}/members",
        {"userId": str(member.id), "roleId": str(role(ws, "viewer").id)},
        format="json",
    )
    assert AccessRequest.objects.get(pk=res.json()["id"]).status == "approved"
    assert client.post(f"/api/v1/projects/{project.id}/access-requests", {}, format="json").status_code == 409


def test_deny_and_withdraw_access_requests(owner, ws, project):
    a = add_member(ws, key="member")
    b = add_member(ws, key="member")
    ra = client_for(a).post(f"/api/v1/projects/{project.id}/access-requests", {}, format="json").json()
    client_for(b).post(f"/api/v1/projects/{project.id}/access-requests", {}, format="json")
    denied = client_for(owner).post(f"/api/v1/projects/{project.id}/access-requests/{ra['id']}/deny")
    assert denied.json()["status"] == "denied"
    assert client_for(owner).post(f"/api/v1/projects/{project.id}/access-requests/{ra['id']}/deny").status_code == 404
    assert client_for(b).delete(f"/api/v1/projects/{project.id}/access-requests/mine").status_code == 204
    assert client_for(owner).get(f"/api/v1/projects/{project.id}/access-requests").json() == []


def test_project_directory(owner, ws, project):
    hidden = make_project(ws, owner, key="HID", name="Hidden")
    member = add_project_member(project, key="viewer")
    directory = client_for(member).get("/api/v1/workspaces/platform/project-directory").json()
    by_key = {p["key"]: p for p in directory}
    assert by_key["PRJ"]["isMember"] is True
    assert by_key["HID"]["isMember"] is False
    assert by_key["HID"]["admins"][0]["id"] == str(owner.id)
    assert set(by_key["HID"]) == {"id", "key", "name", "hue", "admins", "myRequest", "isMember", "status"}
    assert hidden


def test_cross_workspace_isolation(owner, ws, project):
    other_owner = UserFactory()
    other_ws = make_workspace(other_owner, slug="other")
    other_project = make_project(other_ws, other_owner, key="OTH")
    client = client_for(owner)
    for path in ["", "/members", "/statuses", "/labels", "/access-requests"]:
        assert client.get(f"/api/v1/projects/{other_project.id}{path}").status_code == 404, path
    assert client.patch(f"/api/v1/projects/{other_project.id}", {"name": "Hacked"}, format="json").status_code == 404
    assert client.post(f"/api/v1/projects/{other_project.id}/access-requests", {}, format="json").status_code == 404
    assert client.get("/api/v1/workspaces/other/projects/OTH").status_code == 404
    # Roles from another workspace can't be used here.
    res = client.post(
        f"/api/v1/projects/{project.id}/members",
        {"userId": str(owner.id), "roleId": str(role(other_ws, "viewer").id)},
        format="json",
    )
    assert res.status_code == 422


# ───────────────────────── statuses and labels ─────────────────────────


def test_status_crud_and_reorder(owner, ws, project):
    client = client_for(owner)
    created = client.post(f"/api/v1/projects/{project.id}/statuses", {"name": "Blocked"}, format="json")
    assert created.status_code == 201
    st = created.json()
    assert st["category"] == "in_progress"
    assert st["glyph"] == "progress"
    assert st["position"] == 6
    done = client.post(
        f"/api/v1/projects/{project.id}/statuses", {"name": "Shipped", "category": "done"}, format="json"
    ).json()
    assert done["glyph"] == "done"
    assert client.post(f"/api/v1/projects/{project.id}/statuses", {"name": " "}, format="json").status_code == 422
    assert (
        client.post(
            f"/api/v1/projects/{project.id}/statuses", {"name": "x", "category": "nope"}, format="json"
        ).status_code
        == 422
    )
    moved = client.patch(
        f"/api/v1/projects/{project.id}/statuses/{st['id']}",
        {"position": 0, "name": "On hold", "color": "var(--warn)"},
        format="json",
    )
    assert moved.json()["position"] == 0
    assert moved.json()["name"] == "On hold"
    assert moved.json()["color"] == "var(--warn)"
    assert (
        client.patch(
            f"/api/v1/projects/{project.id}/statuses/{st['id']}", {"color": "url(javascript:1)"}, format="json"
        ).status_code
        == 422
    )
    assert (
        client.patch(f"/api/v1/projects/{project.id}/statuses/{st['id']}", {"position": "x"}, format="json").status_code
        == 422
    )
    ids = [s["id"] for s in client.get(f"/api/v1/projects/{project.id}/statuses").json()]
    assert ids[0] == st["id"]
    reordered = client.post(
        f"/api/v1/projects/{project.id}/statuses/reorder", {"ids": list(reversed(ids))}, format="json"
    )
    assert [s["id"] for s in reordered.json()] == list(reversed(ids))
    assert [s["position"] for s in reordered.json()] == list(range(len(ids)))
    assert (
        client.post(f"/api/v1/projects/{project.id}/statuses/reorder", {"ids": ids[:2]}, format="json").status_code
        == 422
    )


def test_status_delete_rules(owner, ws):
    project = make_project(ws, owner, key="SIM", template="simple")
    client = client_for(owner)
    statuses = {s.glyph: s for s in project.statuses.all()}
    res = client.delete(f"/api/v1/projects/{project.id}/statuses/{statuses['done'].id}")
    assert res.status_code == 409
    assert res.json()["code"] == "status_required"
    assert client.delete(f"/api/v1/projects/{project.id}/statuses/{statuses['progress'].id}").status_code == 204
    assert not Status.objects.filter(pk=statuses["progress"].pk).exists()


def test_label_crud(owner, ws, project):
    client = client_for(owner)
    res = client.post(f"/api/v1/projects/{project.id}/labels", {"name": " Perf ", "color": "#ff0000"}, format="json")
    assert res.status_code == 201
    assert res.json()["name"] == "perf"
    same = client.post(f"/api/v1/projects/{project.id}/labels", {"name": "PERF"}, format="json")
    assert same.json()["id"] == res.json()["id"]
    assert client.post(f"/api/v1/projects/{project.id}/labels", {"name": ""}, format="json").status_code == 422
    assert (
        client.post(f"/api/v1/projects/{project.id}/labels", {"name": "x", "color": "red;}"}, format="json").status_code
        == 422
    )
    lid = res.json()["id"]
    assert (
        client.patch(f"/api/v1/projects/{project.id}/labels/{lid}", {"name": "bug"}, format="json").status_code == 422
    )
    up = client.patch(
        f"/api/v1/projects/{project.id}/labels/{lid}", {"name": "speed", "color": "var(--ok)"}, format="json"
    )
    assert up.json() == {**up.json(), "name": "speed", "color": "var(--ok)"}
    assert client.delete(f"/api/v1/projects/{project.id}/labels/{lid}").status_code == 204
    assert client.delete(f"/api/v1/projects/{project.id}/labels/{lid}").status_code == 404
