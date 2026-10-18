"""Sales reads for activities and follow-ups (S3, docs/sales/api.md §14–§16): lists with their filters, the follow-up
buckets in workspace time, the activity and follow-up timeline items (opportunity and company timelines) and the
company summary's activity fields. Every list of owned records goes through `scope.visible()` (`visible_to()`).

Children of a record in the trash are hidden (404 and out of lists) until it is restored, like quotations of a
deleted opportunity.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.db.models import Count, Q, QuerySet

from core.common.exceptions import invalid, not_found
from core.common.params import filter_values
from core.common.utils import iso
from core.workspaces.timezone import workspace_today

from . import module as perms
from . import pipeline_selectors as ps
from . import scope
from .defaults import ensure_defaults
from .models import Activity, Company, FollowUp, Opportunity
from .selectors import sort_spec

ACTIVITY_NOT_FOUND = "Activity not found. It may have been deleted, or you may not have access."
FOLLOWUP_NOT_FOUND = "Follow-up not found. It may have been deleted, or you may not have access."

TYPE_LABELS = {
    Activity.CALL: "Call",
    Activity.VISIT: "Visit",
    Activity.MEETING: "Meeting",
    Activity.EMAIL: "Email",
    Activity.NOTE: "Note",
    Activity.OTHER: "Other",
    Activity.QUOTATION: "Quotation sent",
}

#: Follow-up buckets (spec §5), all pending: overdue (due before today), today, upcoming (the next `upcoming_days`
#: days after today); `later` is only a row hint (due after the upcoming window).
OVERDUE, TODAY, UPCOMING, LATER, ALL = "overdue", "today", "upcoming", "later", "all"
BUCKETS = (OVERDUE, TODAY, UPCOMING, ALL)


def live_targets() -> Q:
    """Children whose target is live: not in the trash (a contact's company neither)."""
    return (
        Q(target_type=Activity.LEAD, lead__deleted_at__isnull=True)
        | Q(target_type=Activity.OPPORTUNITY, opportunity__deleted_at__isnull=True)
        | Q(target_type=Activity.COMPANY, target_company__deleted_at__isnull=True)
        | Q(
            target_type=Activity.CONTACT,
            contact__deleted_at__isnull=True,
            contact__company__deleted_at__isnull=True,
        )
    )


def _related(qs: QuerySet) -> QuerySet:
    return qs.select_related("owner", "lead", "lead__company", "opportunity", "target_company", "contact", "company")


def _targets(request: Any, allowed: tuple[str, ...]) -> list[str]:
    values = filter_values(request, "targetType")
    if any(v not in allowed for v in values):
        raise invalid({"filter[targetType]": f"Use {', '.join(allowed)}"})
    return values


def _target_filters(qs: QuerySet, request: Any, allowed: tuple[str, ...]) -> QuerySet:
    types = _targets(request, allowed)
    if types:
        qs = qs.filter(target_type__in=types)
    targets = ps._ids(request, "target", "record")
    if targets:
        qs = qs.filter(target_id__in=targets)
    companies = ps._ids(request, "company", "company")
    if companies:
        qs = qs.filter(company_id__in=companies)
    return qs


# ───────────────────────── activities ─────────────────────────


def activities_for(user: Any, workspace: Any) -> QuerySet[Activity]:
    qs = Activity.objects.for_workspace(workspace).filter(live_targets())
    return scope.visible(qs, user, perms.ACTIVITY_VIEW, workspace)


ACTIVITY_SORTS = {"occurredAt": "occurred_at", "createdAt": "created_at"}


def activity_sort(qs: QuerySet[Activity], raw: str | None) -> tuple[QuerySet[Activity], list]:
    order, _ = sort_spec(raw, ACTIVITY_SORTS, default="-occurredAt")
    return _related(qs), order


def filter_activities(qs: QuerySet[Activity], request: Any, workspace: Any) -> QuerySet[Activity]:
    types = ps._choices(request, "type", Activity.TYPES)
    if types:
        qs = qs.filter(type__in=types)
    qs = ps._owner_and_team(qs, request, workspace)
    qs = _target_filters(qs, request, Activity.TARGET_TYPES)
    qs = ps._created_range(qs, request, workspace, "occurred_at", "occurred")
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(summary__icontains=q) | Q(outcome__icontains=q))
    return qs


def activity_for(user: Any, activity: Activity) -> Activity:
    live = Activity.objects.for_workspace(activity.workspace_id).filter(live_targets(), pk=activity.pk).exists()
    if not live:
        raise not_found(ACTIVITY_NOT_FOUND)
    scope.require_visible(user, activity, perms.ACTIVITY_VIEW, ACTIVITY_NOT_FOUND)
    return activity


