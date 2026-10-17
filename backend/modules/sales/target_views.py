"""Sales target routes (S4, docs/sales/api.md §14): list, create-or-update, read, delete, the allocation tree, allocate
and the effective targets of a user. Reads need `sales.target.view` and show only subjects in its scope; writes need
`sales.target.manage` with the subject inside its scope (403 otherwise)."""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.utils.dateparse import parse_date
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers, status
from rest_framework.response import Response

from core.common.exceptions import invalid, not_found
from core.workspaces.timezone import workspace_today
from core.workspaces.views import WorkspaceScopedView

from . import kpi, people
from . import module as perms
from . import targets as svc
from .defaults import ensure_defaults
from .models import Target
from .selectors import as_uuid
from .views import TAGS, SalesRecordView, valid

TARGET_NOT_FOUND = "Target not found."
MONEY: dict[str, Any] = {"max_digits": 16, "decimal_places": 2}
PCT: dict[str, Any] = {"max_digits": 9, "decimal_places": 1, "coerce_to_string": False}


# ───────────────────────── serializers ─────────────────────────


class SalesTargetSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    subjectType = serializers.ChoiceField(source="subject_type", choices=Target.SUBJECTS)
    subjectId = serializers.UUIDField(source="subject_id", allow_null=True)
    periodType = serializers.ChoiceField(source="period_type", choices=Target.PERIOD_TYPES)
    periodStart = serializers.DateField(source="period_start")
    periodEnd = serializers.SerializerMethodField()
    amount = serializers.DecimalField(**MONEY)
    note = serializers.CharField()
    updatedAt = serializers.DateTimeField(source="updated_at")

    def get_periodEnd(self, obj) -> dt.date:
        return svc.aligned(obj.period_type, obj.period_start, self.context["settings"]).end


class SalesTargetIn(serializers.Serializer):
    subjectType = serializers.ChoiceField(choices=Target.SUBJECTS)
    subjectId = serializers.UUIDField(required=False, allow_null=True, help_text="User or team id; omit for company")
    periodType = serializers.ChoiceField(choices=Target.PERIOD_TYPES)
    periodStart = serializers.DateField(help_text="First day of the (fiscal) year, quarter or month")
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0)
    note = serializers.CharField(max_length=500, required=False, allow_blank=True)


class SalesTargetAllocateIn(serializers.Serializer):
    subjectType = serializers.ChoiceField(choices=Target.SUBJECTS)
    subjectId = serializers.UUIDField(required=False, allow_null=True)
    year = serializers.IntegerField(min_value=1900, max_value=2200, help_text="The fiscal year starting in this year")
    method = serializers.ChoiceField(choices=svc.METHODS)
    quarters = serializers.ListField(
        child=serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0), required=False, allow_null=True
    )
    months = serializers.ListField(
        child=serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0), required=False, allow_null=True
    )


class SalesTargetMonthSerializer(serializers.Serializer):
    start = serializers.DateField()
    end = serializers.DateField()
    amount = serializers.DecimalField(**MONEY, allow_null=True)


class SalesTargetQuarterSerializer(SalesTargetMonthSerializer):
    months = SalesTargetMonthSerializer(many=True)
    allocationGap = serializers.DecimalField(**MONEY, allow_null=True, help_text="Quarter minus its stored months")


class SalesTargetYearSerializer(serializers.Serializer):
    subjectType = serializers.ChoiceField(choices=Target.SUBJECTS)
    subjectId = serializers.UUIDField(allow_null=True)
    name = serializers.CharField()
    year = serializers.IntegerField()
    start = serializers.DateField()
    end = serializers.DateField()
    target = serializers.DecimalField(**MONEY, allow_null=True, help_text="The stored year target")
    quarters = SalesTargetQuarterSerializer(many=True)
    quarterGap = serializers.DecimalField(**MONEY, allow_null=True, help_text="Year minus its stored quarters")
    monthGap = serializers.DecimalField(**MONEY, allow_null=True, help_text="Year minus its stored months")


