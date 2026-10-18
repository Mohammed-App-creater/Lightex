"""The sales dashboard (S6, docs/sales/spec.md §7, api.md §21): KPIs with the previous period, the pipeline by stage,
the ranking, follow-up counts and attention items, over the people the caller's `sales.dashboard.view` scope reaches
(`own` → themself, `team` → their teammates, `all` → every member). Numbers come from `kpi.py`; this module only picks
the people and lists the records that need attention.

`userId` / `teamId` narrow the people and must stay inside the scope: a user or team outside it answers 403
`forbidden` (`details.permission`), never an empty dashboard, so the UI can tell "no data" from "not allowed".
The same helper (`people_in_scope`) serves the reports and the management daily report.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.db.models import Count, Exists, OuterRef, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone

from core.access import services as access
from core.common.exceptions import forbidden, invalid

from . import kpi, people
from . import module as perms
from .activity_selectors import bucket_counts, live_targets
from .models import FollowUp, Lead, Opportunity, PipelineStage, Quotation
from .periods import WEEK, Period
from .pipeline_selectors import money, weighted_expr
from .selectors import as_uuid, stages
from .targets import TargetBook, subject

#: Rows per attention list; `count` holds the full number.
ATTENTION_LIMIT = 10


# ───────────────────────── people ─────────────────────────


def people_in_scope(
    user: Any, workspace: Any, code: str, *, user_id: str | None = None, team_id: str | None = None
) -> set[str]:
    """User ids the caller's `code` scope reaches, narrowed to `user_id` and/or `team_id` (403 outside the scope)."""
    ids = people.visible_user_ids(user, workspace, code)
    if team_id:
        if as_uuid(team_id) is None:
            raise invalid({"teamId": "Use a team id"})
        if str(team_id) not in people.visible_team_ids(user, workspace, code):
            raise forbidden("That team is outside your scope.", {"permission": code})
        ids &= people.team_member_ids(workspace, team_id)
    if user_id:
        if as_uuid(user_id) is None:
            raise invalid({"userId": "Use a user id"})
        if str(user_id) not in ids:
            raise forbidden("That person is outside your scope.", {"permission": code})
        ids = {str(user_id)}
    return ids


def sellers(workspace: Any, ids: set[str]) -> set[str]:
    """Users who can sell (hold `sales.opportunity.create`)."""
    from core.accounts.models import User

    return {
        str(u.pk) for u in User.objects.filter(pk__in=list(ids)) if access.can(u, perms.OPPORTUNITY_CREATE, workspace)
    }


def ranking_rows(workspace: Any, period: Period, ids: set[str], today: dt.date) -> list[dict[str, Any]]:
    """`kpi.ranking` limited to people who sell or sold or had a target (as the performance ranking)."""
    from core.accounts.models import User

    from .serializers import _user

    rows = kpi.ranking(workspace, period, sorted(ids), today=today)
    can_sell = sellers(workspace, ids)
    rows = kpi.assign_ranks([r for r in rows if r["userId"] in can_sell or r["actual"] or r["target"] is not None])
    users = {str(u.pk): u for u in User.objects.filter(pk__in=[r["userId"] for r in rows])}
    for row in rows:
        row["user"] = _user(users[row["userId"]])
    return rows


def target_subject(user: Any, workspace: Any, code: str, team_id: str | None, user_id: str | None, period: Period,
                   book: TargetBook) -> tuple[str, Any] | None:  # fmt: skip
    """The team's own target when filtering by a team that has one; the company target for an `all` caller without
    filters when one is set; else None (the sum of the users' own targets)."""
    if user_id:
        return None
    if team_id:
        return ("team", team_id) if book.for_period(subject("team", team_id), period) is not None else None
    if people.sees_company(user, workspace, code) and book.for_period(subject("company", None), period) is not None:
        return ("company", None)
    return None


# ───────────────────────── pipeline and attention ─────────────────────────


def pipeline_by_stage(workspace: Any, ids: set[str]) -> dict[str, Any]:
    """Open leads plus each open stage's count, value and weighted value (owners in `ids`)."""
    owners = list(ids)
    leads = Lead.objects.for_workspace(workspace).filter(owner_id__in=owners, status__in=Lead.OPEN_STATUSES)
    lead_row = leads.aggregate(n=Count("id"), value=Sum("estimated_value"))
    opps = Opportunity.objects.for_workspace(workspace).filter(owner_id__in=owners, stage__category=PipelineStage.OPEN)
    totals = {
        r["stage_id"]: r
        for r in opps.values("stage_id").annotate(n=Count("id"), value=Sum("expected_value"), w=Sum(weighted_expr()))
    }
    rows = []
    for stage in stages(workspace).filter(category=PipelineStage.OPEN):
        t = totals.get(stage.pk, {})
        rows.append(
            {
                "stageId": str(stage.pk),
                "name": stage.name,
                "count": t.get("n", 0),
                "value": money(t.get("value")),
                "weightedValue": money(t.get("w")),
            }
        )
    return {"leads": {"count": lead_row["n"], "value": money(lead_row["value"])}, "stages": rows}


