"""Sales API views for leads, opportunities, the pipeline board and quotations (S2, docs/sales/api.md §9–§12). Same
pattern as `views.py`: permission per method, then a selector or a service. Record routes resolve the record's
workspace (404 for non-members), then the module guard, then the permission code, then the record's view scope (404).
"""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.response import Response

from core.common.pagination import paginate_queryset
from core.common.schema import page_of
from core.workspaces.views import WorkspaceScopedView

from . import module as perms
from . import pipeline_selectors as ps
from . import pipeline_services as svc
from .models import Lead, Opportunity, PipelineStage, Quotation
from .pipeline_serializers import (
    SalesBulkAssignResultSerializer,
    SalesLeadBulkAssignIn,
    SalesLeadConvertIn,
    SalesLeadConvertResultSerializer,
    SalesLeadDisqualifyIn,
    SalesLeadIn,
    SalesLeadSerializer,
    SalesLeadUpdateIn,
    SalesOpportunityBulkAssignIn,
    SalesOpportunityIn,
    SalesOpportunityLostIn,
    SalesOpportunityMoveIn,
    SalesOpportunityReopenIn,
    SalesOpportunitySerializer,
    SalesOpportunityUpdateIn,
    SalesOpportunityWonIn,
    SalesPipelineSerializer,
    SalesQuotationIn,
    SalesQuotationSendIn,
    SalesQuotationSerializer,
    SalesQuotationUpdateIn,
    SalesTimelineItemSerializer,
    lead_data,
    one_lead,
    one_quotation,
    opportunity_data,
    opportunity_payload,
    quotation_data,
)
from .serializers import SalesStageSerializer
from .views import PAGE_PARAMS, TAGS, SalesRecordView, one_company, one_contact, valid

SalesLeadPage = page_of("SalesLeadPage", SalesLeadSerializer)
SalesOpportunityPage = page_of("SalesOpportunityPage", SalesOpportunitySerializer)
SalesQuotationPage = page_of("SalesQuotationPage", SalesQuotationSerializer)
SalesTimelinePage = page_of("SalesTimelinePage", SalesTimelineItemSerializer)

OWNER_PARAMS = [
    OpenApiParameter("filter[owner]", str, many=True, description="user id or `me`"),
    OpenApiParameter("filter[team]", str, many=True, description="team id: records owned by its members"),
]


def _sorted_page(request: Any, qs: Any, order: list, serialize: Any) -> dict[str, Any]:
    return paginate_queryset(qs, request.query_params, order=order, serialize=serialize)


# ───────────────────────── leads ─────────────────────────

LEAD_LIST_PARAMS = [
    OpenApiParameter("filter[status]", str, many=True, enum=list(Lead.STATUSES)),
    OpenApiParameter("filter[source]", str, many=True, enum=list(Lead.SOURCES)),
    *OWNER_PARAMS,
    OpenApiParameter("filter[product]", str, many=True, description="product id"),
    OpenApiParameter("filter[company]", str, many=True, description="company id"),
    OpenApiParameter("filter[createdFrom]", str, description="YYYY-MM-DD, workspace time, inclusive"),
    OpenApiParameter("filter[createdTo]", str, description="YYYY-MM-DD, workspace time, inclusive"),
    OpenApiParameter("q", str, description="Matches company name, contact name, phone or email"),
    OpenApiParameter(
        "sort", str, description="-createdAt (default), createdAt, updatedAt, name, status or estimatedValue"
    ),
    *PAGE_PARAMS,
]


def _leads(qs: Any) -> Any:
    return qs.select_related("owner", "company", "contact", "product")