class _Allocated(SalesTargetYearSerializer):
    allocated = serializers.DecimalField(**MONEY, help_text="Sum of the children's year targets")
    unallocated = serializers.DecimalField(**MONEY, allow_null=True)
    allocationGap = serializers.DecimalField(**MONEY, allow_null=True, help_text="Target minus allocated (signed)")


class SalesTargetAllocationUser(_Allocated):
    children = serializers.ListField(child=serializers.DictField(), help_text="Always empty")


class SalesTargetAllocationTeam(_Allocated):
    children = SalesTargetAllocationUser(many=True)


class SalesTargetAllocationSerializer(_Allocated):
    children = SalesTargetAllocationTeam(many=True, help_text="Teams (company), users (team) or none (user)")


class SalesEffectivePeriodSerializer(serializers.Serializer):
    start = serializers.DateField()
    end = serializers.DateField()
    target = serializers.DecimalField(**MONEY, allow_null=True)
    actual = serializers.DecimalField(**MONEY, help_text="Won value from the period start through `date`")
    achievement = serializers.DecimalField(**PCT, allow_null=True)
    remainingWorkingDays = serializers.DecimalField(max_digits=6, decimal_places=2, coerce_to_string=False)
    requiredDailyRunRate = serializers.DecimalField(**MONEY, allow_null=True)


class SalesEffectiveTargetsSerializer(serializers.Serializer):
    userId = serializers.UUIDField()
    date = serializers.DateField()
    day = SalesEffectivePeriodSerializer()
    week = SalesEffectivePeriodSerializer()
    month = SalesEffectivePeriodSerializer()
    quarter = SalesEffectivePeriodSerializer()
    year = SalesEffectivePeriodSerializer()


def _rows(ws: Any, rows: Any) -> Any:
    return SalesTargetSerializer(rows, many=True, context={"settings": ensure_defaults(ws)}).data


def _one(ws: Any, row: Target) -> Any:
    return SalesTargetSerializer(row, context={"settings": ensure_defaults(ws)}).data


def _date(raw: str | None, name: str, default: dt.date) -> dt.date:
    if not raw:
        return default
    day = parse_date(raw)
    if day is None:
        raise invalid({name: "Use YYYY-MM-DD"})
    return day


# ───────────────────────── views ─────────────────────────

LIST_PARAMS = [
    OpenApiParameter("filter[subjectType]", str, enum=list(Target.SUBJECTS)),
    OpenApiParameter("filter[subjectId]", str, description="user or team id"),
    OpenApiParameter("filter[periodType]", str, enum=list(Target.PERIOD_TYPES)),
    OpenApiParameter("filter[year]", int, description="fiscal year (the one starting in this calendar year)"),
]


