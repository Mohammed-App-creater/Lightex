"""Platform Stage 3 (docs/platform/stage3-contract.md §2–§4, architecture §12): enabling and disabling modules, the
guard, dependency and toggle errors, the hidden-permission effects and what survives a disable/enable cycle."""

import pytest

from core.access import catalogue
from core.access import services as access
from core.access.models import Role, RolePermission
from core.audit.models import AuditLog
from core.common.testing import UserFactory, add_member, client_for, make_workspace, role
from core.events.services import emit
from core.modules import services as modules
from core.modules.models import WorkspaceModule
from core.modules.registry import ModuleDefinition, register_module, unregister_module
from core.notifications.models import Notification
from core.tests.fake_module.models import Widget

pytestmark = pytest.mark.django_db

SALES = "sales.health.view"
HEALTH = "/api/v1/sales/workspaces/{}/health"


def put(user, slug, key, enabled):
    return client_for(user).put(f"/api/v1/workspaces/{slug}/modules/{key}", {"enabled": enabled}, format="json")


@pytest.fixture
def fake_module():
    """The Stage 2 fake module as a registered, toggleable module that depends on sales (test-only definition)."""
    register_module(ModuleDefinition(key="fake", name="Fake", description="Test-only", depends_on=("sales",)))
    yield
    unregister_module("fake")


@pytest.fixture
def member(ws):
    return add_member(ws, UserFactory(name="Sam Rivera"), "member")


# ───────────────────────── listing and workspace responses ─────────────────────────


def test_modules_list_includes_core_and_any_member_may_read_it(ws, member):
    res = client_for(member).get("/api/v1/workspaces/platform/modules")
    assert res.status_code == 200
    by_key = {m["key"]: m for m in res.json()}
    assert list(by_key)[:2] == ["core", "tracking"]
    core, tracking, sales = by_key["core"], by_key["tracking"], by_key["sales"]
    assert set(core) == {
        "key", "name", "description", "isCore", "toggleable", "enabled", "dependsOn", "enabledAt", "enabledBy",
        "navItems",
    }  # fmt: skip
    assert (core["isCore"], core["toggleable"], core["enabled"], core["enabledAt"]) == (True, False, True, None)
    assert (tracking["toggleable"], tracking["enabled"]) == (False, True)
    assert tracking["enabledAt"] is not None
    assert tracking["navItems"]
    assert (sales["toggleable"], sales["enabled"], sales["dependsOn"], sales["navItems"]) == (True, False, [], [])


def test_workspace_responses_carry_enabled_modules(ws, owner):
    client = client_for(owner)
    assert client.get("/api/v1/workspaces/platform").json()["enabledModules"] == ["core", "tracking"]
    assert [w["enabledModules"] for w in client.get("/api/v1/workspaces").json()] == [["core", "tracking"]]
    put(owner, "platform", "sales", True)
    assert client.get("/api/v1/workspaces/platform").json()["enabledModules"] == ["core", "tracking", "sales"]
    assert client.get("/api/v1/workspaces").json()[0]["enabledModules"] == ["core", "tracking", "sales"]


def test_create_workspace_with_modules(owner):
    client = client_for(owner)
    res = client.post("/api/v1/workspaces", {"name": "Deals", "slug": "deals", "modules": ["sales"]}, format="json")
    assert res.status_code == 201, res.json()
    body = res.json()
    assert body["enabledModules"] == ["core", "tracking", "sales"]
    assert SALES in body["my_permissions"]
    rows = WorkspaceModule.objects.filter(workspace__slug="deals")
    assert {(r.module_key, r.enabled, r.enabled_by_id) for r in rows} == {
        ("tracking", True, owner.pk),
        ("sales", True, owner.pk),
    }
    ws = rows[0].workspace
    for key in ("owner", "admin", "member"):
        assert SALES in access.role_permission_codes(role(ws, key)), key
    plain = client.post("/api/v1/workspaces", {"name": "Plain", "slug": "plain"}, format="json").json()
    assert plain["enabledModules"] == ["core", "tracking"]
    assert SALES not in plain["my_permissions"]
    assert not RolePermission.objects.filter(role__workspace__slug="plain", permission__code=SALES).exists()


