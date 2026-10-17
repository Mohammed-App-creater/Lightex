"""The sales skeleton (docs/platform/stage3-contract.md §4): its definition and the guarded health route."""

import pytest

from core.access import catalogue
from core.common.testing import UserFactory, add_member, client_for
from core.modules.registry import get_module
from core.modules.services import set_module_enabled

pytestmark = pytest.mark.django_db

URL = "/api/v1/sales/workspaces/platform/health"


def test_definition():
    sales = get_module("sales")
    assert (sales.toggleable, sales.is_core, sales.depends_on) == (True, False, ())
    assert [p.code for p in sales.permissions] == ["sales.health.view"]
    assert catalogue.get("sales.health.view").scope == "workspace"
    assert {k for k, codes in sales.default_role_grants.items() if "sales.health.view" in codes} == {
        "owner",
        "admin",
        "member",
    }
    assert [n.as_dict() for n in sales.nav_items] == [
        {"key": "sales", "label": "Sales", "icon": "briefcase", "path": "sales", "permission": "sales.health.view"}
    ]


def test_health_needs_the_module_and_the_permission(ws, owner):
    member = add_member(ws, UserFactory(), "member")
    assert client_for(owner).get(URL).json()["code"] == "module_disabled"
    set_module_enabled(owner, ws, "sales", True)
    assert client_for(owner).get(URL).json() == {"status": "ok", "module": "sales", "workspace": "platform"}
    assert client_for(member).get(URL).status_code == 200
    # A custom role without the permission: forbidden, not module_disabled.
    res = client_for(owner).post(
        "/api/v1/workspaces/platform/roles",
        {"name": "Guest", "scope": "workspace", "permissions": ["core.workspace.view"]},
        format="json",
    )
    guest = UserFactory()
    from core.workspaces.models import WorkspaceMember

    WorkspaceMember.objects.create(workspace=ws, user=guest, role_id=res.json()["id"])
    denied = client_for(guest).get(URL)
    assert (denied.status_code, denied.json()["details"]) == (403, {"permission": "sales.health.view"})


def test_anonymous_and_non_members(ws, owner, api):
    assert api.get(URL).status_code == 401
    assert client_for(UserFactory()).get(URL).status_code == 404
    assert client_for(owner).get("/api/v1/sales/workspaces/nowhere/health").status_code == 404
