"""Board 33: dashboard.create / dashboard.manage — catalogue, default roles, my_permissions order, archive, data
migration (docs/v2/33-dashboards-presence.md §4)."""

import importlib

import pytest
from django.apps import apps as django_apps

from core.access import catalogue
from core.access.models import Permission, Role, RolePermission
from core.access.services import project_permissions
from core.common.testing import client_for
from modules.tracking.testing import add_project_member, make_project

pytestmark = pytest.mark.django_db

NEW = ("tracking.dashboard.create", "tracking.dashboard.manage")
EXPECTED = {
    "owner": set(),
    "admin": set(),
    "member": set(),
    "project_admin": {"tracking.dashboard.create", "tracking.dashboard.manage"},
    "manager": {"tracking.dashboard.create", "tracking.dashboard.manage"},
    "project_member": {"tracking.dashboard.create"},
    "viewer": set(),
}
migration = importlib.import_module("core.access.migrations.0005_board33_dashboard_permissions")
namespace = importlib.import_module("core.access.migrations.0007_namespace_permission_codes")


def test_catalogue_entries_and_placement(owner):
    rows = client_for(owner).get("/api/v1/permissions").json()
    codes = [r["key"] for r in rows]
    assert (
        codes.index("tracking.dashboard.create") + 1
        == codes.index("tracking.dashboard.manage")
        == codes.index("tracking.report.view") - 1
    )
    assert (
        catalogue.BY_CODE["tracking.dashboard.create"].group,
        catalogue.BY_CODE["tracking.dashboard.create"].label,
    ) == (
        "Reports",
        "Create dashboards",
    )
    assert (
        catalogue.BY_CODE["tracking.dashboard.create"].description == "Build dashboards and edit the ones you created"
    )
    assert catalogue.BY_CODE["tracking.dashboard.manage"].label == "Manage shared dashboards"
    assert (
        catalogue.BY_CODE["tracking.dashboard.manage"].description == "Edit, rearrange and delete any shared dashboard"
    )
    assert all(catalogue.BY_CODE[c].scope == "project" for c in NEW)


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
    ]


def test_default_roles(ws):
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & set(NEW)
        assert held == EXPECTED[role.system_key], role.system_key
    assert set(NEW) <= set(catalogue.ROLE_DEF_BY_KEY["project_admin"].core)


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


def test_archived_projects_drop_both(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    assert set(NEW) <= project_permissions(owner, project)
    client_for(owner).post(f"/api/v1/tracking/projects/{project.id}/archive")
    owner.__dict__.pop("_lx_access_cache", None)
    assert not set(NEW) & project_permissions(owner, project)


def test_data_migration_backfills_system_roles_only_and_is_idempotent(ws):
    custom = Role.objects.create(workspace=ws, name="Release captain", scope="project")
    RolePermission.objects.create(role=custom, permission=Permission.objects.get(code="tracking.project.view"))
    Permission.objects.filter(code__in=NEW).delete()  # a board-40 database
    migration.add_dashboard_permissions(django_apps, None)
    migration.add_dashboard_permissions(django_apps, None)
    namespace.namespace_permission_codes(django_apps, None)  # Stage 1 renames the old codes it created
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
    assert set(custom.permissions.values_list("code", flat=True)) == {"tracking.project.view"}
    assert RolePermission.objects.filter(permission__code="tracking.dashboard.create").count() == 3
    assert RolePermission.objects.filter(permission__code="tracking.dashboard.manage").count() == 2