class LeadListView(WorkspaceScopedView):
    required = {"GET": perms.LEAD_VIEW, "POST": perms.LEAD_CREATE}

    @extend_schema(
        tags=TAGS, operation_id="sales_leads_list", parameters=LEAD_LIST_PARAMS, responses={200: SalesLeadPage}
    )
    def get(self, request, slug):
        qs = ps.filter_leads(ps.leads_for(request.user, self.scope), request, self.scope)
        qs, order = ps.lead_sort(_leads(qs), request.query_params.get("sort"))
        return Response(_sorted_page(request, qs, order, lambda rows: lead_data(request.user, rows)))

    @extend_schema(
        tags=TAGS, operation_id="sales_leads_create", request=SalesLeadIn, responses={201: SalesLeadSerializer}
    )
    def post(self, request, slug):
        lead = svc.create_lead(request.user, self.scope, valid(SalesLeadIn, request))
        return Response(one_lead(request.user, lead), status=status.HTTP_201_CREATED)


class LeadBulkAssignView(WorkspaceScopedView):
    """All-or-nothing: every lead must be in the caller's sales.lead.assign scope. One audit row per changed lead."""

    required = {"POST": perms.LEAD_ASSIGN}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_leads_bulk_assign",
        request=SalesLeadBulkAssignIn,
        responses={200: SalesBulkAssignResultSerializer},
    )
    def post(self, request, slug):
        data = valid(SalesLeadBulkAssignIn, request)
        return Response({"updated": svc.bulk_assign_leads(request.user, self.scope, data["leadIds"], data["owner_id"])})


class LeadRecordView(SalesRecordView):
    model = Lead
    kwarg = "lead_id"
    not_found_message = ps.LEAD_NOT_FOUND

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        ps.lead_for(request.user, self.record)  # 404 outside the view scope, for every method


class LeadDetailView(LeadRecordView):
    required = {"GET": perms.LEAD_VIEW, "PATCH": perms.LEAD_EDIT, "DELETE": perms.LEAD_DELETE}

    @extend_schema(tags=TAGS, operation_id="sales_leads_retrieve", responses={200: SalesLeadSerializer})
    def get(self, request, lead_id):
        return Response(one_lead(request.user, self.record))

    @extend_schema(
        tags=TAGS,
        operation_id="sales_leads_partial_update",
        request=SalesLeadUpdateIn,
        responses={200: SalesLeadSerializer},
    )
    def patch(self, request, lead_id):
        lead = svc.update_lead(request.user, self.record, valid(SalesLeadUpdateIn, request))
        return Response(one_lead(request.user, lead))

    @extend_schema(tags=TAGS, operation_id="sales_leads_destroy", responses={204: None})
    def delete(self, request, lead_id):
        svc.delete_lead(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


class LeadQualifyView(LeadRecordView):
    required = {"POST": perms.LEAD_CONVERT}

    @extend_schema(tags=TAGS, operation_id="sales_leads_qualify", request=None, responses={200: SalesLeadSerializer})
    def post(self, request, lead_id):
        return Response(one_lead(request.user, svc.qualify_lead(request.user, self.record)))


class LeadDisqualifyView(LeadRecordView):
    required = {"POST": perms.LEAD_CONVERT}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_leads_disqualify",
        request=SalesLeadDisqualifyIn,
        responses={200: SalesLeadSerializer},
    )
    def post(self, request, lead_id):
        reason = valid(SalesLeadDisqualifyIn, request)["reason"]
        return Response(one_lead(request.user, svc.disqualify_lead(request.user, self.record, reason)))


class LeadConvertView(LeadRecordView):
    required = {"POST": perms.LEAD_CONVERT}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_leads_convert",
        request=SalesLeadConvertIn,
        responses={200: SalesLeadConvertResultSerializer},
    )
    def post(self, request, lead_id):
        out = svc.convert_lead(request.user, self.record, valid(SalesLeadConvertIn, request))
        user = request.user
        return Response(
            {
                "lead": one_lead(user, out["lead"]),
                "opportunity": opportunity_payload(user, out["opportunity"]),
                "company": one_company(user, out["company"]),
                "contact": one_contact(user, out["contact"]) if out["contact"] is not None else None,
                "companyCreated": out["companyCreated"],
                "contactCreated": out["contactCreated"],
            }
        )


# ───────────────────────── opportunities ─────────────────────────

CLOSE_RANGE_PARAMS = [
    OpenApiParameter("filter[expectedCloseFrom]", str, description="YYYY-MM-DD, inclusive"),
    OpenApiParameter("filter[expectedCloseTo]", str, description="YYYY-MM-DD, inclusive"),
]

