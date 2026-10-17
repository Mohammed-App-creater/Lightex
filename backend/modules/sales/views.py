"""Sales API views (docs/sales/api.md). Thin: permission per method, then a selector or a service.

Workspace collections live under `sales/workspaces/{slug}/…` (`WorkspaceScopedView`); single records under
`sales/<collection>/{id}` (`SalesRecordView`, whose scope is the record's workspace: 404 for non-members). The
module guard (403 `module_disabled`) runs after the membership check and before the permission check. Owned records
outside the caller's view scope answer 404.
"""

from __future__ import annotations

from typing import Any, ClassVar

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.response import Response

from core.access.permissions import ScopedView
from core.common.exceptions import invalid, not_found
from core.common.pagination import paginate_queryset
from core.common.params import body, filter_value
from core.common.schema import page_of
from core.common.utils import iso
from core.workspaces.selectors import workspaces_for
from core.workspaces.views import WorkspaceScopedView

from . import module as perms
from . import scope, selectors, services
from .activity_selectors import company_activity
from .activity_serializers import SalesCompanySummarySerializer
from .models import Company, Contact, Holiday, LostReason, PipelineStage, Product
from .pipeline_selectors import company_deals
from .serializers import (
    SalesCalendarIn,
    SalesCalendarSerializer,
    SalesCompanyIn,
    SalesCompanySerializer,
    SalesCompanyUpdateIn,
    SalesContactIn,
    SalesContactSerializer,
    SalesContactUpdateIn,
    SalesDuplicateCheckSerializer,
    SalesHolidayIn,
    SalesHolidaySerializer,
    SalesHolidayUpdateIn,
    SalesLostReasonIn,
    SalesLostReasonSerializer,
    SalesLostReasonUpdateIn,
    SalesProductIn,
    SalesProductSerializer,
    SalesProductUpdateIn,
    SalesSettingsIn,
    SalesSettingsSerializer,
    SalesStageIn,
    SalesStageReorderIn,
    SalesStageSerializer,
    SalesStageUpdateIn,
)

TAGS = ["sales"]
USE = perms.DASHBOARD_VIEW  # reading reference data: anyone who can open Sales
MANAGE = perms.SETTINGS_MANAGE

SalesCompanyPage = page_of("SalesCompanyPage", SalesCompanySerializer)
SalesContactPage = page_of("SalesContactPage", SalesContactSerializer)

ACTIVE_PARAM = OpenApiParameter("filter[active]", str, enum=["true", "false"])
PAGE_PARAMS = [OpenApiParameter("cursor", str), OpenApiParameter("limit", int, description="1–200, default 50")]


def valid(serializer_class: Any, request: Any, **kwargs: Any) -> dict[str, Any]:
    s = serializer_class(data=body(request), **kwargs)
    s.is_valid(raise_exception=True)
    return dict(s.validated_data)


class SalesRecordView(ScopedView):
    # Scope = the workspace of the record named in the URL (404 for unknown ids and for non-members). A comment, not a
    # docstring: subclasses would inherit it as their API description.

    model: ClassVar[Any] = None
    kwarg: ClassVar[str] = ""
    not_found_message: ClassVar[str] = "Not found."

    def get_scope(self):
        self.record = selectors.get_record(self.model, self.kwargs[self.kwarg], self.not_found_message)
        ws = workspaces_for(self.request.user).filter(pk=self.record.workspace_id).first()
        if ws is None:
            raise not_found(self.not_found_message)
        return ws


# ───────────────────────── settings ─────────────────────────


class SettingsView(WorkspaceScopedView):
    required = {"GET": USE, "PUT": MANAGE}

    @extend_schema(tags=TAGS, operation_id="sales_settings_retrieve", responses={200: SalesSettingsSerializer})
    def get(self, request, slug):
        return Response(SalesSettingsSerializer(selectors.get_settings(self.scope)).data)

    @extend_schema(
        tags=TAGS,
        operation_id="sales_settings_update",
        request=SalesSettingsIn,
        responses={200: SalesSettingsSerializer},
    )
    def put(self, request, slug):
        s = services.update_settings(request.user, self.scope, valid(SalesSettingsIn, request))
        return Response(SalesSettingsSerializer(s).data)


