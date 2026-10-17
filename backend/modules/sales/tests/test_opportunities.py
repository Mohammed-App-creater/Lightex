"""Opportunities (docs/sales/api.md §10): CRUD, probability and weighted value, move with versions, won / lost /
reopen, back-dating the won date, credited user stability, reassignment, the pipeline board, the timeline, and the
S1 in-use guards that S2 fills."""

import datetime as dt
from decimal import Decimal

import pytest
from freezegun import freeze_time

from core.audit.models import AuditLog
from core.events.models import DomainEvent
from modules.sales.models import (
    Company,
    LostReason,
    Opportunity,
    OpportunityStageHistory,
    PipelineStage,
    Product,
    Quotation,
)
from modules.sales.periods import period_containing

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform"


def opp_url(opp, action=""):
    return f"/api/v1/sales/opportunities/{getattr(opp, 'pk', opp)}" + (f"/{action}" if action else "")


def open_stages(world):
    return list(PipelineStage.objects.for_workspace(world.ws).filter(category="open").order_by("order"))


def stage(world, category):
    from modules.sales.selectors import stages

    return stages(world.ws).get(category=category)


def win(world, actor, opp, **body):
    return world.client(actor).post(opp_url(opp, "won"), body, format="json")


# ───────────────────────── CRUD ─────────────────────────


def test_create_read_update_opportunity(world):
    rep = world.client("rep")
    product = Product.objects.create(workspace=world.ws, name="Switch")
    res = rep.post(
        f"{BASE}/opportunities",
        {
            "title": "Core network",
            "companyId": str(world.companies["rep"].pk),
            "contactId": str(world.contacts["rep"].pk),
            "productId": str(product.pk),
            "expectedValue": "250000.50",
            "expectedCloseDate": "2026-01-31",
        },
        format="json",
    )
    assert res.status_code == 201, res.json()
    body = res.json()
    first = open_stages(world)[0]
    assert (body["status"], body["stageId"], body["stage"]["name"], body["version"]) == (
        "open",
        str(first.pk),
        first.name,
        1,
    )
    assert (body["probability"], body["probabilityOverride"], body["weightedValue"]) == (20, None, "50000.10")
    assert body["company"] == {"id": str(world.companies["rep"].pk), "name": "Rep Trading PLC"}
    assert body["flags"] == {"overdueClose": True, "noNextStep": False, "stale": False}
    assert (body["canEdit"], body["canDelete"], body["canMove"], body["canClose"]) == (True, False, True, True)
    assert (body["creditedUserId"], body["wonAt"], body["lostReason"]) == (None, None, None)
    assert rep.get(opp_url(body["id"])).json() == body
    res = rep.patch(opp_url(body["id"]), {"probabilityOverride": 55, "nextAction": "Demo", "version": 1}, format="json")
    assert res.status_code == 200
    assert (res.json()["probability"], res.json()["weightedValue"], res.json()["version"]) == (55, "137500.28", 2)
    res = rep.patch(opp_url(body["id"]), {"probabilityOverride": None}, format="json")
    assert (res.json()["probability"], res.json()["version"]) == (20, 3)
    res = rep.patch(opp_url(body["id"]), {"notes": "x", "version": 1}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "version_conflict")
    assert res.json()["details"]["current"]["version"] == 3
    history = OpportunityStageHistory.objects.for_workspace(world.ws).filter(opportunity_id=body["id"])
    assert [h.kind for h in history] == ["created"]
    assert DomainEvent.objects.filter(type="sales.opportunity.created").count() == 1
    assert rep.delete(opp_url(body["id"])).status_code == 403  # Sales Admin only
    assert world.client("sales_admin").delete(opp_url(body["id"])).status_code == 204
    assert rep.get(opp_url(body["id"])).status_code == 404


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"companyId": "c"}, "title"),
        ({"title": "T"}, "companyId"),
        ({"title": "T", "companyId": "rep3"}, "companyId"),
        ({"title": "T", "companyId": "rep", "contactId": "rep2"}, "contactId"),
        ({"title": "T", "companyId": "rep", "stageId": "won"}, "stageId"),
        ({"title": "T", "companyId": "rep", "probabilityOverride": 101}, "probabilityOverride"),
        ({"title": "T", "companyId": "rep", "expectedValue": "-5"}, "expectedValue"),
    ],
)
def test_opportunity_validation(world, payload, field):
    data = dict(payload)
    if data.get("companyId") in world.companies:
        data["companyId"] = str(world.companies[data["companyId"]].pk)
    if data.get("contactId") in world.contacts:
        data["contactId"] = str(world.contacts[data["contactId"]].pk)
    if data.get("stageId") == "won":
        data["stageId"] = str(stage(world, "won").pk)
    res = world.client("rep").post(f"{BASE}/opportunities", data, format="json")
    assert res.status_code == 422, res.json()
    assert field in res.json()["details"]["fields"]