def _opp_item(o: Opportunity) -> dict[str, Any]:
    return {
        "id": str(o.pk),
        "title": o.title,
        "companyName": o.company.name,
        "ownerId": str(o.owner_id) if o.owner_id else None,
        "ownerName": o.owner.name if o.owner else None,
        "stageName": o.stage.name,
        "expectedValue": money(o.expected_value),
        "expectedCloseDate": o.expected_close_date,
    }


def _capped(qs: Any, item: Any, limit: int) -> dict[str, Any]:
    return {"count": qs.count(), "items": [item(r) for r in qs[:limit]]}


def open_opportunities(workspace: Any, ids: set[str]) -> Any:
    return (
        Opportunity.objects.for_workspace(workspace)
        .filter(owner_id__in=list(ids), stage__category=PipelineStage.OPEN)
        .select_related("company", "owner", "stage")
    )


def overdue_followups(workspace: Any, ids: set[str], today: dt.date) -> Any:
    return (
        FollowUp.objects.for_workspace(workspace)
        .filter(live_targets(), owner_id__in=list(ids), status=FollowUp.PENDING, due_date__lt=today)
        .select_related("owner")
        .order_by("due_date", "id")
    )


def awaiting_quotations(workspace: Any, ids: set[str]) -> Any:
    return (
        Quotation.objects.for_workspace(workspace)
        .filter(owner_id__in=list(ids), status=Quotation.SENT, opportunity__deleted_at__isnull=True)
        .select_related("opportunity", "opportunity__company", "owner")
        .order_by("sent_at", "id")
    )


def large_closing(workspace: Any, ids: set[str], today: dt.date, settings: Any) -> Any:
    week = TargetBook(workspace, settings).period(WEEK, today)
    return (
        open_opportunities(workspace, ids)
        .filter(
            expected_value__gte=settings.large_deal_threshold,
            expected_close_date__range=(week.start, week.end),
        )
        .order_by("-expected_value", "id")
    )


def _followup_item(f: FollowUp) -> dict[str, Any]:
    return {
        "id": str(f.pk),
        "title": f.title,
        "dueDate": f.due_date,
        "targetType": f.target_type,
        "targetId": str(f.target_id),
        "ownerId": str(f.owner_id) if f.owner_id else None,
        "ownerName": f.owner.name if f.owner else None,
    }


def _quotation_item(q: Quotation) -> dict[str, Any]:
    return {
        "id": str(q.pk),
        "number": q.number,
        "title": q.title,
        "amount": money(q.amount),
        "sentAt": q.sent_at,
        "validUntil": q.valid_until,
        "opportunityId": str(q.opportunity_id),
        "companyName": q.opportunity.company.name,
        "ownerId": str(q.owner_id) if q.owner_id else None,
        "ownerName": q.owner.name if q.owner else None,
    }


def attention(workspace: Any, ids: set[str], today: dt.date, settings: Any, limit: int = ATTENTION_LIMIT) -> dict:
    opens = open_opportunities(workspace, ids)
    pending = FollowUp.objects.unscoped().filter(opportunity=OuterRef("pk"), status=FollowUp.PENDING)
    stale_before = timezone.now() - dt.timedelta(days=settings.stale_days)
    return {
        "overdueFollowUps": _capped(overdue_followups(workspace, ids, today), _followup_item, limit),
        "quotationsAwaitingResponse": _capped(awaiting_quotations(workspace, ids), _quotation_item, limit),
        "largeClosingThisWeek": _capped(large_closing(workspace, ids, today, settings), _opp_item, limit),
        "noNextStep": _capped(opens.filter(~Exists(pending)).order_by("-expected_value", "id"), _opp_item, limit),
        "stale": _capped(
            opens.annotate(last=Coalesce("last_activity_at", "created_at"))
            .filter(last__lt=stale_before)
            .order_by("last", "id"),
            _opp_item,
            limit,
        ),
    }


def followup_counts(workspace: Any, ids: set[str], today: dt.date, settings: Any) -> dict[str, int]:
    qs = FollowUp.objects.for_workspace(workspace).filter(live_targets(), owner_id__in=list(ids))
    return bucket_counts(qs, today, today + dt.timedelta(days=settings.upcoming_days))


# ───────────────────────── the dashboard ─────────────────────────


def build(
    user: Any,
    workspace: Any,
    period: Period,
    *,
    today: dt.date,
    book: TargetBook,
    user_id: str | None = None,
    team_id: str | None = None,
) -> dict[str, Any]:
    code = perms.DASHBOARD_VIEW
    ids = people_in_scope(user, workspace, code, user_id=user_id, team_id=team_id)
    settings = book.settings
    subj = target_subject(user, workspace, code, team_id, user_id, period, book)
    k = kpi.compute(workspace, period, ids, target_subject=subj, today=today, book=book)
    return {
        "period": period,
        "scope": _scope_label(user, workspace),
        "userCount": len(ids),
        "kpis": k,
        "previous": k.previous,
        "pipeline": pipeline_by_stage(workspace, ids),
        "ranking": ranking_rows(workspace, period, ids, today),
        "followUps": followup_counts(workspace, ids, today, settings),
        "attention": attention(workspace, ids, today, settings),
    }


def _scope_label(user: Any, workspace: Any) -> str | None:
    from .scope import scope_of

    return scope_of(user, workspace, perms.DASHBOARD_VIEW)
