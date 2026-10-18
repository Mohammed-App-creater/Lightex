"""Sales S0 §1 (docs/sales/s0-contract.md): several workspace roles per member. Union of permissions, widest data
scope, the member and invite APIs (new and old fields), last-Owner invariants and role deletion."""

import pytest

from core.access.models import Permission, Role, RolePermission
from core.access.services import can, my_data_scopes, my_permissions, sync_permission_catalogue, visible_to
from core.audit.models import AuditLog
from core.common.testing import PASSWORD, UserFactory, add_member, client_for, make_member, role, set_roles
from core.modules import services as modules
from core.teams.models import Team, TeamMember
from core.tests.fake_module import module as fake
from core.tests.fake_module.models import Widget
from core.workspaces.models import Invitation, WorkspaceMember, WorkspaceMemberRole

pytestmark = pytest.mark.django_db

VIEW = fake.WIDGET_VIEW
MEMBERS = "/api/v1/workspaces/platform/members"
INVITES = "/api/v1/workspaces/platform/invites"


def custom_role(ws, name, codes, scopes=None):
    r = Role.objects.create(workspace=ws, name=name, scope="workspace")
    for code in codes:
        RolePermission.objects.create(
            role=r, permission=Permission.objects.get(code=code), data_scope=(scopes or {}).get(code)
        )
    return r


def fresh(user):
    user.__dict__.pop("_lx_access_cache", None)
    return user


def ids(*roles):
    return [str(r.pk) for r in roles]


@pytest.fixture
def fake_on(owner, ws):
    fake.register()
    sync_permission_catalogue()
    modules.set_module_enabled(owner, ws, "fake", True)
    yield
    fake.unregister()


# ───────────────────────── effective permissions ─────────────────────────


def test_permissions_are_the_union_of_the_roles(owner, ws):
    auditor = custom_role(ws, "Auditor", ["core.audit.view"])
    user = add_member(ws, UserFactory())
    assert not can(fresh(user), "core.audit.view", ws)
    set_roles(ws, user, role(ws, "member"), auditor)
    assert can(fresh(user), "core.audit.view", ws)
    assert can(user, "core.workspace.view", ws)
    assert my_permissions(user, ws) == ["core.workspace.view", "core.audit.view"]
    assert not can(user, "core.roles.manage", ws)


def test_widest_data_scope_wins(owner, ws, fake_on):
    """Member grants `own`; a second role grants `team`, then `all`. The widest applies to myDataScopes and
    visible_to()."""
    user = add_member(ws, UserFactory(name="Sam"))
    mate = add_member(ws, UserFactory(name="Mate"))
    stranger = add_member(ws, UserFactory(name="Stranger"))
    team = Team.objects.create(workspace=ws, name="Red")
    for u in (user, mate):
        TeamMember.objects.create(workspace=ws, team=team, user=u)
    for u in (user, mate, stranger):
        Widget.objects.create(workspace=ws, title=u.name, owner=u)

    def seen():
        return sorted(visible_to(Widget.objects.all(), fresh(user), VIEW, ws).values_list("title", flat=True))

    assert my_data_scopes(fresh(user), ws) == {VIEW: "own"}
    assert seen() == ["Sam"]
    lead = custom_role(ws, "Team lead", ["core.workspace.view", VIEW], {VIEW: "team"})
    set_roles(ws, user, role(ws, "member"), lead)
    assert my_data_scopes(fresh(user), ws) == {VIEW: "team"}
    assert seen() == ["Mate", "Sam"]
    boss = custom_role(ws, "Boss", [VIEW], {VIEW: "all"})
    set_roles(ws, user, lead, boss, role(ws, "member"))
    assert my_data_scopes(fresh(user), ws) == {VIEW: "all"}
    assert seen() == ["Mate", "Sam", "Stranger"]
    me = client_for(user).get("/api/v1/workspaces/platform").json()
    assert me["myDataScopes"] == {VIEW: "all"}
    assert me["myRoleIds"] == ids(role(ws, "member"), boss, lead)
    assert me["myRoleId"] == str(role(ws, "member").pk)


def test_a_deactivated_membership_grants_nothing(owner, ws):
    user = add_member(ws, UserFactory(), ["member", "admin"])
    WorkspaceMember.objects.filter(workspace=ws, user=user).update(status="deactivated")
    assert my_permissions(fresh(user), ws) == []


# ───────────────────────── member API ─────────────────────────


