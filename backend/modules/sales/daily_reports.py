"""Sales daily reports (S5, docs/sales/spec.md §4–§5, api.md §20): one report per user and business date.

Lifecycle: `draft` (created on demand by `today_report`; metrics computed live) → `submit` (metrics frozen into
`snapshot`, `is_late` when submitted after the cutoff of the report date in workspace time) → `review` (locks it) or
`reopen` (back to a draft, by a reviewer). The author edits only comments and tomorrow's plan, until it is reviewed.

Reusable pieces (S6, the management daily report):

    metrics_for(ws, day, user_ids)      # {user id: metrics dict} for one business date, a few grouped queries
    report_metrics(report)              # the snapshot once submitted, else live
    is_required(ws, day)                # setting on and a working day (weight > 0, not a holiday)
    submitters(ws)                      # active members holding sales.dailyreport.submit
    team_report(user, ws, day, team_id) # every visible submitter with their report, plus totals

Metrics are JSON-ready (money and percentages as strings) so a snapshot and a live draft look the same.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone

from core.access import services as access
from core.common.exceptions import conflict, forbidden
from core.events.services import emit
from core.workspaces.timezone import day_bounds, workspace_now, workspace_today, workspace_zone

from . import kpi, people, scope
from . import module as perms
from .defaults import ensure_defaults
from .models import Activity, DailyReport, FollowUp, Lead, Opportunity, PipelineStage, Quotation
from .periods import DAY
from .services import _audit
from .targets import TargetBook, money
from .workdays import WorkCalendar

NOT_FOUND = "Daily report not found."
SUBMITTED_EVENT = "sales.dailyreport.submitted"
REVIEWED_EVENT = "sales.dailyreport.reviewed"
REMINDER_EVENT = "sales.dailyreport.reminder"
REMINDER_JOB = "sales_report_reminder"
#: The reminder goes out in the hour before the cutoff.
REMINDER_LEAD = dt.timedelta(hours=1)

COUNTS = (
    "newLeads",
    "calls",
    "visits",
    "meetings",
    "quotationsSent",
    "followUpsCompleted",
    "newOpportunities",
    "dealsWon",
    "dealsLost",
)


def _s(v: Decimal | None) -> str | None:
    return None if v is None else str(v)


# ───────────────────────── calendar ─────────────────────────


def is_working_day(workspace: Any, day: dt.date, cal: WorkCalendar | None = None) -> bool:
    return (cal or WorkCalendar(workspace)).weight(day) > 0


def is_required(workspace: Any, day: dt.date, *, settings: Any = None, cal: WorkCalendar | None = None) -> bool:
    settings = settings or ensure_defaults(workspace)
    return bool(settings.daily_report_required) and is_working_day(workspace, day, cal)


def cutoff_at(workspace: Any, day: dt.date, settings: Any = None) -> dt.datetime:
    settings = settings or ensure_defaults(workspace)
    return dt.datetime.combine(day, settings.daily_report_cutoff, tzinfo=workspace_zone(workspace))


# ───────────────────────── metrics ─────────────────────────


def _by(qs: Any, field: str) -> dict[str, int]:
    return {str(r[field]): r["n"] for r in qs.values(field).annotate(n=Count("id")).order_by()}


def metrics_for(
    workspace: Any, day: dt.date, user_ids: Any, *, book: TargetBook | None = None
) -> dict[str, dict[str, Any]]:
    """The spec §5 metrics of each user for business date `day`: today's (effective) target, sales (won value credited
    to them), achievement, and the counts. Attribution follows `kpi.py`: won to `credited_user`, the rest to `owner`."""
    ids = [str(u) for u in user_ids]
    if not ids:
        return {}
    lo, hi = day_bounds(workspace, day)
    book = book or TargetBook(workspace)
    period = book.period(DAY, day)
    owned = {"owner_id__in": ids}
    acts = (
        Activity.objects.for_workspace(workspace)
        .filter(
            **owned, occurred_at__gte=lo, occurred_at__lt=hi, type__in=(Activity.CALL, Activity.VISIT, Activity.MEETING)
        )
        .values("owner_id", "type")
        .annotate(n=Count("id"))
        .order_by()
    )
    by_type: dict[tuple[str, str], int] = {(str(r["owner_id"]), r["type"]): r["n"] for r in acts}
    opps = Opportunity.objects.for_workspace(workspace)
    won_rows = (
        opps.filter(
            credited_user_id__in=ids,
            won_at__gte=lo,
            won_at__lt=hi,
            won_value__isnull=False,
            stage__category=PipelineStage.WON,
        )
        .values("credited_user_id")
        .annotate(n=Count("id"), total=Sum("won_value"))
        .order_by()
    )
    won = {str(r["credited_user_id"]): (r["n"], r["total"]) for r in won_rows}
    counts = {
        "newLeads": _by(
            Lead.objects.for_workspace(workspace).filter(**owned, created_at__gte=lo, created_at__lt=hi), "owner_id"
        ),
        "quotationsSent": _by(
            Quotation.objects.for_workspace(workspace).filter(**owned, sent_at__gte=lo, sent_at__lt=hi), "owner_id"
        ),
        "followUpsCompleted": _by(
            FollowUp.objects.for_workspace(workspace).filter(
                **owned, status=FollowUp.DONE, completed_at__gte=lo, completed_at__lt=hi
            ),
            "owner_id",
        ),
        "newOpportunities": _by(opps.filter(**owned, created_at__gte=lo, created_at__lt=hi), "owner_id"),
        "dealsLost": _by(
            opps.filter(**owned, lost_at__gte=lo, lost_at__lt=hi, stage__category=PipelineStage.LOST), "owner_id"
        ),
    }
    book.users(ids, period)  # prefetch every user's targets
    out: dict[str, dict[str, Any]] = {}
    for uid in ids:
        n_won, total = won.get(uid, (0, None))
        sales = money(total or Decimal("0"))
        target = money(book.users([uid], period))
        out[uid] = {
            "target": _s(target),
            "sales": _s(sales),
            "achievement": _s(kpi.pct(sales, target)),
            "newLeads": counts["newLeads"].get(uid, 0),
            "calls": by_type.get((uid, Activity.CALL), 0),
            "visits": by_type.get((uid, Activity.VISIT), 0),
            "meetings": by_type.get((uid, Activity.MEETING), 0),
            "quotationsSent": counts["quotationsSent"].get(uid, 0),
            "followUpsCompleted": counts["followUpsCompleted"].get(uid, 0),
            "newOpportunities": counts["newOpportunities"].get(uid, 0),
            "dealsWon": n_won,
            "dealsLost": counts["dealsLost"].get(uid, 0),
        }
    return out


def report_metrics(report: DailyReport) -> dict[str, Any]:
    if report.status != DailyReport.DRAFT and report.snapshot:
        return report.snapshot
    return metrics_for(report.workspace, report.report_date, [report.user_id])[str(report.user_id)]


def metrics_of(reports: list[DailyReport]) -> dict[str, dict[str, Any]]:
    """{report id: metrics} for a page of reports: snapshots, and one `metrics_for` per date for the drafts."""
    out: dict[str, dict[str, Any]] = {}
    drafts: dict[tuple[Any, dt.date], list[DailyReport]] = {}
    for r in reports:
        if r.status != DailyReport.DRAFT and r.snapshot:
            out[str(r.pk)] = r.snapshot
        else:
            drafts.setdefault((r.workspace_id, r.report_date), []).append(r)
    for (_, day), rows in drafts.items():
        live = metrics_for(rows[0].workspace, day, [r.user_id for r in rows])
        for r in rows:
            out[str(r.pk)] = live[str(r.user_id)]
    return out


# ───────────────────────── reads ─────────────────────────


def reports_for(user: Any, workspace: Any) -> Any:
    return scope.visible(DailyReport.objects.for_workspace(workspace), user, perms.DAILYREPORT_VIEW, workspace)


def submitters(workspace: Any) -> list[Any]:
    """Active members holding `sales.dailyreport.submit` (the people expected to report)."""
    from core.workspaces.models import WorkspaceMember

    rows = WorkspaceMember.objects.for_workspace(workspace).filter(status="active", user__is_active=True)
    return [m.user for m in rows.select_related("user") if access.can(m.user, perms.DAILYREPORT_SUBMIT, workspace)]


def _label(report: DailyReport) -> str:
    name = getattr(report.user, "name", "") or ""
    return f"Daily report {report.report_date.isoformat()} {name}".strip()


# ───────────────────────── writes ─────────────────────────


def today_report(user: Any, workspace: Any, *, now: dt.datetime | None = None) -> DailyReport:
    """The caller's report for today (workspace time), created as a draft on first read."""
    day = workspace_today(workspace, now)
    qs = DailyReport.objects.for_workspace(workspace).select_related("workspace", "user")
    found = qs.filter(user=user, report_date=day).first()
    if found is not None:
        return found
    try:
        with transaction.atomic():
            report = DailyReport.objects.create(workspace=workspace, user=user, report_date=day)
            _audit(user, workspace, "sales.dailyreport.created", report, _label(report))
    except IntegrityError:  # a concurrent first read created it
        return qs.get(user=user, report_date=day)
    return report


