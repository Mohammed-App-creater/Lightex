"""Leads (docs/sales/api.md §9): CRUD, filters and cursors, the assign rule, qualify and disqualify, conversion (new
and linked company and contact, idempotency) and all-or-nothing bulk assignment."""

from decimal import Decimal

import pytest

from core.audit.models import AuditLog
from core.events.models import DomainEvent
from modules.sales.models import Company, Contact, Lead, Opportunity, OpportunityStageHistory, Product
from modules.sales.selectors import first_open_stage

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform"


def lead_url(lead, action=""):
    return f"/api/v1/sales/leads/{getattr(lead, 'pk', lead)}" + (f"/{action}" if action else "")


def test_create_read_update_delete_lead(world):
    rep = world.client("rep")
    product = Product.objects.create(workspace=world.ws, name="Router")
    res = rep.post(
        f"{BASE}/leads",
        {
            "source": "referral",
            "companyName": "Lalibela Hotels",
            "contactName": "Tigist",
            "phone": "+251 911 000 111",
            "email": "t@lalibela.et",
            "productId": str(product.pk),
            "estimatedValue": "150000.00",
        },
        format="json",
    )
    assert res.status_code == 201, res.json()
    body = res.json()
    assert body["displayName"] == "Lalibela Hotels"
    assert (body["status"], body["source"], body["estimatedValue"]) == ("new", "referral", "150000.00")
    assert body["product"] == {"id": str(product.pk), "name": "Router"}
    assert (body["ownerId"], body["canEdit"], body["canDelete"]) == (str(world.users["rep"].pk), True, False)
    assert rep.get(lead_url(body["id"])).json() == body
    res = rep.patch(lead_url(body["id"]), {"status": "contacted", "notes": "Called"}, format="json")
    assert (res.status_code, res.json()["status"]) == (200, "contacted")
    assert rep.patch(lead_url(body["id"]), {"status": "qualified"}, format="json").status_code == 422
    assert DomainEvent.objects.filter(type="sales.lead.created", target_id=body["id"]).count() == 1
    actions = list(AuditLog.objects.filter(action__startswith="sales.lead.").values_list("action", flat=True))
    assert sorted(actions) == ["sales.lead.created", "sales.lead.updated"]
    # Salespeople can't delete leads; managers can (their team's).
    assert rep.delete(lead_url(body["id"])).status_code == 403
    assert world.client("manager").delete(lead_url(body["id"])).status_code == 204
    assert rep.get(lead_url(body["id"])).status_code == 404


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({}, "companyName"),
        ({"companyName": "X", "source": "fax"}, "source"),
        ({"companyName": "X", "estimatedValue": "-1"}, "estimatedValue"),
        ({"companyName": "X", "email": "nope"}, "email"),
        ({"companyName": "X", "productId": "00000000-0000-0000-0000-000000000000"}, "productId"),
        ({"companyId": "00000000-0000-0000-0000-000000000000"}, "companyId"),
    ],
)
def test_lead_validation(world, payload, field):
    res = world.client("rep").post(f"{BASE}/leads", payload, format="json")
    assert res.status_code == 422, res.json()
    assert field in res.json()["details"]["fields"]


def test_lead_company_and_contact_must_be_visible_and_match(world):
    rep = world.client("rep")
    other = world.companies["rep3"]
    assert rep.post(f"{BASE}/leads", {"companyId": str(other.pk)}, format="json").status_code == 422
    res = rep.post(
        f"{BASE}/leads",
        {"companyId": str(world.companies["rep"].pk), "contactId": str(world.contacts["rep"].pk)},
        format="json",
    )
    assert res.status_code == 201
    assert res.json()["company"]["name"] == "Rep Trading PLC"
    assert res.json()["contact"]["name"] == "Rep Contact"
    mismatch = Contact.objects.create(
        workspace=world.ws, company=world.companies["rep2"], owner=world.users["rep"], name="X"
    )
    res = rep.post(
        f"{BASE}/leads",
        {"companyId": str(world.companies["rep"].pk), "contactId": str(mismatch.pk)},
        format="json",
    )
    assert res.status_code == 422 and "contactId" in res.json()["details"]["fields"]
    # Changing the company clears a contact of the old company.
    lead_id = rep.post(
        f"{BASE}/leads",
        {"companyId": str(world.companies["rep"].pk), "contactId": str(world.contacts["rep"].pk)},
        format="json",
    ).json()["id"]
    Company.objects.filter(pk=world.companies["rep2"].pk).update(owner=world.users["rep"])
    res = rep.patch(lead_url(lead_id), {"companyId": str(world.companies["rep2"].pk)}, format="json")
    assert (res.json()["company"]["name"], res.json()["contactId"]) == ("Rep2 Trading PLC", None)