def test_member_responses_list_every_role_in_precedence_order(owner, ws):
    zed = custom_role(ws, "Zed", ["core.workspace.view"])
    alpha = custom_role(ws, "alpha", ["core.workspace.view"])
    user = add_member(ws, UserFactory(name="Multi"))
    set_roles(ws, user, zed, role(ws, "member"), alpha, role(ws, "admin"))
    rows = client_for(owner).get(MEMBERS).json()["data"]
    me = next(m for m in rows if m["userId"] == str(user.pk))
    assert me["roleIds"] == ids(role(ws, "admin"), role(ws, "member"), alpha, zed)
    assert me["roleId"] == str(role(ws, "admin").pk)
    owner_row = next(m for m in rows if m["userId"] == str(owner.pk))
    assert owner_row["roleIds"] == [owner_row["roleId"]] == ids(role(ws, "owner"))
    # filter[role] matches members holding any of the roles.
    by_alpha = client_for(owner).get(f"{MEMBERS}?filter[role]={alpha.pk}").json()["data"]
    assert [m["userId"] for m in by_alpha] == [str(user.pk)]
    both = client_for(owner).get(f"{MEMBERS}?filter[role]={alpha.pk}&filter[role]={role(ws, 'owner').pk}")
    both = both.json()["data"]
    assert {m["userId"] for m in both} == {str(user.pk), str(owner.pk)}
    assert client_for(owner).get(f"{MEMBERS}?filter[role]=nope").json()["data"] == []


def test_change_roles_with_role_ids(owner, ws):
    seller = custom_role(ws, "Seller", ["core.workspace.view", "core.audit.view"])
    user = add_member(ws, UserFactory(name="Sam"))
    client = client_for(owner)
    res = client.patch(f"{MEMBERS}/{user.pk}", {"roleIds": ids(seller, role(ws, "member"), seller)}, format="json")
    assert res.status_code == 200, res.json()
    assert res.json()["roleIds"] == ids(role(ws, "member"), seller)
    assert can(fresh(user), "core.audit.view", ws)
    row = AuditLog.objects.filter(action="core.member.role_changed").latest("created_at")
    assert row.changes == [{"field": "Roles", "kind": "value", "before": "Member", "after": "Member, Seller"}]
    # The old single field replaces every role.
    res = client.patch(f"{MEMBERS}/{user.pk}", {"roleId": str(role(ws, "admin").pk)}, format="json")
    assert res.status_code == 200
    assert res.json()["roleIds"] == ids(role(ws, "admin"))
    assert set(my_permissions(fresh(user), ws)) == set(my_permissions(fresh(owner), ws)) - {"core.workspace.delete"}
    # roleIds wins over roleId.
    res = client.patch(
        f"{MEMBERS}/{user.pk}", {"roleIds": ids(role(ws, "member")), "roleId": str(seller.pk)}, format="json"
    )
    assert res.json()["roleIds"] == ids(role(ws, "member"))
    # Unchanged: no audit row.
    before = AuditLog.objects.filter(action="core.member.role_changed").count()
    client.patch(f"{MEMBERS}/{user.pk}", {"roleIds": ids(role(ws, "member"))}, format="json")
    assert AuditLog.objects.filter(action="core.member.role_changed").count() == before


@pytest.mark.parametrize(
    ("payload", "field", "message"),
    [
        ({"roleIds": []}, "roleIds", "Pick at least one role"),
        ({"roleIds": "x"}, "roleIds", "Pick at least one role"),
        ({}, "roleIds", "Pick at least one role"),
        ({"roleIds": ["nope"]}, "roleIds", "Pick workspace roles"),
        ({"roleIds": ["00000000-0000-0000-0000-000000000000"]}, "roleIds", "Pick workspace roles"),
        ({"roleId": "nope"}, "roleId", "Pick a workspace role"),
    ],
)
def test_change_roles_validation(owner, ws, payload, field, message):
    user = add_member(ws)
    res = client_for(owner).patch(f"{MEMBERS}/{user.pk}", payload, format="json")
    assert res.status_code == 422
    assert res.json()["details"]["fields"] == {field: message}


def test_project_roles_and_other_workspaces_roles_are_refused(owner, ws):
    user = add_member(ws)
    other = add_member(ws, UserFactory())
    from core.common.testing import make_workspace

    elsewhere = make_workspace(other, name="Else", slug="else")
    for bad in (role(ws, "viewer"), role(elsewhere, "member")):
        res = client_for(owner).patch(f"{MEMBERS}/{user.pk}", {"roleIds": ids(role(ws, "member"), bad)}, format="json")
        assert res.status_code == 422
        assert res.json()["details"]["fields"] == {"roleIds": "Pick workspace roles"}