OPPORTUNITY_LIST_PARAMS = [
    OpenApiParameter("filter[status]", str, many=True, enum=list(PipelineStage.CATEGORIES)),
    OpenApiParameter("filter[stage]", str, many=True, description="stage id"),
    *OWNER_PARAMS,
    OpenApiParameter("filter[product]", str, many=True, description="product id"),
    OpenApiParameter("filter[company]", str, many=True, description="company id"),
    *CLOSE_RANGE_PARAMS,
    OpenApiParameter("filter[wonFrom]", str, description="YYYY-MM-DD, workspace time: won on or after"),
    OpenApiParameter("filter[wonTo]", str, description="YYYY-MM-DD, workspace time: won on or before"),
    OpenApiParameter("q", str, description="Matches title or company name"),
    OpenApiParameter(
        "sort", str, description="-updatedAt (default), createdAt, title, expectedValue, expectedCloseDate or wonAt"
    ),
    *PAGE_PARAMS,
]


def _opportunities(request: Any, ws: Any) -> Any:
    return lambda rows: opportunity_data(request.user, rows, ws)


class OpportunityListView(WorkspaceScopedView):
    required = {"GET": perms.OPPORTUNITY_VIEW, "POST": perms.OPPORTUNITY_CREATE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_opportunities_list",
        parameters=OPPORTUNITY_LIST_PARAMS,
        responses={200: SalesOpportunityPage},
    )
    def get(self, request, slug):
        qs = ps.filter_opportunities(ps.opportunities_for(request.user, self.scope), request, self.scope)
        qs, order = ps.opportunity_sort(ps.related(qs), request.query_params.get("sort"))
        return Response(_sorted_page(request, qs, order, _opportunities(request, self.scope)))

    @extend_schema(
        tags=TAGS,
        operation_id="sales_opportunities_create",
        request=SalesOpportunityIn,
        responses={201: SalesOpportunitySerializer},
    )
    def post(self, request, slug):
        opp = svc.create_opportunity(request.user, self.scope, valid(SalesOpportunityIn, request))
        return Response(opportunity_payload(request.user, opp), status=status.HTTP_201_CREATED)


class OpportunityBulkAssignView(WorkspaceScopedView):
    """All-or-nothing: every opportunity must be in the caller's sales.opportunity.assign scope. Quotations follow;
    `creditedUser` never changes."""

    required = {"POST": perms.OPPORTUNITY_ASSIGN}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_opportunities_bulk_assign",
        request=SalesOpportunityBulkAssignIn,
        responses={200: SalesBulkAssignResultSerializer},
    )
    def post(self, request, slug):
        data = valid(SalesOpportunityBulkAssignIn, request)
        n = svc.bulk_assign_opportunities(request.user, self.scope, data["opportunityIds"], data["owner_id"])
        return Response({"updated": n})


class PipelineView(WorkspaceScopedView):
    """The board: open stages in order with count, value and weighted value, and the first cards of each."""

    required = {"GET": perms.OPPORTUNITY_VIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_pipeline_retrieve",
        parameters=[
            *OWNER_PARAMS,
            OpenApiParameter("filter[product]", str, many=True, description="product id"),
            *CLOSE_RANGE_PARAMS,
            OpenApiParameter("limit", int, description="Cards per stage, 1–200, default 50"),
        ],
        responses={200: SalesPipelineSerializer},
    )
    def get(self, request, slug):
        board = ps.pipeline(request.user, self.scope, request)
        params = {"limit": request.query_params.get("limit")}
        order = [("updated_at", True), ("id", False)]
        stages = []
        for col in board["columns"]:
            page = paginate_queryset(
                ps.related(col["rows"]), params, order=order, serialize=_opportunities(request, self.scope)
            )
            stages.append(
                {
                    "stage": SalesStageSerializer(col["stage"]).data,
                    "count": col["count"],
                    "value": f"{col['value']:.2f}",
                    "weightedValue": f"{col['weightedValue']:.2f}",
                    "opportunities": page["data"],
                    "nextCursor": page["nextCursor"],
                }
            )
        return Response(
            {
                "stages": stages,
                "count": board["count"],
                "value": f"{board['value']:.2f}",
                "weightedValue": f"{board['weightedValue']:.2f}",
                "leadCount": board["leadCount"],
            }
        )