def _own(actor: Any, report: DailyReport) -> None:
    if str(report.user_id) != str(actor.pk):
        raise forbidden("Only the author can change a daily report.", {"permission": perms.DAILYREPORT_SUBMIT})


@transaction.atomic
def update_report(actor: Any, report: DailyReport, data: dict[str, Any]) -> DailyReport:
    """Comments and tomorrow's plan only; refused once reviewed (409 `report_reviewed`)."""
    _own(actor, report)
    report = DailyReport.objects.select_for_update().select_related("workspace", "user").get(pk=report.pk)
    if report.status == DailyReport.REVIEWED:
        raise conflict("report_reviewed", "This report has been reviewed; ask the reviewer to reopen it.")
    changed = []
    if "comments" in data:
        report.comments = list(data["comments"])
        changed.append("comments")
    if "tomorrowPlan" in data:
        report.tomorrow_plan = [
            {k: (str(v) if k == "targetId" else v) for k, v in item.items() if v not in (None, "")}
            for item in data["tomorrowPlan"]
        ]
        changed.append("tomorrow_plan")
    if changed:
        report.save(update_fields=[*changed, "updated_at"])
        _audit(actor, report.workspace_id, "sales.dailyreport.updated", report, _label(report))
    return report


@transaction.atomic
def submit(actor: Any, report: DailyReport, *, now: dt.datetime | None = None) -> DailyReport:
    """Freezes the metrics, sets `is_late` (after the report date's cutoff, workspace time) and emits the event.
    Only drafts (409 `report_submitted` otherwise)."""
    _own(actor, report)
    report = DailyReport.objects.select_for_update().select_related("workspace", "user").get(pk=report.pk)
    if report.status != DailyReport.DRAFT:
        raise conflict("report_submitted", "This report is already submitted.")
    ws = report.workspace
    now = now or timezone.now()
    report.snapshot = report_metrics(report)
    report.status = DailyReport.SUBMITTED
    report.submitted_at = now
    report.is_late = now > cutoff_at(ws, report.report_date)
    report.save(update_fields=["snapshot", "status", "submitted_at", "is_late", "updated_at"])
    _audit(actor, ws.pk, "sales.dailyreport.submitted", report, _label(report), data={"isLate": report.is_late})
    emit(
        SUBMITTED_EVENT,
        workspace=ws,
        target_type="sales.dailyreport",
        target_id=report.pk,
        actor=actor,
        payload={"userId": str(report.user_id), "date": report.report_date.isoformat(), "isLate": report.is_late},
    )
    return report