def test_no_escalation_when_adding_or_removing_roles(owner, ws):
    admin = add_member(ws, UserFactory(), "admin")
    deleter = custom_role(ws, "Deleter", ["core.workspace.view", "core.workspace.delete"])
    user = add_member(ws)
    client = client_for(admin)
    res = client.patch(f"{MEMBERS}/{user.pk}", {"roleIds": ids(role(ws, "member"), deleter)}, format="json")
    assert res.status_code == 403
    assert res.json()["details"] == {"permission": "core.workspace.delete"}
    # A role the member keeps isn't checked; one being removed is.
    set_roles(ws, user, role(ws, "member"), deleter)
    keep = client.patch(f"{MEMBERS}/{user.pk}", {"roleIds": ids(role(ws, "member"), deleter)}, format="json")
    assert keep.status_code == 200
    drop = client.patch(f"{MEMBERS}/{user.pk}", {"roleIds": ids(role(ws, "member"))}, format="json")
    assert drop.status_code == 403


# ───────────────────────── last Owner ─────────────────────────


def test_last_owner_keeps_the_owner_role_even_with_other_roles(owner, ws):
    client = client_for(owner)
    set_roles(ws, owner, role(ws, "owner"), role(ws, "admin"))
    res = client.patch(f"{MEMBERS}/{owner.pk}", {"roleIds": ids(role(ws, "admin"), role(ws, "member"))}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "last_owner")
    # Adding roles next to Owner is fine.
    ok = client.patch(f"{MEMBERS}/{owner.pk}", {"roleIds": ids(role(ws, "member"), role(ws, "owner"))}, format="json")
    assert ok.status_code == 200
    assert ok.json()["roleIds"] == ids(role(ws, "owner"), role(ws, "member"))
    # With a second owner (through a custom role holding the owner permission), the first may step down.
    co = custom_role(ws, "Co-owner", list(my_permissions(fresh(owner), ws)))
    second = add_member(ws, UserFactory())
    set_roles(ws, second, role(ws, "member"), co)
    res = client.patch(f"{MEMBERS}/{owner.pk}", {"roleIds": ids(role(ws, "admin"))}, format="json")
    assert res.status_code == 200
    # Now `second` is the last owner: removing them, or the Co-owner role from them, is refused.
    second_client = client_for(second)
    assert (
        second_client.patch(f"{MEMBERS}/{second.pk}", {"roleIds": ids(role(ws, "member"))}, format="json").json()[
            "code"
        ]
        == "last_owner"
    )
    third = add_member(ws, UserFactory(), "owner")
    assert client_for(third).delete(f"{MEMBERS}/{second.pk}").status_code == 204
    # `third` is now the last owner and can't be removed (by an admin it's an escalation first).
    assert client_for(owner).delete(f"{MEMBERS}/{third.pk}").status_code == 403
    assert WorkspaceMember.objects.filter(workspace=ws, user=third).exists()


def test_last_owner_through_role_edits_and_deletion(owner, ws):
    """Owner permission held only through a custom role next to Member: editing or deleting that role is refused."""
    client = client_for(owner)
    codes = list(my_permissions(fresh(owner), ws))
    co = client.post(
        "/api/v1/workspaces/platform/roles", {"name": "Co", "scope": "workspace", "permissions": codes}, format="json"
    ).json()
    set_roles(ws, owner, role(ws, "member"), co["id"])
    res = client.patch(f"/api/v1/roles/{co['id']}", {"permissions": ["core.workspace.view"]}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "last_owner")
    res = client.delete(f"/api/v1/roles/{co['id']}", {"reassignTo": str(role(ws, "admin").pk)}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "last_owner")
    ok = client.delete(f"/api/v1/roles/{co['id']}", {"reassignTo": str(role(ws, "owner").pk)}, format="json")
    assert ok.status_code == 204
    member = WorkspaceMember.objects.get(workspace=ws, user=owner)
    assert member.role_list() == [role(ws, "owner"), role(ws, "member")]


def test_role_deletion_reassigns_without_duplicates(owner, ws):
    client = client_for(owner)
    helper = custom_role(ws, "Helper", ["core.workspace.view"])
    both = add_member(ws, UserFactory())
    only = add_member(ws, UserFactory())
    set_roles(ws, both, role(ws, "member"), helper)
    set_roles(ws, only, helper)
    res = client.delete(f"/api/v1/roles/{helper.pk}")
    assert (res.status_code, res.json()["details"]) == (409, {"memberCount": 2})
    ok = client.delete(f"/api/v1/roles/{helper.pk}", {"reassignTo": str(role(ws, "member").pk)}, format="json")
    assert ok.status_code == 204
    assert WorkspaceMember.objects.get(workspace=ws, user=both).role_list() == [role(ws, "member")]
    assert WorkspaceMember.objects.get(workspace=ws, user=only).role_list() == [role(ws, "member")]
    assert WorkspaceMemberRole.objects.filter(member__workspace=ws, role=role(ws, "member")).count() == 2
    roles = {r["id"]: r for r in client.get("/api/v1/workspaces/platform/roles").json()}
    assert roles[str(role(ws, "member").pk)]["memberCount"] == 2