def test_inactive_products_cannot_be_picked(world):
    product = Product.objects.create(workspace=world.ws, name="Old", is_active=False)
    res = world.client("rep").post(f"{BASE}/leads", {"companyName": "A", "productId": str(product.pk)}, format="json")
    assert res.status_code == 422


def test_owner_change_needs_assign(deals):
    rep, manager = deals.client("rep"), deals.client("manager")
    rep2 = str(deals.users["rep2"].pk)
    res = rep.post(f"{BASE}/leads", {"companyName": "A", "ownerId": rep2}, format="json")
    assert (res.status_code, res.json()["details"]) == (403, {"permission": "sales.lead.assign", "scope": "team"})
    res = rep.patch(lead_url(deals.leads["rep"]), {"ownerId": rep2}, format="json")
    assert (res.status_code, res.json()["details"]["permission"]) == (403, "sales.lead.assign")
    res = manager.patch(lead_url(deals.leads["rep"]), {"ownerId": rep2}, format="json")
    assert (res.status_code, res.json()["ownerId"]) == (200, rep2)
    rows = AuditLog.objects.filter(action="sales.lead.updated")
    assert [c["field"] for c in rows.get().changes] == ["Owner"]
    res = manager.patch(lead_url(deals.leads["rep"]), {"ownerId": str(deals.users["rep3"].pk)}, format="json")
    assert (res.status_code, res.json()["details"]["fields"]) == (422, {"ownerId": "Pick someone in your team"})
    res = manager.post(f"{BASE}/leads", {"companyName": "B", "ownerId": rep2}, format="json")
    assert res.status_code == 201 and res.json()["ownerId"] == rep2


def test_lead_list_filters_sort_and_cursor(deals):
    admin = deals.client("sales_admin")
    rows = admin.get(f"{BASE}/leads").json()["data"]
    assert len(rows) == 5
    Lead.objects.filter(pk=deals.leads["rep"].pk).update(status="qualified", source="event")
    assert [r["displayName"] for r in admin.get(f"{BASE}/leads?filter[status]=qualified").json()["data"]] == [
        "Rep Prospect"
    ]
    assert len(admin.get(f"{BASE}/leads?filter[source]=event&filter[source]=other").json()["data"]) == 5
    assert len(admin.get(f"{BASE}/leads?filter[owner]=me").json()["data"]) == 1
    team = admin.get(f"{BASE}/leads?filter[team]={deals.teams['north'].pk}").json()["data"]
    assert {r["displayName"] for r in team} == {"Rep Prospect", "Rep2 Prospect", "Manager Prospect"}
    assert [r["displayName"] for r in admin.get(f"{BASE}/leads?q=rep3").json()["data"]] == ["Rep3 Prospect"]
    names = [r["displayName"] for r in admin.get(f"{BASE}/leads?sort=name").json()["data"]]
    assert (names[0], names[-1]) == ("Manager Prospect", "Sales_Admin Prospect")  # database collation
    page = admin.get(f"{BASE}/leads?limit=2&sort=-createdAt").json()
    assert len(page["data"]) == 2 and page["nextCursor"]
    rest = admin.get(f"{BASE}/leads?limit=10&sort=-createdAt&cursor={page['nextCursor']}").json()["data"]
    assert len(rest) == 3
    assert admin.get(f"{BASE}/leads?sort=estimatedValue").status_code == 200
    today = deals.leads["rep"].created_at.date().isoformat()
    assert len(admin.get(f"{BASE}/leads?filter[createdFrom]={today}&filter[createdTo]={today}").json()["data"]) == 5
    assert admin.get(f"{BASE}/leads?filter[createdFrom]=2999-01-01").json()["data"] == []
    for bad in ("filter[status]=won", "filter[createdFrom]=yesterday", "filter[team]=x", "sort=owner"):
        assert admin.get(f"{BASE}/leads?{bad}").status_code == 422, bad
    import uuid

    assert admin.get(f"{BASE}/leads?filter[team]={uuid.uuid4()}").status_code == 422


