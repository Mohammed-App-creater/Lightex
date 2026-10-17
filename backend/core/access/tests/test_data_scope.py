"""Platform Stage 4 (docs/platform/stage4-contract.md §2, §3, §5): scopable permissions, role data scopes,
`myDataScopes` and `visible_to()`, exercised through the test-only fake module (`fake.widget.view`, Widget.owner)."""

import pytest
from django.core.exceptions import ImproperlyConfigured

from core.access import catalogue
from core.access.models import Permission, Role, RolePermission
from core.access.services import my_data_scopes, sync_permission_catalogue, visible_to
from core.audit.models import AuditLog
from core.common.testing import UserFactory, add_member, client_for, make_member, make_workspace, role, set_roles
from core.modules import services as modules
from core.modules.registry import ModuleDefinition, register_module, unregister_module
from core.teams.models import Team, TeamMember
from core.tests.fake_module import module as fake
from core.tests.fake_module.models import Widget

pytestmark = pytest.mark.django_db

VIEW = fake.WIDGET_VIEW


@pytest.fixture
def fake_module():
    fake.register()
    sync_permission_catalogue()
    yield fake.DEFINITION
    fake.unregister()


@pytest.fixture
def world(fake_module, owner, ws):
    """Teams: Red = {m1 (lead), m2}, Blue = {m2, m3}; m4 is in no team. Everyone owns one widget; an outsider owns
    one in another workspace."""
    modules.set_module_enabled(owner, ws, "fake", True)
    admin = add_member(ws, UserFactory(name="Ada Admin"), "admin")
    m1, m2, m3, m4 = (add_member(ws, UserFactory(name=f"M{i}")) for i in range(1, 5))
    red = Team.objects.create(workspace=ws, name="Red")
    blue = Team.objects.create(workspace=ws, name="Blue")
    for team, user, lead in ((red, m1, True), (red, m2, False), (blue, m2, False), (blue, m3, False)):
        TeamMember.objects.create(workspace=ws, team=team, user=user, is_lead=lead)
    people = {"owner": owner, "admin": admin, "m1": m1, "m2": m2, "m3": m3, "m4": m4}
    widgets = {k: Widget.objects.create(workspace=ws, title=f"{k}'s", owner=u) for k, u in people.items()}
    widgets["orphan"] = Widget.objects.create(workspace=ws, title="nobody's", owner=None)
    outsider = UserFactory(name="Out")
    other = make_workspace(outsider, name="Other", slug="other")
    modules.set_module_enabled(outsider, other, "fake", True)
    widgets["other"] = Widget.objects.create(workspace=other, title="theirs", owner=outsider)
    return {**people, "ws": ws, "other": other, "outsider": outsider, "red": red, "blue": blue, "w": widgets}


def seen(world, user, ws=None):
    titles = visible_to(Widget.objects.all(), user, VIEW, ws or world["ws"]).values_list("title", flat=True)
    return sorted(titles)


def set_member_scope(world, scope):
    member = role(world["ws"], "member")
    RolePermission.objects.filter(role=member, permission__code=VIEW).update(data_scope=scope)
    for k in ("m1", "m2", "m3", "m4"):
        world[k].__dict__.pop("_lx_access_cache", None)


# ───────────────────────── catalogue, seeding, responses ─────────────────────────


def test_catalogue_exposes_scopable(world):
    res = client_for(world["owner"]).get("/api/v1/permissions").json()
    by_key = {p["key"]: p for p in res}
    assert by_key[VIEW]["scopable"] is True
    assert by_key["core.workspace.view"]["scopable"] is False
    assert Permission.objects.get(code=VIEW).scopable
    assert catalogue.is_scopable(VIEW) and not catalogue.is_scopable("core.roles.manage")
    assert not catalogue.is_scopable("nope.x.y")