class OpportunityRecordView(SalesRecordView):
    model = Opportunity
    kwarg = "opportunity_id"
    not_found_message = ps.OPPORTUNITY_NOT_FOUND

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        ps.opportunity_for(request.user, self.record)

    def respond(self, opp: Opportunity) -> Response:
        return Response(opportunity_payload(self.request.user, opp))


class OpportunityDetailView(OpportunityRecordView):
    required = {"GET": perms.OPPORTUNITY_VIEW, "PATCH": perms.OPPORTUNITY_EDIT, "DELETE": perms.OPPORTUNITY_DELETE}

    @extend_schema(tags=TAGS, operation_id="sales_opportunities_retrieve", responses={200: SalesOpportunitySerializer})
    def get(self, request, opportunity_id):
        return self.respond(self.record)

    @extend_schema(
        tags=TAGS,
        operation_id="sales_opportunities_partial_update",
        request=SalesOpportunityUpdateIn,
        responses={200: SalesOpportunitySerializer},
    )
    def patch(self, request, opportunity_id):
        return self.respond(svc.update_opportunity(request.user, self.record, valid(SalesOpportunityUpdateIn, request)))

    @extend_schema(tags=TAGS, operation_id="sales_opportunities_destroy", responses={204: None})
    def delete(self, request, opportunity_id):
        svc.delete_opportunity(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


class OpportunityMoveView(OpportunityRecordView):
    required = {"POST": perms.OPPORTUNITY_MOVE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_opportunities_move",
        request=SalesOpportunityMoveIn,
        responses={200: SalesOpportunitySerializer},
    )
    def post(self, request, opportunity_id):
        data = valid(SalesOpportunityMoveIn, request)
        return self.respond(svc.move_opportunity(request.user, self.record, data["stage_id"], data["version"]))


class OpportunityWonView(OpportunityRecordView):
    required = {"POST": perms.OPPORTUNITY_CLOSE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_opportunities_won",
        request=SalesOpportunityWonIn,
        responses={200: SalesOpportunitySerializer},
    )
    def post(self, request, opportunity_id):
        return self.respond(svc.win_opportunity(request.user, self.record, valid(SalesOpportunityWonIn, request)))


class OpportunityLostView(OpportunityRecordView):
    required = {"POST": perms.OPPORTUNITY_CLOSE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_opportunities_lost",
        request=SalesOpportunityLostIn,
        responses={200: SalesOpportunitySerializer},
    )
    def post(self, request, opportunity_id):
        return self.respond(svc.lose_opportunity(request.user, self.record, valid(SalesOpportunityLostIn, request)))


class OpportunityReopenView(OpportunityRecordView):
    """Needs sales.opportunity.reopen and sales.opportunity.close, both reaching the record."""

    required = {"POST": perms.OPPORTUNITY_REOPEN}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_opportunities_reopen",
        request=SalesOpportunityReopenIn,
        responses={200: SalesOpportunitySerializer},
    )
    def post(self, request, opportunity_id):
        data = valid(SalesOpportunityReopenIn, request)
        return self.respond(svc.reopen_opportunity(request.user, self.record, data))


class OpportunityTimelineView(OpportunityRecordView):
    """Stage changes and quotation events, newest first; every child of the opportunity, whatever its owner."""

    required = {"GET": perms.OPPORTUNITY_VIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_opportunities_timeline",
        parameters=PAGE_PARAMS,
        responses={200: SalesTimelinePage},
    )
    def get(self, request, opportunity_id):
        return Response(ps.timeline(self.record, request.query_params))


# ───────────────────────── quotations ─────────────────────────