def related_activities(qs: QuerySet[Activity]) -> QuerySet[Activity]:
    return _related(qs)


# ───────────────────────── follow-ups ─────────────────────────


def followups_for(user: Any, workspace: Any) -> QuerySet[FollowUp]:
    qs = FollowUp.objects.for_workspace(workspace).filter(live_targets())
    return scope.visible(qs, user, perms.FOLLOWUP_VIEW, workspace)


def window(workspace: Any, now: dt.datetime | None = None) -> tuple[dt.date, dt.date]:
    """(today, the last day of the upcoming window), in workspace time."""
    today = workspace_today(workspace, now)
    return today, today + dt.timedelta(days=ensure_defaults(workspace).upcoming_days)


def bucket_q(bucket: str, today: dt.date, until: dt.date) -> Q:
    pending = Q(status=FollowUp.PENDING)
    if bucket == OVERDUE:
        return pending & Q(due_date__lt=today)
    if bucket == TODAY:
        return pending & Q(due_date=today)
    if bucket == UPCOMING:
        return pending & Q(due_date__gt=today, due_date__lte=until)
    return Q()


def bucket_of(f: FollowUp, today: dt.date, until: dt.date) -> str | None:
    if f.status != FollowUp.PENDING:
        return None
    if f.due_date < today:
        return OVERDUE
    if f.due_date == today:
        return TODAY
    return UPCOMING if f.due_date <= until else LATER


def bucket_counts(qs: QuerySet[FollowUp], today: dt.date, until: dt.date) -> dict[str, int]:
    """Overdue, today and upcoming counts of `qs`, in one query."""
    return qs.aggregate(
        overdue=Count("id", filter=bucket_q(OVERDUE, today, until)),
        today=Count("id", filter=bucket_q(TODAY, today, until)),
        upcoming=Count("id", filter=bucket_q(UPCOMING, today, until)),
    )


FOLLOWUP_SORTS = {"dueDate": "due_date", "createdAt": "created_at", "updatedAt": "updated_at"}


def followup_sort(qs: QuerySet[FollowUp], raw: str | None) -> tuple[QuerySet[FollowUp], list]:
    order, _ = sort_spec(raw, FOLLOWUP_SORTS, default="dueDate")
    return _related(qs).select_related("created_by"), order


def filter_followups(qs: QuerySet[FollowUp], request: Any, workspace: Any) -> QuerySet[FollowUp]:
    """Every filter except the bucket (the counts cover the filtered set, whatever the bucket)."""
    statuses = ps._choices(request, "status", FollowUp.STATUSES)
    if statuses:
        qs = qs.filter(status__in=statuses)
    qs = ps._owner_and_team(qs, request, workspace)
    qs = _target_filters(qs, request, FollowUp.TARGET_TYPES)
    first, last = ps._date(request, "dueFrom"), ps._date(request, "dueTo")
    if first is not None:
        qs = qs.filter(due_date__gte=first)
    if last is not None:
        qs = qs.filter(due_date__lte=last)
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(title__icontains=q) | Q(notes__icontains=q))
    return qs


def parse_bucket(raw: str | None) -> str:
    bucket = raw or ALL
    if bucket not in BUCKETS:
        raise invalid({"bucket": f"Use {', '.join(BUCKETS)}"})
    return bucket


def followup_for(user: Any, f: FollowUp) -> FollowUp:
    live = FollowUp.objects.for_workspace(f.workspace_id).filter(live_targets(), pk=f.pk).exists()
    if not live:
        raise not_found(FOLLOWUP_NOT_FOUND)
    scope.require_visible(user, f, perms.FOLLOWUP_VIEW, FOLLOWUP_NOT_FOUND)
    return f


# ───────────────────────── timeline items ─────────────────────────


def target_name(obj: Activity | FollowUp) -> str:
    target = getattr(obj, Activity.TARGET_FIELDS[obj.target_type])
    if target is None:
        return ""
    return target.display_name if obj.target_type == Activity.LEAD else getattr(target, "title", None) or target.name


def activity_brief(a: Activity) -> dict[str, Any]:
    return {
        "id": str(a.pk),
        "type": a.type,
        "occurredAt": iso(a.occurred_at),
        "durationMinutes": a.duration_minutes,
        "summary": a.summary,
        "outcome": a.outcome,
        "targetType": a.target_type,
        "targetId": str(a.target_id),
        "ownerId": str(a.owner_id) if a.owner_id else None,
    }


def followup_brief(f: FollowUp) -> dict[str, Any]:
    return {
        "id": str(f.pk),
        "title": f.title,
        "dueDate": f.due_date.isoformat(),
        "status": f.status,
        "targetType": f.target_type,
        "targetId": str(f.target_id),
        "ownerId": str(f.owner_id) if f.owner_id else None,
    }