def test_list_filters_and_sorts(deals):
    admin = deals.client("sales_admin")
    rows = admin.get(f"{BASE}/opportunities").json()["data"]
    assert len(rows) == 5
    second = open_stages(deals)[1]
    Opportunity.objects.filter(pk=deals.opportunities["rep"].pk).update(stage=second, expected_close_date="2026-11-05")
    by_stage = admin.get(f"{BASE}/opportunities?filter[stage]={second.pk}").json()["data"]
    assert [r["title"] for r in by_stage] == ["Rep Deal"]
    assert len(admin.get(f"{BASE}/opportunities?filter[status]=open").json()["data"]) == 5
    assert admin.get(f"{BASE}/opportunities?filter[status]=won").json()["data"] == []
    rng = "filter[expectedCloseFrom]=2026-11-01&filter[expectedCloseTo]=2026-11-30"
    assert [r["title"] for r in admin.get(f"{BASE}/opportunities?{rng}").json()["data"]] == ["Rep Deal"]
    team = admin.get(f"{BASE}/opportunities?filter[team]={deals.teams['south'].pk}").json()["data"]
    assert {r["title"] for r in team} == {"Rep2 Deal", "Rep3 Deal"}
    assert [r["title"] for r in admin.get(f"{BASE}/opportunities?q=rep3").json()["data"]] == ["Rep3 Deal"]
    company = admin.get(f"{BASE}/opportunities?filter[company]={deals.companies['rep2'].pk}").json()["data"]
    assert [r["title"] for r in company] == ["Rep2 Deal"]
    values = [r["expectedValue"] for r in admin.get(f"{BASE}/opportunities?sort=-expectedValue").json()["data"]]
    assert values == ["5000.00", "4000.00", "3000.00", "2000.00", "1000.00"]
    closes = admin.get(f"{BASE}/opportunities?sort=expectedCloseDate&limit=1").json()
    assert closes["data"][0]["title"] == "Rep Deal" and closes["nextCursor"]
    nxt = admin.get(f"{BASE}/opportunities?sort=expectedCloseDate&limit=10&cursor={closes['nextCursor']}").json()
    assert len(nxt["data"]) == 4
    for sort in ("title", "createdAt", "wonAt", "-updatedAt"):
        assert admin.get(f"{BASE}/opportunities?sort={sort}").status_code == 200
    for bad in ("filter[status]=closed", "filter[stage]=x", "filter[expectedCloseFrom]=soon", "sort=stage"):
        assert admin.get(f"{BASE}/opportunities?{bad}").status_code == 422, bad


# ───────────────────────── move ─────────────────────────


def test_move_uses_the_version_and_writes_history(deals):
    rep = deals.client("rep")
    opp = deals.opportunities["rep"]
    second = open_stages(deals)[1]
    res = rep.post(opp_url(opp, "move"), {"stageId": str(second.pk)}, format="json")
    assert res.status_code == 422 and "version" in res.json()["details"]["fields"]
    res = rep.post(opp_url(opp, "move"), {"stageId": str(second.pk), "version": 7}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "version_conflict")
    assert res.json()["details"]["current"]["stageId"] == str(opp.stage_id)
    res = rep.post(opp_url(opp, "move"), {"stageId": str(second.pk), "version": 1}, format="json")
    assert res.status_code == 200
    assert (res.json()["stageId"], res.json()["version"], res.json()["probability"]) == (str(second.pk), 2, 40)
    # A second client still on version 1 loses.
    res = rep.post(opp_url(opp, "move"), {"stageId": str(open_stages(deals)[2].pk), "version": 1}, format="json")
    assert res.status_code == 409
    # Same stage: nothing happens.
    assert (
        rep.post(opp_url(opp, "move"), {"stageId": str(second.pk), "version": 2}, format="json").json()["version"] == 2
    )
    history = list(OpportunityStageHistory.objects.for_workspace(deals.ws).filter(opportunity=opp))
    assert [(h.kind, h.from_stage_name, h.to_stage_name) for h in history] == [("moved", "Opportunity", "Quotation")]
    audit = AuditLog.objects.get(action="sales.opportunity.moved")
    assert audit.changes == [{"field": "Stage", "kind": "status", "before": "Opportunity", "after": "Quotation"}]
    event = DomainEvent.objects.get(type="sales.opportunity.moved")
    assert event.payload["toStageId"] == str(second.pk)