def _reviewer(actor: Any, report: DailyReport) -> None:
    """Review scope over the author, and never your own report (a report is reviewed by someone else)."""
    scope.require_in_scope(actor, report, perms.DAILYREPORT_REVIEW)
    if str(report.user_id) == str(actor.pk):
        raise forbidden("You can't review your own daily report.", {"permission": perms.DAILYREPORT_REVIEW})


@transaction.atomic
def review(actor: Any, report: DailyReport, comment: str = "", *, now: dt.datetime | None = None) -> DailyReport:
    _reviewer(actor, report)
    report = DailyReport.objects.select_for_update().select_related("workspace", "user").get(pk=report.pk)
    if report.status != DailyReport.SUBMITTED:
        raise conflict("report_not_submitted", "Only a submitted report can be reviewed.")
    report.status = DailyReport.REVIEWED
    report.reviewed_by = actor
    report.reviewed_at = now or timezone.now()
    report.review_comment = comment or ""
    report.save(update_fields=["status", "reviewed_by", "reviewed_at", "review_comment", "updated_at"])
    _audit(actor, report.workspace_id, "sales.dailyreport.reviewed", report, _label(report))
    emit(
        REVIEWED_EVENT,
        workspace=report.workspace,
        target_type="sales.dailyreport",
        target_id=report.pk,
        actor=actor,
        payload={"userId": str(report.user_id), "date": report.report_date.isoformat(), "comment": comment or ""},
    )
    return report


@transaction.atomic
def reopen(actor: Any, report: DailyReport) -> DailyReport:
    """Back to a draft (live metrics again, review cleared); the author resubmits."""
    _reviewer(actor, report)
    report = DailyReport.objects.select_for_update().select_related("workspace", "user").get(pk=report.pk)
    if report.status == DailyReport.DRAFT:
        raise conflict("report_draft", "This report is still a draft.")
    report.status = DailyReport.DRAFT
    report.snapshot = None
    report.submitted_at = None
    report.is_late = False
    report.reviewed_by = None
    report.reviewed_at = None
    report.review_comment = ""
    report.save()
    _audit(actor, report.workspace_id, "sales.dailyreport.reopened", report, _label(report))
    return report


