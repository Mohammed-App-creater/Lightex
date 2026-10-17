"""The sales report engine (S6, docs/sales/spec.md §7, api.md §22): one engine, parameterized by period. Each report
is a small definition (key, title, columns, row builder) on top of `kpi.py` and the selectors; daily, weekly and
monthly reports are the same key with a different period. People come from the caller's `sales.report.view` scope
(`dashboard.people_in_scope`), and every record is attributed as in `kpi.py` (won value to `credited_user`, the rest
to `owner`).

    ctx = Context(ws, period, ids, today=..., book=TargetBook(ws), user=caller)
    report = REPORTS["daily-sales"]; rows = report.build(ctx)
    json_rows(report, rows) / csv_text(report, rows)
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from django.db.models import Count, Sum
from django.utils import timezone

from core.common.csvsafe import csv_document
from core.common.exceptions import invalid
from core.workspaces.timezone import local_date

from . import kpi, people
from . import module as perms
from .dashboard import ranking_rows, sellers
from .models import Activity, FollowUp, Lead, Opportunity, OpportunityStageHistory, PipelineStage, Quotation
from .periods import CUSTOM, DAY, MONTH, YEAR, Period, custom_period
from .pipeline_selectors import weighted_expr, weighted_value, with_flags
from .selectors import stages
from .targets import CENT, TargetBook, money, subject
from .workdays import ZERO

TEXT, DATE, INT, MONEY, PCT = "text", "date", "int", "money", "pct"
TYPES = (TEXT, DATE, INT, MONEY, PCT)
#: Longest custom range, in days.
MAX_CUSTOM_DAYS = 366
#: Period names the API accepts (`today` is the day period).
PERIODS = ("today", "week", "month", "quarter", "year", CUSTOM)


@dataclass
class Context:
    workspace: Any
    period: Period
    ids: set[str]
    today: dt.date
    book: TargetBook
    user: Any = None
    team_id: str | None = None
    user_id: str | None = None
    _names: dict[str, str] = field(default_factory=dict)

    @property
    def settings(self) -> Any:
        return self.book.settings

    def name(self, uid: Any) -> str:
        if not self._names:
            from core.accounts.models import User

            self._names = {str(u.pk): u.name for u in User.objects.filter(pk__in=list(self.ids))}
        return self._names.get(str(uid), "")


Col = tuple[str, str, str]  # key, label, type


@dataclass(frozen=True)
class Report:
    key: str
    title: str
    description: str
    columns: tuple[Col, ...]
    build: Callable[[Context], list[dict[str, Any]]]
    default_period: str = MONTH


# ───────────────────────── helpers ─────────────────────────


def _days(period: Period) -> list[dt.date]:
    return [period.start + dt.timedelta(days=i) for i in range(period.days())]


def buckets(period: Period, grain: str) -> list[Period]:
    """The day or month periods covering `period`, clipped to it."""
    if grain == DAY:
        return [custom_period(d, d, period) for d in _days(period)]
    out, start = [], period.start
    while start <= period.end:
        nxt = (start.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
        out.append(custom_period(start, min(period.end, nxt - dt.timedelta(days=1)), period))
        start = nxt
    return out


def _bounds(ctx: Context) -> tuple[dt.datetime, dt.datetime]:
    return ctx.period.bounds(ctx.workspace)


def _ids(ctx: Context) -> list[str]:
    return sorted(ctx.ids)


def _opps(ctx: Context) -> Any:
    return Opportunity.objects.for_workspace(ctx.workspace)


def _won(ctx: Context) -> Any:
    return kpi._won(ctx.workspace, ctx.period.start, ctx.period.end, _ids(ctx))


def _lost(ctx: Context) -> Any:
    lo, hi = _bounds(ctx)
    return _opps(ctx).filter(
        owner_id__in=_ids(ctx), lost_at__gte=lo, lost_at__lt=hi, stage__category=PipelineStage.LOST
    )


def _open(ctx: Context) -> Any:
    return _opps(ctx).filter(owner_id__in=_ids(ctx), stage__category=PipelineStage.OPEN)


def _by_local_day(ctx: Context, rows: Any) -> dict[dt.date, list[Any]]:
    """Groups (timestamp, *rest) rows by business date."""
    out: dict[dt.date, list[Any]] = defaultdict(list)
    for at, *rest in rows:
        out[local_date(ctx.workspace, at)].append(rest)
    return out


# ───────────────────────── by day ─────────────────────────


def daily_sales(ctx: Context) -> list[dict[str, Any]]:
    by_day = _by_local_day(ctx, _won(ctx).values_list("won_at", "won_value"))
    rows = []
    for day in _days(ctx.period):
        won = by_day.get(day, [])
        actual = sum((v for (v,) in won), ZERO)
        target = money(ctx.book.users(_ids(ctx), custom_period(day, day, ctx.period)))
        rows.append(
            {
                "date": day,
                "wonCount": len(won),
                "actual": actual,
                "target": target,
                "achievement": kpi.pct(actual, target),
            }
        )
    return rows


ACTIVITY_COLUMNS = ("call", "visit", "meeting", "email")


def daily_activity(ctx: Context) -> list[dict[str, Any]]:
    lo, hi = _bounds(ctx)
    ids = _ids(ctx)
    ws = ctx.workspace
    acts = _by_local_day(
        ctx,
        Activity.objects.for_workspace(ws)
        .filter(owner_id__in=ids, occurred_at__gte=lo, occurred_at__lt=hi)
        .values_list("occurred_at", "type"),
    )
    sent = _by_local_day(
        ctx,
        Quotation.objects.for_workspace(ws)
        .filter(owner_id__in=ids, sent_at__gte=lo, sent_at__lt=hi)
        .values_list("sent_at", "id"),
    )
    done = _by_local_day(
        ctx,
        FollowUp.objects.for_workspace(ws)
        .filter(owner_id__in=ids, status=FollowUp.DONE, completed_at__gte=lo, completed_at__lt=hi)
        .values_list("completed_at", "id"),
    )
    leads = _by_local_day(
        ctx,
        Lead.objects.for_workspace(ws)
        .filter(owner_id__in=ids, created_at__gte=lo, created_at__lt=hi)
        .values_list("created_at", "id"),
    )
    opps = _by_local_day(
        ctx, _opps(ctx).filter(owner_id__in=ids, created_at__gte=lo, created_at__lt=hi).values_list("created_at", "id")
    )
    rows = []
    for day in _days(ctx.period):
        types = [t for (t,) in acts.get(day, [])]
        row: dict[str, Any] = {"date": day}
        for t in ACTIVITY_COLUMNS:
            row[f"{t}s"] = types.count(t)
        row["otherActivities"] = sum(1 for t in types if t not in ACTIVITY_COLUMNS)
        row["quotationsSent"] = len(sent.get(day, []))
        row["followUpsCompleted"] = len(done.get(day, []))
        row["newLeads"] = len(leads.get(day, []))
        row["newOpportunities"] = len(opps.get(day, []))
        rows.append(row)
    return rows


# ───────────────────────── by user ─────────────────────────


def _kpi_row(k: kpi.Kpis) -> dict[str, Any]:
    return {
        "actual": k.actual,
        "target": k.target,
        "achievement": k.achievement,
        "status": k.status,
        "wonCount": k.won_count,
        "lostCount": k.lost_count,
        "winRate": k.win_rate,
        "averageDealSize": k.average_deal_size,
        "newLeads": k.new_leads,
        "convertedLeads": k.converted_leads,
        "leadToOpportunityRate": k.lead_to_opportunity_rate,
        "newOpportunities": k.new_opportunities,
        "pipelineValue": k.pipeline_value,
        "weightedPipeline": k.weighted_pipeline,
        "followUpsDue": k.followups_due,
        "followUpsOnTime": k.followups_on_time,
        "followUpPerformance": k.followup_performance,
        "growth": k.growth,
    }


def _busy(row: dict[str, Any]) -> bool:
    keys = ("actual", "wonCount", "lostCount", "newLeads", "newOpportunities", "pipelineValue", "followUpsDue")
    return row["target"] is not None or any(row[k] for k in keys)


def by_user(ctx: Context) -> list[dict[str, Any]]:
    """Every KPI per person (sellers, or anyone with numbers in the period), by name."""
    can_sell = sellers(ctx.workspace, ctx.ids)
    rows = []
    for uid in _ids(ctx):
        k = kpi.compute(ctx.workspace, ctx.period, [uid], today=ctx.today, book=ctx.book)
        row = {"userId": uid, "userName": ctx.name(uid), **_kpi_row(k)}
        if uid in can_sell or _busy(row):
            rows.append(row)
    return sorted(rows, key=lambda r: (r["userName"].lower(), r["userId"]))


def ranking(ctx: Context) -> list[dict[str, Any]]:
    rows = ranking_rows(ctx.workspace, ctx.period, ctx.ids, ctx.today)
    for row in rows:
        row["userName"] = row.pop("user")["name"]
    return rows


# ───────────────────────── by team ─────────────────────────


def by_team(ctx: Context) -> list[dict[str, Any]]:
    from core.teams.models import Team

    team_ids = people.visible_team_ids(ctx.user, ctx.workspace, perms.REPORT_VIEW)
    if ctx.team_id:
        team_ids &= {str(ctx.team_id)}
    rows = []
    for team in Team.objects.for_workspace(ctx.workspace).filter(pk__in=list(team_ids)).order_by("name", "id"):
        members = people.team_member_ids(ctx.workspace, team.pk) & ctx.ids
        if not members:
            continue
        own = ctx.book.for_period(subject("team", team.pk), ctx.period) is not None
        k = kpi.compute(
            ctx.workspace,
            ctx.period,
            members,
            target_subject=("team", team.pk) if own else None,
            today=ctx.today,
            book=ctx.book,
        )
        rows.append({"teamId": str(team.pk), "teamName": team.name, "members": len(members), **_kpi_row(k)})
    return rows


# ───────────────────────── by period bucket ─────────────────────────


def target_vs_actual(ctx: Context) -> list[dict[str, Any]]:
    grain = DAY if ctx.period.days() <= 31 else MONTH
    rows = []
    for b in buckets(ctx.period, grain):
        target = money(ctx.book.users(_ids(ctx), b))
        actual = kpi.actual(ctx.workspace, b.start, b.end, _ids(ctx))
        rows.append(
            {
                "start": b.start,
                "end": b.end,
                "target": target,
                "actual": actual,
                "achievement": kpi.pct(actual, target),
                "variance": None if target is None else actual - target,
            }
        )
    return rows


def by_month(ctx: Context) -> list[dict[str, Any]]:
    rows = []
    for b in buckets(ctx.period, MONTH):
        k = kpi.compute(ctx.workspace, b, ctx.ids, today=ctx.today, book=ctx.book, with_previous=False)
        rows.append({"month": b.start.strftime("%Y-%m"), "start": b.start, "end": b.end, **_kpi_row(k)})
    return rows


def sales_performance(ctx: Context) -> list[dict[str, Any]]:
    """The scope's KPIs as metric rows: current, previous and the change."""
    k = kpi.compute(ctx.workspace, ctx.period, ctx.ids, today=ctx.today, book=ctx.book)
    cur, prev = _kpi_row(k), _kpi_row(k.previous) if k.previous else {}
    rows = []
    for key, label, kind in SALES_METRICS:
        a, b = cur.get(key), prev.get(key)
        change = None
        if kind in (MONEY, INT) and a is not None and b is not None:
            change = kpi.pct(Decimal(a) - Decimal(b), Decimal(b))
        rows.append({"metric": label, "current": _fmt(a, kind), "previous": _fmt(b, kind), "change": change})
    return rows


