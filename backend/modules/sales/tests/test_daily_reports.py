"""S5 daily reports (docs/sales/api.md §20): lifecycle, lateness in workspace time, metrics from a small dataset,
non-working days, data scope on the list and team views, and the reminder job. Workspace time is Addis Ababa
(UTC+3): the default 18:00 cutoff is 15:00 UTC."""

import datetime as dt
from decimal import Decimal

import pytest
from django.utils import timezone
from freezegun import freeze_time

from core.audit.models import AuditLog
from core.jobs.services import run_job
from core.modules.services import set_module_enabled
from core.notifications.models import Notification
from modules.sales.models import (
    Activity,
    DailyReport,
    FollowUp,
    Holiday,
    Lead,
    Opportunity,
    PipelineStage,
    Quotation,
    Target,
)
from modules.sales.selectors import first_open_stage

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform"
WED = "2026-10-14"


def today(world, actor):
    res = world.client(actor).get(f"{BASE}/daily-reports/me/today")
    assert res.status_code == 200, res.json()
    return res.json()


def act(world, actor, report_id, action, body=None):
    return world.client(actor).post(f"/api/v1/sales/daily-reports/{report_id}/{action}", body or {}, format="json")


def put(world, actor, report_id, body):
    return world.client(actor).put(f"/api/v1/sales/daily-reports/{report_id}", body, format="json")


@freeze_time(f"{WED} 10:00:00")
def test_lifecycle_draft_submit_review_reopen(world):
    r = today(world, "rep")
    assert (r["status"], r["reportDate"], r["required"], r["canEdit"]) == ("draft", WED, True, True)
    assert today(world, "rep")["id"] == r["id"]  # created once
    plan = [{"text": "Visit Abay", "targetType": "sales.company", "targetId": str(world.companies["rep"].pk)}]
    res = put(world, "rep", r["id"], {"comments": ["Two calls"], "tomorrowPlan": plan})
    assert res.status_code == 200 and res.json()["tomorrowPlan"] == plan
    assert put(world, "manager", r["id"], {"comments": ["x"]}).status_code == 403  # not the author

    res = act(world, "rep", r["id"], "submit")
    assert res.status_code == 200 and (res.json()["status"], res.json()["isLate"]) == ("submitted", False)
    assert act(world, "rep", r["id"], "submit").status_code == 409
    reviewers = set(Notification.objects.filter(type="sales.dailyreport.submitted").values_list("recipient", flat=True))
    assert world.users["manager"].pk in reviewers and world.users["rep"].pk not in reviewers
    assert put(world, "rep", r["id"], {"comments": ["Still editable"]}).status_code == 200

    assert act(world, "rep", r["id"], "review").status_code == 403  # Salesperson: no review permission
    assert act(world, "multi", r["id"], "review").status_code == 404  # South lead: rep is out of view scope
    res = act(world, "manager", r["id"], "review", {"comment": "Good"})
    assert res.status_code == 200 and (res.json()["status"], res.json()["reviewComment"]) == ("reviewed", "Good")
    assert Notification.objects.filter(type="sales.dailyreport.reviewed", recipient=world.users["rep"]).exists()
    res = put(world, "rep", r["id"], {"comments": ["Too late"]})
    assert res.status_code == 409 and res.json()["code"] == "report_reviewed"

    res = act(world, "manager", r["id"], "reopen")
    assert res.status_code == 200 and res.json()["status"] == "draft"
    assert put(world, "rep", r["id"], {"comments": ["Fixed"]}).status_code == 200

    mine = today(world, "manager")
    assert act(world, "manager", mine["id"], "submit").status_code == 200
    assert act(world, "manager", mine["id"], "review").status_code == 403  # never your own
    logged = AuditLog.objects.for_workspace(world.ws).filter(action__startswith="sales.dailyreport.")
    actions = set(logged.values_list("action", flat=True))
    assert {"created", "updated", "submitted", "reviewed", "reopened"} <= {a.rsplit(".", 1)[1] for a in actions}


@pytest.mark.parametrize(("at", "late"), [("14:59:59", False), ("15:00:01", True)])
def test_lateness_uses_the_cutoff_in_workspace_time(world, at, late):
    with freeze_time(f"{WED} {at}"):
        r = today(world, "rep")
        assert act(world, "rep", r["id"], "submit").json()["isLate"] is late


