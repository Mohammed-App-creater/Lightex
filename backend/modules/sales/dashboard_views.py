"""Sales dashboard route (S6, docs/sales/api.md §21): `GET /sales/workspaces/{slug}/dashboard`."""

from __future__ import annotations

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.response import Response

from core.workspaces.timezone import workspace_today
from core.workspaces.views import WorkspaceScopedView

from . import dashboard
from . import module as perms
from .activity_serializers import SalesFollowUpCountsSerializer
from .performance_views import SalesKpisSerializer, SalesPeriodSerializer, SalesRankingRowSerializer
from .report_engine import parse_period
from .target_views import MONEY
from .targets import TargetBook

_M = {**MONEY, "allow_null": True}


class SalesDashboardStageSerializer(serializers.Serializer):
    stageId = serializers.UUIDField()
    name = serializers.CharField()
    count = serializers.IntegerField()
    value = serializers.DecimalField(**MONEY)
    weightedValue = serializers.DecimalField(**MONEY)


class SalesDashboardLeadsSerializer(serializers.Serializer):
    count = serializers.IntegerField()
    value = serializers.DecimalField(**MONEY, help_text="Sum of the open leads' estimated values")


class SalesDashboardPipelineSerializer(serializers.Serializer):
    leads = SalesDashboardLeadsSerializer()
    stages = SalesDashboardStageSerializer(many=True)


class _Owned(serializers.Serializer):
    id = serializers.UUIDField()
    ownerId = serializers.UUIDField(allow_null=True)
    ownerName = serializers.CharField(allow_null=True)


class SalesAttentionFollowUpSerializer(_Owned):
    title = serializers.CharField()
    dueDate = serializers.DateField()
    targetType = serializers.CharField()
    targetId = serializers.UUIDField()


class SalesAttentionQuotationSerializer(_Owned):
    number = serializers.CharField()
    title = serializers.CharField()
    amount = serializers.DecimalField(**MONEY)
    sentAt = serializers.DateTimeField(allow_null=True)
    validUntil = serializers.DateField(allow_null=True)
    opportunityId = serializers.UUIDField()
    companyName = serializers.CharField()


class SalesAttentionOpportunitySerializer(_Owned):
    title = serializers.CharField()
    companyName = serializers.CharField()
    stageName = serializers.CharField()
    expectedValue = serializers.DecimalField(**MONEY)
    expectedCloseDate = serializers.DateField(allow_null=True)


def _list(item: type[serializers.Serializer], name: str) -> type[serializers.Serializer]:
    return type(
        name,
        (serializers.Serializer,),
        {"count": serializers.IntegerField(help_text="All matching records"), "items": item(many=True)},
    )


SalesAttentionFollowUpsSerializer = _list(SalesAttentionFollowUpSerializer, "SalesAttentionFollowUpsSerializer")
SalesAttentionQuotationsSerializer = _list(SalesAttentionQuotationSerializer, "SalesAttentionQuotationsSerializer")
SalesAttentionOpportunitiesSerializer = _list(
    SalesAttentionOpportunitySerializer, "SalesAttentionOpportunitiesSerializer"
)


class SalesAttentionSerializer(serializers.Serializer):
    overdueFollowUps = SalesAttentionFollowUpsSerializer()
    quotationsAwaitingResponse = SalesAttentionQuotationsSerializer()
    largeClosingThisWeek = SalesAttentionOpportunitiesSerializer()
    noNextStep = SalesAttentionOpportunitiesSerializer()
    stale = SalesAttentionOpportunitiesSerializer()


class SalesDashboardSerializer(serializers.Serializer):
    period = SalesPeriodSerializer()
    scope = serializers.ChoiceField(choices=["own", "team", "all"], allow_null=True)
    userCount = serializers.IntegerField(help_text="People the numbers cover")
    kpis = SalesKpisSerializer()
    previous = SalesKpisSerializer()
    pipeline = SalesDashboardPipelineSerializer()
    ranking = SalesRankingRowSerializer(many=True)
    followUps = SalesFollowUpCountsSerializer()
    attention = SalesAttentionSerializer()


class DashboardView(WorkspaceScopedView):
    required = {"GET": perms.DASHBOARD_VIEW}

    @extend_schema(
        tags=["sales"],
        operation_id="sales_dashboard",
        parameters=[
            OpenApiParameter(
                "period", str, enum=["today", "week", "month", "quarter", "year"], description="default month"
            ),
            OpenApiParameter("date", str, description="YYYY-MM-DD inside the period; default today (workspace time)"),
            OpenApiParameter("userId", str, description="one person in your dashboard scope (403 outside it)"),
            OpenApiParameter("teamId", str, description="one team in your dashboard scope (403 outside it)"),
        ],
        responses={200: SalesDashboardSerializer},
    )
    def get(self, request, slug):
        ws = self.scope
        book = TargetBook(ws)
        today = workspace_today(ws)
        period = parse_period(request.query_params, book, today, custom=False)
        data = dashboard.build(
            request.user,
            ws,
            period,
            today=today,
            book=book,
            user_id=request.query_params.get("userId"),
            team_id=request.query_params.get("teamId"),
        )
        return Response(SalesDashboardSerializer(data).data)