def test_move_refuses_closing_stages_and_closed_deals(deals):
    rep = deals.client("rep")
    opp = deals.opportunities["rep"]
    res = rep.post(opp_url(opp, "move"), {"stageId": str(stage(deals, "won").pk), "version": 1}, format="json")
    assert res.status_code == 422 and "stageId" in res.json()["details"]["fields"]
    assert win(deals, "rep", opp).status_code == 200
    res = rep.post(opp_url(opp, "move"), {"stageId": str(open_stages(deals)[1].pk), "version": 2}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "opportunity_closed")
    assert (
        deals.client("ceo").post(opp_url(opp, "move"), {"stageId": "x", "version": 1}, format="json").status_code == 403
    )


# ───────────────────────── won, lost, reopen ─────────────────────────


def test_won_defaults_credit_and_company_status(deals):
    opp = deals.opportunities["rep"]
    res = win(deals, "rep", opp)
    assert res.status_code == 200, res.json()
    body = res.json()
    rep_id = str(deals.users["rep"].pk)
    assert (body["status"], body["wonValue"], body["creditedUserId"], body["probability"]) == (
        "won",
        "1000.00",
        rep_id,
        100,
    )
    assert body["wonAt"] is not None and body["flags"]["overdueClose"] is False
    company = Company.objects.get(pk=opp.company_id)
    assert company.status == "active"
    assert AuditLog.objects.filter(action="sales.company.updated", target_id=str(company.pk)).count() == 1
    event = DomainEvent.objects.get(type="sales.opportunity.won")
    assert (event.payload["wonValue"], event.payload["creditedUserId"]) == ("1000.00", rep_id)
    assert [h.kind for h in OpportunityStageHistory.objects.for_workspace(deals.ws).filter(opportunity=opp)] == ["won"]
    res = win(deals, "rep", opp)
    assert (res.status_code, res.json()["code"]) == (409, "opportunity_closed")
    other = deals.opportunities["rep2"]
    assert win(deals, "rep2", other, wonValue="1234.56").json()["wonValue"] == "1234.56"
    assert win(deals, "ceo", deals.opportunities["rep3"]).status_code == 403


def test_lost_needs_an_active_reason(deals):
    rep = deals.client("rep")
    opp = deals.opportunities["rep"]
    price = LostReason.objects.create(workspace=deals.ws, name="Price")
    old = LostReason.objects.create(workspace=deals.ws, name="Old", is_active=False)
    res = rep.post(opp_url(opp, "lost"), {}, format="json")
    assert res.status_code == 422 and "lostReasonId" in res.json()["details"]["fields"]
    res = rep.post(opp_url(opp, "lost"), {"lostReasonId": str(old.pk)}, format="json")
    assert res.status_code == 422
    res = rep.post(opp_url(opp, "lost"), {"lostReasonId": str(price.pk), "lostNote": "Too dear"}, format="json")
    body = res.json()
    assert (body["status"], body["lostReason"]["name"], body["lostNote"], body["probability"]) == (
        "lost",
        "Price",
        "Too dear",
        0,
    )
    assert body["lostAt"] is not None and body["weightedValue"] == "0.00"
    assert DomainEvent.objects.filter(type="sales.opportunity.lost").count() == 1
    assert rep.post(opp_url(opp, "lost"), {"lostReasonId": str(price.pk)}, format="json").status_code == 409
    # The reason is now in use.
    res = deals.client("owner").delete(f"/api/v1/sales/lost-reasons/{price.pk}")
    assert (res.status_code, res.json()["code"]) == (409, "lost_reason_in_use")