def test_create_workspace_rejects_unknown_or_unmet_modules(owner, fake_module):
    client = client_for(owner)
    res = client.post("/api/v1/workspaces", {"name": "Bad", "slug": "bad", "modules": ["nope"]}, format="json")
    assert res.status_code == 422
    assert res.json()["details"]["fields"]["modules"]
    res = client.post("/api/v1/workspaces", {"name": "Bad", "slug": "bad", "modules": "sales"}, format="json")
    assert res.status_code == 422
    res = client.post("/api/v1/workspaces", {"name": "Bad", "slug": "bad", "modules": ["fake"]}, format="json")
    assert res.status_code == 400
    assert res.json()["code"] == "module_dependency"
    assert res.json()["details"] == {"modules": ["sales"]}
    ok = client.post("/api/v1/workspaces", {"name": "Ok", "slug": "ok", "modules": ["fake", "sales"]}, format="json")
    assert ok.json()["enabledModules"] == ["core", "tracking", "sales", "fake"]
    # Always-on keys are accepted and change nothing.
    same = client.post("/api/v1/workspaces", {"name": "Same", "slug": "same", "modules": ["core", "tracking"]})
    assert same.json()["enabledModules"] == ["core", "tracking"]


# ───────────────────────── enable / disable ─────────────────────────


def test_enable_and_disable(ws, owner):
    client = client_for(owner)
    assert client.get(HEALTH.format("platform")).json()["code"] == "module_disabled"
    res = put(owner, "platform", "sales", True)
    assert res.status_code == 200, res.json()
    body = res.json()
    assert (body["key"], body["enabled"]) == ("sales", True)
    assert body["enabledBy"] == str(owner.pk)
    assert body["enabledAt"]
    assert body["navItems"] == [
        {"key": "sales", "label": "Sales", "icon": "briefcase", "path": "sales", "permission": SALES}
    ]
    assert client.get(HEALTH.format("platform")).json() == {"status": "ok", "module": "sales", "workspace": "platform"}
    res = put(owner, "platform", "sales", False)
    assert res.status_code == 200
    assert (res.json()["enabled"], res.json()["navItems"], res.json()["enabledBy"]) == (False, [], None)
    disabled = client.get(HEALTH.format("platform"))
    assert disabled.status_code == 403
    assert disabled.json()["code"] == "module_disabled"
    assert disabled.json()["details"] == {"module": "sales"}


def test_toggling_to_the_current_state_is_a_no_op(ws, owner):
    put(owner, "platform", "sales", True)
    assert put(owner, "platform", "sales", True).json()["enabled"] is True
    assert put(owner, "platform", "sales", False).status_code == 200
    assert put(owner, "platform", "sales", False).json()["enabled"] is False
    assert AuditLog.objects.filter(action__startswith="core.module.").count() == 2


def test_audit_entries(ws, owner):
    put(owner, "platform", "sales", True)
    put(owner, "platform", "sales", False)
    rows = list(AuditLog.objects.filter(action__startswith="core.module.").order_by("created_at"))
    assert [(r.action, r.target, r.module, r.target_type, r.data) for r in rows] == [
        ("core.module.enabled", "Sales", "core", "core.module", {"module": "sales"}),
        ("core.module.disabled", "Sales", "core", "core.module", {"module": "sales"}),
    ]
    assert rows[0].actor_id == owner.pk
    assert rows[1].changes == [{"field": "Enabled", "kind": "value", "before": True, "after": False}]
    listed = client_for(owner).get("/api/v1/workspaces/platform/audit").json()["data"]
    assert {"core.module.enabled", "core.module.disabled"} <= {r["action"] for r in listed}