SALES_METRICS: tuple[Col, ...] = (
    ("actual", "Actual sales", MONEY),
    ("target", "Target", MONEY),
    ("achievement", "Achievement %", PCT),
    ("wonCount", "Won deals", INT),
    ("lostCount", "Lost deals", INT),
    ("winRate", "Conversion rate %", PCT),
    ("averageDealSize", "Average deal size", MONEY),
    ("newLeads", "New leads", INT),
    ("leadToOpportunityRate", "Lead-to-opportunity rate %", PCT),
    ("newOpportunities", "New opportunities", INT),
    ("pipelineValue", "Pipeline value", MONEY),
    ("weightedPipeline", "Weighted pipeline", MONEY),
    ("followUpPerformance", "Follow-up performance %", PCT),
)


# ───────────────────────── by stage, source, product, company, outcome ─────────────────────────


def pipeline_movement(ctx: Context) -> list[dict[str, Any]]:
    lo, hi = _bounds(ctx)
    history = OpportunityStageHistory.objects.for_workspace(ctx.workspace).filter(
        opportunity__owner_id__in=_ids(ctx), opportunity__deleted_at__isnull=True, changed_at__gte=lo, changed_at__lt=hi
    )
    entered = {
        r["to_stage_id"]: r
        for r in history.values("to_stage_id").annotate(n=Count("id"), value=Sum("opportunity__expected_value"))
    }
    left = {r["from_stage_id"]: r["n"] for r in history.values("from_stage_id").annotate(n=Count("id"))}
    rows = []
    for stage in stages(ctx.workspace):
        e = entered.get(stage.pk, {})
        rows.append(
            {
                "stageName": stage.name,
                "category": stage.category,
                "entered": e.get("n", 0),
                "enteredValue": e.get("value") or ZERO,
                "left": left.get(stage.pk, 0),
            }
        )
    return rows


