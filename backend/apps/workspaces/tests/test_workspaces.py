import re

import pytest
from django.core import mail
from freezegun import freeze_time

from apps.audit.models import AuditLog
from apps.common.testing import PASSWORD, UserFactory, add_member, client_for, make_workspace, role
from apps.workspaces.models import Invitation, Workspace, WorkspaceMember

pytestmark = pytest.mark.django_db


def test_create_workspace_seeds_roles_and_owner(owner):
    client = client_for(owner)
    res = client.post("/api/v1/workspaces", {"name": "Platform team", "slug": "Platform Team!"}, format="json")
    assert res.status_code == 201
    body = res.json()
    assert body["slug"] == "platform-team"
    assert body["memberCount"] == 1
    assert "workspace.delete" in body["my_permissions"]
    assert body["my_permissions"][0] == "workspace.view"
    ws = Workspace.objects.get(slug="platform-team")
    assert ws.roles.count() == 7
    assert set(ws.roles.values_list("system_key", flat=True)) == {
        "owner", "admin", "member", "project_admin", "manager", "project_member", "viewer",
    }  # fmt: skip
    assert body["myRoleId"] == str(role(ws, "owner").id)
    assert AuditLog.objects.filter(workspace=ws, action="workspace.created").exists()


def test_create_workspace_validation(owner):
    client = client_for(owner)
    make_workspace(owner, slug="taken")
    res = client.post("/api/v1/workspaces", {"name": "x", "slug": "taken"}, format="json")
    assert res.status_code == 422
    assert set(res.json()["details"]["fields"]) == {"name", "slug"}
    assert client.post("/api/v1/workspaces", {"name": "Admin", "slug": "admin"}, format="json").status_code == 422


def test_list_only_my_workspaces(owner, ws):
    other = make_workspace(UserFactory(), name="Other", slug="other")
    res = client_for(owner).get("/api/v1/workspaces")
    assert [w["slug"] for w in res.json()] == ["platform"]
    assert other.slug not in str(res.json())


def test_non_member_gets_404_everywhere(ws):
    stranger = client_for(UserFactory())
    for path in ["", "/members", "/invites", "/slug-availability?q=x", "/access-requests/mine"]:
        assert stranger.get(f"/api/v1/workspaces/platform{path}").status_code == 404, path
    assert stranger.patch("/api/v1/workspaces/platform", {"name": "Hacked"}, format="json").status_code == 404
    assert stranger.delete("/api/v1/workspaces/platform", {"confirm": "platform"}, format="json").status_code == 404


def test_update_workspace_permissions_and_audit(owner, ws):
    member = add_member(ws, key="member")
    assert client_for(member).patch("/api/v1/workspaces/platform", {"name": "Nope"}, format="json").status_code == 403
    res = client_for(owner).patch("/api/v1/workspaces/platform", {"name": "Core team", "slug": "core"}, format="json")
    assert res.status_code == 200
    assert res.json()["slug"] == "core"
    entry = AuditLog.objects.get(action="workspace.updated")
    assert {c["field"] for c in entry.changes} == {"Name", "URL"}
    bad = client_for(owner).patch("/api/v1/workspaces/core", {"name": "a", "slug": "x"}, format="json")
    assert bad.status_code == 422


def test_slug_availability(owner, ws):
    make_workspace(UserFactory(), name="Other", slug="other")
    client = client_for(owner)
    assert client.get("/api/v1/workspaces/platform/slug-availability?q=other").json() == {
        "slug": "other",
        "available": False,
    }
    assert client.get("/api/v1/workspaces/platform/slug-availability?q=Fresh One").json() == {
        "slug": "fresh-one",
        "available": True,
    }
    assert client.get("/api/v1/workspaces/platform/slug-availability?q=platform").json()["available"] is True


def test_delete_workspace_requires_confirm_and_permission(owner, ws):
    admin = add_member(ws, key="admin")
    assert (
        client_for(admin).delete("/api/v1/workspaces/platform", {"confirm": "platform"}, format="json").status_code
        == 403
    )
    client = client_for(owner)
    assert client.delete("/api/v1/workspaces/platform", {"confirm": "nope"}, format="json").status_code == 422
    assert client.delete("/api/v1/workspaces/platform", {"confirm": "platform"}, format="json").status_code == 204
    assert client.get("/api/v1/workspaces/platform").status_code == 404
    assert Workspace.all_objects.get(slug="platform").deleted_at is not None
    assert client.get("/api/v1/workspaces").json() == []


