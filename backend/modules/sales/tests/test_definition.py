"""The sales module definition (docs/sales/spec.md §3, docs/sales/api.md §2): the full permission catalogue, the default
roles and their grants, the built-in roles' grants, navigation and role seeding."""

import pytest

from core.access import catalogue
from core.access import services as access
from core.access.models import Role, RolePermission
from core.common.testing import client_for, make_workspace, role
from core.modules import services as modules
from core.modules.registry import get_module
from modules.sales import module as m

pytestmark = pytest.mark.django_db

#: Spec §3, verbatim: code → scopable.
SPEC = {
    "sales.dashboard.view": True,
    **{f"sales.company.{a}": True for a in ("view", "edit", "delete")},
    "sales.company.create": False,
    **{f"sales.contact.{a}": True for a in ("view", "edit", "delete")},
    "sales.contact.create": False,
    **{f"sales.lead.{a}": True for a in ("view", "edit", "delete", "assign", "convert")},
    "sales.lead.create": False,
    **{f"sales.opportunity.{a}": True for a in ("view", "edit", "move", "close", "delete", "assign")},
    "sales.opportunity.create": False,
    "sales.opportunity.reopen": True,
    **{f"sales.quotation.{a}": True for a in ("view", "edit", "delete")},
    "sales.quotation.create": False,
    **{f"sales.activity.{a}": True for a in ("view", "edit", "delete")},
    "sales.activity.create": False,
    **{f"sales.followup.{a}": True for a in ("view", "edit", "complete", "reassign", "delete")},
    "sales.followup.create": False,
    "sales.target.view": True,
    "sales.target.manage": True,
    "sales.dailyreport.submit": False,
    "sales.dailyreport.view": True,
    "sales.dailyreport.review": True,
    "sales.performance.view": True,
    "sales.report.view": True,
    "sales.report.export": True,
    "sales.settings.manage": False,
}

#: The record-changing codes a CEO / GM must never hold (spec §3: no day-to-day editing).
DAY_TO_DAY = [
    c
    for c in SPEC
    if c.rsplit(".", 1)[1] in ("create", "edit", "delete", "move", "close", "assign", "reassign", "convert", "reopen")
    and not c.startswith(("sales.target.", "sales.dailyreport."))
]


def test_the_full_catalogue_is_declared():
    sales = get_module("sales")
    assert {p.code: p.scopable for p in sales.permissions} == SPEC
    assert all(p.scope == "workspace" and p.module == "sales" for p in sales.permissions)
    assert (sales.toggleable, sales.is_core, sales.depends_on) == (True, False, ())
    assert catalogue.is_scopable("sales.company.view") and not catalogue.is_scopable("sales.company.create")
    assert "sales.health.view" not in m.ALL_CODES
    assert [n.as_dict() for n in sales.nav_items] == [
        {"key": "sales", "label": "Sales", "icon": "briefcase", "path": "sales", "permission": "sales.dashboard.view"}
    ]
    assert set(m.GRANT_TABLE) == set(SPEC)
    assert sales.target_types == (
        "sales.company",
        "sales.contact",
        "sales.lead",
        "sales.opportunity",
        "sales.quotation",
    )


def _grants(key):
    return dict(next(r for r in m.DEFAULT_ROLES if r.key == key).grants)


