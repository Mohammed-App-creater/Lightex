"""Board 37: integration.manage / development.link — catalogue, default roles, my_permissions order, data migration
(docs/v2/37-integrations-github-gitlab.md §4)."""

import pytest

from core.access import catalogue
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


def test_catalogue_and_orders(owner):
    entry = catalogue.BY_CODE["tracking.integration.manage"]
    assert (entry.scope, entry.group, entry.label) == ("workspace", "Administration", "Manage integrations")
    link = catalogue.BY_CODE["tracking.development.link"]
    assert (link.scope, link.group, link.label) == ("project", "Tasks", "Link code")
    sales_codes = [c for c in catalogue.WORKSPACE_ORDER if c.startswith("sales.")]
    assert [
        "core.workspace.view",
        "core.workspace.update",
        "core.workspace.delete",
        "core.workspace.manage_members",
        "core.roles.manage",
        "core.audit.view",
        "core.modules.manage",
        "core.teams.manage",
        # Platform Stage 3: module codes follow core's, in module order.
        "tracking.project.create",
        "tracking.project.assign_admin",
        "tracking.integration.manage",
        # Sales S1: the sales catalogue follows (modules/sales/tests/test_definition.py checks its own order).
        *sales_codes,
    ] == catalogue.WORKSPACE_ORDER
    assert catalogue.WORKSPACE_ORDER.index("sales.dashboard.view") == len(catalogue.CORE_WORKSPACE_CODES) + 3
    order = catalogue.PROJECT_ORDER
    assert order[order.index("tracking.project.import") + 1] == "tracking.development.link"
    assert order[order.index("tracking.development.link") + 1] == "tracking.time.log"
    codes = [r["key"] for r in client_for(owner).get("/api/v1/permissions").json()]
    assert codes.index("tracking.integration.manage") == codes.index("tracking.project.assign_admin") + 1
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