def test_role_member_count_counts_each_holder_once(owner, ws):
    user = add_member(ws, UserFactory(), ["member", "admin"])
    assert user
    roles = {r["id"]: r for r in client_for(owner).get("/api/v1/workspaces/platform/roles").json()}
    assert roles[str(role(ws, "member").pk)]["memberCount"] == 1
    assert roles[str(role(ws, "admin").pk)]["memberCount"] == 1
    assert roles[str(role(ws, "owner").pk)]["memberCount"] == 1


# ───────────────────────── invitations ─────────────────────────


def test_invite_with_several_roles(owner, ws, api):
    from django.core import mail

    seller = custom_role(ws, "Seller", ["core.workspace.view", "core.audit.view"])
    client = client_for(owner)
    res = client.post(INVITES, {"emails": ["new@team.dev"], "roleIds": ids(seller, role(ws, "member"))}, format="json")
    assert res.status_code == 201, res.json()
    inv = res.json()[0]
    assert inv["roleIds"] == ids(role(ws, "member"), seller)
    assert inv["roleNames"] == ["Member", "Seller"]
    assert (inv["roleId"], inv["roleName"]) == (str(role(ws, "member").pk), "Member")
    listed = client.get(INVITES).json()
    assert listed[0]["roleIds"] == inv["roleIds"]
    assert "Member, Seller" in mail.outbox[-1].body or "Member, Seller" in str(mail.outbox[-1].alternatives)
    token = mail.outbox[-1].body.split("/invite/")[1].split()[0].strip(")>\"'")
    ok = api.post(f"/api/v1/invites/{token}/accept", {"name": "New Person", "password": PASSWORD}, format="json")
    assert ok.status_code == 200, ok.json()
    member = WorkspaceMember.objects.get(workspace=ws, user__email="new@team.dev")
    assert member.role_list() == [role(ws, "member"), seller]
    assert can(fresh(member.user), "core.audit.view", ws)


def test_invite_old_single_role_and_validation(owner, ws):
    client = client_for(owner)
    res = client.post(INVITES, {"emails": ["one@team.dev"], "roleId": str(role(ws, "admin").pk)}, format="json")
    assert res.status_code == 201
    assert res.json()[0]["roleIds"] == ids(role(ws, "admin"))
    empty = client.post(INVITES, {"emails": ["two@team.dev"], "roleIds": []}, format="json")
    assert (empty.status_code, empty.json()["details"]["fields"]) == (422, {"roleIds": "Pick at least one role"})
    project = client.post(INVITES, {"emails": ["two@team.dev"], "roleIds": ids(role(ws, "viewer"))}, format="json")
    assert (project.status_code, project.json()["details"]["fields"]) == (422, {"roleIds": "Pick workspace roles"})
    admin = add_member(ws, UserFactory(), "admin")
    escalate = client_for(admin).post(
        INVITES, {"emails": ["two@team.dev"], "roleIds": ids(role(ws, "member"), role(ws, "owner"))}, format="json"
    )
    assert escalate.status_code == 403


def test_deleting_a_role_on_an_invite(owner, ws):
    client = client_for(owner)
    helper = custom_role(ws, "Helper", ["core.workspace.view"])
    gone = custom_role(ws, "Gone", ["core.workspace.view"])
    client.post(INVITES, {"emails": ["a@team.dev"], "roleIds": ids(helper, role(ws, "member"))}, format="json")
    client.post(INVITES, {"emails": ["b@team.dev"], "roleIds": ids(helper)}, format="json")
    client.post(INVITES, {"emails": ["c@team.dev"], "roleIds": ids(gone)}, format="json")
    assert client.delete(f"/api/v1/roles/{helper.pk}", {"reassignTo": str(role(ws, "member").pk)}).status_code == 204
    assert Invitation.objects.get(email="a@team.dev").role_list() == [role(ws, "member")]
    assert Invitation.objects.get(email="b@team.dev").role_list() == [role(ws, "member")]
    assert client.delete(f"/api/v1/roles/{gone.pk}").status_code == 204
    assert not Invitation.objects.filter(email="c@team.dev").exists()


def test_make_member_helper_and_search_role_name(owner, ws):
    user = UserFactory(name="Searchable Person")
    make_member(ws, user, role(ws, "admin"), role(ws, "member"))
    res = client_for(owner).get("/api/v1/workspaces/platform/search?q=Searchable&filter[type]=user").json()
    assert [(r["title"], r["roleName"]) for r in res] == [("Searchable Person", "Admin")]