def new_leads(ctx: Context) -> list[dict[str, Any]]:
    lo, hi = _bounds(ctx)
    qs = Lead.objects.for_workspace(ctx.workspace).filter(owner_id__in=_ids(ctx), created_at__gte=lo, created_at__lt=hi)
    found = {r["source"]: r for r in qs.values("source").annotate(n=Count("id"), value=Sum("estimated_value"))}
    status: defaultdict[tuple[str, str], int] = defaultdict(int)
    for source, state in qs.values_list("source", "status"):
        status[(source, state)] += 1
    rows = []
    for source in Lead.SOURCES:
        r = found.get(source)
        if r is None:
            continue
        rows.append(
            {
                "source": source,
                "newLeads": r["n"],
                "open": sum(status[(source, s)] for s in Lead.OPEN_STATUSES),
                "converted": status[(source, Lead.CONVERTED)],
                "disqualified": status[(source, Lead.DISQUALIFIED)],
                "conversionRate": kpi.pct(status[(source, Lead.CONVERTED)], r["n"]),
                "estimatedValue": r["value"] or ZERO,
            }
        )
    return rows


def _group(qs: Any, key: str, name: str, value: str) -> dict[Any, dict[str, Any]]:
    return {r[key]: r for r in qs.values(key, name).annotate(n=Count("id"), total=Sum(value))}


