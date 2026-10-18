"""Sales KPIs (docs/sales/spec.md §6): the single source of truth for performance, daily reports (S5), dashboards and
reports (S6). Computed from source tables (no rollups); Decimal throughout; all period boundaries in the workspace
time zone (`periods.Period.bounds`).

Every function takes the workspace, a `periods.Period` and the set of user ids the caller may see (usually
`people.visible_user_ids(caller, ws, code)`), so the caller's data scope is applied by the caller:

    k = kpi.compute(ws, period, user_ids)                         # Kpis for the users together
    k = kpi.compute(ws, period, user_ids, target_subject=("team", team_id))   # with the team's own target
    kpi.actual_by_user(ws, period.start, period.end, user_ids)    # {user id: won value}
    kpi.ranking(ws, period, user_ids)                             # one row per user, best first
    kpi.status(actual, target, period, today=..., settings=..., calendar=...)

Attribution: won value and won counts go to `credited_user`; lost deals, leads, new opportunities, the open pipeline
and follow-ups go to the record's `owner`. Percentages are rounded to one decimal, money to cents.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from django.db.models import Count, DecimalField, ExpressionWrapper, F, Sum
from django.db.models.functions import Coalesce

from core.workspaces.timezone import local_date, range_bounds, workspace_today

from .defaults import ensure_defaults
from .models import Lead, Opportunity, PipelineStage
from .periods import DAY, MONTH, QUARTER, WEEK, YEAR, Period
from .targets import CENT, TargetBook, money, subject
from .workdays import ZERO, WorkCalendar

GREEN, YELLOW, RED = "green", "yellow", "red"
TENTH = Decimal("0.1")


def pct(part: Decimal | int | None, whole: Decimal | int | None) -> Decimal | None:
    """part / whole x 100, one decimal; None when whole is None or zero."""
    if part is None or not whole:
        return None
    return (Decimal(part) * 100 / Decimal(whole)).quantize(TENTH, ROUND_HALF_UP)


def _ids(user_ids: Iterable[Any]) -> list[str]:
    return [str(u) for u in user_ids]


# ───────────────────────── actual sales ─────────────────────────


def _won(workspace: Any, start: dt.date, end: dt.date, user_ids: Iterable[Any]) -> Any:
    lo, hi = range_bounds(workspace, start, end)
    return Opportunity.objects.for_workspace(workspace).filter(
        credited_user_id__in=_ids(user_ids),
        won_at__gte=lo,
        won_at__lt=hi,
        won_value__isnull=False,
        stage__category=PipelineStage.WON,
    )


def actual_by_user(workspace: Any, start: dt.date, end: dt.date, user_ids: Iterable[Any]) -> dict[str, Decimal]:
    """Won value per credited user, by won date in [start, end] (workspace time); users without sales are absent."""
    rows = _won(workspace, start, end, user_ids).values("credited_user_id").annotate(total=Sum("won_value"))
    return {str(r["credited_user_id"]): r["total"] for r in rows}


def actual(workspace: Any, start: dt.date, end: dt.date, user_ids: Iterable[Any]) -> Decimal:
    return _won(workspace, start, end, user_ids).aggregate(t=Sum("won_value"))["t"] or ZERO


# ───────────────────────── status colors ─────────────────────────


def status(
    actual_value: Decimal,
    target: Decimal | None,
    period: Period,
    *,
    today: dt.date,
    settings: Any,
    calendar: WorkCalendar,
) -> tuple[str | None, Decimal | None]:
    """(color, expected). Closed periods compare actual with the whole target; the current period with the pro-rata
    expected = target x elapsed working-day weight (today included) / the period's weight. None without a target and
    for future periods; green while nothing is expected yet."""
    if target is None or today < period.start:
        return None, None
    if period.end < today:
        expected = target
    else:
        whole = calendar.total(period.start, period.end)
        expected = target * calendar.total(period.start, today) / whole if whole else target
    if expected <= 0:
        return GREEN, ZERO
    ratio = actual_value * 100 / expected
    if ratio >= settings.status_green_pct:
        color = GREEN
    elif ratio >= settings.status_yellow_pct:
        color = YELLOW
    else:
        color = RED
    return color, expected.quantize(CENT, ROUND_HALF_UP)


# ───────────────────────── all KPIs ─────────────────────────


@dataclass
class Kpis:
    period: Period
    actual: Decimal
    target: Decimal | None
    achievement: Decimal | None
    expected: Decimal | None
    status: str | None
    won_count: int
    lost_count: int
    win_rate: Decimal | None
    average_deal_size: Decimal | None
    new_leads: int
    converted_leads: int
    lead_to_opportunity_rate: Decimal | None
    new_opportunities: int
    pipeline_value: Decimal
    pipeline_value_in_period: Decimal
    weighted_pipeline: Decimal
    pipeline_coverage: Decimal | None
    followups_due: int
    followups_on_time: int
    followup_performance: Decimal | None
    previous_actual: Decimal | None = None
    growth: Decimal | None = None
    previous: Kpis | None = field(default=None, repr=False)


def _pipeline(workspace: Any, period: Period, ids: list[str]) -> tuple[Decimal, Decimal, Decimal]:
    open_ = Opportunity.objects.for_workspace(workspace).filter(owner_id__in=ids, stage__category=PipelineStage.OPEN)
    weighted = ExpressionWrapper(
        F("expected_value") * Coalesce("probability_override", "stage__default_probability") / 100,
        output_field=DecimalField(max_digits=20, decimal_places=4),
    )
    totals = open_.aggregate(value=Sum("expected_value"), weighted=Sum(weighted))
    in_period = open_.filter(expected_close_date__range=(period.start, period.end)).aggregate(v=Sum("expected_value"))
    return (
        totals["value"] or ZERO,
        in_period["v"] or ZERO,
        money(totals["weighted"] or ZERO) or ZERO,
    )


def _followups(workspace: Any, period: Period, ids: list[str]) -> tuple[int, int]:
    """(due in the period and not cancelled, of which completed on or before the due date in workspace time)."""
    from .models import FollowUp

    rows = (
        FollowUp.objects.for_workspace(workspace)
        .filter(owner_id__in=ids, due_date__range=(period.start, period.end))
        .exclude(status=FollowUp.CANCELLED)
        .values_list("status", "due_date", "completed_at")
    )
    due = on_time = 0
    for state, due_date, completed_at in rows:
        due += 1
        if state == FollowUp.DONE and completed_at is not None and local_date(workspace, completed_at) <= due_date:
            on_time += 1
    return due, on_time


def compute(
    workspace: Any,
    period: Period,
    user_ids: Iterable[Any],
    *,
    target_subject: tuple[str, Any] | None = None,
    today: dt.date | None = None,
    book: TargetBook | None = None,
    with_previous: bool = True,
) -> Kpis:
    """Every spec §6 KPI for `user_ids` together in `period`. The target is the sum of the users' own targets, or
    `target_subject`'s (`("team", id)` / `("company", None)`). With `with_previous`, `previous` holds the same KPIs for
    the immediately preceding equal period and `growth` compares the actuals (null when the previous is 0)."""
    ids = _ids(user_ids)
    book = book or TargetBook(workspace)
    settings = book.settings
    today = today or workspace_today(workspace)
    lo, hi = period.bounds(workspace)
    ws_opps = Opportunity.objects.for_workspace(workspace)

    won = _won(workspace, period.start, period.end, ids).aggregate(total=Sum("won_value"), n=Count("id"))
    actual_value: Decimal = won["total"] or ZERO
    won_count = won["n"]
    lost_count = ws_opps.filter(
        owner_id__in=ids, lost_at__gte=lo, lost_at__lt=hi, stage__category=PipelineStage.LOST
    ).count()
    leads = Lead.objects.for_workspace(workspace).filter(owner_id__in=ids)
    new_leads = leads.filter(created_at__gte=lo, created_at__lt=hi).count()
    converted = leads.filter(status=Lead.CONVERTED, converted_at__gte=lo, converted_at__lt=hi).count()
    new_opps = ws_opps.filter(owner_id__in=ids, created_at__gte=lo, created_at__lt=hi).count()
    pipeline_value, pipeline_in_period, weighted = _pipeline(workspace, period, ids)
    due, on_time = _followups(workspace, period, ids)

    if target_subject is not None:
        target = book.for_period(subject(*target_subject), period)
    else:
        target = book.users(ids, period)
    target = money(target)
    color, expected = status(actual_value, target, period, today=today, settings=settings, calendar=book.cal)
    coverage = None if not target else (pipeline_in_period / target).quantize(CENT, ROUND_HALF_UP)

    k = Kpis(
        period=period,
        actual=actual_value,
        target=target,
        achievement=pct(actual_value, target),
        expected=expected,
        status=color,
        won_count=won_count,
        lost_count=lost_count,
        win_rate=pct(won_count, won_count + lost_count),
        average_deal_size=money(actual_value / won_count) if won_count else None,
        new_leads=new_leads,
        converted_leads=converted,
        lead_to_opportunity_rate=pct(converted, new_leads),
        new_opportunities=new_opps,
        pipeline_value=pipeline_value,
        pipeline_value_in_period=pipeline_in_period,
        weighted_pipeline=weighted,
        pipeline_coverage=coverage,
        followups_due=due,
        followups_on_time=on_time,
        followup_performance=pct(on_time, due),
    )
    if with_previous:
        prev = compute(
            workspace,
            period.previous(),
            ids,
            target_subject=target_subject,
            today=today,
            book=book,
            with_previous=False,
        )
        k.previous, k.previous_actual = prev, prev.actual
        k.growth = pct(actual_value - prev.actual, prev.actual)
    return k


def ranking(
    workspace: Any, period: Period, user_ids: Iterable[Any], *, today: dt.date | None = None
) -> list[dict[str, Any]]:
    """One row per user (`userId`, `actual`, `target`, `achievement`, `status`, `wonCount`, `rank`), ordered by
    actual (then achievement, then id); equal actuals share a rank."""
    ids = _ids(user_ids)
    settings = ensure_defaults(workspace)
    book = TargetBook(workspace, settings)
    today = today or workspace_today(workspace)
    won = (
        _won(workspace, period.start, period.end, ids)
        .values("credited_user_id")
        .annotate(total=Sum("won_value"), n=Count("id"))
    )
    by_user = {str(r["credited_user_id"]): (r["total"], r["n"]) for r in won}
    book.users(ids, period)  # prefetch every user's targets in one query
    rows = []
    for uid in ids:
        total, n = by_user.get(uid, (ZERO, 0))
        target = money(book.users([uid], period))
        color, _ = status(total, target, period, today=today, settings=settings, calendar=book.cal)
        rows.append(
            {
                "userId": uid,
                "actual": total,
                "target": target,
                "achievement": pct(total, target),
                "status": color,
                "wonCount": n,
            }
        )
    rows.sort(key=lambda r: (-r["actual"], -(r["achievement"] or Decimal(-1)), r["userId"]))
    return assign_ranks(rows)


def assign_ranks(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ranks sorted rows by `actual` (equal actuals share a rank); call again after filtering rows out."""
    rank, last = 0, None
    for i, row in enumerate(rows, start=1):
        if row["actual"] != last:
            rank, last = i, row["actual"]
        row["rank"] = rank
    return rows


def effective(workspace: Any, user_id: Any, day: dt.date, *, book: TargetBook | None = None) -> dict[str, Any]:
    """The user's day, week, month, quarter and year containing `day`: effective target, actual so far (period start
    through `day`), achievement, and the required daily run rate = (target - actual so far) / remaining working-day
    weight from `day` (included) to the period end; 0 once the target is met, null without a target or working days."""
    book = book or TargetBook(workspace)
    subj = subject("user", user_id)
    out: dict[str, Any] = {}
    for kind in (DAY, WEEK, MONTH, QUARTER, YEAR):
        p = book.period(kind, day)
        target = money(book.for_period(subj, p))
        so_far = actual(workspace, p.start, day, [user_id])
        remaining = book.cal.total(day, p.end)
        rate = None if target is None or not remaining else money(max(target - so_far, ZERO) / remaining)
        out[kind] = {
            "start": p.start,
            "end": p.end,
            "target": target,
            "actual": so_far,
            "achievement": pct(so_far, target),
            "remainingWorkingDays": remaining,
            "requiredDailyRunRate": rate,
        }
    return out