def test_reopen_needs_close_and_reopen(deals):
    opp = deals.opportunities["rep"]
    win(deals, "rep", opp)
    assert deals.client("rep").post(opp_url(opp, "reopen"), {}, format="json").status_code == 403
    assert deals.client("manager").post(opp_url(opp, "reopen"), {}, format="json").status_code == 403
    target = open_stages(deals)[2]
    res = deals.client("sales_admin").post(
        opp_url(opp, "reopen"), {"stageId": str(target.pk), "version": 2}, format="json"
    )
    assert res.status_code == 200, res.json()
    body = res.json()
    assert (body["status"], body["stageId"], body["wonAt"], body["wonValue"], body["creditedUserId"]) == (
        "open",
        str(target.pk),
        None,
        None,
        None,
    )
    audit = AuditLog.objects.get(action="sales.opportunity.reopened")
    assert {c["field"] for c in audit.changes} == {"Stage", "Won value", "Credited to"}
    res = deals.client("sales_admin").post(opp_url(opp, "reopen"), {}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "opportunity_open")
    # Reopening a lost deal clears the reason; the default target is the first open stage.
    reason = LostReason.objects.create(workspace=deals.ws, name="Timing")
    deals.client("rep").post(opp_url(opp, "lost"), {"lostReasonId": str(reason.pk)}, format="json")
    body = deals.client("sales_admin").post(opp_url(opp, "reopen"), {}, format="json").json()
    assert (body["lostReasonId"], body["lostAt"], body["stageId"]) == (None, None, str(open_stages(deals)[0].pk))
    kinds = [h.kind for h in OpportunityStageHistory.objects.for_workspace(deals.ws).filter(opportunity=opp)]
    assert kinds == ["won", "reopened", "lost", "reopened"]
    # A Sales Manager given reopen but whose close scope misses the record is refused with the close code.
    from core.access.models import Permission, RolePermission
    from core.common.testing import role

    mgr = role(deals.ws, "sales_manager")
    RolePermission.objects.create(
        role=mgr, permission=Permission.objects.get(code="sales.opportunity.reopen"), data_scope="all"
    )
    RolePermission.objects.filter(role=mgr, permission__code="sales.opportunity.view").update(data_scope="all")
    deals.users["manager"].__dict__.pop("_lx_access_cache", None)
    win(deals, "rep3", deals.opportunities["rep3"])
    res = deals.client("manager").post(opp_url(deals.opportunities["rep3"], "reopen"), {}, format="json")
    assert (res.status_code, res.json()["details"]) == (403, {"permission": "sales.opportunity.close"})


def test_credited_user_survives_reassignment(deals):
    opp = deals.opportunities["rep"]
    quote = deals.quotations["rep"]
    win(deals, "rep", opp)
    rep2 = deals.users["rep2"]
    res = deals.client("manager").patch(opp_url(opp), {"ownerId": str(rep2.pk)}, format="json")
    assert res.status_code == 200, res.json()
    body = res.json()
    assert (body["ownerId"], body["creditedUserId"]) == (str(rep2.pk), str(deals.users["rep"].pk))
    quote.refresh_from_db()
    assert quote.owner_id == rep2.pk  # quotations follow the opportunity's owner
    event = DomainEvent.objects.get(type="sales.opportunity.reassigned")
    assert (event.payload["fromOwnerId"], event.payload["toOwnerId"]) == (str(deals.users["rep"].pk), str(rep2.pk))
    # Bulk reassignment never changes it either.
    res = deals.client("sales_admin").post(
        f"{BASE}/opportunities/bulk-assign",
        {"opportunityIds": [str(opp.pk)], "ownerId": str(deals.users["rep3"].pk)},
        format="json",
    )
    assert res.json() == {"updated": 1}
    opp.refresh_from_db()
    assert (opp.owner_id, opp.credited_user_id) == (deals.users["rep3"].pk, deals.users["rep"].pk)
    # Changing the credit needs sales.opportunity.reopen (Sales Admin), and is audited.
    res = deals.client("manager").patch(opp_url(opp), {"creditedUserId": str(rep2.pk)}, format="json")
    assert res.status_code == 404  # rep3 now owns it: outside the North manager's view scope
    res = deals.client("sales_admin").patch(opp_url(opp), {"creditedUserId": str(rep2.pk)}, format="json")
    assert res.json()["creditedUserId"] == str(rep2.pk)
    audit = AuditLog.objects.filter(action="sales.opportunity.updated").order_by("created_at").last()
    assert audit.changes[0]["field"] == "Credited to"
    other = deals.opportunities["rep2"]
    res = deals.client("sales_admin").patch(opp_url(other), {"creditedUserId": str(rep2.pk)}, format="json")
    assert res.status_code == 422  # open deals aren't credited


