"""S7 security review regressions: role assignment can't widen data scopes, a missing action permission doesn't reveal
out-of-scope records, crafted timeline cursors answer 400, and Owner / Admin aren't expected daily reporters."""

import pytest

from core.access.models import Permission, Role, RolePermission
from core.common.exceptions import ApiError
from core.common.pagination import encode_cursor
from core.common.testing import role, set_roles
from core.workspaces.services import change_member_roles
from modules.sales.daily_reports import submitters

pytestmark = pytest.mark.django_db


def test_assigning_a_role_cannot_widen_the_actors_data_scope(world):
    ws, manager = world.ws, world.users["manager"]
    people = Role.objects.create(workspace=ws, name="People admin", scope="workspace")
    RolePermission.objects.create(role=people, permission=Permission.objects.get(code="core.workspace.manage_members"))
    set_roles(ws, manager, role(ws, "sales_manager"), people)
    # CEO / GM's codes are a subset of Sales Manager's, but its scope is `all` (the manager's is `team`).
    ceo_role = role(ws, "sales_ceo")
    for target in (manager, world.users["rep"]):
        current = [str(r.pk) for r in ws.members.get(user=target).role_list()]
        with pytest.raises(ApiError) as exc:
            change_member_roles(manager, ws, target.pk, {"roleIds": [*current, str(ceo_role.pk)]})
        assert exc.value.code == "data_scope_exceeds_own"
    # The owner may.
    current = [str(r.pk) for r in ws.members.get(user=world.users["rep"]).role_list()]
    change_member_roles(world.users["owner"], ws, world.users["rep"].pk, {"roleIds": [*current, str(ceo_role.pk)]})


def test_missing_action_permission_answers_404_outside_the_view_scope(world):
    rep = world.client("rep")
    # Salesperson has no `sales.company.delete`: 403 on their own company, 404 on one they can't see.
    assert rep.delete(f"/api/v1/sales/companies/{world.companies['rep'].pk}").status_code == 403
    assert rep.delete(f"/api/v1/sales/companies/{world.companies['rep2'].pk}").status_code == 404
    assert world.client("ceo").delete(f"/api/v1/sales/companies/{world.companies['rep2'].pk}").status_code == 403


def test_naive_timeline_cursor_is_rejected(deals):
    opp = deals.opportunities["rep"]
    cursor = encode_cursor(["2026-01-01T00:00:00", str(opp.pk)])
    res = deals.client("rep").get(f"/api/v1/sales/opportunities/{opp.pk}/timeline?cursor={cursor}")
    assert res.status_code == 400 and res.json()["code"] == "invalid_cursor"


def test_owner_and_admin_are_not_expected_to_submit_daily_reports(world):
    expected = {u.pk for u in submitters(world.ws)}
    assert world.users["owner"].pk not in expected and world.users["admin"].pk not in expected
    assert world.users["rep"].pk in expected


def _assign(world, actor, target, *keys):
    ids = [str(role(world.ws, k).pk) for k in keys]
    return world.client(actor).patch(
        f"/api/v1/workspaces/platform/members/{world.users[target].pk}", {"roleIds": ids}, format="json"
    )


def test_owner_and_admin_can_assign_sales_roles_with_self_service_codes(world):
    # Owner / Admin don't hold `sales.dailyreport.submit` (self-service) but may grant roles that include it.
    assert _assign(world, "owner", "member", "member", "sales_salesperson").status_code == 200
    assert _assign(world, "admin", "member", "member", "sales_manager").status_code == 200
    assert _assign(world, "admin", "member", "member", "sales_admin").status_code == 200


def test_a_salesperson_who_manages_members_cannot_escalate(world):
    ws, rep = world.ws, world.users["rep"]
    people = Role.objects.create(workspace=ws, name="People admin", scope="workspace")
    RolePermission.objects.create(role=people, permission=Permission.objects.get(code="core.workspace.manage_members"))
    set_roles(ws, rep, role(ws, "sales_salesperson"), people)
    res = _assign(world, "rep", "member", "member", "sales_manager")  # codes the rep lacks (assign, review, ...)
    assert res.status_code == 403
    res = _assign(world, "rep", "rep", "sales_salesperson", "sales_ceo")  # wider scope for codes the rep holds
    assert res.status_code == 403