# ───────────────────────── members ─────────────────────────


def test_member_list_pagination_and_filters(owner, ws):
    for i in range(5):
        add_member(ws, UserFactory(name=f"Member {i}"), key="member")
    client = client_for(owner)
    page = client.get("/api/v1/workspaces/platform/members?limit=4").json()
    assert len(page["data"]) == 4
    assert page["nextCursor"]
    rest = client.get(f"/api/v1/workspaces/platform/members?limit=4&cursor={page['nextCursor']}").json()
    assert len(rest["data"]) == 2
    assert rest["nextCursor"] is None
    names = [m["user"]["name"] for m in page["data"] + rest["data"]]
    assert names == sorted(names)
    first = page["data"][0]
    assert set(first) == {"userId", "workspaceId", "roleId", "user", "status", "joinedAt", "lastActiveAt"}
    q = client.get("/api/v1/workspaces/platform/members?q=member 3").json()
    assert [m["user"]["name"] for m in q["data"]] == ["Member 3"]
    owners = client.get(f"/api/v1/workspaces/platform/members?filter[role]={role(ws, 'owner').id}").json()
    assert [m["userId"] for m in owners["data"]] == [str(owner.id)]


def test_change_role_rules(owner, ws):
    admin = add_member(ws, key="admin")
    member = add_member(ws, key="member")
    plain = client_for(member)
    assert (
        plain.patch(
            f"/api/v1/workspaces/platform/members/{admin.id}", {"roleId": str(role(ws, "member").id)}, format="json"
        ).status_code
        == 403
    )
    a = client_for(admin)
    ok = a.patch(
        f"/api/v1/workspaces/platform/members/{member.id}", {"roleId": str(role(ws, "admin").id)}, format="json"
    )
    assert ok.status_code == 200
    assert ok.json()["roleId"] == str(role(ws, "admin").id)
    # No escalation: an admin can't grant (or take away) the owner role.
    up = a.patch(
        f"/api/v1/workspaces/platform/members/{member.id}", {"roleId": str(role(ws, "owner").id)}, format="json"
    )
    assert up.status_code == 403
    down = a.patch(
        f"/api/v1/workspaces/platform/members/{owner.id}", {"roleId": str(role(ws, "member").id)}, format="json"
    )
    assert down.status_code == 403
    # Project roles are not workspace roles.
    bad = a.patch(
        f"/api/v1/workspaces/platform/members/{member.id}", {"roleId": str(role(ws, "viewer").id)}, format="json"
    )
    assert bad.status_code == 422
    assert (
        a.patch(f"/api/v1/workspaces/platform/members/{member.id}", {"roleId": "nope"}, format="json").status_code
        == 422
    )


def test_last_owner_cannot_be_demoted_or_removed(owner, ws):
    client = client_for(owner)
    res = client.patch(
        f"/api/v1/workspaces/platform/members/{owner.id}", {"roleId": str(role(ws, "admin").id)}, format="json"
    )
    assert res.status_code == 409
    assert res.json()["code"] == "last_owner"
    second = add_member(ws, key="owner")
    assert (
        client.patch(
            f"/api/v1/workspaces/platform/members/{owner.id}", {"roleId": str(role(ws, "admin").id)}, format="json"
        ).status_code
        == 200
    )
    # `second` is now the last owner; owner (now admin) can't remove them.
    assert client_for(owner).delete(f"/api/v1/workspaces/platform/members/{second.id}").status_code in (403, 409)


def test_remove_member(owner, ws):
    member = add_member(ws, key="member")
    client = client_for(owner)
    assert client.delete(f"/api/v1/workspaces/platform/members/{owner.id}").status_code == 403  # self
    assert client.delete(f"/api/v1/workspaces/platform/members/{member.id}").status_code == 204
    assert not WorkspaceMember.objects.filter(workspace=ws, user=member).exists()
    assert client.delete(f"/api/v1/workspaces/platform/members/{member.id}").status_code == 404
    assert client_for(member).get("/api/v1/workspaces/platform").status_code == 404
    assert AuditLog.objects.filter(action="member.removed").exists()