def _activity_summary(a: Activity) -> str:
    label = TYPE_LABELS.get(a.type, a.type.title())
    return f"{label}: {a.summary}"[:300] if a.summary else label


def _quotation_brief(a: Activity) -> dict[str, Any] | None:
    q = a.quotation
    if q is None:
        return None
    return {"id": str(q.pk), "number": q.number, "title": q.title, "amount": f"{q.amount:.2f}", "status": q.status}


def activity_items(rows: QuerySet[Activity]) -> list[dict[str, Any]]:
    return [
        ps._item(
            str(a.pk),
            "activity_logged",
            a.occurred_at,
            a.owner,
            _activity_summary(a),
            activity=activity_brief(a),
            quotation=_quotation_brief(a),
        )
        for a in rows.select_related("owner", "quotation")
    ]


def followup_items(rows: QuerySet[FollowUp]) -> list[dict[str, Any]]:
    out = []
    for f in rows.select_related("owner", "created_by"):
        brief = followup_brief(f)
        due = f.due_date.isoformat()
        out.append(
            ps._item(
                f"{f.pk}:scheduled",
                "followup_scheduled",
                f.created_at,
                f.created_by,
                f"Follow-up planned for {due}: {f.title}"[:300],
                followUp=brief,
            )
        )
        if f.completed_at:
            out.append(
                ps._item(
                    f"{f.pk}:completed",
                    "followup_completed",
                    f.completed_at,
                    f.owner,
                    f"Done: {f.title}"[:300],
                    followUp=brief,
                )
            )
        if f.cancelled_at:
            out.append(
                ps._item(
                    f"{f.pk}:cancelled",
                    "followup_cancelled",
                    f.cancelled_at,
                    f.owner,
                    f"Cancelled: {f.title}"[:300],
                    followUp=brief,
                )
            )
    return out


def _opportunity_activities(opp: Opportunity) -> list[dict[str, Any]]:
    # `quotation` entries are left out here: the opportunity timeline already shows the send (`quotation_sent`).
    rows = Activity.objects.for_workspace(opp.workspace_id).filter(opportunity=opp).exclude(type=Activity.QUOTATION)
    return activity_items(rows)


def _opportunity_followups(opp: Opportunity) -> list[dict[str, Any]]:
    return followup_items(FollowUp.objects.for_workspace(opp.workspace_id).filter(opportunity=opp))


def _company_activities(company: Company) -> list[dict[str, Any]]:
    rows = Activity.objects.for_workspace(company.workspace_id).filter(live_targets(), company=company)
    return activity_items(rows)


def _company_followups(company: Company) -> list[dict[str, Any]]:
    rows = FollowUp.objects.for_workspace(company.workspace_id).filter(live_targets(), company=company)
    return followup_items(rows)


#: The company timeline: every activity and follow-up on the company or on its contacts, leads and opportunities.
COMPANY_TIMELINE_SOURCES = [_company_activities, _company_followups]


def company_timeline(company: Company, params: Any) -> dict[str, Any]:
    items = [item for source in COMPANY_TIMELINE_SOURCES for item in source(company)]
    return ps.page_items(items, params)


def register_timeline_sources() -> None:
    """Adds activity and follow-up items to the opportunity timeline (`pipeline_selectors.TIMELINE_SOURCES`)."""
    for source in (_opportunity_activities, _opportunity_followups):
        if source not in ps.TIMELINE_SOURCES:
            ps.TIMELINE_SOURCES.append(source)


# ───────────────────────── company summary (S3 part) ─────────────────────────

SUMMARY_TIMELINE_ITEMS = 20


def last_contact_at(company: Company) -> dt.datetime | None:
    """The latest call, visit, meeting or email on the company or any of its records (spec §5)."""
    row = (
        Activity.objects.for_workspace(company.workspace_id)
        .filter(company=company, type__in=Activity.CONTACT_TYPES)
        .order_by("-occurred_at")
        .values_list("occurred_at", flat=True)
        .first()
    )
    return row


def company_activity(user: Any, company: Company) -> dict[str, Any]:
    """Open follow-ups of the company the caller can see, the last contact and the newest timeline items (the whole
    timeline: `GET /companies/{id}/timeline`)."""
    open_ = followups_for(user, company.workspace_id).filter(company=company, status=FollowUp.PENDING).count()
    page = company_timeline(company, {"limit": SUMMARY_TIMELINE_ITEMS})
    return {"openFollowUpCount": open_, "lastContactAt": last_contact_at(company), "timeline": page["data"]}