# ───────────────────────── stages ─────────────────────────


def _stages(ws: Any) -> Any:
    return SalesStageSerializer(selectors.stages(ws), many=True).data


class StageListView(WorkspaceScopedView):
    required = {"GET": USE, "POST": MANAGE}

    @extend_schema(tags=TAGS, operation_id="sales_stages_list", responses={200: SalesStageSerializer(many=True)})
    def get(self, request, slug):
        return Response(_stages(self.scope))

    @extend_schema(
        tags=TAGS, operation_id="sales_stages_create", request=SalesStageIn, responses={201: SalesStageSerializer}
    )
    def post(self, request, slug):
        stage = services.create_stage(request.user, self.scope, valid(SalesStageIn, request))
        return Response(SalesStageSerializer(stage).data, status=status.HTTP_201_CREATED)


class StageReorderView(WorkspaceScopedView):
    required = {"POST": MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_stages_reorder",
        request=SalesStageReorderIn,
        responses={200: SalesStageSerializer(many=True)},
    )
    def post(self, request, slug):
        services.reorder_stages(request.user, self.scope, valid(SalesStageReorderIn, request)["stageIds"])
        return Response(_stages(self.scope))


class StageDetailView(SalesRecordView):
    model = PipelineStage
    kwarg = "stage_id"
    not_found_message = "Stage not found."
    required = {"PATCH": MANAGE, "DELETE": MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_stages_partial_update",
        request=SalesStageUpdateIn,
        responses={200: SalesStageSerializer},
    )
    def patch(self, request, stage_id):
        stage = services.update_stage(request.user, self.record, valid(SalesStageUpdateIn, request))
        return Response(SalesStageSerializer(stage).data)

    @extend_schema(tags=TAGS, operation_id="sales_stages_destroy", responses={204: None})
    def delete(self, request, stage_id):
        services.delete_stage(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ───────────────────────── products ─────────────────────────


class ProductListView(WorkspaceScopedView):
    required = {"GET": USE, "POST": MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_products_list",
        parameters=[ACTIVE_PARAM],
        responses={200: SalesProductSerializer(many=True)},
    )
    def get(self, request, slug):
        rows = selectors.products(self.scope, filter_value(request, "active"))
        return Response(SalesProductSerializer(rows, many=True).data)

    @extend_schema(
        tags=TAGS, operation_id="sales_products_create", request=SalesProductIn, responses={201: SalesProductSerializer}
    )
    def post(self, request, slug):
        product = services.create_product(request.user, self.scope, valid(SalesProductIn, request))
        return Response(SalesProductSerializer(product).data, status=status.HTTP_201_CREATED)


class ProductDetailView(SalesRecordView):
    model = Product
    kwarg = "product_id"
    not_found_message = "Product not found."
    required = {"PATCH": MANAGE, "DELETE": MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_products_partial_update",
        request=SalesProductUpdateIn,
        responses={200: SalesProductSerializer},
    )
    def patch(self, request, product_id):
        product = services.update_product(request.user, self.record, valid(SalesProductUpdateIn, request))
        return Response(SalesProductSerializer(product).data)

    @extend_schema(tags=TAGS, operation_id="sales_products_destroy", responses={204: None})
    def delete(self, request, product_id):
        services.delete_product(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ───────────────────────── lost reasons ─────────────────────────


class LostReasonListView(WorkspaceScopedView):
    required = {"GET": USE, "POST": MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_lost_reasons_list",
        parameters=[ACTIVE_PARAM],
        responses={200: SalesLostReasonSerializer(many=True)},
    )
    def get(self, request, slug):
        rows = selectors.lost_reasons(self.scope, filter_value(request, "active"))
        return Response(SalesLostReasonSerializer(rows, many=True).data)

    @extend_schema(
        tags=TAGS,
        operation_id="sales_lost_reasons_create",
        request=SalesLostReasonIn,
        responses={201: SalesLostReasonSerializer},
    )
    def post(self, request, slug):
        reason = services.create_lost_reason(request.user, self.scope, valid(SalesLostReasonIn, request))
        return Response(SalesLostReasonSerializer(reason).data, status=status.HTTP_201_CREATED)


class LostReasonDetailView(SalesRecordView):
    model = LostReason
    kwarg = "lost_reason_id"
    not_found_message = "Lost reason not found."
    required = {"PATCH": MANAGE, "DELETE": MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_lost_reasons_partial_update",
        request=SalesLostReasonUpdateIn,
        responses={200: SalesLostReasonSerializer},
    )
    def patch(self, request, lost_reason_id):
        reason = services.update_lost_reason(request.user, self.record, valid(SalesLostReasonUpdateIn, request))
        return Response(SalesLostReasonSerializer(reason).data)

    @extend_schema(tags=TAGS, operation_id="sales_lost_reasons_destroy", responses={204: None})
    def delete(self, request, lost_reason_id):
        services.delete_lost_reason(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ───────────────────────── calendar and holidays ─────────────────────────


class CalendarView(WorkspaceScopedView):
    required = {"GET": USE, "PUT": MANAGE}

    @extend_schema(tags=TAGS, operation_id="sales_calendar_retrieve", responses={200: SalesCalendarSerializer})
    def get(self, request, slug):
        return Response(SalesCalendarSerializer(selectors.get_calendar(self.scope)).data)

    @extend_schema(
        tags=TAGS,
        operation_id="sales_calendar_update",
        request=SalesCalendarIn,
        responses={200: SalesCalendarSerializer},
    )
    def put(self, request, slug):
        weights = valid(SalesCalendarIn, request)["weekdayWeights"]
        return Response(SalesCalendarSerializer(services.update_calendar(request.user, self.scope, weights)).data)


class HolidayListView(WorkspaceScopedView):
    required = {"GET": USE, "POST": MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_holidays_list",
        parameters=[OpenApiParameter("filter[year]", int)],
        responses={200: SalesHolidaySerializer(many=True)},
    )
    def get(self, request, slug):
        rows = selectors.holidays(self.scope, filter_value(request, "year"))
        return Response(SalesHolidaySerializer(rows, many=True).data)

    @extend_schema(
        tags=TAGS, operation_id="sales_holidays_create", request=SalesHolidayIn, responses={201: SalesHolidaySerializer}
    )
    def post(self, request, slug):
        holiday = services.create_holiday(request.user, self.scope, valid(SalesHolidayIn, request))
        return Response(SalesHolidaySerializer(holiday).data, status=status.HTTP_201_CREATED)


class HolidayDetailView(SalesRecordView):
    model = Holiday
    kwarg = "holiday_id"
    not_found_message = "Holiday not found."
    required = {"PATCH": MANAGE, "DELETE": MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_holidays_partial_update",
        request=SalesHolidayUpdateIn,
        responses={200: SalesHolidaySerializer},
    )
    def patch(self, request, holiday_id):
        holiday = services.update_holiday(request.user, self.record, valid(SalesHolidayUpdateIn, request))
        return Response(SalesHolidaySerializer(holiday).data)

    @extend_schema(tags=TAGS, operation_id="sales_holidays_destroy", responses={204: None})
    def delete(self, request, holiday_id):
        services.delete_holiday(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ───────────────────────── companies ─────────────────────────


def _owned_context(user: Any, ws: Any, model: Any, rows: list[Any], edit: str, delete: str) -> dict[str, Any]:
    ids = [r.pk for r in rows]
    return {
        "editable": scope.ids_in_scope(user, ws, model, ids, edit),
        "deletable": scope.ids_in_scope(user, ws, model, ids, delete),
    }


def company_data(user: Any, rows: list[Company]) -> Any:
    if not rows:
        return []
    ctx = _owned_context(user, rows[0].workspace_id, Company, rows, perms.COMPANY_EDIT, perms.COMPANY_DELETE)
    return SalesCompanySerializer(rows, many=True, context=ctx).data


def one_company(user: Any, company: Company) -> dict[str, Any]:
    fresh = Company.objects.for_workspace(company.workspace_id).select_related("owner").get(pk=company.pk)
    return company_data(user, [fresh])[0]


def contact_data(user: Any, rows: list[Contact]) -> Any:
    if not rows:
        return []
    ctx = _owned_context(user, rows[0].workspace_id, Contact, rows, perms.CONTACT_EDIT, perms.CONTACT_DELETE)
    return SalesContactSerializer(rows, many=True, context=ctx).data


def one_contact(user: Any, contact: Contact) -> dict[str, Any]:
    fresh = Contact.objects.for_workspace(contact.workspace_id).select_related("owner", "company").get(pk=contact.pk)
    return contact_data(user, [fresh])[0]


COMPANY_LIST_PARAMS = [
    OpenApiParameter("filter[status]", str, many=True, enum=list(Company.STATUSES)),
    OpenApiParameter("filter[owner]", str, many=True, description="user id or `me`"),
    OpenApiParameter("filter[industry]", str, many=True),
    OpenApiParameter("filter[region]", str, many=True),
    OpenApiParameter("filter[city]", str, many=True),
    OpenApiParameter("q", str, description="Matches name, phone, email or city"),
    OpenApiParameter(
        "sort", str, description="name (default), createdAt, updatedAt or status; prefix - for descending"
    ),
    *PAGE_PARAMS,
]


class CompanyListView(WorkspaceScopedView):
    required = {"GET": perms.COMPANY_VIEW, "POST": perms.COMPANY_CREATE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_companies_list",
        parameters=COMPANY_LIST_PARAMS,
        responses={200: SalesCompanyPage},
    )
    def get(self, request, slug):
        order, name = selectors.sort_spec(request.query_params.get("sort"), selectors.COMPANY_SORTS)
        qs = selectors.filter_companies(selectors.companies_for(request.user, self.scope), request)
        qs = selectors.with_sort(qs, name).select_related("owner")
        return Response(
            paginate_queryset(
                qs, request.query_params, order=order, serialize=lambda rows: company_data(request.user, rows)
            )
        )

    @extend_schema(
        tags=TAGS,
        operation_id="sales_companies_create",
        request=SalesCompanyIn,
        responses={201: SalesCompanySerializer},
    )
    def post(self, request, slug):
        company = services.create_company(request.user, self.scope, valid(SalesCompanyIn, request))
        return Response(one_company(request.user, company), status=status.HTTP_201_CREATED)


class CompanyDuplicateCheckView(WorkspaceScopedView):
    """Says whether a live company in the workspace matches, and who owns it, whatever the caller's scope. It
    returns nothing else (no id, no name, no details)."""

    required = {"GET": perms.COMPANY_VIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_companies_check_duplicate",
        parameters=[
            OpenApiParameter("name", str, description="Matched after normalization (case, punctuation, PLC/Ltd…)"),
            OpenApiParameter("phone", str, description="Matched on the last nine digits"),
            OpenApiParameter("excludeId", str, description="A company to ignore (the one being edited)"),
        ],
        responses={200: SalesDuplicateCheckSerializer},
    )
    def get(self, request, slug):
        name = (request.query_params.get("name") or "").strip()
        phone = (request.query_params.get("phone") or "").strip()
        if not name and not phone:
            raise invalid({"name": "Send a name or a phone number"})
        exclude = request.query_params.get("excludeId") or None
        if exclude is not None and selectors.as_uuid(exclude) is None:
            raise invalid({"excludeId": "Use a company id"})
        match = selectors.duplicate_of(self.scope, name, phone, exclude)
        owner = match.owner.name if match is not None and match.owner_id else None
        return Response({"exists": match is not None, "ownerName": owner})


class CompanyRecordView(SalesRecordView):
    model = Company
    kwarg = "company_id"
    not_found_message = selectors.COMPANY_NOT_FOUND


class CompanyDetailView(CompanyRecordView):
    required = {"GET": perms.COMPANY_VIEW, "PATCH": perms.COMPANY_EDIT, "DELETE": perms.COMPANY_DELETE}

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        selectors.company_for(request.user, self.record)  # 404 outside the view scope, for every method

    @extend_schema(tags=TAGS, operation_id="sales_companies_retrieve", responses={200: SalesCompanySerializer})
    def get(self, request, company_id):
        return Response(one_company(request.user, self.record))

    @extend_schema(
        tags=TAGS,
        operation_id="sales_companies_partial_update",
        request=SalesCompanyUpdateIn,
        responses={200: SalesCompanySerializer},
    )
    def patch(self, request, company_id):
        company = services.update_company(request.user, self.record, valid(SalesCompanyUpdateIn, request))
        return Response(one_company(request.user, company))

    @extend_schema(tags=TAGS, operation_id="sales_companies_destroy", responses={204: None})
    def delete(self, request, company_id):
        services.delete_company(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


class CompanySummaryView(CompanyRecordView):
    required = {"GET": perms.COMPANY_VIEW}

    @extend_schema(tags=TAGS, operation_id="sales_companies_summary", responses={200: SalesCompanySummarySerializer})
    def get(self, request, company_id):
        company = selectors.company_for(request.user, self.record)
        summary = selectors.company_summary(request.user, company)
        primary = summary["primaryContact"]
        deals = company_deals(request.user, company)
        activity = company_activity(request.user, company)
        return Response(
            {
                "company": one_company(request.user, company),
                "contactCount": summary["contactCount"],
                "primaryContact": one_contact(request.user, primary) if primary is not None else None,
                "openOpportunityCount": deals["openOpportunityCount"],
                "pipelineValue": f"{deals['pipelineValue']:.2f}",
                "wonValue": f"{deals['wonValue']:.2f}",
                "openFollowUpCount": activity["openFollowUpCount"],
                "lastContactAt": iso(activity["lastContactAt"]),
                "timeline": activity["timeline"],
            }
        )


# ───────────────────────── contacts ─────────────────────────

CONTACT_LIST_PARAMS = [
    OpenApiParameter("filter[company]", str, many=True, description="company id"),
    OpenApiParameter("filter[owner]", str, many=True, description="user id or `me`"),
    OpenApiParameter("filter[primary]", str, enum=["true", "false"]),
    OpenApiParameter("q", str, description="Matches name, phone, email or company name"),
    OpenApiParameter("sort", str, description="name (default), createdAt or updatedAt; prefix - for descending"),
    *PAGE_PARAMS,
]


class ContactListView(WorkspaceScopedView):
    required = {"GET": perms.CONTACT_VIEW, "POST": perms.CONTACT_CREATE}

    @extend_schema(
        tags=TAGS, operation_id="sales_contacts_list", parameters=CONTACT_LIST_PARAMS, responses={200: SalesContactPage}
    )
    def get(self, request, slug):
        order, name = selectors.sort_spec(request.query_params.get("sort"), selectors.CONTACT_SORTS)
        qs = selectors.filter_contacts(selectors.contacts_for(request.user, self.scope), request)
        qs = selectors.with_sort(qs, name).select_related("owner", "company")
        return Response(
            paginate_queryset(
                qs, request.query_params, order=order, serialize=lambda rows: contact_data(request.user, rows)
            )
        )

    @extend_schema(
        tags=TAGS, operation_id="sales_contacts_create", request=SalesContactIn, responses={201: SalesContactSerializer}
    )
    def post(self, request, slug):
        contact = services.create_contact(request.user, self.scope, valid(SalesContactIn, request))
        return Response(one_contact(request.user, contact), status=status.HTTP_201_CREATED)


class ContactDetailView(SalesRecordView):
    model = Contact
    kwarg = "contact_id"
    not_found_message = selectors.CONTACT_NOT_FOUND
    required = {"GET": perms.CONTACT_VIEW, "PATCH": perms.CONTACT_EDIT, "DELETE": perms.CONTACT_DELETE}

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        selectors.contact_for(request.user, self.record)

    @extend_schema(tags=TAGS, operation_id="sales_contacts_retrieve", responses={200: SalesContactSerializer})
    def get(self, request, contact_id):
        return Response(one_contact(request.user, self.record))

    @extend_schema(
        tags=TAGS,
        operation_id="sales_contacts_partial_update",
        request=SalesContactUpdateIn,
        responses={200: SalesContactSerializer},
    )
    def patch(self, request, contact_id):
        contact = services.update_contact(request.user, self.record, valid(SalesContactUpdateIn, request))
        return Response(one_contact(request.user, contact))

    @extend_schema(tags=TAGS, operation_id="sales_contacts_destroy", responses={204: None})
    def delete(self, request, contact_id):
        services.delete_contact(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)