def test_enabling_seeds_default_scopes(world):
    scopes = dict(
        RolePermission.objects.filter(role__workspace=world["ws"], permission__code=VIEW).values_list(
            "role__system_key", "data_scope"
        )
    )
    assert scopes == {"owner": "all", "admin": "all", "member": "own"}
    # Non-scopable grants carry no scope.
    assert not RolePermission.objects.filter(permission__scopable=False, data_scope__isnull=False).exists()


def test_new_workspace_seeds_default_scopes(fake_module, owner):
    ws = make_workspace(owner, name="Fresh", slug="fresh", modules=["fake"])
    assert dict(
        RolePermission.objects.filter(role__workspace=ws, permission__code=VIEW).values_list(
            "role__system_key", "data_scope"
        )
    ) == {"owner": "all", "admin": "all", "member": "own"}


def test_a_module_may_name_the_default_scope(owner, ws):
    defn = ModuleDefinition(
        key="scoped",
        name="Scoped",
        permissions=(catalogue.workspace_permission("scoped.lead.view", "S", "View", "View", scopable=True),),
        default_role_grants={"owner": {"scoped.lead.view": "team"}, "member": ["scoped.lead.view"]},
    )
    register_module(defn)
    try:
        assert catalogue.role_def("owner").data_scopes == {"scoped.lead.view": "team"}
        assert catalogue.role_def("member").data_scopes == {"scoped.lead.view": "own"}
        modules.set_module_enabled(owner, ws, "scoped", True)
        assert my_data_scopes(owner, ws) == {"scoped.lead.view": "team"}
    finally:
        unregister_module("scoped")


def test_definitions_are_validated():
    with pytest.raises(ValueError, match="workspace"):
        register_module(
            ModuleDefinition(
                key="badscope",
                name="Bad",
                permissions=(
                    catalogue.PermissionDef("badscope.x.view", catalogue.PROJECT, "G", "L", "D", "badscope", True),
                ),
            )
        )
    with pytest.raises(ValueError, match="data scope"):
        register_module(ModuleDefinition(key="badgrant", name="Bad", default_role_grants={"owner": {"a.b.c": "most"}}))


def test_workspace_responses_carry_my_data_scopes(world):
    owner = client_for(world["owner"]).get("/api/v1/workspaces/platform").json()
    assert owner["myDataScopes"] == {VIEW: "all"}
    member = client_for(world["m1"]).get("/api/v1/workspaces/platform").json()
    assert member["myDataScopes"] == {VIEW: "own"}
    listed = client_for(world["m1"]).get("/api/v1/workspaces").json()
    assert listed[0]["myDataScopes"] == {VIEW: "own"}
    modules.set_module_enabled(world["owner"], world["ws"], "fake", False)
    assert client_for(world["owner"]).get("/api/v1/workspaces/platform").json()["myDataScopes"] == {}


def test_sync_keeps_data_scopes_consistent(world):
    owner_role = role(world["ws"], "owner")
    member_role = role(world["ws"], "member")
    RolePermission.objects.filter(role__in=[owner_role, member_role], permission__code=VIEW).update(data_scope=None)
    RolePermission.objects.filter(role=owner_role, permission__code="core.workspace.view").update(data_scope="all")
    custom = Role.objects.create(workspace=world["ws"], name="Custom", scope="workspace")
    RolePermission.objects.create(role=custom, permission=Permission.objects.get(code=VIEW))
    sync_permission_catalogue()
    assert RolePermission.objects.get(role=owner_role, permission__code=VIEW).data_scope == "all"
    assert RolePermission.objects.get(role=member_role, permission__code=VIEW).data_scope == "own"
    assert RolePermission.objects.get(role=custom, permission__code=VIEW).data_scope == "own"
    assert RolePermission.objects.get(role=owner_role, permission__code="core.workspace.view").data_scope is None


# ───────────────────────── visible_to ─────────────────────────


def test_all_sees_the_whole_workspace_only(world):
    expected = sorted(w.title for k, w in world["w"].items() if k != "other")
    assert seen(world, world["owner"]) == expected
    assert seen(world, world["admin"]) == expected
    assert seen(world, world["outsider"], world["other"]) == ["theirs"]


