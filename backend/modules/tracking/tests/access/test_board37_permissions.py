"""Board 37: integration.manage / development.link — catalogue, default roles, my_permissions order, data migration
(docs/v2/37-integrations-github-gitlab.md §4)."""

import importlib

import pytest
from django.apps import apps as django_apps

from core.access import catalogue
from core.access.models import Permission, Role, RolePermission
from core.common.testing import client_for
from modules.tracking.testing import add_project_member, make_project

pytestmark = pytest.mark.django_db

EXPECTED = {
    "owner": {"tracking.integration.manage"},
    "admin": {"tracking.integration.manage"},
    "member": set(),
    "project_admin": {"tracking.development.link"},
    "manager": {"tracking.development.link"},
    "project_member": {"tracking.development.link"},
    "viewer": set(),
}
NEW = {"tracking.integration.manage", "tracking.development.link"}
migration = importlib.import_module("core.access.migrations.0006_board37_integration_permissions")
namespace = importlib.import_module("core.access.migrations.0007_namespace_permission_codes")


def test_catalogue_and_orders(owner):
    entry = catalogue.BY_CODE["tracking.integration.manage"]
    assert (entry.scope, entry.group, entry.label) == ("workspace", "Administration", "Manage integrations")
    link = catalogue.BY_CODE["tracking.development.link"]
    assert (link.scope, link.group, link.label) == ("project", "Tasks", "Link code")
    assert catalogue.WORKSPACE_ORDER == [
        "core.workspace.view",
        "core.workspace.update",
        "core.workspace.delete",
        "core.workspace.manage_members",
        "core.roles.manage",
        "tracking.project.create",
        "tracking.project.assign_admin",
        "tracking.integration.manage",
        "core.audit.view",
        "core.modules.manage",
        "core.teams.manage",
    ]
    order = catalogue.PROJECT_ORDER
    assert order[order.index("tracking.project.import") + 1] == "tracking.development.link"
    assert order[order.index("tracking.development.link") + 1] == "tracking.time.log"
    codes = [r["key"] for r in client_for(owner).get("/api/v1/permissions").json()]
    assert codes.index("tracking.integration.manage") == codes.index("core.roles.manage") + 1
    assert codes.index("tracking.development.link") == codes.index("tracking.project.import") + 1


def test_default_roles(ws):
    for role in ws.roles.filter(is_system=True):
        assert set(role.permissions.values_list("code", flat=True)) & NEW == EXPECTED[role.system_key], role.system_key
    assert "tracking.integration.manage" not in catalogue.ROLE_DEF_BY_KEY["admin"].core


def test_sams_my_permissions_example(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    sam = add_project_member(project, key="project_member")
    assert client_for(sam).get(f"/api/v1/tracking/projects/{project.id}").json()["my_permissions"] == [
        "tracking.project.view",
        "tracking.task.create",
        "tracking.task.edit_own",
        "tracking.task.assign",
        "tracking.task.move",
        "tracking.project.import",
        "tracking.development.link",
        "tracking.time.log",
        "tracking.comment.create",
        "tracking.comment.edit_own",
        "tracking.attachment.upload",
        "tracking.dashboard.create",
        "tracking.report.view",
    ]


def test_data_migration_backfills_system_roles_only_and_is_idempotent(ws):
    custom = Role.objects.create(workspace=ws, name="Release captain", scope="project")
    RolePermission.objects.filter(permission__code__in=NEW).delete()
    Permission.objects.filter(code="tracking.development.link").delete()
    migration.add_integration_permissions(django_apps, None)
    migration.add_integration_permissions(django_apps, None)
    namespace.namespace_permission_codes(django_apps, None)  # Stage 1 renames the old codes it created
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & NEW
        assert held == EXPECTED[role.system_key], role.system_key
    assert not custom.permissions.exists()
    assert RolePermission.objects.filter(permission__code="tracking.development.link").count() == 3