def test_reassignment_needs_assign(deals):
    opp = deals.opportunities["rep"]
    res = deals.client("rep").patch(opp_url(opp), {"ownerId": str(deals.users["rep2"].pk)}, format="json")
    assert (res.status_code, res.json()["details"]["permission"]) == (403, "sales.opportunity.assign")
    res = deals.client("manager").patch(opp_url(opp), {"ownerId": str(deals.users["rep3"].pk)}, format="json")
    assert res.status_code == 422
    res = deals.client("manager").post(
        f"{BASE}/opportunities/bulk-assign",
        {"opportunityIds": [str(opp.pk), str(deals.opportunities["rep3"].pk)], "ownerId": str(deals.users["rep2"].pk)},
        format="json",
    )
    assert res.status_code == 422
    assert Opportunity.objects.get(pk=opp.pk).owner_id == deals.users["rep"].pk


# ───────────────────────── back-dating and time zones ─────────────────────────

NOW = "2026-10-20 09:00:00"  # 12:00 in Addis Ababa (UTC+3)


@freeze_time(NOW)
def test_back_dating_rules(deals):
    opp = deals.opportunities["rep"]
    res = win(deals, "rep", opp, wonAt="2026-10-19")
    assert (res.status_code, res.json()["details"]) == (403, {"permission": "sales.opportunity.close", "scope": "team"})
    assert win(deals, "rep", opp, wonAt="2026-10-21").status_code == 422  # future
    assert win(deals, "rep", opp, wonAt="yesterday").status_code == 422
    # Earlier today is fine for anyone.
    res = win(deals, "rep", opp, wonAt="2026-10-20T08:00:00")
    assert res.json()["wonAt"] == "2026-10-20T05:00:00Z"
    manager_opp = deals.opportunities["rep2"]
    res = win(deals, "manager", manager_opp, wonAt="2026-09-30")
    assert res.status_code == 422 and "2026-10-01" in res.json()["details"]["fields"]["wonAt"]
    res = win(deals, "manager", manager_opp, wonAt="2026-10-01")
    assert (res.status_code, res.json()["wonAt"]) == (200, "2026-10-01T09:00:00Z")
    # A date given as today means now.
    assert win(deals, "sales_admin", deals.opportunities["sales_admin"], wonAt="2026-10-20").json()["wonAt"] == (
        "2026-10-20T09:00:00Z"
    )


@freeze_time(NOW)
def test_won_late_evening_and_after_midnight_land_on_the_right_local_date(deals):
    """23:30 on the 14th Addis time is 20:30 UTC on the 14th; 00:30 on the 15th is 21:30 UTC, still the 14th in UTC."""
    win(deals, "manager", deals.opportunities["rep"], wonAt="2026-10-14T23:30:00+03:00")
    win(deals, "manager", deals.opportunities["rep2"], wonAt="2026-10-15T00:30:00+03:00")
    stored = Opportunity.objects.get(pk=deals.opportunities["rep2"].pk).won_at
    assert stored.astimezone(dt.UTC).date() == dt.date(2026, 10, 14)
    admin = deals.client("sales_admin")

    def won_on(day):
        rows = admin.get(f"{BASE}/opportunities?filter[wonFrom]={day}&filter[wonTo]={day}").json()["data"]
        return {r["title"] for r in rows}

    assert won_on("2026-10-14") == {"Rep Deal"}
    assert won_on("2026-10-15") == {"Rep2 Deal"}
    # Naive timestamps are workspace time.
    win(deals, "manager", deals.opportunities["manager"], wonAt="2026-10-15T23:59:00")
    assert won_on("2026-10-15") == {"Rep2 Deal", "Manager Deal"}


@freeze_time("2026-03-31 21:30:00")  # 00:30 on April 1st in Addis Ababa
def test_the_closing_period_follows_the_workspace_date(deals):
    res = win(deals, "manager", deals.opportunities["rep"], wonAt="2026-03-31")
    assert res.status_code == 422  # it is already April locally


def test_period_helper():
    p = period_containing("month", dt.date(2026, 2, 10))
    assert (p.start, p.end, p.days()) == (dt.date(2026, 2, 1), dt.date(2026, 2, 28), 28)
    assert (p.previous().start, p.next().start) == (dt.date(2026, 1, 1), dt.date(2026, 3, 1))
    week = period_containing("week", dt.date(2026, 10, 17), week_start="sunday")  # a Saturday
    assert (week.start, week.end) == (dt.date(2026, 10, 11), dt.date(2026, 10, 17))
    q = period_containing("quarter", dt.date(2026, 3, 10), fiscal_start_month=7)
    assert (q.start, q.end) == (dt.date(2026, 1, 1), dt.date(2026, 3, 31))
    year = period_containing("year", dt.date(2026, 3, 10), fiscal_start_month=7)
    assert (year.start, year.end, year.previous().start) == (
        dt.date(2025, 7, 1),
        dt.date(2026, 6, 30),
        dt.date(2024, 7, 1),
    )
    assert period_containing("day", dt.date(2026, 1, 1)).previous().start == dt.date(2025, 12, 31)
    assert period_containing("quarter", dt.date(2026, 1, 15)).contains(dt.date(2026, 3, 31))
    with pytest.raises(ValueError):
        period_containing("fortnight", dt.date(2026, 1, 1))
    with pytest.raises(ValueError):
        period_containing("year", dt.date(2026, 1, 1), fiscal_start_month=13)


