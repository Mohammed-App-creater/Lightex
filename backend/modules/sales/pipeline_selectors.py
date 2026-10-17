"""Sales reads for leads, opportunities, quotations, the pipeline board and the opportunity timeline (S2). Every list
of owned records goes through `scope.visible()` (`visible_to()`), as in `selectors.py`.
"""

from __future__ import annotations

import datetime as dt
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from django.db.models import (
    Count,
    DecimalField,
    ExpressionWrapper,
    F,
    Q,
    QuerySet,
    Sum,
    Value,
)
from django.db.models.functions import Coalesce, Lower

from core.common.exceptions import invalid, not_found
from core.common.pagination import decode_cursor, encode_cursor, parse_limit
from core.common.params import filter_values
from core.common.utils import iso
from core.workspaces.timezone import range_bounds, workspace_today

from . import module as perms
from . import scope
from .models import Lead, Opportunity, OpportunityStageHistory, PipelineStage, Quotation
from .selectors import _owner_ids, as_uuid, sort_spec, stages

LEAD_NOT_FOUND = "Lead not found. It may have been deleted, or you may not have access."
OPPORTUNITY_NOT_FOUND = "Opportunity not found. It may have been deleted, or you may not have access."
QUOTATION_NOT_FOUND = "Quotation not found. It may have been deleted, or you may not have access."

CENT = Decimal("0.01")
ZERO = Decimal("0.00")
_FAR = dt.date(9999, 12, 31)
_MONEY = DecimalField(max_digits=20, decimal_places=4)


def money(value: Any) -> Decimal:
    return Decimal(value or 0).quantize(CENT, rounding=ROUND_HALF_UP)


# ───────────────────────── shared filter helpers ─────────────────────────


def _ids(request: Any, key: str, label: str) -> list[Any]:
    values = filter_values(request, key)
    if any(as_uuid(v) is None for v in values):
        raise invalid({f"filter[{key}]": f"Use {label} ids"})
    return values


def _choices(request: Any, key: str, allowed: tuple[str, ...]) -> list[str]:
    values = filter_values(request, key)
    if any(v not in allowed for v in values):
        raise invalid({f"filter[{key}]": f"Use {', '.join(allowed)}"})
    return values


def _date(request: Any, key: str) -> dt.date | None:
    values = filter_values(request, key)
    if not values:
        return None
    try:
        return dt.date.fromisoformat(values[0])
    except ValueError:
        raise invalid({f"filter[{key}]": "Use a date (YYYY-MM-DD)"})


def team_members(workspace: Any, team_ids: list[Any]) -> QuerySet:
    """User ids of the members (and leads) of live teams `team_ids` in the workspace; 422 for unknown teams."""
    from core.teams.models import Team, TeamMember

    found = Team.objects.for_workspace(workspace).filter(pk__in=team_ids).count()
    if found != len(set(team_ids)):
        raise invalid({"filter[team]": "Pick teams of this workspace"})
    return TeamMember.objects.for_workspace(workspace).filter(team_id__in=team_ids).values("user_id")


def _owner_and_team(qs: QuerySet, request: Any, workspace: Any) -> QuerySet:
    owners = filter_values(request, "owner")
    if owners:
        qs = qs.filter(owner_id__in=_owner_ids(owners, request.user, "filter[owner]"))
    teams = _ids(request, "team", "team")
    if teams:
        qs = qs.filter(owner_id__in=team_members(workspace, teams))
    return qs


def _created_range(qs: QuerySet, request: Any, workspace: Any, field: str, prefix: str) -> QuerySet:
    """`filter[<prefix>From]` / `filter[<prefix>To]`: business dates (workspace zone), inclusive, on a timestamp."""
    first, last = _date(request, f"{prefix}From"), _date(request, f"{prefix}To")
    if first is not None:
        qs = qs.filter(**{f"{field}__gte": range_bounds(workspace, first, first)[0]})
    if last is not None:
        qs = qs.filter(**{f"{field}__lt": range_bounds(workspace, last, last)[1]})
    return qs


# ───────────────────────── leads ─────────────────────────


def leads_for(user: Any, workspace: Any) -> QuerySet[Lead]:
    return scope.visible(Lead.objects.for_workspace(workspace), user, perms.LEAD_VIEW, workspace)


LEAD_SORTS = {
    "createdAt": "created_at",
    "updatedAt": "updated_at",
    "name": "_sort_name",
    "status": "status",
    "estimatedValue": "_sort_value",
}