def test_qualify_and_disqualify(deals):
    rep = deals.client("rep")
    lead = deals.leads["rep"]
    res = rep.post(lead_url(lead, "disqualify"), {}, format="json")
    assert res.status_code == 422 and "reason" in res.json()["details"]["fields"]
    res = rep.post(lead_url(lead, "disqualify"), {"reason": "No budget"}, format="json")
    assert (res.json()["status"], res.json()["disqualifyReason"]) == ("disqualified", "No budget")
    res = rep.post(lead_url(lead, "convert"), {}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "lead_disqualified")
    res = rep.post(lead_url(lead, "qualify"))
    assert (res.json()["status"], res.json()["disqualifyReason"]) == ("qualified", "")
    assert rep.post(lead_url(lead, "qualify")).status_code == 200  # already qualified: no-op
    actions = AuditLog.objects.filter(action__startswith="sales.lead.").values_list("action", flat=True)
    assert sorted(actions) == ["sales.lead.disqualified", "sales.lead.qualified"]
    assert deals.client("ceo").post(lead_url(lead, "qualify")).status_code == 403


def test_convert_creates_company_contact_and_opportunity(deals):
    rep = deals.client("rep")
    product = Product.objects.create(workspace=deals.ws, name="Switch")
    lead = deals.leads["rep"]
    Lead.objects.filter(pk=lead.pk).update(
        company_name_text="Blue Nile Foods", product=product, estimated_value=Decimal("90000.00"), email="b@n.et"
    )
    res = rep.post(lead_url(lead, "convert"), {}, format="json")
    assert res.status_code == 200, res.json()
    body = res.json()
    assert (body["companyCreated"], body["contactCreated"]) == (True, True)
    assert body["company"]["name"] == "Blue Nile Foods" and body["company"]["ownerId"] == str(deals.users["rep"].pk)
    assert body["contact"]["name"] == "Rep Person" and body["contact"]["isPrimary"] is True
    assert body["contact"]["email"] == "b@n.et"
    opp = body["opportunity"]
    assert opp["title"] == "Blue Nile Foods – Switch"
    assert (opp["expectedValue"], opp["productId"], opp["ownerId"]) == ("90000.00", str(product.pk), str(lead.owner_id))
    assert opp["stageId"] == str(first_open_stage(deals.ws).pk) and opp["sourceLeadId"] == str(lead.pk)
    assert (opp["probability"], opp["weightedValue"]) == (20, "18000.00")
    lead.refresh_from_db()
    assert lead.status == "converted" and str(lead.converted_opportunity_id) == opp["id"]
    assert str(lead.company_id) == body["company"]["id"] and lead.converted_at is not None
    assert body["lead"]["convertedOpportunityId"] == opp["id"]
    history = OpportunityStageHistory.objects.for_workspace(deals.ws).get(opportunity_id=opp["id"])
    assert (history.kind, history.from_stage_id, history.to_stage_name) == ("created", None, "Opportunity")
    events = set(DomainEvent.objects.values_list("type", flat=True))
    assert {"sales.lead.converted", "sales.opportunity.created"} <= events
    assert AuditLog.objects.filter(action="sales.lead.converted").count() == 1
    # Converting twice is refused, and nothing new is created.
    count = Opportunity.objects.for_workspace(deals.ws).count()
    res = rep.post(lead_url(lead, "convert"), {}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "lead_converted")
    assert res.json()["details"]["opportunityId"] == opp["id"]
    assert Opportunity.objects.for_workspace(deals.ws).count() == count
    # A converted lead is read-only.
    assert rep.patch(lead_url(lead), {"notes": "x"}, format="json").status_code == 409
    assert rep.post(lead_url(lead, "qualify")).status_code == 409


def test_convert_links_an_existing_company_by_normalized_name(deals):
    rep = deals.client("rep")
    lead = deals.leads["rep"]
    Lead.objects.filter(pk=lead.pk).update(company_name_text="rep trading p.l.c.", contact_name="Rep Contact")
    before = Company.objects.for_workspace(deals.ws).count()
    body = rep.post(lead_url(lead, "convert"), {"opportunity": {"title": "Big order"}}, format="json").json()
    assert (body["companyCreated"], body["contactCreated"]) == (False, False)
    assert body["company"]["id"] == str(deals.companies["rep"].pk)
    assert body["contact"]["id"] == str(deals.contacts["rep"].pk)  # same name at that company
    assert body["opportunity"]["title"] == "Big order" and body["opportunity"]["expectedValue"] == "0.00"
    assert Company.objects.for_workspace(deals.ws).count() == before
    # Another salesperson's matching company is out of scope: a new one is created instead.
    lead3 = deals.leads["rep3"]
    Lead.objects.filter(pk=lead3.pk).update(company_name_text="Rep Trading")
    body = deals.client("rep3").post(lead_url(lead3, "convert"), {}, format="json").json()
    assert body["companyCreated"] is True and body["company"]["id"] != str(deals.companies["rep"].pk)