def _grouped(ctx: Context, key: str, name: str, empty: str) -> list[dict[str, Any]]:
    won = _group(_won(ctx), key, name, "won_value")
    lost = _group(_lost(ctx), key, name, "expected_value")
    opened = _group(_open(ctx), key, name, "expected_value")
    rows = []
    for k in set(won) | set(lost) | set(opened):
        w, lo, op = won.get(k, {}), lost.get(k, {}), opened.get(k, {})
        label = (w or lo or op).get(name) or empty
        wc, lc = w.get("n", 0), lo.get("n", 0)
        rows.append(
            {
                "id": str(k) if k else None,
                "name": label,
                "wonCount": wc,
                "wonValue": w.get("total") or ZERO,
                "lostCount": lc,
                "winRate": kpi.pct(wc, wc + lc),
                "openCount": op.get("n", 0),
                "openValue": op.get("total") or ZERO,
            }
        )
    return sorted(rows, key=lambda r: (-r["wonValue"], -r["openValue"], r["name"].lower()))


def by_product(ctx: Context) -> list[dict[str, Any]]:
    return _grouped(ctx, "product_id", "product__name", "No product")


def by_company(ctx: Context) -> list[dict[str, Any]]:
    return _grouped(ctx, "company_id", "company__name", "")


def win_loss(ctx: Context) -> list[dict[str, Any]]:
    won = _won(ctx).aggregate(n=Count("id"), total=Sum("won_value"))
    lost = list(
        _lost(ctx).values("lost_reason__name").annotate(n=Count("id"), total=Sum("expected_value")).order_by("-n")
    )
    closed = won["n"] + sum(r["n"] for r in lost)
    rows = [
        {
            "outcome": "won",
            "reason": "",
            "count": won["n"],
            "value": won["total"] or ZERO,
            "share": kpi.pct(won["n"], closed),
        }
    ]
    for r in lost:
        rows.append(
            {
                "outcome": "lost",
                "reason": r["lost_reason__name"] or "No reason",
                "count": r["n"],
                "value": r["total"] or ZERO,
                "share": kpi.pct(r["n"], closed),
            }
        )
    return rows


def revenue_forecast(ctx: Context) -> list[dict[str, Any]]:
    """Open opportunities expected to close in the period, by month: value and weighted value."""
    rows = []
    for b in buckets(ctx.period, MONTH):
        t = (
            _open(ctx)
            .filter(expected_close_date__range=(b.start, b.end))
            .aggregate(n=Count("id"), value=Sum("expected_value"), weighted=Sum(weighted_expr()))
        )
        rows.append(
            {
                "month": b.start.strftime("%Y-%m"),
                "count": t["n"],
                "value": t["value"] or ZERO,
                "weightedValue": money(t["weighted"]) or ZERO,
            }
        )
    return rows