def test_default_role_grants():
    sales_admin, ceo, manager, rep = (
        _grants(k) for k in ("sales_admin", "sales_ceo", "sales_manager", "sales_salesperson")
    )
    # Everyone can open the workspace and Sales.
    for g in (sales_admin, ceo, manager, rep):
        assert g["core.workspace.view"] is None
        assert "sales.dashboard.view" in g
    # Sales Admin: everything, scope all.
    assert set(sales_admin) - {"core.workspace.view"} == set(SPEC)
    assert {s for c, s in sales_admin.items() if SPEC.get(c)} == {"all"}
    # CEO / GM: sees everything, reviews, manages targets, reports; no day-to-day record changes.
    assert {s for c, s in ceo.items() if SPEC.get(c)} == {"all"}
    assert not set(DAY_TO_DAY) & set(ceo)
    for code in ("sales.report.export", "sales.dailyreport.review", "sales.target.manage", "sales.performance.view"):
        assert code in ceo
    assert all(c in ceo for c in SPEC if c.endswith(".view"))
    assert "sales.settings.manage" not in ceo
    # Sales Manager: team scope; creates, edits, assigns, moves and closes; no deleting customers or deals.
    assert {s for c, s in manager.items() if SPEC.get(c)} == {"team"}
    for code in (
        "sales.lead.assign", "sales.opportunity.assign", "sales.opportunity.move", "sales.opportunity.close",
        "sales.followup.reassign", "sales.target.manage", "sales.dailyreport.review", "sales.report.export",
    ):  # fmt: skip
        assert code in manager, code
    for code in (
        "sales.company.delete",
        "sales.opportunity.delete",
        "sales.opportunity.reopen",
        "sales.settings.manage",
    ):
        assert code not in manager, code
    # Salesperson: own scope; works their own records; never assigns, reports or manages.
    assert {s for c, s in rep.items() if SPEC.get(c)} == {"own"}
    for code in ("sales.company.create", "sales.company.edit", "sales.dailyreport.submit", "sales.target.view"):
        assert code in rep, code
    for code in (
        "sales.company.delete", "sales.lead.assign", "sales.opportunity.assign", "sales.followup.reassign",
        "sales.target.manage", "sales.dailyreport.review", "sales.report.view", "sales.settings.manage",
    ):  # fmt: skip
        assert code not in rep, code


def test_built_in_role_grants(owner):
    ws = make_workspace(owner, name="Deals", slug="deals", modules=["sales"])
    for key in ("owner", "admin"):
        codes = access.role_permission_codes(role(ws, key))
        assert set(SPEC) <= codes, key
        scopes = set(
            RolePermission.objects.filter(role=role(ws, key), permission__scopable=True).values_list(
                "data_scope", flat=True
            )
        )
        assert scopes == {"all"}
    assert not [c for c in access.role_permission_codes(role(ws, "member")) if c.startswith("sales.")]
    me = client_for(owner).get("/api/v1/workspaces/deals").json()
    assert me["myDataScopes"]["sales.company.view"] == "all"


def test_default_roles_are_seeded_on_create_and_on_enable(owner, ws):
    assert not Role.objects.filter(workspace=ws, system_key__startswith="sales_").exists()
    modules.set_module_enabled(owner, ws, "sales", True)
    seeded = {r.system_key: r for r in Role.objects.filter(workspace=ws, system_key__startswith="sales_")}
    assert {k: r.name for k, r in seeded.items()} == {
        "sales_admin": "Sales Admin",
        "sales_ceo": "CEO / GM",
        "sales_manager": "Sales Manager",
        "sales_salesperson": "Salesperson",
    }
    assert all(r.is_system and r.scope == "workspace" for r in seeded.values())
    rep = seeded["sales_salesperson"]
    rows = dict(RolePermission.objects.filter(role=rep).values_list("permission__code", "data_scope"))
    assert rows == _grants("sales_salesperson")
    # Re-enabling keeps admin edits and adds nothing.
    RolePermission.objects.filter(role=rep, permission__code="sales.target.view").delete()
    modules.set_module_enabled(owner, ws, "sales", False)
    modules.set_module_enabled(owner, ws, "sales", True)
    assert not RolePermission.objects.filter(role=rep, permission__code="sales.target.view").exists()
    assert Role.objects.filter(workspace=ws, system_key__startswith="sales_").count() == 4
    other = make_workspace(owner, name="Other", slug="other", modules=["sales"])
    assert Role.objects.filter(workspace=other, system_key__startswith="sales_").count() == 4