def test_errors_unknown_and_not_toggleable(ws, owner):
    assert put(owner, "platform", "nope", True).status_code == 404
    for key in ("core", "tracking"):
        res = put(owner, "platform", key, False)
        assert res.status_code == 400, key
        assert res.json()["code"] == "module_not_toggleable"
    res = client_for(owner).put("/api/v1/workspaces/platform/modules/sales", {"enabled": "yes"}, format="json")
    assert res.status_code == 422


def test_toggling_requires_modules_manage(ws, owner, member):
    admin = add_member(ws, UserFactory(), "admin")
    res = put(member, "platform", "sales", True)
    assert res.status_code == 403
    assert res.json()["details"] == {"permission": "core.modules.manage"}
    assert put(admin, "platform", "sales", True).status_code == 200  # Admin holds core.modules.manage


def test_dependency_refusal(ws, owner, fake_module):
    res = put(owner, "platform", "fake", True)
    assert res.status_code == 400
    assert (res.json()["code"], res.json()["details"]) == ("module_dependency", {"modules": ["sales"]})
    assert put(owner, "platform", "sales", True).status_code == 200
    assert put(owner, "platform", "fake", True).status_code == 200
    res = put(owner, "platform", "sales", False)
    assert res.status_code == 400
    assert (res.json()["code"], res.json()["details"]) == ("module_dependency", {"modules": ["fake"]})
    assert put(owner, "platform", "fake", False).status_code == 200
    assert put(owner, "platform", "sales", False).status_code == 200


def test_enabling_seeds_default_grants_idempotently(ws, owner):
    assert not RolePermission.objects.filter(role__workspace=ws, permission__code=SALES).exists()
    put(owner, "platform", "sales", True)
    holders = set(
        RolePermission.objects.filter(role__workspace=ws, permission__code=SALES).values_list(
            "role__system_key", flat=True
        )
    )
    assert holders == {"owner", "admin", "member"}
    put(owner, "platform", "sales", False)
    put(owner, "platform", "sales", True)
    assert RolePermission.objects.filter(role__workspace=ws, permission__code=SALES).count() == 3


# ───────────────────────── disabled-module effects ─────────────────────────


def test_hidden_permissions_in_my_permissions_and_role_responses(ws, owner):
    client = client_for(owner)
    put(owner, "platform", "sales", True)
    assert SALES in client.get("/api/v1/workspaces/platform").json()["my_permissions"]
    owner_role = next(r for r in client.get("/api/v1/workspaces/platform/roles").json() if r["name"] == "Owner")
    assert SALES in owner_role["permissions"]
    put(owner, "platform", "sales", False)
    assert SALES not in client.get("/api/v1/workspaces/platform").json()["my_permissions"]
    roles = client.get("/api/v1/workspaces/platform/roles").json()
    assert all(SALES not in r["permissions"] for r in roles)
    # The global catalogue still lists everything, with its module.
    catalogue_rows = {r["key"]: r for r in client.get("/api/v1/permissions").json()}
    assert catalogue_rows[SALES]["module"] == "sales"


def test_can_ignores_codes_of_disabled_modules(ws, owner):
    modules.set_module_enabled(owner, ws, "sales", True)
    access.invalidate(owner)
    assert access.can(owner, SALES, ws)
    modules.set_module_enabled(owner, ws, "sales", False)
    access.invalidate(owner)
    assert not access.can(owner, SALES, ws)
    assert SALES not in access.my_permissions(owner, ws)
    assert RolePermission.objects.filter(role=role(ws, "owner"), permission__code=SALES).exists()