def pipeline_analysis(ctx: Context) -> list[dict[str, Any]]:
    """The open pipeline now, by stage: size, weighted value, average age and the flags."""
    now = timezone.now()
    stale_before = now - dt.timedelta(days=ctx.settings.stale_days)
    rows = []
    opens = list(with_flags(_open(ctx).select_related("stage")))
    today = ctx.today
    for stage in stages(ctx.workspace).filter(category=PipelineStage.OPEN):
        mine = [o for o in opens if o.stage_id == stage.pk]
        value = sum((o.expected_value for o in mine), ZERO)
        weighted = sum((weighted_value(o) for o in mine), ZERO)
        age = sum((now - o.created_at).days for o in mine)
        rows.append(
            {
                "stageName": stage.name,
                "count": len(mine),
                "value": value,
                "weightedValue": weighted,
                "averageAgeDays": round(age / len(mine)) if mine else None,
                "stale": sum(1 for o in mine if (o.last_activity_at or o.created_at) < stale_before),
                "noNextStep": sum(1 for o in mine if not getattr(o, "has_next_step", False)),
                "overdueClose": sum(1 for o in mine if (o.expected_close_date or today) < today),
            }
        )
    return rows


# ───────────────────────── the catalogue ─────────────────────────

USER: tuple[Col, ...] = (("userId", "User id", TEXT), ("userName", "Salesperson", TEXT))
ACHIEVE: tuple[Col, ...] = (
    ("target", "Target", MONEY),
    ("actual", "Actual", MONEY),
    ("achievement", "Achievement %", PCT),
    ("status", "Status", TEXT),
)
GROUPED: tuple[Col, ...] = (
    ("wonCount", "Won", INT),
    ("wonValue", "Won value", MONEY),
    ("lostCount", "Lost", INT),
    ("winRate", "Conversion rate %", PCT),
    ("openCount", "Open", INT),
    ("openValue", "Open value", MONEY),
)

