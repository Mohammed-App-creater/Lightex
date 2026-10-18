"""Sales performance routes (S4, docs/sales/api.md §15): one salesperson's KPIs with the previous period and status,
and the ranking. People come from the caller's `sales.performance.view` scope (`people.visible_user_ids`); a user
outside it answers 404."""

from __future__ import annotations

import datetime as dt
from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.response import Response

from core.access import services as access
from core.accounts.models import User
from core.common.exceptions import invalid, not_found
from core.workspaces.timezone import workspace_today
from core.workspaces.views import WorkspaceScopedView

from . import kpi, people
from . import module as perms
from .periods import KINDS, MONTH, Period
from .selectors import as_uuid
from .serializers import SalesUserBriefSerializer, _user
from .target_views import MONEY, PCT, _date
from .targets import TargetBook

STATUSES = (kpi.GREEN, kpi.YELLOW, kpi.RED)


class SalesPeriodSerializer(serializers.Serializer):
    kind = serializers.CharField()
    start = serializers.DateField()
    end = serializers.DateField()


class SalesKpisSerializer(serializers.Serializer):
    period = SalesPeriodSerializer()
    actual = serializers.DecimalField(**MONEY)
    target = serializers.DecimalField(**MONEY, allow_null=True)
    achievement = serializers.DecimalField(**PCT, allow_null=True)
    expected = serializers.DecimalField(
        **MONEY, allow_null=True, help_text="Pro-rata target so far (current period) or the target (closed)"
    )
    status = serializers.CharField(allow_null=True, help_text="green, yellow, red or null")
    wonCount = serializers.IntegerField(source="won_count")
    lostCount = serializers.IntegerField(source="lost_count")
    winRate = serializers.DecimalField(source="win_rate", **PCT, allow_null=True)
    averageDealSize = serializers.DecimalField(source="average_deal_size", **MONEY, allow_null=True)
    newLeads = serializers.IntegerField(source="new_leads")
    convertedLeads = serializers.IntegerField(source="converted_leads")
    leadToOpportunityRate = serializers.DecimalField(source="lead_to_opportunity_rate", **PCT, allow_null=True)
    newOpportunities = serializers.IntegerField(source="new_opportunities")
    pipelineValue = serializers.DecimalField(source="pipeline_value", **MONEY)
    pipelineValueInPeriod = serializers.DecimalField(source="pipeline_value_in_period", **MONEY)
    weightedPipeline = serializers.DecimalField(source="weighted_pipeline", **MONEY)
    pipelineCoverage = serializers.DecimalField(
        source="pipeline_coverage", max_digits=12, decimal_places=2, coerce_to_string=False, allow_null=True
    )
    followUpsDue = serializers.IntegerField(source="followups_due")
    followUpsOnTime = serializers.IntegerField(source="followups_on_time")
    followUpPerformance = serializers.DecimalField(source="followup_performance", **PCT, allow_null=True)
    growth = serializers.DecimalField(**PCT, allow_null=True)


class SalesUserPerformanceSerializer(serializers.Serializer):
    user = SalesUserBriefSerializer()
    current = SalesKpisSerializer()
    previous = SalesKpisSerializer()


class SalesRankingRowSerializer(serializers.Serializer):
    rank = serializers.IntegerField()
    user = SalesUserBriefSerializer()
    actual = serializers.DecimalField(**MONEY)
    target = serializers.DecimalField(**MONEY, allow_null=True)
    achievement = serializers.DecimalField(**PCT, allow_null=True)
    status = serializers.CharField(allow_null=True, help_text="green, yellow, red or null")
    wonCount = serializers.IntegerField()


class SalesRankingSerializer(serializers.Serializer):
    period = SalesPeriodSerializer()
    rows = SalesRankingRowSerializer(many=True)


PERIOD_PARAMS = [
    OpenApiParameter("period", str, enum=list(KINDS), description="default month"),
    OpenApiParameter("date", str, description="YYYY-MM-DD inside the period; default today (workspace time)"),
]


def _period(request: Any, ws: Any, book: TargetBook) -> tuple[Period, dt.date]:
    kind = request.query_params.get("period") or MONTH
    if kind not in KINDS:
        raise invalid({"period": f"Use one of {', '.join(KINDS)}"})
    today = workspace_today(ws)
    return book.period(kind, _date(request.query_params.get("date"), "date", today)), today


class PerformanceUserView(WorkspaceScopedView):
    required = {"GET": perms.PERFORMANCE_VIEW}

    @extend_schema(
        tags=["sales"],
        operation_id="sales_performance_user",
        parameters=PERIOD_PARAMS,
        responses={200: SalesUserPerformanceSerializer},
    )
    def get(self, request, slug, user_id):
        if str(user_id) not in people.visible_user_ids(request.user, self.scope, perms.PERFORMANCE_VIEW):
            raise not_found("User not found.")
        book = TargetBook(self.scope)
        period, today = _period(request, self.scope, book)
        k = kpi.compute(self.scope, period, [user_id], today=today, book=book)
        data = {"user": _user(User.objects.get(pk=user_id)), "current": k, "previous": k.previous}
        return Response(SalesUserPerformanceSerializer(data).data)


def _sellers(ws: Any, ids: set[str]) -> set[str]:
    """Users who can sell (hold `sales.opportunity.create`)."""
    users = User.objects.filter(pk__in=list(ids))
    return {str(u.pk) for u in users if access.can(u, perms.OPPORTUNITY_CREATE, ws)}


class PerformanceRankingView(WorkspaceScopedView):
    required = {"GET": perms.PERFORMANCE_VIEW}

    @extend_schema(
        tags=["sales"],
        operation_id="sales_performance_ranking",
        parameters=[*PERIOD_PARAMS, OpenApiParameter("teamId", str, description="only this team's members")],
        responses={200: SalesRankingSerializer},
    )
    def get(self, request, slug):
        """Visible users who sell, or who sold or had a target in the period, best first."""
        ids = people.visible_user_ids(request.user, self.scope, perms.PERFORMANCE_VIEW)
        team_id = request.query_params.get("teamId")
        if team_id:
            if as_uuid(team_id) is None:
                raise invalid({"teamId": "Use a team id"})
            ids &= people.team_member_ids(self.scope, team_id)
        book = TargetBook(self.scope)
        period, today = _period(request, self.scope, book)
        rows = kpi.ranking(self.scope, period, sorted(ids), today=today)
        sellers = _sellers(self.scope, ids)
        rows = kpi.assign_ranks([r for r in rows if r["userId"] in sellers or r["actual"] or r["target"] is not None])
        users = {str(u.pk): u for u in User.objects.filter(pk__in=[r["userId"] for r in rows])}
        for row in rows:
            row["user"] = _user(users[row["userId"]])
        return Response(SalesRankingSerializer({"period": period, "rows": rows}).data)