# ───────────────────────── pipeline board ─────────────────────────


def test_pipeline_board_totals_and_filters(deals):
    first, second = open_stages(deals)[:2]
    Opportunity.objects.filter(pk=deals.opportunities["rep2"].pk).update(stage=second, probability_override=50)
    win(deals, "rep3", deals.opportunities["rep3"])  # closed: off the board
    admin = deals.client("sales_admin")
    board = admin.get(f"{BASE}/pipeline").json()
    assert [c["stage"]["name"] for c in board["stages"]] == ["Opportunity", "Quotation", "Negotiation"]
    col1, col2, col3 = board["stages"]
    assert (col1["count"], col1["value"], col1["weightedValue"]) == (3, "10000.00", "2000.00")  # 1000+4000+5000 at 20%
    assert (col2["count"], col2["value"], col2["weightedValue"]) == (1, "2000.00", "1000.00")
    assert (col3["count"], col3["value"], col3["opportunities"], col3["nextCursor"]) == (0, "0.00", [], None)
    assert (board["count"], board["value"], board["weightedValue"], board["leadCount"]) == (4, "12000.00", "3000.00", 5)
    assert {o["title"] for o in col1["opportunities"]} == {"Rep Deal", "Manager Deal", "Sales_Admin Deal"}
    paged = admin.get(f"{BASE}/pipeline?limit=1").json()["stages"][0]
    assert len(paged["opportunities"]) == 1 and paged["nextCursor"]
    more = admin.get(f"{BASE}/opportunities?filter[stage]={first.pk}&sort=-updatedAt&cursor={paged['nextCursor']}")
    assert len(more.json()["data"]) == 2
    north = admin.get(f"{BASE}/pipeline?filter[team]={deals.teams['north'].pk}").json()
    assert (north["count"], north["leadCount"]) == (3, 3)
    mine = deals.client("rep").get(f"{BASE}/pipeline").json()
    assert (mine["count"], mine["value"], mine["leadCount"]) == (1, "1000.00", 1)
    Opportunity.objects.filter(pk=deals.opportunities["rep"].pk).update(expected_close_date="2026-12-01")
    ranged = admin.get(
        f"{BASE}/pipeline?filter[expectedCloseFrom]=2026-12-01&filter[expectedCloseTo]=2026-12-31"
    ).json()
    assert ranged["count"] == 1
    product = Product.objects.create(workspace=deals.ws, name="P")
    assert admin.get(f"{BASE}/pipeline?filter[product]={product.pk}").json()["count"] == 0


# ───────────────────────── timeline ─────────────────────────


def test_timeline_shows_stage_changes_and_quotations(deals):
    rep = deals.client("rep")
    res = rep.post(f"{BASE}/opportunities", {"title": "T", "companyId": str(deals.companies["rep"].pk)}, format="json")
    opp_id = res.json()["id"]
    second = open_stages(deals)[1]
    rep.post(opp_url(opp_id, "move"), {"stageId": str(second.pk), "version": 1}, format="json")
    q = rep.post(f"{BASE}/quotations", {"opportunityId": opp_id, "title": "Offer", "amount": "10.00"}, format="json")
    rep.post(f"/api/v1/sales/quotations/{q.json()['id']}/send", {}, format="json")
    rep.post(opp_url(opp_id, "won"), {}, format="json")
    page = rep.get(opp_url(opp_id, "timeline")).json()
    kinds = [i["kind"] for i in page["data"]]
    assert kinds == ["stage_won", "quotation_sent", "quotation_created", "stage_moved", "stage_created"]
    assert page["nextCursor"] is None
    moved = page["data"][3]
    assert moved["stageChange"] == {
        "fromStageId": str(open_stages(deals)[0].pk),
        "fromStage": "Opportunity",
        "toStageId": str(second.pk),
        "toStage": "Quotation",
    }
    assert moved["actor"]["id"] == str(deals.users["rep"].pk)
    assert (moved["quotation"], moved["activity"], moved["followUp"]) == (None, None, None)
    sent = page["data"][1]
    assert sent["quotation"]["status"] == "sent" and sent["summary"].startswith("Quotation Q-")
    first = rep.get(opp_url(opp_id, "timeline") + "?limit=2").json()
    assert [i["kind"] for i in first["data"]] == kinds[:2]
    rest = rep.get(opp_url(opp_id, "timeline") + f"?limit=2&cursor={first['nextCursor']}").json()
    assert [i["kind"] for i in rest["data"]] == kinds[2:4]
    assert rep.get(opp_url(opp_id, "timeline") + "?cursor=garbage").status_code == 400
    # Children are shown whoever owns them; outsiders of the opportunity get 404.
    assert deals.client("rep2").get(opp_url(opp_id, "timeline")).status_code == 404