class TargetListView(WorkspaceScopedView):
    required = {"GET": perms.TARGET_VIEW, "POST": perms.TARGET_MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_targets_list",
        parameters=LIST_PARAMS,
        responses={200: SalesTargetSerializer(many=True)},
    )
    def get(self, request, slug):
        qs = svc.visible_targets(request.user, self.scope)
        q = request.query_params
        if q.get("filter[subjectType]"):
            qs = qs.filter(subject_type=q["filter[subjectType]"])
        if q.get("filter[subjectId]"):
            sid = as_uuid(q["filter[subjectId]"])
            if sid is None:
                raise invalid({"filter[subjectId]": "Use a user or team id"})
            qs = qs.filter(subject_id=sid)
        if q.get("filter[periodType]"):
            qs = qs.filter(period_type=q["filter[periodType]"])
        if q.get("filter[year]"):
            year = q["filter[year]"]
            if not year.isdigit() or not 1900 <= int(year) <= 2200:
                raise invalid({"filter[year]": "Pick a year"})
            fy = svc.fiscal_year(ensure_defaults(self.scope), int(year))
            qs = qs.filter(period_start__range=(fy.start, fy.end))
        return Response(_rows(self.scope, qs.order_by("subject_type", "subject_id", "period_start", "period_type")))

    @extend_schema(
        tags=TAGS,
        operation_id="sales_targets_set",
        description="Create or update the subject's target for one period (200 updated, 201 created).",
        request=SalesTargetIn,
        responses={200: SalesTargetSerializer, 201: SalesTargetSerializer},
    )
    def post(self, request, slug):
        row, created = svc.set_target(request.user, self.scope, valid(SalesTargetIn, request))
        return Response(_one(self.scope, row), status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class TargetDetailView(SalesRecordView):
    model = Target
    kwarg = "sales_target_id"
    not_found_message = TARGET_NOT_FOUND
    required = {"GET": perms.TARGET_VIEW, "DELETE": perms.TARGET_MANAGE}

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        subj = svc.subject(self.record.subject_type, self.record.subject_id)
        if not svc.can_reach(request.user, self.scope, perms.TARGET_VIEW, subj):
            raise not_found(TARGET_NOT_FOUND)

    @extend_schema(tags=TAGS, operation_id="sales_targets_retrieve", responses={200: SalesTargetSerializer})
    def get(self, request, sales_target_id):
        return Response(_one(self.scope, self.record))

    @extend_schema(tags=TAGS, operation_id="sales_targets_destroy", responses={204: None})
    def delete(self, request, sales_target_id):
        svc.delete_target(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TargetAllocationView(WorkspaceScopedView):
    required = {"GET": perms.TARGET_VIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_targets_allocation",
        parameters=[
            OpenApiParameter(
                "subject", str, description="company, team:<id> or user:<id>; default company (scope all) or yourself"
            ),
            OpenApiParameter("year", int, description="fiscal year; default the current one"),
        ],
        responses={200: SalesTargetAllocationSerializer},
    )
    def get(self, request, slug):
        settings = ensure_defaults(self.scope)
        raw = request.query_params.get("year")
        if raw:
            if not raw.isdigit() or not 1900 <= int(raw) <= 2200:
                raise invalid({"year": "Pick a year"})
            year = int(raw)
        else:
            year = svc.fiscal_year_of(workspace_today(self.scope), settings)
        subject = request.query_params.get("subject") or (
            "company" if people.sees_company(request.user, self.scope, perms.TARGET_VIEW) else f"user:{request.user.pk}"
        )
        return Response(
            SalesTargetAllocationSerializer(svc.allocation_tree(request.user, self.scope, subject, year)).data
        )


class TargetAllocateView(WorkspaceScopedView):
    required = {"POST": perms.TARGET_MANAGE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_targets_allocate",
        request=SalesTargetAllocateIn,
        responses={200: SalesTargetYearSerializer},
    )
    def post(self, request, slug):
        node = svc.allocate(request.user, self.scope, valid(SalesTargetAllocateIn, request))
        return Response(SalesTargetYearSerializer(node).data)


class TargetEffectiveView(WorkspaceScopedView):
    required = {"GET": perms.TARGET_VIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_targets_effective",
        parameters=[
            OpenApiParameter("userId", str, description="default: the caller"),
            OpenApiParameter("date", str, description="YYYY-MM-DD; default today (workspace time)"),
        ],
        responses={200: SalesEffectiveTargetsSerializer},
    )
    def get(self, request, slug):
        user_id = request.query_params.get("userId") or str(request.user.pk)
        if user_id not in people.visible_user_ids(request.user, self.scope, perms.TARGET_VIEW):
            raise not_found("User not found.")
        day = _date(request.query_params.get("date"), "date", workspace_today(self.scope))
        data = {"userId": user_id, "date": day, **kpi.effective(self.scope, user_id, day)}
        return Response(SalesEffectiveTargetsSerializer(data).data)
