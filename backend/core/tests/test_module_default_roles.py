"""Sales S0 §4: a module contributes its own workspace-scope default roles (`ModuleDefinition.default_roles`), seeded
on workspace creation and on enable, idempotently, without clobbering admin edits; disabling keeps them."""

import dataclasses

import pytest

from core.access import catalogue
from core.access.models import Role, RolePermission
from core.access.services import my_data_scopes, my_permissions, seed_module_roles, sync_permission_catalogue
from core.common.testing import UserFactory, add_member, client_for, make_workspace, set_roles
from core.modules import services as modules
from core.modules.registry import DefaultRole, ModuleDefinition, register_module, unregister_module
from core.tests.fake_module import module as fake

pytestmark = pytest.mark.django_db

VIEW = fake.WIDGET_VIEW
ROLES = (
    DefaultRole(
        "fake_widgeteer",
        "Widgeteer",
        "Works on widgets.",
        {"core.workspace.view": None, VIEW: "team"},
    ),
    DefaultRole("fake_watcher", "Watcher", grants={VIEW: None}),
)


@pytest.fixture
def module_with_roles():
    register_module(dataclasses.replace(fake.DEFINITION, default_roles=ROLES))
    sync_permission_catalogue()
    yield
    fake.unregister()


def grants(ws, key):
    rows = RolePermission.objects.filter(role__workspace=ws, role__system_key=key)
    return dict(rows.values_list("permission__code", "data_scope"))


def test_seeded_when_a_workspace_is_created_with_the_module(module_with_roles, owner):
    ws = make_workspace(owner, name="Fresh", slug="fresh", modules=["fake"])
    role = Role.objects.get(workspace=ws, system_key="fake_widgeteer")
    assert (role.name, role.description, role.scope, role.is_system) == (
        "Widgeteer",
        "Works on widgets.",
        "workspace",
        True,
    )
    assert grants(ws, "fake_widgeteer") == {"core.workspace.view": None, VIEW: "team"}
    assert grants(ws, "fake_watcher") == {VIEW: "own"}  # None means `own` for a scopable code
    # A member who also holds the module role gets the union, and the widest scope.
    user = add_member(ws, UserFactory(), ["member", "fake_widgeteer"])
    assert my_data_scopes(user, ws) == {VIEW: "team"}
    assert my_permissions(user, ws) == ["core.workspace.view", VIEW]


def test_not_seeded_without_the_module_then_seeded_on_enable(module_with_roles, owner, ws):
    assert not Role.objects.filter(workspace=ws, system_key__startswith="fake_").exists()
    modules.set_module_enabled(owner, ws, "fake", True)
    assert set(Role.objects.filter(workspace=ws, system_key__startswith="fake_").values_list("name", flat=True)) == {
        "Widgeteer",
        "Watcher",
    }


def test_idempotent_and_keeps_admin_edits(module_with_roles, owner, ws):
    modules.set_module_enabled(owner, ws, "fake", True)
    role = Role.objects.get(workspace=ws, system_key="fake_widgeteer")
    client = client_for(owner)
    res = client.patch(
        f"/api/v1/roles/{role.pk}",
        {"permissions": ["core.workspace.view", VIEW], "dataScopes": {VIEW: "all"}},
        format="json",
    )
    assert res.status_code == 200, res.json()
    # System role: not deletable, not renamable.
    assert client.delete(f"/api/v1/roles/{role.pk}").status_code == 403
    assert client.patch(f"/api/v1/roles/{role.pk}", {"name": "X"}, format="json").status_code == 403
    holder = add_member(ws, UserFactory(), ["member", "fake_widgeteer"])
    # Disable keeps the role and the membership; enable again changes nothing.
    modules.set_module_enabled(owner, ws, "fake", False)
    assert Role.objects.filter(pk=role.pk).exists()
    assert my_permissions(holder, ws) == ["core.workspace.view"]
    modules.set_module_enabled(owner, ws, "fake", True)
    assert seed_module_roles(ws, fake.DEFINITION) == {}
    assert Role.objects.filter(workspace=ws, system_key="fake_widgeteer").count() == 1
    assert grants(ws, "fake_widgeteer") == {"core.workspace.view": None, VIEW: "all"}
    holder.__dict__.pop("_lx_access_cache", None)
    assert my_data_scopes(holder, ws) == {VIEW: "all"}


def test_a_taken_name_gets_the_module_suffix(module_with_roles, owner, ws):
    Role.objects.create(workspace=ws, name="widgeteer", scope="workspace")
    Role.objects.create(workspace=ws, name="Watcher", scope="workspace")
    Role.objects.create(workspace=ws, name="Watcher (Fake)", scope="workspace")
    modules.set_module_enabled(owner, ws, "fake", True)
    assert Role.objects.get(workspace=ws, system_key="fake_widgeteer").name == "Widgeteer (Fake)"
    assert not Role.objects.filter(workspace=ws, system_key="fake_watcher").exists()  # both names taken: skipped


def test_role_assignable_and_catalogue(module_with_roles, owner, ws):
    modules.set_module_enabled(owner, ws, "fake", True)
    assert [r.key for r in catalogue.module_default_roles("fake")] == ["fake_widgeteer", "fake_watcher"]
    assert catalogue.module_default_roles("tracking") == []
    assert catalogue.role_def("fake_widgeteer").data_scopes == {VIEW: "team"}
    user = add_member(ws, UserFactory())
    role = Role.objects.get(workspace=ws, system_key="fake_watcher")
    set_roles(ws, user, role)
    assert my_data_scopes(user, ws) == {VIEW: "own"}


def test_definitions_are_validated():
    def bad(*roles, key="badroles"):
        return ModuleDefinition(key=key, name="Bad", default_roles=roles)

    cases = [
        bad(DefaultRole("owner", "Owner 2")),
        bad(DefaultRole("", "Empty")),
        bad(DefaultRole("badroles_x", "X"), DefaultRole("badroles_x", "Y")),
        bad(DefaultRole("badroles_y", "  ")),
        bad(DefaultRole("badroles_z", "Z", grants={"tracking.project.create": None})),
        bad(DefaultRole("badroles_w", "W", grants={"badroles.x.view": "most"})),
    ]
    for defn in cases:
        with pytest.raises(ValueError):
            register_module(defn)
    unregister_module("badroles")


def test_seeding_refuses_project_codes(owner, ws):
    defn = ModuleDefinition(
        key="projx",
        name="P",
        permissions=(catalogue.project_permission("projx.thing.do", "G", "L", "D"),),
        default_roles=(DefaultRole("projx_doer", "Doer", grants={"projx.thing.do": None}),),
    )
    register_module(defn)
    try:
        with pytest.raises(LookupError):
            seed_module_roles(ws, defn)
    finally:
        unregister_module("projx")
