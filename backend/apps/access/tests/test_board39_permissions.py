"""Board 39: field.manage, time.log, time.delete_any — catalogue, default roles, archive, data migration."""

import importlib

import pytest
from django.apps import apps as django_apps

from apps.access import catalogue
from apps.access.models import Permission, Role, RolePermission
from apps.access.services import project_permissions
from apps.common.testing import add_project_member, client_for, make_project

pytestmark = pytest.mark.django_db

NEW = ("field.manage", "time.log", "time.delete_any")
EXPECTED = {
    "owner": set(),
    "admin": set(),
    "member": set(),
    "project_admin": set(NEW),
    "manager": set(NEW),
    "project_member": {"time.log"},
    "viewer": set(),
}
migration = importlib.import_module("apps.access.migrations.0003_board39_permissions")


def test_catalogue_endpoint_lists_the_new_codes_in_order(owner):
    rows = client_for(owner).get("/api/v1/permissions").json()
    codes = [r["key"] for r in rows]
    for code in NEW:
        assert code in codes
    assert codes.index("field.manage") == codes.index("status.manage") + 1
    assert codes.index("time.log") == codes.index("task.delete") + 1
    assert codes.index("time.delete_any") == codes.index("time.log") + 1


def test_project_order_is_exactly_the_contract():
    assert catalogue.PROJECT_ORDER == [
        "project.view", "project.update", "project.archive", "project.delete", "project.manage_members",
        "objective.manage", "milestone.manage", "epic.manage", "sprint.manage", "status.manage", "field.manage",
        "task.create", "task.edit_any", "task.edit_own", "task.delete", "task.assign", "task.move",
        "time.log", "time.delete_any",
        "comment.create", "comment.edit_own", "comment.delete_any", "attachment.upload", "attachment.delete_any",
        "report.view",
    ]  # fmt: skip


def test_default_roles_hold_exactly_the_grants(ws):
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & set(NEW)
        assert held == EXPECTED[role.system_key], role.system_key
    admin = catalogue.ROLE_DEF_BY_KEY["project_admin"]
    assert set(NEW) <= set(admin.core)


def test_member_my_permissions_example(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    sam = add_project_member(project, key="project_member")
    body = client_for(sam).get(f"/api/v1/projects/{project.id}").json()
    assert body["my_permissions"] == [
        "project.view", "task.create", "task.edit_own", "task.assign", "task.move", "time.log",
        "comment.create", "comment.edit_own", "attachment.upload", "report.view",
    ]  # fmt: skip


def test_archived_projects_drop_the_new_codes(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    assert set(NEW) <= project_permissions(owner, project)
    client_for(owner).post(f"/api/v1/projects/{project.id}/archive")
    project.refresh_from_db()
    owner.__dict__.pop("_lx_access_cache", None)
    assert not set(NEW) & project_permissions(owner, project)


def test_data_migration_backfills_system_roles_only_and_is_idempotent(ws):
    custom = Role.objects.create(workspace=ws, name="Release captain", scope="project")
    RolePermission.objects.create(role=custom, permission=Permission.objects.get(code="project.view"))
    # Simulate a v1 database: none of the new codes exist anywhere.
    Permission.objects.filter(code__in=NEW).delete()
    migration.add_board39_permissions(django_apps, None)
    migration.add_board39_permissions(django_apps, None)  # idempotent
    for code in NEW:
        perm = Permission.objects.get(code=code)
        assert perm.scope == "project"
        assert perm.label == catalogue.BY_CODE[code].label
        assert perm.group == catalogue.BY_CODE[code].group
        assert perm.description == catalogue.BY_CODE[code].description
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & set(NEW)
        assert held == EXPECTED[role.system_key], role.system_key
    assert set(custom.permissions.values_list("code", flat=True)) == {"project.view"}
    assert RolePermission.objects.filter(permission__code__in=NEW).count() == 3 + 3 + 1