# ───────────────────────── invitations ─────────────────────────


def _token() -> str:
    match = re.search(r"/invite/([A-Za-z0-9_\-]+)", mail.outbox[-1].body)
    assert match
    return match.group(1)


def test_invite_flow_new_user(owner, ws, api):
    client = client_for(owner)
    res = client.post(
        "/api/v1/workspaces/platform/invites",
        {"emails": ["New@Team.dev", "new@team.dev"], "roleId": str(role(ws, "admin").id)},
        format="json",
    )
    assert res.status_code == 201
    assert len(res.json()) == 1
    invite = res.json()[0]
    assert invite["email"] == "new@team.dev"
    assert invite["roleName"] == "Admin"
    assert invite["status"] == "pending"
    assert invite["invitedBy"]["id"] == str(owner.id)
    assert "token" not in str(invite)
    assert mail.outbox[-1].to == ["new@team.dev"]
    assert "Platform team" in mail.outbox[-1].subject
    token = _token()
    assert not Invitation.objects.filter(token_hash=token).exists()  # only the hash is stored

    public = api.get(f"/api/v1/invites/{token}")
    assert public.status_code == 200
    assert public.json()["workspaceName"] == "Platform team"
    bad = api.post(f"/api/v1/invites/{token}/accept", {"name": "N", "password": "x"}, format="json")
    assert bad.status_code == 422
    ok = api.post(f"/api/v1/invites/{token}/accept", {"name": "New Person", "password": PASSWORD}, format="json")
    assert ok.status_code == 200
    assert ok.json()["workspaceSlug"] == "platform"
    assert ok.json()["accessToken"]
    member = WorkspaceMember.objects.get(workspace=ws, user__email="new@team.dev")
    assert member.role.system_key == "admin"
    again = api.post(f"/api/v1/invites/{token}/accept", {"name": "New Person", "password": PASSWORD}, format="json")
    assert again.status_code == 410
    assert client.get("/api/v1/workspaces/platform/invites").json() == []


def test_invite_existing_user_requires_password_or_session(owner, ws, api):
    existing = UserFactory(email="exists@team.dev")
    client_for(owner).post(
        "/api/v1/workspaces/platform/invites",
        {"emails": ["exists@team.dev"], "roleId": str(role(ws, "member").id)},
        format="json",
    )
    token = _token()
    stolen = api.post(f"/api/v1/invites/{token}/accept", {"name": "Attacker", "password": "Wr0ng!pass"}, format="json")
    assert stolen.status_code == 422
    other = UserFactory(email="other@team.dev")
    mismatch = client_for(other).post(f"/api/v1/invites/{token}/accept", {}, format="json")
    assert mismatch.status_code == 403
    ok = client_for(existing).post(f"/api/v1/invites/{token}/accept", {}, format="json")
    assert ok.status_code == 200
    assert WorkspaceMember.objects.filter(workspace=ws, user=existing).exists()


def test_invite_existing_user_with_password(owner, ws, api):
    UserFactory(email="pw@team.dev")
    client_for(owner).post(
        "/api/v1/workspaces/platform/invites",
        {"emails": ["pw@team.dev"], "roleId": str(role(ws, "member").id)},
        format="json",
    )
    ok = api.post(f"/api/v1/invites/{_token()}/accept", {"name": "", "password": PASSWORD}, format="json")
    assert ok.status_code == 200


def test_invite_validation_and_permissions(owner, ws):
    member = add_member(ws, key="member")
    payload = {"emails": ["a@b.dev"], "roleId": str(role(ws, "member").id)}
    assert client_for(member).post("/api/v1/workspaces/platform/invites", payload, format="json").status_code == 403
    assert client_for(member).get("/api/v1/workspaces/platform/invites").status_code == 403
    client = client_for(owner)
    assert (
        client.post(
            "/api/v1/workspaces/platform/invites", {"emails": [], "roleId": payload["roleId"]}, format="json"
        ).status_code
        == 422
    )
    bad = client.post(
        "/api/v1/workspaces/platform/invites", {"emails": ["nope"], "roleId": payload["roleId"]}, format="json"
    )
    assert "isn’t an email" in bad.json()["details"]["fields"]["emails"]
    assert (
        client.post(
            "/api/v1/workspaces/platform/invites",
            {"emails": ["a@b.dev"], "roleId": str(role(ws, "viewer").id)},
            format="json",
        ).status_code
        == 422
    )
    too_many = {"emails": [f"u{i}@b.dev" for i in range(21)], "roleId": payload["roleId"]}
    assert client.post("/api/v1/workspaces/platform/invites", too_many, format="json").status_code == 422
    # Existing members are skipped silently.
    res = client.post(
        "/api/v1/workspaces/platform/invites", {"emails": [member.email], "roleId": payload["roleId"]}, format="json"
    )
    assert res.json() == []


