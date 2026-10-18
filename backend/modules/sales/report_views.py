"""Sales report routes (S6, docs/sales/api.md §22): the catalogue and one report as JSON or CSV."""

from __future__ import annotations

from django.http import HttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response

from core.access import services as access
from core.common.exceptions import forbidden, invalid, not_found
from core.workspaces.timezone import workspace_today
from core.workspaces.views import WorkspaceScopedView

from . import module as perms
from . import report_engine as engine
from .dashboard import people_in_scope
from .performance_views import SalesPeriodSerializer
from .targets import TargetBook


class SalesReportColumnSerializer(serializers.Serializer):
    key = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]
    type = serializers.ChoiceField(choices=list(engine.TYPES))


class SalesReportInfoSerializer(serializers.Serializer):
    key = serializers.CharField()
    title = serializers.CharField()
    description = serializers.CharField()
    defaultPeriod = serializers.ChoiceField(choices=list(engine.PERIODS))
    periods = serializers.ListField(child=serializers.ChoiceField(choices=list(engine.PERIODS)))
    columns = SalesReportColumnSerializer(many=True)


class SalesReportSerializer(serializers.Serializer):
    key = serializers.CharField()
    title = serializers.CharField()
    period = SalesPeriodSerializer()
    columns = SalesReportColumnSerializer(many=True)
    rows = serializers.ListField(
        child=serializers.DictField(),
        help_text="One object per row, keyed by column key: money as decimal strings, percentages as numbers, "
        "dates YYYY-MM-DD, counts as integers, null when there is no value",
    )


class _JsonOnly(WorkspaceScopedView):
    def perform_content_negotiation(self, request, force=False):
        # `format=csv` is a report parameter, not DRF's renderer override (which would 404 an unknown format).
        renderer = JSONRenderer()
        return renderer, renderer.media_type


class ReportCatalogueView(WorkspaceScopedView):
    required = {"GET": perms.REPORT_VIEW}

    @extend_schema(tags=["sales"], operation_id="sales_reports", responses={200: SalesReportInfoSerializer(many=True)})
    def get(self, request, slug):
        return Response(SalesReportInfoSerializer(engine.catalogue(), many=True).data)


class ReportView(_JsonOnly):
    required = {"GET": perms.REPORT_VIEW}

    @extend_schema(
        tags=["sales"],
        operation_id="sales_report",
        parameters=[
            OpenApiParameter("period", str, enum=list(engine.PERIODS), description="default: the report's"),
            OpenApiParameter("date", str, description="YYYY-MM-DD inside the period; default today (workspace time)"),
            OpenApiParameter("from", str, description="custom period start (YYYY-MM-DD)"),
            OpenApiParameter("to", str, description="custom period end (YYYY-MM-DD), at most 366 days after from"),
            OpenApiParameter("userId", str, description="one person in your report scope (403 outside it)"),
            OpenApiParameter("teamId", str, description="one team in your report scope (403 outside it)"),
            OpenApiParameter("format", str, enum=["json", "csv"], description="csv needs sales.report.export"),
        ],
        responses={
            200: OpenApiResponse(SalesReportSerializer, description="JSON; with format=csv a text/csv attachment"),
            (200, "text/csv"): OpenApiTypes.STR,
        },
    )
    def get(self, request, slug, report_key):
        report = engine.REPORTS.get(report_key)
        if report is None:
            raise not_found("Report not found.")
        fmt = request.query_params.get("format") or "json"
        if fmt not in ("json", "csv"):
            raise invalid({"format": "Use json or csv"})
        ws = self.scope
        if fmt == "csv" and not access.can(request.user, perms.REPORT_EXPORT, ws):
            raise forbidden(details={"permission": perms.REPORT_EXPORT})
        book = TargetBook(ws)
        today = workspace_today(ws)
        period = engine.parse_period(request.query_params, book, today, report.default_period)
        user_id, team_id = request.query_params.get("userId"), request.query_params.get("teamId")
        ids = people_in_scope(request.user, ws, perms.REPORT_VIEW, user_id=user_id, team_id=team_id)
        ctx = engine.Context(ws, period, ids, today, book, user=request.user, team_id=team_id, user_id=user_id)
        rows = report.build(ctx)
        if fmt == "csv":
            name = f"sales-{report.key}-{period.start.isoformat()}-{period.end.isoformat()}.csv"
            res = HttpResponse(engine.csv_text(report, rows), content_type="text/csv; charset=utf-8")
            res["Content-Disposition"] = f'attachment; filename="{name}"'
            return res
        data = {
            "key": report.key,
            "title": report.title,
            "period": SalesPeriodSerializer(period).data,
            "columns": [{"key": k, "label": label, "type": t} for k, label, t in report.columns],
            "rows": engine.json_rows(report, rows),
        }
        return Response(data)