def test_role_editor_keeps_hidden_grants_and_refuses_disabled_codes(ws, owner):
    client = client_for(owner)
    put(owner, "platform", "sales", True)
    member_role = role(ws, "member")
    put(owner, "platform", "sales", False)
    url = f"/api/v1/roles/{member_role.pk}/permissions"
    res = client.put(url, {"permissions": ["core.workspace.view", "core.audit.view"]}, format="json")
    assert res.status_code == 200, res.json()
    assert res.json()["permissions"] == ["core.workspace.view", "core.audit.view"]
    stored = set(member_role.permissions.values_list("code", flat=True))
    assert stored == {"core.workspace.view", "core.audit.view", SALES}  # the hidden sales grant was kept
    res = client.put(url, {"permissions": ["core.workspace.view", SALES]}, format="json")
    assert res.status_code == 422
    put(owner, "platform", "sales", True)
    restored = client.get("/api/v1/workspaces/platform/roles").json()
    assert next(r for r in restored if r["id"] == str(member_role.pk))["permissions"] == [
        "core.workspace.view",
        "core.audit.view",
        SALES,
    ]


def test_assigning_a_role_with_hidden_grants_is_not_an_escalation(ws, owner):
    """An admin whose own sales grant is hidden can still hand out a role carrying a hidden sales grant."""
    admin = add_member(ws, UserFactory(), "admin")
    put(owner, "platform", "sales", True)
    put(owner, "platform", "sales", False)
    target = UserFactory()
    add_member(ws, target, "member")
    res = client_for(admin).patch(
        f"/api/v1/workspaces/platform/members/{target.pk}", {"roleId": str(role(ws, "member").pk)}, format="json"
    )
    assert res.status_code == 200


def test_data_and_role_grants_survive_disable_and_enable(ws, owner, fake_module):
    client = client_for(owner)
    put(owner, "platform", "sales", True)
    custom = client.post(
        "/api/v1/workspaces/platform/roles",
        {"name": "Sales lead", "scope": "workspace", "permissions": ["core.workspace.view", SALES]},
        format="json",
    ).json()
    put(owner, "platform", "fake", True)
    widget = Widget.objects.create(workspace=ws, title="Kept sprocket", owner=owner)
    before = set(RolePermission.objects.filter(role__workspace=ws).values_list("role_id", "permission__code"))
    put(owner, "platform", "fake", False)
    put(owner, "platform", "sales", False)
    assert set(RolePermission.objects.filter(role__workspace=ws).values_list("role_id", "permission__code")) == before
    assert Widget.objects.filter(pk=widget.pk).exists()
    hidden = next(r for r in client.get("/api/v1/workspaces/platform/roles").json() if r["id"] == custom["id"])
    assert hidden["permissions"] == ["core.workspace.view"]
    put(owner, "platform", "sales", True)
    put(owner, "platform", "fake", True)
    assert set(RolePermission.objects.filter(role__workspace=ws).values_list("role_id", "permission__code")) == before
    shown = next(r for r in client.get("/api/v1/workspaces/platform/roles").json() if r["id"] == custom["id"])
    assert shown["permissions"] == ["core.workspace.view", SALES]
    assert Role.objects.filter(pk=custom["id"]).exists()
    assert client.get(HEALTH.format("platform")).status_code == 200


def test_event_handlers_are_skipped_while_disabled(ws, owner, member, fake_module):
    widget = Widget.objects.create(workspace=ws, title="Pinged", owner=owner)

    def ping(note):
        emit(
            "fake.widget.pinged",
            workspace=ws,
            target_type="fake.widget",
            target_id=widget.id,
            actor=owner,
            payload={"userIds": [str(member.id)], "note": note},
        )

    ping("while off")
    assert not Notification.objects.filter(event__type="fake.widget.pinged").exists()
    modules.set_module_enabled(owner, ws, "sales", True)
    modules.set_module_enabled(owner, ws, "fake", True)
    ping("while on")
    assert [n.payload for n in Notification.objects.filter(event__type="fake.widget.pinged")] == [{"note": "while on"}]