def test_own(world):
    for k in ("m1", "m2", "m3", "m4"):
        assert seen(world, world[k]) == [f"{k}'s"]


def test_team_covers_teammates_across_several_teams(world):
    set_member_scope(world, "team")
    assert seen(world, world["m1"]) == ["m1's", "m2's"]  # a lead sees the team
    assert seen(world, world["m2"]) == ["m1's", "m2's", "m3's"]  # in two teams
    assert seen(world, world["m3"]) == ["m2's", "m3's"]
    assert seen(world, world["m4"]) == ["m4's"]  # in no team: only their own


def test_team_ignores_deleted_teams_and_other_workspaces(world):
    set_member_scope(world, "team")
    world["red"].deleted_at = world["red"].created_at
    world["red"].save()
    assert seen(world, world["m1"]) == ["m1's"]
    # A team in another workspace never widens this one.
    other_team = Team.objects.create(workspace=world["other"], name="X")
    add_member(world["other"], world["m4"])
    TeamMember.objects.create(workspace=world["other"], team=other_team, user=world["m4"])
    TeamMember.objects.create(workspace=world["other"], team=other_team, user=world["outsider"])
    assert seen(world, world["m4"]) == ["m4's"]
    assert seen(world, world["m4"], world["other"]) == []  # member there with `own`, owns nothing there


def test_no_grant_non_members_and_disabled_module_see_nothing(world):
    ws = world["ws"]
    custom = Role.objects.create(workspace=ws, name="Bare", scope="workspace")
    RolePermission.objects.create(role=custom, permission=Permission.objects.get(code="core.workspace.view"))
    bare = UserFactory()
    make_member(ws, bare, custom)
    assert seen(world, bare) == []
    assert seen(world, world["outsider"]) == []
    assert my_data_scopes(world["outsider"], ws) == {}
    from django.contrib.auth.models import AnonymousUser

    assert seen(world, AnonymousUser()) == []
    modules.set_module_enabled(world["owner"], ws, "fake", False)
    owner = world["owner"]
    owner.__dict__.pop("_lx_access_cache", None)
    assert seen(world, owner) == []
    assert Widget.objects.filter(workspace=ws).count() == 7  # disabling never deletes data


def test_programming_errors():
    with pytest.raises(ValueError, match="Unknown"):
        visible_to(Widget.objects.all(), None, "nope.x.view", None)
    with pytest.raises(ValueError, match="not a scopable"):
        visible_to(Widget.objects.all(), None, "core.workspace.view", None)


def test_a_model_without_an_owner_field_is_an_error(fake_module):
    from core.collab.models import Comment

    with pytest.raises(ImproperlyConfigured):
        visible_to(Comment.objects.all(), None, VIEW, None)


def test_my_data_scopes_is_cached_per_request(world, django_assert_num_queries):
    user = world["m1"]
    my_data_scopes(user, world["ws"])
    with django_assert_num_queries(0):
        assert my_data_scopes(user, world["ws"]) == {VIEW: "own"}


# ───────────────────────── the role API ─────────────────────────


def _member_role(world):
    return role(world["ws"], "member")


def test_role_responses_carry_data_scopes(world):
    roles = client_for(world["owner"]).get("/api/v1/workspaces/platform/roles").json()
    by_key = {r["name"]: r for r in roles if r["scope"] == "workspace"}
    assert by_key["Owner"]["dataScopes"] == {VIEW: "all"}
    assert by_key["Member"]["dataScopes"] == {VIEW: "own"}
    project_role = next(r for r in roles if r["scope"] == "project")
    assert project_role["dataScopes"] == {}
    modules.set_module_enabled(world["owner"], world["ws"], "fake", False)
    roles = client_for(world["owner"]).get("/api/v1/workspaces/platform/roles").json()
    assert all(r["dataScopes"] == {} for r in roles)


