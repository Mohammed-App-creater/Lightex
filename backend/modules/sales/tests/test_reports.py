"""S6 reports (docs/sales/api.md §22–§23): the catalogue, every report on a small dataset, CSV export and the
management daily report job."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal as D

import pytest
from freezegun import freeze_time

from core.access.models import RolePermission
from core.common.testing import role
from core.jobs.services import run_job
from core.modules.services import set_module_enabled
from core.notifications.models import Notification
from modules.sales.models import Activity, Company, FollowUp, Opportunity, OpportunityStageHistory, Target
from modules.sales.report_engine import REPORTS

from .test_dashboard import NOW, won

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform/reports"


def dataset(w):
    won(w, "rep", D(100))
    won(w, "rep2", D("200.50"))
    lost = w.opportunities["rep3"]
    lost_stage = lost.stage.__class__.objects.for_workspace(w.ws).get(category="lost")
    Opportunity.objects.filter(pk=lost.pk).update(stage=lost_stage, lost_at=dt.datetime(2026, 10, 13, tzinfo=dt.UTC))
    opp = w.opportunities["rep"]
    OpportunityStageHistory.objects.create(
        workspace=w.ws, opportunity=opp, to_stage=opp.stage, changed_at=dt.datetime(2026, 10, 2, tzinfo=dt.UTC)
    )
    Activity.objects.create(
        workspace=w.ws, owner=w.users["rep"], type="call", occurred_at=dt.datetime(2026, 10, 13, 8, tzinfo=dt.UTC),
        company=opp.company, target_type="sales.opportunity", target_id=opp.pk, opportunity=opp,
    )  # fmt: skip
    FollowUp.objects.create(
        workspace=w.ws, owner=w.users["rep"], created_by=w.users["rep"], title="Call", due_date=dt.date(2026, 10, 12),
        company=opp.company, target_type="sales.opportunity", target_id=opp.pk, opportunity=opp,
    )  # fmt: skip
    Target.objects.create(
        workspace=w.ws, subject_type="user", subject_id=w.users["rep"].pk, period_type="month",
        period_start=dt.date(2026, 10, 1), amount=D("1000"),
    )  # fmt: skip


def test_catalogue_lists_the_18_reports(deals):
    res = deals.client("manager").get(BASE)
    assert res.status_code == 200
    keys = [r["key"] for r in res.json()]
    assert len(keys) == 18 == len(set(keys))
    assert {"daily-sales", "revenue-forecast", "annual-summary", "win-loss"} <= set(keys)
    assert deals.client("rep").get(BASE).status_code == 403  # salespeople have no sales.report.view


@freeze_time(NOW)
@pytest.mark.parametrize("key", sorted(REPORTS))
def test_every_report_answers_json(deals, key):
    dataset(deals)
    res = deals.client("sales_admin").get(f"{BASE}/{key}")
    assert res.status_code == 200, res.json()
    body = res.json()
    assert body["key"] == key and body["columns"]
    keys = {c["key"] for c in body["columns"]}
    assert all(set(row) == keys for row in body["rows"])


@freeze_time(NOW)
def test_report_numbers_follow_the_scope(deals):
    dataset(deals)
    rows = deals.client("manager").get(f"{BASE}/target-achievement").json()["rows"]
    assert {r["userName"]: r["actual"] for r in rows if r["actual"] != "0.00"} == {"Rep": "100.00", "Rep2": "200.50"}
    rep = next(r for r in rows if r["userName"] == "Rep")
    assert (rep["target"], rep["achievement"]) == ("1000.00", 10.0)
    win_loss = deals.client("ceo").get(f"{BASE}/win-loss").json()["rows"]
    assert [(r["outcome"], r["count"]) for r in win_loss] == [("won", 2), ("lost", 1)]
    day = deals.client("manager").get(f"{BASE}/daily-sales?period=week").json()["rows"]
    assert [r["actual"] for r in day if r["date"] == "2026-10-13"] == ["300.50"]
    res = deals.client("manager").get(f"{BASE}/ranking?userId={deals.users['rep3'].pk}")
    assert res.status_code == 403


@freeze_time(NOW)
def test_custom_period_validation(deals):
    c = deals.client("manager")
    assert c.get(f"{BASE}/daily-sales?period=custom&from=2026-10-01").status_code == 422
    assert c.get(f"{BASE}/daily-sales?from=2026-10-05&to=2026-10-01").status_code == 422
    assert c.get(f"{BASE}/daily-sales?from=2025-01-01&to=2026-10-01").status_code == 422
    assert c.get(f"{BASE}/daily-sales?from=2026-13-01&to=2026-10-01").status_code == 422
    assert c.get(f"{BASE}/daily-sales?period=fortnight").status_code == 422
    assert c.get(f"{BASE}/nope").status_code == 404
    body = c.get(f"{BASE}/daily-sales?from=2026-10-01&to=2026-10-03").json()
    assert body["period"] == {"kind": "custom", "start": "2026-10-01", "end": "2026-10-03"}
    assert len(body["rows"]) == 3


@freeze_time(NOW)
def test_csv_export(deals):
    dataset(deals)
    Company.objects.filter(pk=deals.companies["rep"].pk).update(name='=HYPERLINK("x")')
    res = deals.client("manager").get(f"{BASE}/customer-performance?format=csv")
    assert res.status_code == 200
    assert res["Content-Type"] == "text/csv; charset=utf-8"
    assert "attachment" in res["Content-Disposition"]
    text = res.content.decode("utf-8-sig")
    assert text.splitlines()[0].startswith('"Company id","Company","Won"')
    assert '"\'=HYPERLINK(""x"")"' in text
    assert deals.client("manager").get(f"{BASE}/ranking?format=xml").status_code == 422

    RolePermission.objects.filter(role=role(deals.ws, "sales_manager"), permission__code="sales.report.export").delete()
    res = deals.client("manager").get(f"{BASE}/ranking?format=csv")
    assert res.status_code == 403
    assert res.json()["details"]["permission"] == "sales.report.export"
    assert deals.client("manager").get(f"{BASE}/ranking").status_code == 200


# ───────────────────────── management daily report ─────────────────────────

AT = dt.datetime(2026, 10, 14, 17, 0, tzinfo=dt.UTC)  # 20:00 in Addis Ababa, a Wednesday


def test_management_report_job(deals):
    dataset(deals)
    run_job("sales_management_daily_report", workspace_id=deals.ws.pk, now=AT)
    run_job("sales_management_daily_report", workspace_id=deals.ws.pk, now=AT)
    rows = Notification.objects.filter(type="sales.report.management")
    got = {n.recipient_id for n in rows}
    u = deals.users
    assert got == {u[a].pk for a in ("owner", "admin", "sales_admin", "ceo", "manager", "multi")}
    assert rows.count() == len(got)  # idempotent: one per recipient and date

    from core.events.models import DomainEvent

    reports = {
        e.payload["userId"]: e.payload["report"] for e in DomainEvent.objects.filter(type="sales.report.management")
    }
    manager, ceo = reports[str(u["manager"].pk)], reports[str(u["ceo"].pk)]
    assert manager["people"] == 3 and ceo["people"] > 3
    assert manager["summary"]["actual"] == "0"  # nothing won on the 14th
    assert manager["topPerformer"]["user"]["name"] == "Rep2"
    assert manager["attention"]["overdueFollowUps"]["count"] == 1
    assert {p["name"] for p in manager["attention"]["notSubmitted"]} == {"Manager", "Rep", "Rep2"}

    set_module_enabled(u["owner"], deals.ws, "sales", False)
    result = run_job("sales_management_daily_report", workspace_id=deals.ws.pk, now=AT + dt.timedelta(days=1))
    assert result.count("skipped") == 1
    assert rows.count() == len(got)
