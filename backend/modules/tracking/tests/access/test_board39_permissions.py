"""Board 39: field.manage, time.log, time.delete_any — catalogue, default roles, archive, data migration."""

import importlib

import pytest
from django.apps import apps as django_apps

from core.access import catalogue
from core.access.models import Permission, Role, RolePermission
from core.access.services import project_permissions
from core.common.testing import client_for
from modules.tracking.testing import add_project_member, make_project

pytestmark = pytest.mark.django_db

NEW = ("tracking.field.manage", "tracking.time.log", "tracking.time.delete_any")
EXPECTED = {
    "owner": set(),
    "admin": set(),
    "member": set(),
    "project_admin": set(NEW),
    "manager": set(NEW),
    "project_member": {"tracking.time.log"},
    "viewer": set(),
}
migration = importlib.import_module("core.access.migrations.0003_board39_permissions")
namespace = importlib.import_module("core.access.migrations.0007_namespace_permission_codes")


def test_catalogue_endpoint_lists_the_new_codes_in_order(owner):
    rows = client_for(owner).get("/api/v1/permissions").json()
    codes = [r["key"] for r in rows]
    for code in NEW:
        assert code in codes
    assert codes.index("tracking.field.manage") == codes.index("tracking.status.manage") + 1
    assert codes.index("tracking.time.log") == codes.index("tracking.development.link") + 1
    assert codes.index("tracking.time.delete_any") == codes.index("tracking.time.log") + 1


def test_project_order_is_exactly_the_contract():
    assert catalogue.PROJECT_ORDER == [
        "tracking.project.view",
        "tracking.project.update",
        "tracking.project.archive",
        "tracking.project.delete",
        "tracking.project.manage_members",
        "tracking.objective.manage",
        "tracking.milestone.manage",
        "tracking.epic.manage",
        "tracking.sprint.manage",
        "tracking.status.manage",
        "tracking.field.manage",
        "tracking.task.create",
        "tracking.task.edit_any",
        "tracking.task.edit_own",
        "tracking.task.delete",
        "tracking.task.assign",
        "tracking.task.move",
        "tracking.project.import",
        "tracking.development.link",
        "tracking.time.log",
        "tracking.time.delete_any",
        "tracking.comment.create",
        "tracking.comment.edit_own",
        "tracking.comment.delete_any",
        "tracking.attachment.upload",
        "tracking.attachment.delete_any",
        "tracking.dashboard.create",
        "tracking.dashboard.manage",
        "tracking.report.view",
    ]  # fmt: skip  (board 33 added the dashboard codes)


def test_default_roles_hold_exactly_the_grants(ws):
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & set(NEW)
        assert held == EXPECTED[role.system_key], role.system_key
    admin = catalogue.ROLE_DEF_BY_KEY["project_admin"]
    assert set(NEW) <= set(admin.core)


def test_member_my_permissions_example(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    sam = add_project_member(project, key="project_member")
    body = client_for(sam).get(f"/api/v1/tracking/projects/{project.id}").json()
    assert body["my_permissions"] == [
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
    ]  # fmt: skip  (board 33 added dashboard.create)


def test_archived_projects_drop_the_new_codes(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    assert set(NEW) <= project_permissions(owner, project)
    client_for(owner).post(f"/api/v1/tracking/projects/{project.id}/archive")
    project.refresh_from_db()
    owner.__dict__.pop("_lx_access_cache", None)
    assert not set(NEW) & project_permissions(owner, project)


def test_data_migration_backfills_system_roles_only_and_is_idempotent(ws):
    custom = Role.objects.create(workspace=ws, name="Release captain", scope="project")
    RolePermission.objects.create(role=custom, permission=Permission.objects.get(code="tracking.project.view"))
    # Simulate a v1 database: none of the new codes exist anywhere.
    Permission.objects.filter(code__in=NEW).delete()
    migration.add_board39_permissions(django_apps, None)
    migration.add_board39_permissions(django_apps, None)  # idempotent
    namespace.namespace_permission_codes(django_apps, None)  # Stage 1 renames the old codes it created
    for code in NEW:
        perm = Permission.objects.get(code=code)
        assert perm.scope == "project"
        assert perm.label == catalogue.BY_CODE[code].label
        assert perm.group == catalogue.BY_CODE[code].group
        assert perm.description == catalogue.BY_CODE[code].description
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & set(NEW)
        assert held == EXPECTED[role.system_key], role.system_key
    assert set(custom.permissions.values_list("code", flat=True)) == {"tracking.project.view"}
    assert RolePermission.objects.filter(permission__code__in=NEW).count() == 3 + 3 + 1
