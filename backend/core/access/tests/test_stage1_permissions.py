"""Platform Stage 1: namespaced permission codes, `module` and the two new core codes (the rename data migration
was dropped with the Stage 5 fresh migrations) (docs/platform/stage1-contract.md §1)."""

import pytest

from core.access import catalogue
from core.common.testing import client_for

pytestmark = pytest.mark.django_db

NEW_CORE = {"core.modules.manage", "core.teams.manage"}


def test_every_code_is_namespaced_and_carries_its_module():
    for p in catalogue.PERMISSIONS:
        assert p.module in ("core", "tracking", "sales"), p.code
        assert p.code.startswith(f"{p.module}."), p.code
    assert set(catalogue.BY_CODE) >= NEW_CORE


def test_new_core_codes_go_to_owner_and_admin_only(ws):
    for role in ws.roles.filter(is_system=True):
        held = set(role.permissions.values_list("code", flat=True)) & NEW_CORE
        assert held == (NEW_CORE if role.system_key in ("owner", "admin") else set()), role.system_key


def test_permissions_endpoint_lists_module(owner):
    rows = client_for(owner).get("/api/v1/permissions").json()
    by_key = {r["key"]: r for r in rows}
    assert by_key["core.modules.manage"]["module"] == "core"
    assert by_key["core.roles.manage"]["module"] == "core"
    assert by_key["tracking.task.create"]["module"] == "tracking"
    assert by_key["tracking.project.create"]["scope"] == "workspace"