def lead_sort(qs: QuerySet[Lead], raw: str | None) -> tuple[QuerySet[Lead], list[tuple[str, bool]]]:
    order, name = sort_spec(raw, LEAD_SORTS, default="-createdAt")
    if name == "name":
        qs = qs.annotate(_sort_name=Lower(Coalesce("company__name", "company_name_text")))
    elif name == "estimatedValue":
        qs = qs.annotate(_sort_value=Coalesce("estimated_value", Value(Decimal("-1")), output_field=_MONEY))
    return qs, order


def filter_leads(qs: QuerySet[Lead], request: Any, workspace: Any) -> QuerySet[Lead]:
    statuses = _choices(request, "status", Lead.STATUSES)
    if statuses:
        qs = qs.filter(status__in=statuses)
    sources = _choices(request, "source", Lead.SOURCES)
    if sources:
        qs = qs.filter(source__in=sources)
    products = _ids(request, "product", "product")
    if products:
        qs = qs.filter(product_id__in=products)
    companies = _ids(request, "company", "company")
    if companies:
        qs = qs.filter(company_id__in=companies)
    qs = _owner_and_team(qs, request, workspace)
    qs = _created_range(qs, request, workspace, "created_at", "created")
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(
            Q(company_name_text__icontains=q)
            | Q(company__name__icontains=q)
            | Q(contact_name__icontains=q)
            | Q(phone__icontains=q)
            | Q(email__icontains=q)
        )
    return qs


def lead_for(user: Any, lead: Lead) -> Lead:
    scope.require_visible(user, lead, perms.LEAD_VIEW, LEAD_NOT_FOUND)
    return lead


# ───────────────────────── opportunities ─────────────────────────


def probability_expr() -> Any:
    return Coalesce("probability_override", "stage__default_probability")


def weighted_expr() -> Any:
    return ExpressionWrapper(F("expected_value") * probability_expr() / Value(Decimal(100)), output_field=_MONEY)


def probability_of(opp: Opportunity) -> int:
    if opp.probability_override is not None:
        return opp.probability_override
    return opp.stage.default_probability


def weighted_value(opp: Opportunity) -> Decimal:
    return money(opp.expected_value * probability_of(opp) / Decimal(100))


def status_of(opp: Opportunity) -> str:
    """open, won or lost: the stage's category."""
    return opp.stage.category


def opportunities_for(user: Any, workspace: Any) -> QuerySet[Opportunity]:
    return scope.visible(Opportunity.objects.for_workspace(workspace), user, perms.OPPORTUNITY_VIEW, workspace)


OPPORTUNITY_SORTS = {
    "updatedAt": "updated_at",
    "createdAt": "created_at",
    "title": "_sort_title",
    "expectedValue": "expected_value",
    "expectedCloseDate": "_sort_close",
    "wonAt": "_sort_won",
}


def opportunity_sort(qs: QuerySet[Opportunity], raw: str | None) -> tuple[QuerySet[Opportunity], list]:
    order, name = sort_spec(raw, OPPORTUNITY_SORTS, default="-updatedAt")
    if name == "title":
        qs = qs.annotate(_sort_title=Lower("title"))
    elif name == "expectedCloseDate":
        qs = qs.annotate(_sort_close=Coalesce("expected_close_date", Value(_FAR)))
    elif name == "wonAt":
        qs = qs.annotate(_sort_won=Coalesce("won_at", "created_at"))
    return qs, order


def filter_opportunities(qs: QuerySet[Opportunity], request: Any, workspace: Any) -> QuerySet[Opportunity]:
    stage_ids = _ids(request, "stage", "stage")
    if stage_ids:
        qs = qs.filter(stage_id__in=stage_ids)
    statuses = _choices(request, "status", PipelineStage.CATEGORIES)
    if statuses:
        qs = qs.filter(stage__category__in=statuses)
    for key in ("product", "company"):
        values = _ids(request, key, key)
        if values:
            qs = qs.filter(**{f"{key}_id__in": values})
    qs = _owner_and_team(qs, request, workspace)
    qs = close_range(qs, request)
    qs = _created_range(qs, request, workspace, "won_at", "won")
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(title__icontains=q) | Q(company__name__icontains=q))
    return qs


def close_range(qs: QuerySet[Opportunity], request: Any) -> QuerySet[Opportunity]:
    first, last = _date(request, "expectedCloseFrom"), _date(request, "expectedCloseTo")
    if first is not None:
        qs = qs.filter(expected_close_date__gte=first)
    if last is not None:
        qs = qs.filter(expected_close_date__lte=last)
    return qs