_REPORTS: tuple[Report, ...] = (
    Report(
        "daily-sales",
        "Daily sales",
        "Won deals and value per day against the day targets.",
        (
            ("date", "Date", DATE),
            ("wonCount", "Won", INT),
            ("actual", "Actual", MONEY),
            ("target", "Target", MONEY),
            ("achievement", "Achievement %", PCT),
        ),
        daily_sales,
    ),
    Report(
        "daily-activity",
        "Daily activity",
        "Calls, visits, meetings, emails, quotations sent, follow-ups completed, new leads and opportunities per day.",
        (
            ("date", "Date", DATE),
            ("calls", "Calls", INT),
            ("visits", "Visits", INT),
            ("meetings", "Meetings", INT),
            ("emails", "Emails", INT),
            ("otherActivities", "Other activities", INT),
            ("quotationsSent", "Quotations sent", INT),
            ("followUpsCompleted", "Follow-ups completed", INT),
            ("newLeads", "New leads", INT),
            ("newOpportunities", "New opportunities", INT),
        ),
        daily_activity,
        DAY,
    ),
    Report(
        "target-achievement",
        "Target achievement",
        "Each salesperson's target, actual sales, achievement and status color.",
        (("rank", "Rank", INT), *USER, *ACHIEVE),
        ranking,
    ),
    Report(
        "salesperson-performance",
        "Salesperson performance",
        "Every KPI per salesperson.",
        (
            *USER,
            *ACHIEVE,
            ("wonCount", "Won", INT),
            ("lostCount", "Lost", INT),
            ("winRate", "Conversion rate %", PCT),
            ("averageDealSize", "Average deal size", MONEY),
            ("newLeads", "New leads", INT),
            ("newOpportunities", "New opportunities", INT),
            ("pipelineValue", "Pipeline value", MONEY),
            ("followUpPerformance", "Follow-up performance %", PCT),
            ("growth", "Growth %", PCT),
        ),
        by_user,
    ),
    Report(
        "pipeline-movement",
        "Pipeline movement",
        "Opportunities entering and leaving each stage in the period.",
        (
            ("stageName", "Stage", TEXT),
            ("category", "Category", TEXT),
            ("entered", "Entered", INT),
            ("enteredValue", "Entered value", MONEY),
            ("left", "Left", INT),
        ),
        pipeline_movement,
    ),
    Report(
        "new-leads",
        "New leads",
        "Leads created in the period by source, with where they are now.",
        (
            ("source", "Source", TEXT),
            ("newLeads", "New leads", INT),
            ("open", "Open", INT),
            ("converted", "Converted", INT),
            ("disqualified", "Disqualified", INT),
            ("conversionRate", "Conversion %", PCT),
            ("estimatedValue", "Estimated value", MONEY),
        ),
        new_leads,
    ),
    Report(
        "conversion",
        "Conversion",
        "Lead-to-opportunity and win rates per salesperson.",
        (
            *USER,
            ("newLeads", "New leads", INT),
            ("convertedLeads", "Converted leads", INT),
            ("leadToOpportunityRate", "Lead-to-opportunity %", PCT),
            ("newOpportunities", "New opportunities", INT),
            ("wonCount", "Won", INT),
            ("lostCount", "Lost", INT),
            ("winRate", "Conversion rate %", PCT),
        ),
        by_user,
    ),
    Report(
        "followup-performance",
        "Follow-up performance",
        "Follow-ups due in the period and how many were completed on time, per salesperson.",
        (
            *USER,
            ("followUpsDue", "Due", INT),
            ("followUpsOnTime", "On time", INT),
            ("followUpPerformance", "On time %", PCT),
        ),
        by_user,
    ),
    Report(
        "sales-performance",
        "Sales performance",
        "The KPIs of everyone in scope against the previous equal period.",
        (
            ("metric", "Metric", TEXT),
            ("current", "Current", TEXT),
            ("previous", "Previous", TEXT),
            ("change", "Change %", PCT),
        ),
        sales_performance,
    ),
    Report(
        "target-vs-actual",
        "Target vs actual",
        "Target and actual per day (periods up to 31 days) or per month.",
        (
            ("start", "From", DATE),
            ("end", "To", DATE),
            ("target", "Target", MONEY),
            ("actual", "Actual", MONEY),
            ("achievement", "Achievement %", PCT),
            ("variance", "Variance", MONEY),
        ),
        target_vs_actual,
    ),
    Report(
        "ranking",
        "Ranking",
        "Salespeople ranked by actual sales.",
        (
            ("rank", "Rank", INT),
            *USER,
            ("actual", "Actual", MONEY),
            ("wonCount", "Won", INT),
            ("achievement", "Achievement %", PCT),
            ("status", "Status", TEXT),
        ),
        ranking,
    ),
    Report(
        "product-performance",
        "Product performance",
        "Won, lost and open deals per product.",
        (("id", "Product id", TEXT), ("name", "Product", TEXT), *GROUPED),
        by_product,
    ),
    Report(
        "customer-performance",
        "Customer performance",
        "Won, lost and open deals per company.",
        (("id", "Company id", TEXT), ("name", "Company", TEXT), *GROUPED),
        by_company,
    ),
    Report(
        "win-loss",
        "Win / loss",
        "Deals closed in the period: won, and lost by reason.",
        (
            ("outcome", "Outcome", TEXT),
            ("reason", "Lost reason", TEXT),
            ("count", "Deals", INT),
            ("value", "Value", MONEY),
            ("share", "Share %", PCT),
        ),
        win_loss,
    ),
    Report(
        "revenue-forecast",
        "Revenue forecast",
        "Open pipeline and weighted pipeline by expected close month.",
        (
            ("month", "Month", TEXT),
            ("count", "Opportunities", INT),
            ("value", "Value", MONEY),
            ("weightedValue", "Weighted value", MONEY),
        ),
        revenue_forecast,
        "quarter",
    ),
    Report(
        "pipeline-analysis",
        "Pipeline analysis",
        "The open pipeline now by stage: size, weighted value, age and flags (the period is ignored).",
        (
            ("stageName", "Stage", TEXT),
            ("count", "Opportunities", INT),
            ("value", "Value", MONEY),
            ("weightedValue", "Weighted value", MONEY),
            ("averageAgeDays", "Average age (days)", INT),
            ("stale", "Stale", INT),
            ("noNextStep", "No next step", INT),
            ("overdueClose", "Overdue close", INT),
        ),
        pipeline_analysis,
    ),
    Report(
        "team-performance",
        "Team performance",
        "Each visible team's target (its own, else its members'), actual and KPIs.",
        (
            ("teamId", "Team id", TEXT),
            ("teamName", "Team", TEXT),
            ("members", "Members", INT),
            *ACHIEVE,
            ("wonCount", "Won", INT),
            ("winRate", "Conversion rate %", PCT),
            ("newLeads", "New leads", INT),
            ("pipelineValue", "Pipeline value", MONEY),
        ),
        by_team,
    ),
    Report(
        "annual-summary",
        "Annual summary",
        "Month by month over the period (the fiscal year by default).",
        (
            ("month", "Month", TEXT),
            ("start", "From", DATE),
            ("end", "To", DATE),
            *ACHIEVE,
            ("wonCount", "Won", INT),
            ("lostCount", "Lost", INT),
            ("newLeads", "New leads", INT),
            ("newOpportunities", "New opportunities", INT),
        ),
        by_month,
        YEAR,
    ),
)