# ───────────────────────── S1 guards and the company summary ─────────────────────────


def test_in_use_guards(deals):
    owner = deals.client("owner")
    first = open_stages(deals)[0]
    res = owner.delete(f"/api/v1/sales/stages/{first.pk}")
    assert (res.status_code, res.json()["code"]) == (409, "stage_in_use")
    product = Product.objects.create(workspace=deals.ws, name="Used")
    Opportunity.objects.filter(pk=deals.opportunities["rep"].pk).update(product=product)
    assert owner.delete(f"/api/v1/sales/products/{product.pk}").json()["code"] == "product_in_use"
    lead_product = Product.objects.create(workspace=deals.ws, name="Lead only")
    deals.leads["rep"].__class__.objects.filter(pk=deals.leads["rep"].pk).update(product=lead_product)
    assert owner.delete(f"/api/v1/sales/products/{lead_product.pk}").status_code == 409
    free = Product.objects.create(workspace=deals.ws, name="Free")
    assert owner.delete(f"/api/v1/sales/products/{free.pk}").status_code == 204
    res = owner.delete(f"/api/v1/sales/companies/{deals.companies['rep'].pk}")
    assert (res.status_code, res.json()["code"]) == (409, "company_has_opportunities")
    # Still refused while the opportunity sits in the trash.
    owner.delete(opp_url(deals.opportunities["rep"]))
    assert owner.delete(f"/api/v1/sales/companies/{deals.companies['rep'].pk}").status_code == 409


def test_company_summary_counts_deals_in_scope(deals):
    company = deals.companies["rep"]
    extra = Opportunity.objects.create(
        workspace=deals.ws,
        owner=deals.users["rep3"],
        company=company,
        title="Other rep's deal",
        stage=open_stages(deals)[0],
        expected_value=Decimal("700.00"),
    )
    win(deals, "rep", deals.opportunities["rep"], wonValue="900.00")
    Opportunity.objects.create(
        workspace=deals.ws,
        owner=deals.users["rep"],
        company=company,
        title="Open",
        stage=open_stages(deals)[1],
        expected_value=Decimal("300.00"),
    )
    url = f"/api/v1/sales/companies/{company.pk}/summary"
    mine = deals.client("rep").get(url).json()
    assert (mine["openOpportunityCount"], mine["pipelineValue"], mine["wonValue"]) == (1, "300.00", "900.00")
    everyone = deals.client("sales_admin").get(url).json()
    assert (everyone["openOpportunityCount"], everyone["pipelineValue"], everyone["wonValue"]) == (
        2,
        "1000.00",
        "900.00",
    )
    assert extra.pk