def test_convert_with_explicit_company_and_contact(deals):
    rep = deals.client("rep")
    res = rep.post(
        lead_url(deals.leads["rep"], "convert"),
        {
            "company": {"name": "Explicit PLC", "city": "Adama"},
            "contact": {"name": "Selam", "jobTitle": "Buyer"},
            "opportunity": {"expectedValue": "5000.00", "expectedCloseDate": "2026-12-31"},
        },
        format="json",
    )
    body = res.json()
    assert (body["company"]["name"], body["company"]["city"], body["contact"]["jobTitle"]) == (
        "Explicit PLC",
        "Adama",
        "Buyer",
    )
    assert (body["opportunity"]["expectedValue"], body["opportunity"]["expectedCloseDate"]) == ("5000.00", "2026-12-31")
    res = rep.post(
        lead_url(deals.leads["rep"], "convert"),
        {"companyId": str(deals.companies["rep"].pk), "company": {"name": "Both"}},
        format="json",
    )
    assert res.status_code == 422
    lead = Lead.objects.create(workspace=deals.ws, owner=deals.users["rep"], contact_name="Solo")
    body = rep.post(
        lead_url(lead, "convert"),
        {"companyId": str(deals.companies["rep"].pk), "contactId": str(deals.contacts["rep"].pk)},
        format="json",
    ).json()
    assert (body["company"]["id"], body["contact"]["id"]) == (
        str(deals.companies["rep"].pk),
        str(deals.contacts["rep"].pk),
    )
    nameless = Lead.objects.create(workspace=deals.ws, owner=deals.users["rep"], phone="1")
    res = rep.post(lead_url(nameless, "convert"), {}, format="json")
    assert res.status_code == 422 and "company" in res.json()["details"]["fields"]


def test_a_manager_converting_a_team_lead_keeps_the_owner(deals):
    body = deals.client("manager").post(lead_url(deals.leads["rep"], "convert"), {}, format="json").json()
    rep = str(deals.users["rep"].pk)
    assert (body["company"]["ownerId"], body["contact"]["ownerId"], body["opportunity"]["ownerId"]) == (rep, rep, rep)


def test_bulk_assign_is_all_or_nothing(deals):
    manager = deals.client("manager")
    url = f"{BASE}/leads/bulk-assign"
    ids = [str(deals.leads["rep"].pk), str(deals.leads["rep3"].pk)]  # rep3 is outside the manager's team
    rep2 = str(deals.users["rep2"].pk)
    res = manager.post(url, {"leadIds": ids, "ownerId": rep2}, format="json")
    assert res.status_code == 422 and "leadIds" in res.json()["details"]["fields"]
    assert Lead.objects.filter(owner=deals.users["rep2"]).count() == 1
    ids = [str(deals.leads["rep"].pk), str(deals.leads["manager"].pk), str(deals.leads["rep2"].pk)]
    res = manager.post(url, {"leadIds": ids, "ownerId": rep2}, format="json")
    assert res.json() == {"updated": 2}  # rep2's own lead is skipped
    assert Lead.objects.filter(owner=deals.users["rep2"]).count() == 3
    rows = AuditLog.objects.filter(action="sales.lead.updated")
    assert rows.count() == 2 and all(r.data == {"bulk": True} for r in rows)
    # A view scope wider than the assign scope: 403 for the whole batch.
    from core.access.models import RolePermission
    from core.common.testing import role

    RolePermission.objects.filter(role=role(deals.ws, "sales_manager"), permission__code="sales.lead.view").update(
        data_scope="all"
    )
    deals.users["manager"].__dict__.pop("_lx_access_cache", None)
    res = manager.post(url, {"leadIds": [str(deals.leads["rep3"].pk)], "ownerId": rep2}, format="json")
    assert (res.status_code, res.json()["details"]) == (403, {"permission": "sales.lead.assign"})
    res = manager.post(
        url, {"leadIds": [str(deals.leads["rep"].pk)], "ownerId": str(deals.users["rep3"].pk)}, format="json"
    )
    assert res.status_code == 422