@freeze_time(f"{WED} 12:00:00")
def test_metrics_from_a_small_dataset(world):
    rep, ws = world.users["rep"], world.ws
    now = timezone.now()
    opp_stage = first_open_stage(ws)
    stages = {s.category: s for s in PipelineStage.objects.for_workspace(ws).exclude(category="open")}
    company = world.companies["rep"]

    def opp(**kw):
        return Opportunity.objects.create(
            workspace=ws, owner=rep, company=company, title="Deal", expected_value=1, **kw
        )

    open_opp = opp(stage=opp_stage)
    opp(stage=stages["won"], won_at=now, won_value=Decimal("300.00"), credited_user=rep)
    opp(stage=stages["lost"], lost_at=now)
    Lead.objects.create(workspace=ws, owner=rep, contact_name="Abebe")
    on = {"target_type": "sales.opportunity", "target_id": open_opp.pk, "opportunity": open_opp, "company": company}
    yesterday = now - dt.timedelta(days=1)
    for kind, when in (("call", now), ("call", now), ("visit", now), ("meeting", now), ("call", yesterday)):
        Activity.objects.create(workspace=ws, owner=rep, type=kind, occurred_at=when, **on)
    Quotation.objects.create(
        workspace=ws, owner=rep, opportunity=open_opp, number="Q-1", title="Q", amount=1, status="sent", sent_at=now
    )
    FollowUp.objects.create(workspace=ws, owner=rep, title="F", due_date=WED, status="done", completed_at=now, **on)
    # October 2026 has 22 working days (Mon-Fri): 2200 a month is 100 a day.
    Target.objects.create(
        workspace=ws,
        subject_type="user",
        subject_id=rep.pk,
        period_type="month",
        period_start="2026-10-01",
        amount=2200,
    )
    expected = {
        "target": "100.00",
        "sales": "300.00",
        "achievement": 300.0,
        "newLeads": 1,
        "calls": 2,
        "visits": 1,
        "meetings": 1,
        "quotationsSent": 1,
        "followUpsCompleted": 1,
        "newOpportunities": 3,
        "dealsWon": 1,
        "dealsLost": 1,
    }
    r = today(world, "rep")
    assert r["metrics"] == expected
    act(world, "rep", r["id"], "submit")
    Activity.objects.create(workspace=ws, owner=rep, type="call", occurred_at=now, **on)
    frozen = world.client("rep").get(f"/api/v1/sales/daily-reports/{r['id']}").json()["metrics"]
    assert frozen == expected  # the snapshot, not live numbers


@freeze_time("2026-10-17 09:00:00")  # a Saturday
def test_non_working_days_do_not_require_a_report(world):
    r = today(world, "rep")
    assert r["required"] is False
    assert act(world, "rep", r["id"], "submit").status_code == 200
    Holiday.objects.create(workspace=world.ws, date=WED, name="Holiday")
    with freeze_time(f"{WED} 09:00:00"):
        assert today(world, "rep")["required"] is False


@freeze_time(f"{WED} 10:00:00")
def test_list_and_team_view_follow_the_data_scope(world):
    for actor in ("rep", "rep3"):
        today(world, actor)
    act(world, "rep", DailyReport.objects.for_workspace(world.ws).get(user=world.users["rep"]).pk, "submit")

    def listed(actor):
        res = world.client(actor).get(f"{BASE}/daily-reports?filter[date]={WED}")
        return {row["user"]["name"] for row in res.json()["data"]}

    assert listed("rep") == {"Rep"}
    assert listed("manager") == {"Rep"}
    assert listed("ceo") == {"Rep", "Rep3"}

    team = world.client("manager").get(f"{BASE}/daily-reports/team?date={WED}").json()
    rows = {row["user"]["name"]: row["status"] for row in team["users"]}
    assert rows == {"Manager": "missing", "Rep": "submitted", "Rep2": "missing"}
    assert (team["totals"]["submitted"], team["totals"]["missing"], team["totals"]["people"]) == (1, 2, 3)
    south = world.client("ceo").get(f"{BASE}/daily-reports/team?date={WED}&teamId={world.teams['south'].pk}").json()
    assert {row["user"]["name"]: row["status"] for row in south["users"]} == {
        "Multi Role": "missing",
        "Rep2": "missing",
        "Rep3": "draft",
    }


def test_reminder_once_before_cutoff_and_skipped_when_sales_is_off(world):
    with freeze_time(f"{WED} 10:00:00"):
        r = today(world, "rep")
        act(world, "rep", r["id"], "submit")
    early = dt.datetime(2026, 10, 14, 13, 0, tzinfo=dt.UTC)  # 16:00 local: outside the hour before 18:00
    run_job("sales_report_reminder", workspace_id=world.ws.pk, now=early)
    reminders = Notification.objects.filter(type="sales.dailyreport.reminder")
    assert not reminders.exists()
    at = dt.datetime(2026, 10, 14, 14, 30, tzinfo=dt.UTC)  # 17:30 local
    run_job("sales_report_reminder", workspace_id=world.ws.pk, now=at)
    run_job("sales_report_reminder", workspace_id=world.ws.pk, now=at + dt.timedelta(minutes=15))
    got = list(reminders.values_list("recipient_id", flat=True))
    assert len(got) == len(set(got)) and world.users["rep2"].pk in got
    assert world.users["rep"].pk not in got and world.users["ceo"].pk not in got  # submitted / no submit permission
    count = reminders.count()
    set_module_enabled(world.users["owner"], world.ws, "sales", False)
    result = run_job("sales_report_reminder", workspace_id=world.ws.pk, now=at + dt.timedelta(days=1))
    assert result.count("skipped") == 1 and reminders.count() == count