def opportunity_for(user: Any, opp: Opportunity) -> Opportunity:
    scope.require_visible(user, opp, perms.OPPORTUNITY_VIEW, OPPORTUNITY_NOT_FOUND)
    return opp


def related(qs: QuerySet[Opportunity]) -> QuerySet[Opportunity]:
    return qs.select_related("owner", "company", "contact", "product", "stage", "credited_user", "lost_reason")


# ───────────────────────── pipeline board ─────────────────────────


def pipeline(user: Any, workspace: Any, request: Any) -> dict[str, Any]:
    """Open stages in board order, each with its count, value and weighted value over the caller's visible
    opportunities (filters: owner, team, product, expected close range), plus the open leads count."""
    qs = opportunities_for(user, workspace).filter(stage__category=PipelineStage.OPEN)
    qs = _owner_and_team(qs, request, workspace)
    products = _ids(request, "product", "product")
    if products:
        qs = qs.filter(product_id__in=products)
    qs = close_range(qs, request)
    totals: dict[Any, Any] = {
        row["stage_id"]: row
        for row in qs.values("stage_id").annotate(
            n=Count("id"), value=Sum("expected_value"), weighted=Sum(weighted_expr())
        )
    }
    columns = []
    for stage in stages(workspace).filter(category=PipelineStage.OPEN):
        row = totals.get(stage.pk, {})
        columns.append(
            {
                "stage": stage,
                "count": row.get("n", 0),
                "value": money(row.get("value")),
                "weightedValue": money(row.get("weighted")),
                "rows": qs.filter(stage=stage),
            }
        )
    leads = None
    from core.access import services as access

    if access.can(user, perms.LEAD_VIEW, workspace):
        lead_qs = leads_for(user, workspace).filter(status__in=Lead.OPEN_STATUSES)
        lead_qs = _owner_and_team(lead_qs, request, workspace)
        if products:
            lead_qs = lead_qs.filter(product_id__in=products)
        leads = lead_qs.count()
    return {
        "columns": columns,
        "count": sum(c["count"] for c in columns),
        "value": money(sum((c["value"] for c in columns), ZERO)),
        "weightedValue": money(sum((c["weightedValue"] for c in columns), ZERO)),
        "leadCount": leads,
    }


# ───────────────────────── company summary (S2 part) ─────────────────────────


def company_deals(user: Any, company: Any) -> dict[str, Any]:
    """Open opportunity count, pipeline value (open expected value) and won value of the company's opportunities the
    caller can see."""
    qs = opportunities_for(user, company.workspace_id).filter(company=company)
    open_ = qs.filter(stage__category=PipelineStage.OPEN).aggregate(n=Count("id"), value=Sum("expected_value"))
    won = qs.filter(stage__category=PipelineStage.WON).aggregate(value=Sum("won_value"))
    return {
        "openOpportunityCount": open_["n"],
        "pipelineValue": money(open_["value"]),
        "wonValue": money(won["value"]),
    }


# ───────────────────────── quotations ─────────────────────────


def quotations_for(user: Any, workspace: Any) -> QuerySet[Quotation]:
    """Live quotations of live opportunities in the caller's quotation view scope."""
    qs = Quotation.objects.for_workspace(workspace).filter(opportunity__deleted_at__isnull=True)
    return scope.visible(qs, user, perms.QUOTATION_VIEW, workspace)


QUOTATION_SORTS = {
    "createdAt": "created_at",
    "updatedAt": "updated_at",
    "number": "number",
    "amount": "amount",
    "validUntil": "_sort_valid",
}


def quotation_sort(qs: QuerySet[Quotation], raw: str | None) -> tuple[QuerySet[Quotation], list]:
    order, name = sort_spec(raw, QUOTATION_SORTS, default="-createdAt")
    if name == "validUntil":
        qs = qs.annotate(_sort_valid=Coalesce("valid_until", Value(_FAR)))
    return qs, order


def filter_quotations(qs: QuerySet[Quotation], request: Any, workspace: Any) -> QuerySet[Quotation]:
    statuses = _choices(request, "status", Quotation.STATUSES)
    if statuses:
        qs = qs.filter(status__in=statuses)
    opportunities = _ids(request, "opportunity", "opportunity")
    if opportunities:
        qs = qs.filter(opportunity_id__in=opportunities)
    qs = _owner_and_team(qs, request, workspace)
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(number__icontains=q) | Q(title__icontains=q) | Q(opportunity__company__name__icontains=q))
    return qs