def test_update_role_data_scopes(world):
    client = client_for(world["owner"])
    member = _member_role(world)
    res = client.patch(f"/api/v1/roles/{member.id}", {"dataScopes": {VIEW: "team"}}, format="json")
    assert res.status_code == 200, res.json()
    assert res.json()["dataScopes"] == {VIEW: "team"}
    assert VIEW in res.json()["permissions"]
    row = AuditLog.objects.filter(action="core.role.updated").latest("created_at")
    assert row.changes == [
        {"field": "Data scopes", "kind": "value", "before": f"{VIEW}: own", "after": f"{VIEW}: team"}
    ]
    # Leaving dataScopes out keeps the stored scope.
    perms = res.json()["permissions"]
    res = client.patch(f"/api/v1/roles/{member.id}", {"permissions": perms}, format="json")
    assert res.status_code == 200 and res.json()["dataScopes"] == {VIEW: "team"}
    # The PUT permissions route takes dataScopes too.
    res = client.put(
        f"/api/v1/roles/{member.id}/permissions", {"permissions": perms, "dataScopes": {VIEW: "all"}}, format="json"
    )
    assert res.status_code == 200 and res.json()["dataScopes"] == {VIEW: "all"}
    res = client.put(f"/api/v1/roles/{member.id}/permissions", {"permissions": perms}, format="json")
    assert res.json()["dataScopes"] == {VIEW: "all"}
    # Removing the grant drops the scope.
    res = client.patch(f"/api/v1/roles/{member.id}", {"permissions": ["core.workspace.view"]}, format="json")
    assert res.status_code == 200 and res.json()["dataScopes"] == {}
    # Granting it again needs a scope.
    res = client.patch(f"/api/v1/roles/{member.id}", {"permissions": perms}, format="json")
    assert (res.status_code, res.json()["code"], res.json()["details"]) == (
        400,
        "data_scope_required",
        {"codes": [VIEW]},
    )
    res = client.patch(f"/api/v1/roles/{member.id}", {"permissions": perms, "dataScopes": {VIEW: "own"}}, format="json")
    assert res.status_code == 200 and res.json()["dataScopes"] == {VIEW: "own"}


def test_role_data_scope_errors(world):
    client = client_for(world["owner"])
    member = _member_role(world)
    url = f"/api/v1/roles/{member.id}"
    res = client.patch(url, {"dataScopes": {"core.workspace.view": "all"}}, format="json")
    assert (res.status_code, res.json()["code"]) == (400, "data_scope_not_allowed")
    assert res.json()["details"] == {"codes": ["core.workspace.view"]}
    res = client.patch(url, {"dataScopes": {VIEW: "everything"}}, format="json")
    assert (res.status_code, res.json()["code"]) == (422, "validation_failed")
    assert "dataScopes" in res.json()["details"]["fields"]
    res = client.patch(url, {"dataScopes": ["own"]}, format="json")
    assert res.status_code == 422
    assert RolePermission.objects.get(role=member, permission__code=VIEW).data_scope == "own"


def test_create_role_with_data_scopes(world):
    client = client_for(world["owner"])
    url = "/api/v1/workspaces/platform/roles"
    payload = {"name": "Sales rep", "scope": "workspace", "permissions": ["core.workspace.view", VIEW]}
    res = client.post(url, payload, format="json")
    assert (res.status_code, res.json()["code"], res.json()["details"]) == (
        400,
        "data_scope_required",
        {"codes": [VIEW]},
    )
    res = client.post(url, {**payload, "dataScopes": {VIEW: "team"}}, format="json")
    assert res.status_code == 201, res.json()
    assert res.json()["dataScopes"] == {VIEW: "team"}
    created = AuditLog.objects.filter(action="core.role.created").latest("created_at")
    assert created.changes[-1]["field"] == "Data scopes"
    # A scope for a scopable code the role doesn't grant is dropped.
    res = client.post(
        url,
        {"name": "Viewer", "scope": "workspace", "permissions": ["core.workspace.view"], "dataScopes": {VIEW: "all"}},
        format="json",
    )
    assert res.status_code == 201 and res.json()["dataScopes"] == {}


