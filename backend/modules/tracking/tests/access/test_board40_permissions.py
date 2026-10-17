"""Board 40: project.import — catalogue, default roles, my_permissions order, archive, data migration."""

import pytest

from core.access import catalogue
from core.access.services import project_permissions
from core.common.testing import client_for
from modules.tracking.testing import add_project_member, make_project

pytestmark = pytest.mark.django_db

CODE = "tracking.project.import"
EXPECTED = {
    "owner": False,
    "admin": False,
    "member": False,
    "project_admin": True,
    "manager": True,
    "project_member": True,
    "viewer": False,
}


def test_catalogue_entry_and_placement(owner):
    rows = client_for(owner).get("/api/v1/permissions").json()
    codes = [r["key"] for r in rows]
    assert codes.index(CODE) == codes.index("tracking.task.move") + 1
    entry = catalogue.BY_CODE[CODE]
    assert (entry.scope, entry.group, entry.label, entry.description) == (
        "project", "Tasks", "Import tasks", "Bring in tasks from a CSV or another tool’s export",
    )  # fmt: skip
    order = catalogue.PROJECT_ORDER
    # board 37 placed development.link right after it
    assert (
        order.index(CODE) == order.index("tracking.task.move") + 1
        and order[order.index(CODE) + 1] == "tracking.development.link"
    )
    assert CODE in catalogue.ROLE_DEF_BY_KEY["project_admin"].core


def test_default_roles_hold_exactly_the_grant(ws):
    for role in ws.roles.filter(is_system=True):
        held = role.permissions.filter(code=CODE).exists()
        assert held == EXPECTED[role.system_key], role.system_key


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


def test_archived_projects_drop_it(ws, owner):
    project = make_project(ws, owner, key="PRJ")
    assert CODE in project_permissions(owner, project)
    client_for(owner).post(f"/api/v1/tracking/projects/{project.id}/archive")
    project.refresh_from_db()
    owner.__dict__.pop("_lx_access_cache", None)
    assert CODE not in project_permissions(owner, project)
