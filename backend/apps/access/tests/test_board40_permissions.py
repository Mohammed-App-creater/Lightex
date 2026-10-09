"""Board 40: project.import — catalogue, default roles, my_permissions order, archive, data migration."""

import importlib

import pytest
from django.apps import apps as django_apps

from apps.access import catalogue
from apps.access.models import Permission, Role, RolePermission
from apps.access.services import project_permissions
from apps.common.testing import add_project_member, client_for, make_project

pytestmark = pytest.mark.django_db

CODE = "project.import"
EXPECTED = {
    "owner": False,
    "admin": False,
    "member": False,
    "project_admin": True,
    "manager": True,
    "project_member": True,
    "viewer": False,
}
migration = importlib.import_module("apps.access.migrations.0004_board40_import_permission")


def test_catalogue_entry_and_placement(owner):
    rows = client_for(owner).get("/api/v1/permissions").json()
    codes = [r["key"] for r in rows]
    assert codes.index(CODE) == codes.index("time.delete_any") + 1
    entry = catalogue.BY_CODE[CODE]
    assert (entry.scope, entry.group, entry.label, entry.description) == (
        "project", "Tasks", "Import tasks", "Bring in tasks from a CSV or another tool’s export",
    )  # fmt: skip
    order = catalogue.PROJECT_ORDER
    assert order.index(CODE) == order.index("task.move") + 1 and order[order.index(CODE) + 1] == "time.log"
    assert CODE in catalogue.ROLE_DEF_BY_KEY["project_admin"].core


def test_default_roles_hold_exactly_the_grant(ws):
    for role in ws.roles.filter(is_system=True):
        held = role.permissions.filter(code=CODE).exists()
        assert held == EXPECTED[role.system_key], role.system_key


def test_member_my_permissions_example(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    sam = add_project_member(project, key="project_member")
    body = client_for(sam).get(f"/api/v1/projects/{project.id}").json()
    assert body["my_permissions"] == [
        "project.view",
        "task.create",
        "task.edit_own",
        "task.assign",
        "task.move",
        "project.import",
        "time.log",
        "comment.create",
        "comment.edit_own",
        "attachment.upload",
        "dashboard.create",
        "report.view",
    ]  # fmt: skip  (board 33 added dashboard.create)


def test_archived_projects_drop_it(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    assert CODE in project_permissions(owner, project)
    client_for(owner).post(f"/api/v1/projects/{project.id}/archive")
    project.refresh_from_db()
    owner.__dict__.pop("_lx_access_cache", None)
    assert CODE not in project_permissions(owner, project)


def test_data_migration_backfills_system_roles_only_and_is_idempotent(ws):
    custom = Role.objects.create(workspace=ws, name="Release captain", scope="project")
    RolePermission.objects.create(role=custom, permission=Permission.objects.get(code="project.view"))
    Permission.objects.filter(code=CODE).delete()  # a board-39 database
    migration.add_import_permission(django_apps, None)
    migration.add_import_permission(django_apps, None)
    perm = Permission.objects.get(code=CODE)
    assert (perm.scope, perm.group, perm.label) == ("project", "Tasks", "Import tasks")
    assert perm.description == catalogue.BY_CODE[CODE].description
    for role in ws.roles.filter(is_system=True):
        assert role.permissions.filter(code=CODE).exists() == EXPECTED[role.system_key], role.system_key
    assert set(custom.permissions.values_list("code", flat=True)) == {"project.view"}
    assert RolePermission.objects.filter(permission__code=CODE).count() == 3
