"""Quotations (docs/sales/api.md §11): numbering, owner = the opportunity's owner, transitions (409 on invalid), the
send defaults in workspace time, and the nightly expiry job (idempotent, skipped where sales is off)."""

import datetime as dt

import pytest
from freezegun import freeze_time

from core.audit.models import AuditLog
from core.events.models import DomainEvent
from core.jobs.registry import get_job
from core.jobs.services import run_job
from core.modules.services import set_module_enabled
from modules.sales.models import Opportunity, Quotation, SalesSettings
from modules.sales.pipeline_services import next_number

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform"


def q_url(q, action=""):
    return f"/api/v1/sales/quotations/{getattr(q, 'pk', q)}" + (f"/{action}" if action else "")


def create(world, actor="rep", opp="rep", **extra):
    body = {"opportunityId": str(world.opportunities[opp].pk), "title": "Offer", "amount": "1500.00", **extra}
    return world.client(actor).post(f"{BASE}/quotations", body, format="json")


@freeze_time("2026-06-01 08:00:00")
def test_numbers_are_a_per_workspace_yearly_sequence(deals):
    first = create(deals).json()
    second = create(deals, actor="manager").json()
    assert (first["number"], second["number"]) == ("Q-2026-0001", "Q-2026-0002")
    assert first["ownerId"] == second["ownerId"] == str(deals.users["rep"].pk)  # the opportunity's owner
    assert first["status"] == "draft" and first["opportunity"]["companyName"] == "Rep Trading PLC"
    assert next_number(deals.other_ws, 2026) == "Q-2026-0001"  # another workspace counts on its own
    assert next_number(deals.ws, 2027) == "Q-2027-0001"
    with freeze_time("2026-12-31 21:30:00"):  # 00:30 on January 1st in Addis Ababa
        assert create(deals).json()["number"] == "Q-2027-0002"


def test_create_validation_and_scope(deals):
    res = create(deals, opp="rep3")
    assert res.status_code == 422 and "opportunityId" in res.json()["details"]["fields"]
    assert create(deals, amount="-1").status_code == 422
    assert create(deals, title="").status_code == 422
    assert create(deals, actor="ceo").status_code == 403


def test_send_accept_reject_transitions(deals):
    rep = deals.client("rep")
    q = create(deals).json()
    with freeze_time("2026-10-20 22:00:00"):  # 01:00 on the 21st in Addis Ababa
        res = deals.client("rep").post(q_url(q["id"], "send"), {}, format="json")
    assert res.status_code == 200, res.json()
    body = res.json()
    assert (body["status"], body["validUntil"]) == ("sent", "2026-11-20")  # 21 Oct + 30 days, workspace time
    assert body["sentAt"] == "2026-10-20T22:00:00Z"
    event = DomainEvent.objects.get(type="sales.quotation.sent")
    assert event.payload["number"] == q["number"]
    res = rep.post(q_url(q["id"], "send"), {}, format="json")
    assert (res.status_code, res.json()["code"], res.json()["details"]) == (
        409,
        "invalid_transition",
        {"status": "sent", "action": "sent"},
    )
    assert rep.patch(q_url(q["id"]), {"amount": "1600.00"}, format="json").json()["amount"] == "1600.00"
    res = rep.post(q_url(q["id"], "accept"))
    assert (res.json()["status"], res.json()["respondedAt"] is not None) == ("accepted", True)
    opp = Opportunity.objects.select_related("stage").get(pk=deals.opportunities["rep"].pk)
    assert opp.stage.category == "open"  # accepting never wins the deal
    assert rep.post(q_url(q["id"], "reject")).status_code == 409
    assert rep.patch(q_url(q["id"]), {"notes": "late"}, format="json").status_code == 409
    other = create(deals).json()
    assert rep.post(q_url(other["id"], "accept")).status_code == 409  # drafts can't be answered
    SalesSettings.objects.filter(workspace=deals.ws).update(quotation_validity_days=7)
    res = rep.post(q_url(other["id"], "send"), {"validUntil": "2000-01-01"}, format="json")
    assert res.status_code == 422
    res = rep.post(q_url(other["id"], "send"), {"validUntil": "2099-01-01"}, format="json")
    assert res.json()["validUntil"] == "2099-01-01"
    assert rep.post(q_url(other["id"], "reject")).json()["status"] == "rejected"
    actions = AuditLog.objects.filter(action__startswith="sales.quotation.").values_list("action", flat=True)
    assert {"sales.quotation.created", "sales.quotation.sent", "sales.quotation.accepted"} <= set(actions)
    assert "sales.quotation.rejected" in set(actions) and "sales.quotation.updated" in set(actions)


