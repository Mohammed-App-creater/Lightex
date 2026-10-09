"""Board 33: dashboard.create / dashboard.manage — catalogue, default roles, my_permissions order, archive, data
migration (docs/v2/33-dashboards-presence.md §4)."""

import importlib

import pytest
from django.apps import apps as django_apps

from apps.access import catalogue
from apps.access.models import Permission, Role, RolePermission
from apps.access.services import project_permissions
from apps.common.testing import add_project_member, client_for, make_project

pytestmark = pytest.mark.django_db

NEW = ("dashboard.create", "dashboard.manage")
EXPECTED = {
    "owner": set(),
    "admin": set(),
    "member": set(),
    "project_admin": {"dashboard.create", "dashboard.manage"},
    "manager": {"dashboard.create", "dashboard.manage"},
    "project_member": {"dashboard.create"},
    "viewer": set(),
}
migration = importlib.import_module("apps.access.migrations.0005_board33_dashboard_permissions")


def test_catalogue_entries_and_placement(owner):
    rows = client_for(owner).get("/api/v1/permissions").json()
    codes = [r["key"] for r in rows]
    assert codes.index("dashboard.create") + 1 == codes.index("dashboard.manage") == codes.index("report.view") - 1
    assert (catalogue.BY_CODE["dashboard.create"].group, catalogue.BY_CODE["dashboard.create"].label) == (
        "Reports",
        "Create dashboards",
    )
    assert catalogue.BY_CODE["dashboard.create"].description == "Build dashboards and edit the ones you created"
    assert catalogue.BY_CODE["dashboard.manage"].label == "Manage shared dashboards"
    assert catalogue.BY_CODE["dashboard.manage"].description == "Edit, rearrange and delete any shared dashboard"
    assert all(catalogue.BY_CODE[c].scope == "project" for c in NEW)


def test_project_order_is_exactly_the_contract():
    assert catalogue.PROJECT_ORDER == [
        "project.view", "project.update", "project.archive", "project.delete", "project.manage_members",
        "objective.manage", "milestone.manage", "epic.manage", "sprint.manage", "status.manage", "field.manage",
        "task.create", "task.edit_any", "task.edit_own", "task.delete", "task.assign", "task.move", "project.import",
        "time.log", "time.delete_any",
        "comment.create", "comment.edit_own", "comment.delete_any", "attachment.upload", "attachment.delete_any",
        "dashboard.create", "dashboard.manage",
        "report.view",
    ]  # fmt: skip


def test_default_roles(ws):
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & set(NEW)
        assert held == EXPECTED[role.system_key], role.system_key
    assert set(NEW) <= set(catalogue.ROLE_DEF_BY_KEY["project_admin"].core)


def test_sams_my_permissions_example(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    sam = add_project_member(project, key="project_member")
    assert client_for(sam).get(f"/api/v1/projects/{project.id}").json()["my_permissions"] == [
        "project.view", "task.create", "task.edit_own", "task.assign", "task.move", "project.import", "time.log",
        "comment.create", "comment.edit_own", "attachment.upload", "dashboard.create", "report.view",
    ]  # fmt: skip


def test_archived_projects_drop_both(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    assert set(NEW) <= project_permissions(owner, project)
    client_for(owner).post(f"/api/v1/projects/{project.id}/archive")
    owner.__dict__.pop("_lx_access_cache", None)
    assert not set(NEW) & project_permissions(owner, project)


def test_data_migration_backfills_system_roles_only_and_is_idempotent(ws):
    custom = Role.objects.create(workspace=ws, name="Release captain", scope="project")
    RolePermission.objects.create(role=custom, permission=Permission.objects.get(code="project.view"))
    Permission.objects.filter(code__in=NEW).delete()  # a board-40 database
    migration.add_dashboard_permissions(django_apps, None)
    migration.add_dashboard_permissions(django_apps, None)
    for code in NEW:
        perm = Permission.objects.get(code=code)
        assert (perm.scope, perm.group, perm.label, perm.description) == (
            "project",
            catalogue.BY_CODE[code].group,
            catalogue.BY_CODE[code].label,
            catalogue.BY_CODE[code].description,
        )
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & set(NEW)
        assert held == EXPECTED[role.system_key], role.system_key
    assert set(custom.permissions.values_list("code", flat=True)) == {"project.view"}
    assert RolePermission.objects.filter(permission__code="dashboard.create").count() == 3
    assert RolePermission.objects.filter(permission__code="dashboard.manage").count() == 2