QUOTATION_LIST_PARAMS = [
    OpenApiParameter("filter[status]", str, many=True, enum=list(Quotation.STATUSES)),
    OpenApiParameter("filter[opportunity]", str, many=True, description="opportunity id"),
    *OWNER_PARAMS,
    OpenApiParameter("q", str, description="Matches number, title or company name"),
    OpenApiParameter(
        "sort", str, description="-createdAt (default), createdAt, updatedAt, number, amount or validUntil"
    ),
    *PAGE_PARAMS,
]


class QuotationListView(WorkspaceScopedView):
    required = {"GET": perms.QUOTATION_VIEW, "POST": perms.QUOTATION_CREATE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_quotations_list",
        parameters=QUOTATION_LIST_PARAMS,
        responses={200: SalesQuotationPage},
    )
    def get(self, request, slug):
        qs = ps.filter_quotations(ps.quotations_for(request.user, self.scope), request, self.scope)
        qs = qs.select_related("owner", "opportunity", "opportunity__company")
        qs, order = ps.quotation_sort(qs, request.query_params.get("sort"))
        return Response(_sorted_page(request, qs, order, lambda rows: quotation_data(request.user, rows)))

    @extend_schema(
        tags=TAGS,
        operation_id="sales_quotations_create",
        request=SalesQuotationIn,
        responses={201: SalesQuotationSerializer},
    )
    def post(self, request, slug):
        q = svc.create_quotation(request.user, self.scope, valid(SalesQuotationIn, request))
        return Response(one_quotation(request.user, q), status=status.HTTP_201_CREATED)


class QuotationRecordView(SalesRecordView):
    model = Quotation
    kwarg = "quotation_id"
    not_found_message = ps.QUOTATION_NOT_FOUND

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        ps.quotation_for(request.user, self.record)


class QuotationDetailView(QuotationRecordView):
    required = {"GET": perms.QUOTATION_VIEW, "PATCH": perms.QUOTATION_EDIT, "DELETE": perms.QUOTATION_DELETE}

    @extend_schema(tags=TAGS, operation_id="sales_quotations_retrieve", responses={200: SalesQuotationSerializer})
    def get(self, request, quotation_id):
        return Response(one_quotation(request.user, self.record))

    @extend_schema(
        tags=TAGS,
        operation_id="sales_quotations_partial_update",
        request=SalesQuotationUpdateIn,
        responses={200: SalesQuotationSerializer},
    )
    def patch(self, request, quotation_id):
        q = svc.update_quotation(request.user, self.record, valid(SalesQuotationUpdateIn, request))
        return Response(one_quotation(request.user, q))

    @extend_schema(tags=TAGS, operation_id="sales_quotations_destroy", responses={204: None})
    def delete(self, request, quotation_id):
        svc.delete_quotation(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


class QuotationSendView(QuotationRecordView):
    required = {"POST": perms.QUOTATION_EDIT}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_quotations_send",
        request=SalesQuotationSendIn,
        responses={200: SalesQuotationSerializer},
    )
    def post(self, request, quotation_id):
        q = svc.send_quotation(request.user, self.record, valid(SalesQuotationSendIn, request))
        return Response(one_quotation(request.user, q))


class QuotationAcceptView(QuotationRecordView):
    """sent → accepted. It does not win the opportunity."""

    required = {"POST": perms.QUOTATION_EDIT}

    @extend_schema(
        tags=TAGS, operation_id="sales_quotations_accept", request=None, responses={200: SalesQuotationSerializer}
    )
    def post(self, request, quotation_id):
        q = svc.answer_quotation(request.user, self.record, Quotation.ACCEPTED)
        return Response(one_quotation(request.user, q))


class QuotationRejectView(QuotationRecordView):
    """sent → rejected."""

    required = {"POST": perms.QUOTATION_EDIT}

    @extend_schema(
        tags=TAGS, operation_id="sales_quotations_reject", request=None, responses={200: SalesQuotationSerializer}
    )
    def post(self, request, quotation_id):
        q = svc.answer_quotation(request.user, self.record, Quotation.REJECTED)
        return Response(one_quotation(request.user, q))