def test_trash_restores_an_opportunity_with_exactly_its_quotations(deals):
    admin = deals.client("sales_admin")
    opp = deals.opportunities["rep"]
    quote = deals.quotations["rep"]
    loose = Quotation.objects.create(
        workspace=deals.ws, opportunity=opp, owner=deals.users["rep"], number="Q-2000-0077", title="Earlier", amount=1
    )
    assert admin.delete(f"/api/v1/sales/quotations/{loose.pk}").status_code == 204
    assert admin.delete(opp_url(opp)).status_code == 204
    assert admin.get(f"/api/v1/sales/quotations/{quote.pk}").status_code == 404
    assert not Quotation.objects.for_workspace(deals.ws).filter(opportunity=opp).exists()
    trash = admin.get("/api/v1/workspaces/platform/trash").json()
    items = {(i["kind"], i["title"]) for i in trash["data"]}
    assert ("sales.opportunity", "Rep Deal") in items
    assert ("sales.quotation", "Q-2000-0077 Earlier") not in items  # its opportunity is in the trash
    assert {"sales.lead", "sales.opportunity", "sales.quotation"} <= set(trash["kinds"])
    res = admin.post(
        "/api/v1/workspaces/platform/trash/restore",
        {"items": [{"kind": "sales.opportunity", "id": str(opp.pk)}]},
        format="json",
    )
    assert res.status_code == 200, res.json()
    assert admin.get(f"/api/v1/sales/quotations/{quote.pk}").status_code == 200
    assert admin.get(f"/api/v1/sales/quotations/{loose.pk}").status_code == 404
    trash = admin.get("/api/v1/workspaces/platform/trash").json()
    assert ("sales.quotation", "Q-2000-0077 Earlier") in {(i["kind"], i["title"]) for i in trash["data"]}
    # Purging an opportunity removes its quotations and history; its lead keeps living.
    lead = deals.leads["rep"]
    lead.__class__.objects.filter(pk=lead.pk).update(converted_opportunity=opp, status="converted")
    admin.delete(opp_url(opp))
    res = admin.post(
        "/api/v1/workspaces/platform/trash/purge",
        {"items": [{"kind": "sales.opportunity", "id": str(opp.pk)}]},
        format="json",
    )
    assert res.status_code == 200, res.json()
    assert not Quotation.all_objects.for_workspace(deals.ws).filter(pk=quote.pk).exists()
    lead.refresh_from_db()
    assert lead.converted_opportunity_id is None
    actions = set(AuditLog.objects.filter(action__startswith="sales.opportunity.").values_list("action", flat=True))
    assert {"sales.opportunity.deleted", "sales.opportunity.restored", "sales.opportunity.purged"} <= actions


def test_lead_and_quotation_trash(deals):
    manager = deals.client("manager")
    lead = deals.leads["rep"]
    assert manager.delete(f"/api/v1/sales/leads/{lead.pk}").status_code == 204
    quote = deals.quotations["rep"]
    assert manager.delete(f"/api/v1/sales/quotations/{quote.pk}").status_code == 204
    titles = {(i["kind"], i["title"]) for i in manager.get("/api/v1/workspaces/platform/trash").json()["data"]}
    assert {("sales.lead", "Rep Prospect"), ("sales.quotation", "Q-2000-0001 Rep Quote")} <= titles
    # Salespeople hold neither delete code: no sales trash kinds.
    rep_trash = deals.client("rep").get("/api/v1/workspaces/platform/trash")
    if rep_trash.status_code == 200:
        assert not [k for k in rep_trash.json()["kinds"] if k.startswith("sales.")]
    else:
        assert rep_trash.status_code == 403
    res = manager.post(
        "/api/v1/workspaces/platform/trash/restore",
        {"items": [{"kind": "sales.lead", "id": str(lead.pk)}, {"kind": "sales.quotation", "id": str(quote.pk)}]},
        format="json",
    )
    assert res.status_code == 200, res.json()
    assert deals.client("rep").get(f"/api/v1/sales/leads/{lead.pk}").status_code == 200
    manager.delete(f"/api/v1/sales/leads/{lead.pk}")
    res = manager.post(
        "/api/v1/workspaces/platform/trash/purge",
        {"items": [{"kind": "sales.lead", "id": str(lead.pk)}]},
        format="json",
    )
    assert res.status_code == 200
    assert not lead.__class__.all_objects.for_workspace(deals.ws).filter(pk=lead.pk).exists()
    manager.delete(f"/api/v1/sales/quotations/{quote.pk}")
    res = manager.post(
        "/api/v1/workspaces/platform/trash/purge",
        {"items": [{"kind": "sales.quotation", "id": str(quote.pk)}]},
        format="json",
    )
    assert res.status_code == 200


def test_purging_expired_items_and_whole_workspaces(deals):
    from django.utils import timezone

    from core.audit import trash

    admin = deals.users["sales_admin"]
    from modules.sales import pipeline_services as svc

    svc.delete_opportunity(admin, deals.opportunities["rep"])
    svc.delete_lead(admin, deals.leads["rep2"])
    counts = trash.purge_expired(timezone.now() + dt.timedelta(days=365))
    assert counts["opportunities"] >= 1  # rows deleted, cascades included
    assert not Opportunity.all_objects.for_workspace(deals.ws).filter(pk=deals.opportunities["rep"].pk).exists()
    trash.purge_workspace(deals.ws)
    assert not Opportunity.all_objects.unscoped().filter(workspace_id=deals.ws.pk).exists()
    assert not Company.all_objects.unscoped().filter(workspace_id=deals.ws.pk).exists()
