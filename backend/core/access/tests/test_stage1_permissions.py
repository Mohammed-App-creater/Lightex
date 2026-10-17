"""Platform Stage 1: namespaced permission codes, `module`, the two new core codes and the rename migration
(docs/platform/stage1-contract.md §1)."""

import importlib

import pytest
from django.apps import apps as django_apps

from core.access import catalogue
from core.access.models import Permission, Role, RolePermission
from core.common.testing import client_for

pytestmark = pytest.mark.django_db

namespace = importlib.import_module("core.access.migrations.0007_namespace_permission_codes")
NEW_CORE = {"core.modules.manage", "core.teams.manage"}


def test_every_code_is_namespaced_and_carries_its_module():
    for p in catalogue.PERMISSIONS:
        assert p.module in ("core", "tracking", "sales"), p.code
        assert p.code.startswith(f"{p.module}."), p.code
    stage3 = {"sales.health.view"}  # docs/platform/stage3-contract.md §4
    assert set(namespace.RENAMES.values()) | NEW_CORE | stage3 == set(catalogue.BY_CODE)


def test_new_core_codes_go_to_owner_and_admin_only(ws):
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & NEW_CORE
        assert held == (NEW_CORE if role.system_key in ("owner", "admin") else set()), role.system_key


def test_permissions_endpoint_lists_module(owner):
    rows = client_for(owner).get("/api/v1/permissions").json()
    by_key = {r["key"]: r for r in rows}
    assert by_key["core.modules.manage"]["module"] == "core"
    assert by_key["core.roles.manage"]["module"] == "core"
    assert by_key["tracking.task.create"]["module"] == "tracking"
    assert by_key["tracking.project.create"]["scope"] == "workspace"


def test_rename_migration_keeps_links_and_is_idempotent(ws):
    custom = Role.objects.create(workspace=ws, name="Release captain", scope="project")
    view = Permission.objects.get(code="tracking.project.view")
    RolePermission.objects.create(role=custom, permission=view)
    links_before = RolePermission.objects.filter(permission=view).count()
    # Simulate a pre-Stage-1 database: old codes, no new core codes.
    Permission.objects.filter(code="tracking.project.view").update(code="project.view", module="tracking")
    Permission.objects.filter(code="core.roles.manage").update(code="workspace.manage_roles", module="tracking")
    Permission.objects.filter(code__in=NEW_CORE).delete()
    # The catalogue was also synced before migrating: both the old and the new row exist.
    Permission.objects.create(code="tracking.project.view", scope="project", group="x", label="x", description="x")

    namespace.namespace_permission_codes(django_apps, None)
    namespace.namespace_permission_codes(django_apps, None)

    assert not Permission.objects.filter(code__in=["project.view", "workspace.manage_roles"]).exists()
    assert RolePermission.objects.filter(permission__code="tracking.project.view").count() == links_before
    assert custom.permissions.filter(code="tracking.project.view").exists()
    roles_manage = Permission.objects.get(code="core.roles.manage")
    assert roles_manage.module == "core"
    assert ws.roles.get(system_key="admin").permissions.filter(pk=roles_manage.pk).exists()
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & NEW_CORE
        assert held == (NEW_CORE if role.system_key in ("owner", "admin") else set()), role.system_key
    assert not custom.permissions.filter(code__in=NEW_CORE).exists()