def test_scope_change_reaches_visible_to_and_my_data_scopes(world):
    client = client_for(world["owner"])
    member = _member_role(world)
    client.patch(f"/api/v1/roles/{member.id}", {"dataScopes": {VIEW: "team"}}, format="json")
    m1 = client_for(world["m1"]).get("/api/v1/workspaces/platform").json()
    assert m1["myDataScopes"] == {VIEW: "team"}
    assert seen(world, world["m1"]) == ["m1's", "m2's"]


def test_a_scope_change_tells_role_holders(world):
    from core.realtime.models import RealtimeEvent

    RealtimeEvent.objects.all().delete()
    member = _member_role(world)
    client_for(world["owner"]).patch(f"/api/v1/roles/{member.id}", {"dataScopes": {VIEW: "all"}}, format="json")
    targets = set(RealtimeEvent.objects.filter(type="core.access.changed").values_list("user_id", flat=True))
    assert {world[k].pk for k in ("m1", "m2", "m3", "m4")} <= targets


# ───────────────────────── Stage 5: no wider scope than your own ─────────────────────────


def _role_manager(world, scope):
    """A workspace member whose custom role manages roles and holds VIEW with `scope`."""
    custom = Role.objects.create(workspace=world["ws"], name=f"Role manager {scope}", scope="workspace")
    for code in ("core.workspace.view", "core.roles.manage", VIEW):
        RolePermission.objects.create(
            role=custom, permission=Permission.objects.get(code=code), data_scope=scope if code == VIEW else None
        )
    user = add_member(world["ws"], UserFactory(name=f"RM {scope}"))
    set_roles(world["ws"], user, custom)
    return user


def test_a_wider_data_scope_than_your_own_is_refused(world):
    actor = client_for(_role_manager(world, "team"))
    member = _member_role(world)
    url = f"/api/v1/roles/{member.id}"
    res = actor.patch(url, {"dataScopes": {VIEW: "all"}}, format="json")
    assert (res.status_code, res.json()["code"]) == (403, "data_scope_exceeds_own")
    assert res.json()["details"] == {"code": VIEW, "dataScope": "all", "yours": "team"}
    assert RolePermission.objects.get(role=member, permission__code=VIEW).data_scope == "own"
    res = actor.patch(url, {"dataScopes": {VIEW: "team"}}, format="json")  # up to your own is fine
    assert res.status_code == 200 and res.json()["dataScopes"] == {VIEW: "team"}
    res = actor.patch(url, {"dataScopes": {VIEW: "own"}}, format="json")  # narrowing is fine
    assert res.status_code == 200
    res = actor.post(
        "/api/v1/workspaces/platform/roles",
        {
            "name": "Wide",
            "scope": "workspace",
            "permissions": ["core.workspace.view", VIEW],
            "dataScopes": {VIEW: "all"},
        },
        format="json",
    )
    assert (res.status_code, res.json()["code"]) == (403, "data_scope_exceeds_own")
    # Unchanged scopes don't count: editing other permissions keeps a role's existing wider scope.
    RolePermission.objects.filter(role=member, permission__code=VIEW).update(data_scope="all")
    perms = sorted(member.permissions.values_list("code", flat=True))
    assert actor.patch(url, {"permissions": perms}, format="json").status_code == 200


def test_owners_are_exempt_from_the_scope_ceiling(world):
    member = _member_role(world)
    owner_role = role(world["ws"], "owner")
    RolePermission.objects.filter(role=owner_role, permission__code=VIEW).update(data_scope="own")
    world["owner"].__dict__.pop("_lx_access_cache", None)
    res = client_for(world["owner"]).patch(f"/api/v1/roles/{member.id}", {"dataScopes": {VIEW: "all"}}, format="json")
    assert res.status_code == 200 and res.json()["dataScopes"] == {VIEW: "all"}