def quotation_for(user: Any, quotation: Quotation) -> Quotation:
    if quotation.opportunity.deleted_at is not None:
        raise not_found(QUOTATION_NOT_FOUND)
    scope.require_visible(user, quotation, perms.QUOTATION_VIEW, QUOTATION_NOT_FOUND)
    return quotation


# ───────────────────────── opportunity timeline ─────────────────────────
#
# Items of every kind share one shape (api.md §11.6). S2 contributes stage changes and quotation events; S3 adds
# activities and follow-ups through `TIMELINE_SOURCES` (append a function `(opportunity) -> list[item]`).


def _user(u: Any) -> dict[str, Any] | None:
    return None if u is None else {"id": str(u.pk), "name": u.name, "hue": u.hue}


def _item(item_id: str, kind: str, at: dt.datetime, actor: Any, summary: str, **parts: Any) -> dict[str, Any]:
    return {
        "id": item_id,
        "kind": kind,
        "at": at,
        "actor": _user(actor),
        "summary": summary,
        "stageChange": parts.get("stageChange"),
        "quotation": parts.get("quotation"),
        "activity": None,
        "followUp": None,
    }


_STAGE_SUMMARY = {
    OpportunityStageHistory.CREATED: "Created in {to}",
    OpportunityStageHistory.MOVED: "Moved from {frm} to {to}",
    OpportunityStageHistory.WON: "Marked won",
    OpportunityStageHistory.LOST: "Marked lost",
    OpportunityStageHistory.REOPENED: "Reopened in {to}",
}


def _stage_items(opp: Opportunity) -> list[dict[str, Any]]:
    out = []
    for h in (
        OpportunityStageHistory.objects.for_workspace(opp.workspace_id)
        .filter(opportunity=opp)
        .select_related("changed_by")
    ):
        change = {
            "fromStageId": str(h.from_stage_id) if h.from_stage_id else None,
            "fromStage": h.from_stage_name or None,
            "toStageId": str(h.to_stage_id) if h.to_stage_id else None,
            "toStage": h.to_stage_name or None,
        }
        summary = _STAGE_SUMMARY[h.kind].format(frm=h.from_stage_name, to=h.to_stage_name)
        out.append(_item(str(h.pk), f"stage_{h.kind}", h.changed_at, h.changed_by, summary, stageChange=change))
    return out


def _quotation_items(opp: Opportunity) -> list[dict[str, Any]]:
    out = []
    rows = Quotation.objects.for_workspace(opp.workspace_id).filter(opportunity=opp).select_related("owner")
    for q in rows:
        brief = {"id": str(q.pk), "number": q.number, "title": q.title, "amount": f"{q.amount:.2f}", "status": q.status}
        events = [("created", q.created_at, f"Quotation {q.number} drafted")]
        if q.sent_at:
            events.append(("sent", q.sent_at, f"Quotation {q.number} sent"))
        if q.responded_at:
            events.append((q.status, q.responded_at, f"Quotation {q.number} {q.status}"))
        if q.expired_at:
            events.append(("expired", q.expired_at, f"Quotation {q.number} expired"))
        for event, at, summary in events:
            actor = None if event == "expired" else q.owner
            out.append(_item(f"{q.pk}:{event}", f"quotation_{event}", at, actor, summary, quotation=brief))
    return out


TIMELINE_SOURCES = [_stage_items, _quotation_items]


def timeline(opp: Opportunity, params: Any) -> dict[str, Any]:
    """Every child of the opportunity, newest first, as `{data, nextCursor}` (keyset on (at, id)). The caller has
    already been checked against the opportunity's view scope; its children are shown whatever their own owner."""
    items = [item for source in TIMELINE_SOURCES for item in source(opp)]
    items.sort(key=lambda i: (i["at"], i["id"]), reverse=True)
    limit = parse_limit(params.get("limit"), 50, 200)
    cursor = params.get("cursor")
    if cursor:
        at_raw, last_id = decode_cursor(cursor, 2)
        try:
            at = dt.datetime.fromisoformat(str(at_raw))
        except ValueError:
            from core.common.exceptions import ApiError

            raise ApiError(400, "invalid_cursor", "This page link is no longer valid.")
        items = [i for i in items if (i["at"], i["id"]) < (at, str(last_id))]
    page = items[:limit]
    nxt = encode_cursor([page[-1]["at"], page[-1]["id"]]) if len(items) > limit else None
    return {"data": [{**i, "at": iso(i["at"])} for i in page], "nextCursor": nxt}


def today(workspace: Any) -> dt.date:
    return workspace_today(workspace)
