"""S6 dashboard (docs/sales/api.md §21): numbers per data scope, filters inside the scope, attention items."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal as D

import pytest
from freezegun import freeze_time

from modules.sales.defaults import ensure_defaults
from modules.sales.models import FollowUp, Opportunity, PipelineStage, Quotation

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform/dashboard"
NOW = "2026-10-14 09:00:00"  # Wednesday, 12:00 in Addis Ababa


def won(w, actor, value, day="2026-10-13"):
    ensure_defaults(w.ws)
    user = w.users[actor]
    return Opportunity.objects.create(
        workspace=w.ws,
        owner=user,
        company=w.companies[actor if actor in w.companies else "rep"],
        title=f"{actor} won",
        stage=PipelineStage.objects.for_workspace(w.ws).get(category="won"),
        expected_value=value,
        won_value=value,
        won_at=dt.datetime.fromisoformat(f"{day}T09:00:00+00:00"),
        credited_user=user,
    )


def get(w, actor, query=""):
    res = w.client(actor).get(f"{BASE}{query}")
    assert res.status_code == 200, res.json()
    return res.json()


@freeze_time(NOW)
@pytest.mark.parametrize(
    ("actor", "actual", "pipeline", "scope"),
    [
        ("rep", "100.00", "1000.00", "own"),  # own deals only
        ("manager", "300.00", "7000.00", "team"),  # North: manager, rep, rep2
        ("ceo", "600.00", "15000.00", "all"),
    ],
)
def test_dashboard_follows_the_data_scope(deals, actor, actual, pipeline, scope):
    for who, value in (("rep", 100), ("rep2", 200), ("rep3", 300)):
        won(deals, who, D(value))
    data = get(deals, actor)
    assert data["scope"] == scope
    assert data["period"]["kind"] == "month"
    assert data["kpis"]["actual"] == actual
    assert data["kpis"]["wonCount"] == {"rep": 1, "manager": 2, "ceo": 3}[actor]
    assert sum(D(s["value"]) for s in data["pipeline"]["stages"]) == D(pipeline)
    assert data["pipeline"]["leads"]["count"] == {"rep": 1, "manager": 3, "ceo": 5}[actor]
    assert data["previous"]["actual"] == "0.00"


@freeze_time(NOW)
def test_filters_stay_inside_the_scope(deals):
    won(deals, "rep", D(100))
    won(deals, "rep2", D(200))
    rep = deals.users["rep"].pk
    assert get(deals, "manager", f"?userId={rep}")["kpis"]["actual"] == "100.00"
    assert get(deals, "manager", f"?teamId={deals.teams['north'].pk}")["kpis"]["actual"] == "300.00"
    res = deals.client("rep").get(f"{BASE}?userId={deals.users['rep2'].pk}")
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "sales.dashboard.view"
    assert deals.client("manager").get(f"{BASE}?teamId={deals.teams['south'].pk}").status_code == 403
    assert deals.client("manager").get(f"{BASE}?period=custom").status_code == 422
    assert get(deals, "ceo", f"?teamId={deals.teams['south'].pk}")["userCount"] == 3


@freeze_time(NOW)
def test_attention_items(deals):
    opp = deals.opportunities["rep"]
    FollowUp.objects.create(
        workspace=deals.ws, owner=deals.users["rep"], created_by=deals.users["rep"], title="Call back",
        due_date=dt.date(2026, 10, 10), company=opp.company, target_type="sales.opportunity", target_id=opp.pk,
        opportunity=opp,
    )  # fmt: skip
    Quotation.objects.filter(pk=deals.quotations["rep"].pk).update(
        status="sent", sent_at=dt.datetime(2026, 10, 1, tzinfo=dt.UTC)
    )
    s = ensure_defaults(deals.ws)
    s.large_deal_threshold = D("1500")
    s.save()
    Opportunity.objects.filter(pk=deals.opportunities["rep2"].pk).update(expected_close_date=dt.date(2026, 10, 16))

    data = get(deals, "manager")
    a = data["attention"]
    assert [i["title"] for i in a["overdueFollowUps"]["items"]] == ["Call back"]
    assert a["quotationsAwaitingResponse"]["count"] == 1
    assert [i["title"] for i in a["largeClosingThisWeek"]["items"]] == ["Rep2 Deal"]
    assert a["noNextStep"]["count"] == 2  # rep's deal has a pending follow-up
    assert data["followUps"] == {"overdue": 1, "today": 0, "upcoming": 0}
    assert get(deals, "rep3")["attention"]["overdueFollowUps"]["count"] == 0