def test_admin_cannot_invite_owner(owner, ws):
    admin = add_member(ws, key="admin")
    res = client_for(admin).post(
        "/api/v1/workspaces/platform/invites",
        {"emails": ["x@b.dev"], "roleId": str(role(ws, "owner").id)},
        format="json",
    )
    assert res.status_code == 403


def test_revoke_and_resend(owner, ws, api):
    client = client_for(owner)
    inv = client.post(
        "/api/v1/workspaces/platform/invites",
        {"emails": ["r@team.dev"], "roleId": str(role(ws, "member").id)},
        format="json",
    ).json()[0]
    first = _token()
    resent = client.post(f"/api/v1/workspaces/platform/invites/{inv['id']}/resend")
    assert resent.status_code == 200
    second = _token()
    assert first != second
    assert api.get(f"/api/v1/invites/{first}").status_code == 404  # old link no longer works
    assert api.get(f"/api/v1/invites/{second}").status_code == 200
    assert client.delete(f"/api/v1/workspaces/platform/invites/{inv['id']}").status_code == 204
    assert (
        api.post(f"/api/v1/invites/{second}/accept", {"name": "R R", "password": PASSWORD}, format="json").status_code
        == 410
    )
    assert client.post(f"/api/v1/workspaces/platform/invites/{inv['id']}/resend").status_code == 409
    assert client.delete(f"/api/v1/workspaces/platform/invites/{inv['id']}").status_code == 204  # idempotent


def test_invite_expires_after_seven_days(owner, ws, api):
    with freeze_time("2026-10-01 09:00:00"):
        client_for(owner).post(
            "/api/v1/workspaces/platform/invites",
            {"emails": ["late@team.dev"], "roleId": str(role(ws, "member").id)},
            format="json",
        )
    token = _token()
    with freeze_time("2026-10-08 08:59:00"):
        assert api.get(f"/api/v1/invites/{token}").json()["status"] == "pending"
    with freeze_time("2026-10-08 09:01:00"):
        assert api.get(f"/api/v1/invites/{token}").json()["status"] == "expired"
        res = api.post(f"/api/v1/invites/{token}/accept", {"name": "Late", "password": PASSWORD}, format="json")
        assert res.status_code == 410
        # A new invite to the same address replaces the expired one.
        again = client_for(owner).post(
            "/api/v1/workspaces/platform/invites",
            {"emails": ["late@team.dev"], "roleId": str(role(ws, "member").id)},
            format="json",
        )
        assert len(again.json()) == 1


def test_unknown_invite_token(api):
    assert api.get("/api/v1/invites/nope").status_code == 404
    assert api.post("/api/v1/invites/nope/accept", {}, format="json").status_code == 404


# ───────────────────────── workspace access requests ─────────────────────────


def test_workspace_access_request(owner, ws):
    member = add_member(ws, key="member")
    client = client_for(member)
    assert client.get("/api/v1/workspaces/platform/access-requests/mine").json() == {"request": None}
    created = client.post("/api/v1/workspaces/platform/access-requests")
    assert created.status_code == 201
    assert client.post("/api/v1/workspaces/platform/access-requests").json()["id"] == created.json()["id"]
    assert (
        client.get("/api/v1/workspaces/platform/access-requests/mine").json()["request"]["id"] == created.json()["id"]
    )
    assert client.delete("/api/v1/workspaces/platform/access-requests/mine").status_code == 204
    assert client.get("/api/v1/workspaces/platform/access-requests/mine").json() == {"request": None}
    assert client_for(owner).post("/api/v1/workspaces/platform/access-requests").status_code == 409