def test_list_filters_and_detail(deals):
    admin = deals.client("sales_admin")
    rows = admin.get(f"{BASE}/quotations").json()["data"]
    assert len(rows) == 5
    Quotation.objects.filter(pk=deals.quotations["rep"].pk).update(status="sent", valid_until="2026-01-01")
    assert [r["title"] for r in admin.get(f"{BASE}/quotations?filter[status]=sent").json()["data"]] == ["Rep Quote"]
    opp = deals.opportunities["rep2"].pk
    assert [r["title"] for r in admin.get(f"{BASE}/quotations?filter[opportunity]={opp}").json()["data"]] == [
        "Rep2 Quote"
    ]
    assert [r["number"] for r in admin.get(f"{BASE}/quotations?q=0003").json()["data"]] == ["Q-2000-0003"]
    numbers = [r["number"] for r in admin.get(f"{BASE}/quotations?sort=number").json()["data"]]
    assert numbers == sorted(numbers)
    for sort in ("validUntil", "amount", "-updatedAt"):
        assert admin.get(f"{BASE}/quotations?sort={sort}").status_code == 200
    assert admin.get(f"{BASE}/quotations?filter[status]=open").status_code == 422
    rep = deals.client("rep")
    assert [r["title"] for r in rep.get(f"{BASE}/quotations").json()["data"]] == ["Rep Quote"]
    assert rep.get(q_url(deals.quotations["rep2"])).status_code == 404
    assert rep.delete(q_url(deals.quotations["rep"])).status_code == 403  # salespeople can't delete quotations


# ───────────────────────── the expiry job ─────────────────────────


def test_the_job_is_registered():
    job = get_job("sales_expire_quotations")
    assert (job.module, job.schedule) == ("sales", "daily 00:15")


def test_expire_job_is_idempotent_and_uses_the_workspace_date(deals):
    q = deals.quotations["rep"]
    Quotation.objects.filter(pk=q.pk).update(status="sent", valid_until=dt.date(2026, 10, 20))
    keep = deals.quotations["rep2"]
    Quotation.objects.filter(pk=keep.pk).update(status="sent", valid_until=dt.date(2026, 10, 21))
    # 23:00 UTC on the 20th is already the 21st in Addis Ababa: valid until the 20th has lapsed.
    result = run_job("sales_expire_quotations", now=dt.datetime(2026, 10, 20, 23, 0, tzinfo=dt.UTC))
    assert result.count("ran") == 2
    q.refresh_from_db()
    keep.refresh_from_db()
    assert (q.status, keep.status) == ("expired", "sent")
    assert q.expired_at is not None
    run_job("sales_expire_quotations", now=dt.datetime(2026, 10, 20, 23, 30, tzinfo=dt.UTC))
    assert AuditLog.objects.filter(action="sales.quotation.expired").count() == 1  # the second run did nothing
    timeline = deals.client("rep").get(f"/api/v1/sales/opportunities/{q.opportunity_id}/timeline").json()["data"]
    assert timeline[0]["kind"] == "quotation_expired" and timeline[0]["actor"] is None
    assert deals.client("rep").post(q_url(q, "accept")).status_code == 409


def test_expire_job_skips_workspaces_with_sales_off(deals):
    Quotation.objects.filter(pk=deals.quotations["rep"].pk).update(status="sent", valid_until=dt.date(2000, 1, 1))
    set_module_enabled(deals.users["owner"], deals.ws, "sales", False)
    result = run_job("sales_expire_quotations", workspace_id=deals.ws.pk)
    assert result.count("skipped") == 1
    assert Quotation.objects.get(pk=deals.quotations["rep"].pk).status == "sent"