REPORTS: dict[str, Report] = {r.key: r for r in _REPORTS}


# ───────────────────────── periods ─────────────────────────


def _parse_date(raw: str | None, name: str) -> dt.date | None:
    if not raw:
        return None
    try:
        return dt.date.fromisoformat(raw)
    except ValueError:
        raise invalid({name: "Use YYYY-MM-DD"}) from None


def parse_period(params: Any, book: TargetBook, today: dt.date, default: str = MONTH, *, custom: bool = True) -> Period:
    """`period` (today, week, month, quarter, year, or custom with `from` and `to`), anchored on `date` (default
    today, workspace time). `from`/`to` without `period` mean custom. Custom ranges span at most 366 days."""
    kind = params.get("period") or (CUSTOM if custom and (params.get("from") or params.get("to")) else default)
    kind = DAY if kind in ("today", DAY) else kind
    if kind == CUSTOM and custom:
        start, end = _parse_date(params.get("from"), "from"), _parse_date(params.get("to"), "to")
        if start is None or end is None:
            raise invalid({"from" if start is None else "to": "A custom period needs both from and to"})
        if end < start:
            raise invalid({"to": "to must not be before from"})
        if (end - start).days + 1 > MAX_CUSTOM_DAYS:
            raise invalid({"to": f"A custom period spans at most {MAX_CUSTOM_DAYS} days"})
        return custom_period(start, end, book.settings)
    allowed = PERIODS if custom else PERIODS[:-1]
    if kind not in (DAY, "week", MONTH, "quarter", YEAR):
        raise invalid({"period": f"Use one of {', '.join(allowed)}"})
    return book.period(kind, _parse_date(params.get("date"), "date") or today)


# ───────────────────────── output ─────────────────────────


def _fmt(value: Any, kind: str) -> str | None:
    """A value as a string: money with two places, percentages with one, dates ISO; None stays None."""
    if value is None:
        return None
    if kind == MONEY:
        return str(Decimal(value).quantize(CENT, ROUND_HALF_UP))
    if kind == PCT:
        return str(Decimal(value).quantize(kpi.TENTH, ROUND_HALF_UP))
    if isinstance(value, dt.date):
        return value.isoformat()
    return str(value)


def json_rows(report: Report, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows for JSON: money as decimal strings, percentages as numbers, dates ISO, counts as integers."""
    out = []
    for row in rows:
        item: dict[str, Any] = {}
        for key, _, kind in report.columns:
            v = row.get(key)
            if v is None or kind in (INT,):
                item[key] = v
            elif kind == PCT:
                item[key] = float(Decimal(v).quantize(kpi.TENTH, ROUND_HALF_UP))
            elif kind in (MONEY, DATE):
                item[key] = _fmt(v, kind)
            else:
                item[key] = v if isinstance(v, str) else str(v)
        out.append(item)
    return out


def csv_text(report: Report, rows: list[dict[str, Any]]) -> str:
    """The report as a formula-safe CSV document (header row of labels)."""
    lines: list[list[Any]] = [[label for _, label, _ in report.columns]]
    for row in rows:
        lines.append([_fmt(row.get(key), kind) or "" for key, _, kind in report.columns])
    return csv_document(lines)


def catalogue() -> list[dict[str, Any]]:
    return [
        {
            "key": r.key,
            "title": r.title,
            "description": r.description,
            "defaultPeriod": "today" if r.default_period == DAY else r.default_period,
            "periods": list(PERIODS),
            "columns": [{"key": k, "label": label, "type": t} for k, label, t in r.columns],
        }
        for r in _REPORTS
    ]
