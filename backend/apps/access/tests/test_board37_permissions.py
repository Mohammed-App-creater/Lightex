"""Board 37: integration.manage / development.link — catalogue, default roles, my_permissions order, data migration
(docs/v2/37-integrations-github-gitlab.md §4)."""

import importlib

import pytest
from django.apps import apps as django_apps

from apps.access import catalogue
from apps.access.models import Permission, Role, RolePermission
from apps.common.testing import add_project_member, client_for, make_project

pytestmark = pytest.mark.django_db

EXPECTED = {
    "owner": {"integration.manage"},
    "admin": {"integration.manage"},
    "member": set(),
    "project_admin": {"development.link"},
    "manager": {"development.link"},
    "project_member": {"development.link"},
    "viewer": set(),
}
NEW = {"integration.manage", "development.link"}
migration = importlib.import_module("apps.access.migrations.0006_board37_integration_permissions")


def test_catalogue_and_orders(owner):
    entry = catalogue.BY_CODE["integration.manage"]
    assert (entry.scope, entry.group, entry.label) == ("workspace", "Administration", "Manage integrations")
    link = catalogue.BY_CODE["development.link"]
    assert (link.scope, link.group, link.label) == ("project", "Tasks", "Link code")
    assert catalogue.WORKSPACE_ORDER == [
        "workspace.view", "workspace.update", "workspace.delete", "workspace.manage_members", "workspace.manage_roles",
        "project.create", "project.assign_admin", "integration.manage", "audit.view",
    ]  # fmt: skip
    order = catalogue.PROJECT_ORDER
    assert order[order.index("project.import") + 1] == "development.link"
    assert order[order.index("development.link") + 1] == "time.log"
    codes = [r["key"] for r in client_for(owner).get("/api/v1/permissions").json()]
    assert codes.index("integration.manage") == codes.index("workspace.manage_roles") + 1
    assert codes.index("development.link") == codes.index("project.import") + 1


def test_default_roles(ws):
    for role in ws.roles.filter(is_system=True):
        assert set(role.permissions.values_list("code", flat=True)) & NEW == EXPECTED[role.system_key], role.system_key
    assert "integration.manage" not in catalogue.ROLE_DEF_BY_KEY["admin"].core


def test_sams_my_permissions_example(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    sam = add_project_member(project, key="project_member")
    assert client_for(sam).get(f"/api/v1/projects/{project.id}").json()["my_permissions"] == [
        "project.view", "task.create", "task.edit_own", "task.assign", "task.move", "project.import",
        "development.link", "time.log", "comment.create", "comment.edit_own", "attachment.upload", "dashboard.create",
        "report.view",
    ]  # fmt: skip


def test_data_migration_backfills_system_roles_only_and_is_idempotent(ws):
    custom = Role.objects.create(workspace=ws, name="Release captain", scope="project")
    RolePermission.objects.filter(permission__code__in=NEW).delete()
    Permission.objects.filter(code="development.link").delete()
    migration.add_integration_permissions(django_apps, None)
    migration.add_integration_permissions(django_apps, None)
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & NEW
        assert held == EXPECTED[role.system_key], role.system_key
    assert not custom.permissions.exists()
    assert RolePermission.objects.filter(permission__code="development.link").count() == 3