def test_comment_notifications_on_a_disabled_modules_target_are_skipped(ws, owner, member, fake_module):
    widget = Widget.objects.create(workspace=ws, title="Quiet", owner=owner)
    doc = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Hi"}]}]}
    modules.set_module_enabled(owner, ws, "sales", True)
    modules.set_module_enabled(owner, ws, "fake", True)
    client_for(member).post(f"/api/v1/targets/fake.widget/{widget.id}/comments", {"body": doc}, format="json")
    assert Notification.objects.filter(recipient=owner, kind="comment").count() == 1
    modules.set_module_enabled(owner, ws, "fake", False)
    emit(
        "core.comment.created",
        workspace=ws,
        target_type="fake.widget",
        target_id=widget.id,
        actor=member,
        payload={"userIds": [str(owner.id)], "quote": "Hi again"},
    )
    assert Notification.objects.filter(recipient=owner, kind="comment").count() == 1


def test_search_providers_are_skipped_while_disabled(ws, owner, fake_module):
    widget = Widget.objects.create(workspace=ws, title="Findable sprocket", owner=owner)
    client = client_for(owner)
    in_ws = "/api/v1/workspaces/platform/search?q=sprocket&filter[type]=widget"
    everywhere = "/api/v1/search?q=sprocket&type=widget"
    assert client.get(in_ws).json() == []
    assert client.get(everywhere).json()["data"] == []
    put(owner, "platform", "sales", True)
    put(owner, "platform", "fake", True)
    assert [r["targetId"] for r in client.get(in_ws).json()] == [str(widget.id)]
    assert [r["targetId"] for r in client.get(everywhere).json()["data"]] == [str(widget.id)]


def test_trash_kinds_are_skipped_while_disabled(ws, owner, fake_module):
    widget = Widget.objects.create(workspace=ws, title="Binned", owner=owner)
    Widget.all_objects.filter(pk=widget.pk).update(deleted_at=widget.created_at, deleted_by=owner)
    client = client_for(owner)
    listed = client.get("/api/v1/workspaces/platform/trash").json()
    assert "fake.widget" not in listed["kinds"]
    assert all(i["kind"] != "fake.widget" for i in listed["data"])
    res = client.post(
        "/api/v1/workspaces/platform/trash/restore",
        {"items": [{"kind": "fake.widget", "id": str(widget.id)}]},
        format="json",
    )
    assert res.status_code == 404
    put(owner, "platform", "sales", True)
    put(owner, "platform", "fake", True)
    listed = client.get("/api/v1/workspaces/platform/trash").json()
    assert [i["id"] for i in listed["data"] if i["kind"] == "fake.widget"] == [str(widget.id)]


# ───────────────────────── tenant isolation ─────────────────────────


@pytest.mark.parametrize("sales_on", [False, True])
def test_tenant_isolation(ws, owner, sales_on):
    """A user of workspace A gets 404 for workspace B's module endpoints, whatever B's module state."""
    other = UserFactory(name="Lee Outsider")
    make_workspace(other, name="Elsewhere", slug="elsewhere")
    if sales_on:
        put(owner, "platform", "sales", True)
    lee = client_for(other)
    assert lee.get("/api/v1/workspaces/platform/modules").status_code == 404
    assert put(other, "platform", "sales", not sales_on).status_code == 404
    assert put(other, "platform", "nope", True).status_code == 404
    assert lee.get(HEALTH.format("platform")).status_code == 404
    assert WorkspaceModule.objects.get(workspace=ws, module_key="tracking").enabled
    assert modules.is_enabled(ws, "sales") is sales_on
    # The outsider's own workspace is unaffected.
    assert lee.get(HEALTH.format("elsewhere")).json()["code"] == "module_disabled"
    assert put(other, "elsewhere", "sales", True).status_code == 200
    assert lee.get(HEALTH.format("elsewhere")).status_code == 200


def test_permission_catalogue_lists_every_module(owner):
    keys = [r["key"] for r in client_for(owner).get("/api/v1/permissions").json()]
    assert keys == [p.code for p in catalogue.all_permissions()]
    assert SALES in keys
