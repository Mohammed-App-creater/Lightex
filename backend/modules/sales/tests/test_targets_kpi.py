"""S4: targets (allocation, effective targets, scope), the KPI service and performance (spec §12)."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal as D

import pytest
from django.urls import reverse

from modules.sales import kpi
from modules.sales.defaults import ensure_defaults
from modules.sales.models import Holiday, Lead, Opportunity, PipelineStage, SalesCalendar, Target
from modules.sales.periods import MONTH, period_containing
from modules.sales.targets import TargetBook, subject

pytestmark = pytest.mark.django_db

UTC = dt.UTC


def _target(w, actor, period_type, start, amount, kind="user"):
    sid = None if kind == "company" else w.users[actor].pk
    return Target.objects.create(
        workspace=w.ws, subject_type=kind, subject_id=sid, period_type=period_type, period_start=start, amount=amount
    )


def _deal(w, actor, category, value, at=None, close=None):
    ensure_defaults(w.ws)
    stage = PipelineStage.objects.for_workspace(w.ws).filter(category=category).first()
    user = w.users[actor]
    opp = Opportunity.objects.create(
        workspace=w.ws,
        owner=user,
        company=w.companies["rep"],
        title="Deal",
        stage=stage,
        expected_value=value,
        expected_close_date=close,
    )
    if category == "won":
        opp.won_at, opp.won_value, opp.credited_user = at, value, user
    elif category == "lost":
        opp.lost_at = at
    opp.save()
    return opp


def _at(day: str) -> dt.datetime:
    return dt.datetime.fromisoformat(f"{day}T09:00:00").replace(tzinfo=UTC)


# ───────────────────────── KPIs ─────────────────────────


def test_kpis_fixed_dataset(world):
    ensure_defaults(world.ws)
    rep = str(world.users["rep"].pk)
    sept = period_containing(MONTH, dt.date(2026, 9, 1))
    _target(world, "rep", "month", sept.start, D("10000"))
    _deal(world, "rep", "won", D("3000"), _at("2026-09-10"))
    _deal(world, "rep", "won", D("5000"), _at("2026-09-20"))
    _deal(world, "rep", "lost", D("900"), _at("2026-09-21"))
    _deal(world, "rep", "won", D("2000"), _at("2026-08-15"))  # previous period
    _deal(world, "rep", "open", D("6000"), close=dt.date(2026, 9, 25))  # first open stage: 20 %
    _deal(world, "rep", "open", D("1000"), close=dt.date(2026, 12, 1))
    leads = [Lead.objects.create(workspace=world.ws, owner=world.users["rep"], contact_name=f"L{i}") for i in range(4)]
    Lead.objects.filter(pk__in=[x.pk for x in leads]).update(created_at=_at("2026-09-05"))
    Lead.objects.filter(pk=leads[0].pk).update(status="converted", converted_at=_at("2026-09-06"))

    k = kpi.compute(world.ws, sept, [rep], today=dt.date(2026, 10, 17))
    assert k.actual == D("8000") and k.target == D("10000.00")
    assert k.achievement == D("80.0")
    assert (k.won_count, k.lost_count, k.win_rate) == (2, 1, D("66.7"))
    assert k.average_deal_size == D("4000.00")
    assert (k.new_leads, k.converted_leads, k.lead_to_opportunity_rate) == (4, 1, D("25.0"))
    assert (k.pipeline_value, k.pipeline_value_in_period) == (D("7000"), D("6000"))
    assert k.weighted_pipeline == D("1400.00")
    assert k.pipeline_coverage == D("0.60")
    assert k.previous_actual == D("2000") and k.growth == D("300.0")
    assert k.status == kpi.YELLOW  # closed: 80 % against green 100 / yellow 70

    aug = kpi.compute(world.ws, sept.previous(), [rep], today=dt.date(2026, 10, 17))
    assert aug.previous_actual == 0 and aug.growth is None  # zero previous
    assert aug.target is None and aug.achievement is None and aug.status is None


def test_status_closed_vs_in_progress(world):
    ensure_defaults(world.ws)
    oct_ = period_containing(MONTH, dt.date(2026, 10, 1))
    _target(world, "rep", "month", oct_.start, D("2200"))  # 22 working days
    _deal(world, "rep", "won", D("1300"), _at("2026-10-05"))
    rep = [str(world.users["rep"].pk)]
    # 17 Oct: 12 of 22 working days elapsed → expected 1200; 1300 is ahead although only 59 % achieved.
    k = kpi.compute(world.ws, oct_, rep, today=dt.date(2026, 10, 17), with_previous=False)
    assert k.achievement == D("59.1") and k.expected == D("1200.00") and k.status == kpi.GREEN
    closed = kpi.compute(world.ws, oct_, rep, today=dt.date(2026, 11, 2), with_previous=False)
    assert closed.status == kpi.RED


# ───────────────────────── effective targets ─────────────────────────


@pytest.fixture
def june_calendar(world):
    ensure_defaults(world.ws)
    SalesCalendar.objects.for_workspace(world.ws).update(saturday=D("0.5"))
    Holiday.objects.create(workspace=world.ws, date=dt.date(2026, 6, 10), name="Holiday")
    # June 2026: 22 weekdays + 4 half Saturdays - 1 holiday = 23; July: 23 weekdays + 4 halves = 25.
    _target(world, "rep", "month", dt.date(2026, 6, 1), D("2300"))
    _target(world, "rep", "month", dt.date(2026, 7, 1), D("2500"))
    return world


def test_day_targets_with_holidays_and_half_days(june_calendar):
    w = june_calendar
    book = TargetBook(w.ws)
    subj = subject("user", w.users["rep"].pk)
    day = lambda d: book.range(subj, d, d)  # noqa: E731
    assert day(dt.date(2026, 6, 11)) == D("100")
    assert day(dt.date(2026, 6, 13)) == D("50")  # half-day Saturday
    assert day(dt.date(2026, 6, 10)) == 0  # holiday
    assert day(dt.date(2026, 6, 14)) == 0  # Sunday


def test_week_spanning_two_months(june_calendar):
    w = june_calendar
    week = period_containing("week", dt.date(2026, 7, 1))
    assert (week.start, week.end) == (dt.date(2026, 6, 29), dt.date(2026, 7, 5))
    target = TargetBook(w.ws).for_period(subject("user", w.users["rep"].pk), week)
    assert target.quantize(D("0.01")) == D("550.00")  # 100 + 100 + 3 x 100 + 50 + 0


def test_effective_and_run_rate(june_calendar):
    w = june_calendar
    _deal(w, "rep", "won", D("300"), _at("2026-06-02"))
    res = w.client("manager").get(
        reverse("sales-targets-effective", kwargs={"slug": w.ws.slug}),
        {"userId": str(w.users["rep"].pk), "date": "2026-06-11"},
    )
    assert res.status_code == 200, res.content
    month = res.json()["month"]
    assert month["target"] == "2300.00" and month["actual"] == "300.00"
    # Remaining weight 11–30 June = 23 - 7.5 = 15.5 → (2300 - 300) / 15.5
    assert month["remainingWorkingDays"] == 15.5 and month["requiredDailyRunRate"] == "129.03"
    assert res.json()["day"]["target"] == "100.00"
    other = w.client("rep").get(
        reverse("sales-targets-effective", kwargs={"slug": w.ws.slug}), {"userId": str(w.users["rep3"].pk)}
    )
    assert other.status_code == 404


# ───────────────────────── writes and allocation ─────────────────────────


def _set(w, actor, body):
    return w.client(actor).post(reverse("sales-targets", kwargs={"slug": w.ws.slug}), body, format="json")


def _allocate(w, actor, body):
    return w.client(actor).post(reverse("sales-targets-allocate", kwargs={"slug": w.ws.slug}), body, format="json")


def test_upsert_scope_and_events(world):
    from core.audit.models import AuditLog
    from core.events.models import DomainEvent

    rep = str(world.users["rep"].pk)
    body = {"subjectType": "user", "subjectId": rep, "periodType": "month", "periodStart": "2026-11-01"}
    assert _set(world, "manager", {**body, "amount": "500"}).status_code == 201
    res = _set(world, "manager", {**body, "amount": "700"})
    assert res.status_code == 200 and res.json()["amount"] == "700.00" and res.json()["periodEnd"] == "2026-11-30"
    assert Target.objects.for_workspace(world.ws).count() == 1
    assert DomainEvent.objects.filter(type="sales.target.changed").count() == 2
    assert AuditLog.objects.filter(action="sales.target.set").count() == 2
    assert _set(world, "manager", {**body, "periodStart": "2026-11-02", "amount": "1"}).status_code == 422
    rep3 = {**body, "subjectId": str(world.users["rep3"].pk), "amount": "1"}
    assert _set(world, "manager", rep3).status_code == 403  # not a team-mate
    company = {"subjectType": "company", "periodType": "year", "periodStart": "2026-01-01", "amount": "9"}
    assert _set(world, "manager", company).status_code == 403
    assert _set(world, "ceo", company).status_code == 201
    team = {"subjectType": "team", "subjectId": str(world.teams["north"].pk), "periodType": "year"}
    assert _set(world, "manager", {**team, "periodStart": "2026-01-01", "amount": "5"}).status_code == 201


def test_allocate_equal_and_working_days(world):
    rep = str(world.users["rep"].pk)
    _target(world, "rep", "year", dt.date(2026, 1, 1), D("1200"))
    base = {"subjectType": "user", "subjectId": rep, "year": 2026}
    res = _allocate(world, "manager", {**base, "method": "equal"})
    assert res.status_code == 200, res.content
    data = res.json()
    assert [q["amount"] for q in data["quarters"]] == ["300.00"] * 4
    assert {m["amount"] for q in data["quarters"] for m in q["months"]} == {"100.00"}
    assert data["quarterGap"] == "0.00" and data["monthGap"] == "0.00"

    res = _allocate(world, "manager", {**base, "method": "working_days"})
    data = res.json()
    months = [D(m["amount"]) for q in data["quarters"] for m in q["months"]]
    assert sum(months) == D("1200") and data["monthGap"] == "0.00"
    assert months[1] < months[2]  # February has fewer working days than March
    q1 = data["quarters"][0]
    assert sum(D(m["amount"]) for m in q1["months"]) == D(q1["amount"])


def test_allocate_manual_reports_gaps(world):
    rep = str(world.users["rep"].pk)
    _target(world, "rep", "year", dt.date(2026, 1, 1), D("1200"))
    body = {"subjectType": "user", "subjectId": rep, "year": 2026, "method": "manual", "months": ["90"] * 12}
    data = _allocate(world, "manager", body).json()
    assert data["monthGap"] == "120.00" and data["quarterGap"] is None
    tree = world.client("manager").get(
        reverse("sales-targets-allocation", kwargs={"slug": world.ws.slug}),
        {"subject": f"team:{world.teams['north'].pk}", "year": 2026},
    )
    assert tree.status_code == 200, tree.content
    users = {c["name"]: c for c in tree.json()["children"]}
    assert users["Rep"]["target"] == "1200.00" and users["Rep"]["monthGap"] == "120.00"
    assert tree.json()["allocated"] == "1200.00" and tree.json()["target"] is None


def test_fiscal_year_not_january(world):
    from modules.sales.models import SalesSettings

    ensure_defaults(world.ws)
    SalesSettings.objects.for_workspace(world.ws).update(fiscal_year_start_month=7)
    rep = str(world.users["rep"].pk)
    year = {"subjectType": "user", "subjectId": rep, "periodType": "year", "amount": "1200"}
    assert _set(world, "manager", {**year, "periodStart": "2026-01-01"}).status_code == 422
    assert _set(world, "manager", {**year, "periodStart": "2026-07-01"}).status_code == 201
    quarter = {"subjectType": "user", "subjectId": rep, "periodType": "quarter", "amount": "1"}
    assert _set(world, "manager", {**quarter, "periodStart": "2026-08-01"}).status_code == 422
    data = _allocate(world, "manager", {"subjectType": "user", "subjectId": rep, "year": 2026, "method": "equal"})
    starts = [q["start"] for q in data.json()["quarters"]]
    assert starts == ["2026-07-01", "2026-10-01", "2027-01-01", "2027-04-01"]
    assert data.json()["end"] == "2027-06-30"


# ───────────────────────── performance ─────────────────────────


def test_ranking_scope(world):
    _deal(world, "rep", "won", D("500"), _at("2026-10-05"))
    _deal(world, "rep3", "won", D("900"), _at("2026-10-06"))
    url = reverse("sales-performance-ranking", kwargs={"slug": world.ws.slug})
    q = {"period": "month", "date": "2026-10-10"}
    names = lambda actor: [r["user"]["name"] for r in world.client(actor).get(url, q).json()["rows"]]  # noqa: E731
    manager = names("manager")
    assert manager[0] == "Rep" and "Rep3" not in manager  # North only
    assert names("rep") == ["Rep"]
    admin = world.client("sales_admin").get(url, q).json()["rows"]
    assert [r["user"]["name"] for r in admin[:2]] == ["Rep3", "Rep"] and admin[0]["rank"] == 1
    user = reverse("sales-performance-user", kwargs={"slug": world.ws.slug, "user_id": world.users["rep3"].pk})
    assert world.client("manager").get(user).status_code == 404
    res = world.client("sales_admin").get(user, q)
    assert res.status_code == 200 and res.json()["current"]["actual"] == "900.00"