# ───────────────────────── team daily report ─────────────────────────


def team_report(user: Any, workspace: Any, day: dt.date, team_id: Any = None) -> dict[str, Any]:
    """Every submitter the caller sees under `sales.dailyreport.view` (and anyone in scope with a report that day),
    optionally narrowed to a team: their report status, comments, plan and metrics, plus totals. The team target is
    the sum of the members' own targets (spec §8 core; S6 extends it)."""
    visible = people.visible_user_ids(user, workspace, perms.DAILYREPORT_VIEW)
    reports = {
        str(r.user_id): r
        for r in reports_for(user, workspace).filter(report_date=day).select_related("user", "workspace")
    }
    people_by_id = {str(u.pk): u for u in submitters(workspace) if str(u.pk) in visible}
    people_by_id.update({uid: r.user for uid, r in reports.items()})
    if team_id is not None:
        members = people.team_member_ids(workspace, team_id)
        people_by_id = {k: v for k, v in people_by_id.items() if k in members}
    ids = sorted(people_by_id, key=lambda k: (people_by_id[k].name.lower(), k))
    live = metrics_for(workspace, day, [i for i in ids if i not in reports or reports[i].status == DailyReport.DRAFT])
    rows = []
    for uid in ids:
        r = reports.get(uid)
        metrics = r.snapshot if r is not None and r.status != DailyReport.DRAFT and r.snapshot else live[uid]
        rows.append(
            {
                "user": {"id": uid, "name": people_by_id[uid].name},
                "reportId": str(r.pk) if r else None,
                "status": r.status if r else "missing",
                "isLate": r.is_late if r else False,
                "submittedAt": r.submitted_at if r else None,
                "comments": r.comments if r else [],
                "tomorrowPlan": r.tomorrow_plan if r else [],
                "metrics": metrics,
            }
        )
    return {
        "date": day,
        "required": is_required(workspace, day),
        "users": rows,
        "totals": _totals(rows),
    }


def _totals(rows: list[dict[str, Any]]) -> dict[str, Any]:
    targets = [Decimal(r["metrics"]["target"]) for r in rows if r["metrics"].get("target") is not None]
    target = money(sum(targets, Decimal("0"))) if targets else None
    actual = money(sum((Decimal(r["metrics"]["sales"] or "0") for r in rows), Decimal("0")))
    out: dict[str, Any] = {
        "target": _s(target),
        "sales": _s(actual),
        "achievement": _s(kpi.pct(actual, target)),
        **{k: sum(int(r["metrics"].get(k) or 0) for r in rows) for k in COUNTS},
        "people": len(rows),
        "submitted": sum(r["status"] in (DailyReport.SUBMITTED, DailyReport.REVIEWED) for r in rows),
        "reviewed": sum(r["status"] == DailyReport.REVIEWED for r in rows),
        "drafts": sum(r["status"] == DailyReport.DRAFT for r in rows),
        "missing": sum(r["status"] == "missing" for r in rows),
        "late": sum(bool(r["isLate"]) for r in rows),
    }
    return out


# ───────────────────────── the reminder job ─────────────────────────


def send_reminders(workspace: Any, *, now: dt.datetime | None = None) -> int:
    """The `sales_report_reminder` job: in the hour before the cutoff (workspace time) of a day that requires a
    report, one `sales.dailyreport.reminder` event per submitter who hasn't submitted. Outside that window it does
    nothing, so it can be scheduled every 15 minutes whatever each workspace's cutoff. Idempotent per user and
    date (`claim`)."""
    from core.jobs.services import claim

    local = workspace_now(workspace, now)
    day = local.date()
    settings = ensure_defaults(workspace)
    cutoff = cutoff_at(workspace, day, settings)
    if not (cutoff - REMINDER_LEAD <= local < cutoff) or not is_required(workspace, day, settings=settings):
        return 0
    done = set(
        DailyReport.objects.for_workspace(workspace)
        .filter(report_date=day)
        .filter(~Q(status=DailyReport.DRAFT))
        .values_list("user_id", flat=True)
    )
    done_ids = {str(u) for u in done}
    sent = 0
    for user in submitters(workspace):
        if str(user.pk) in done_ids or not claim(workspace, REMINDER_JOB, f"{day.isoformat()}:{user.pk}"):
            continue
        emit(
            REMINDER_EVENT,
            workspace=workspace,
            payload={"userId": str(user.pk), "date": day.isoformat(), "cutoff": cutoff.strftime("%H:%M")},
        )
        sent += 1
    return sent
