from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.response import Response

from apps.common.params import filter_value
from apps.projects.views import ProjectScopedView

from . import services

RANGE_PARAMS = [
    OpenApiParameter("filter[range]", str, enum=list(services.RANGES)),
    OpenApiParameter("filter[from]", str, description="YYYY-MM-DD (custom range)"),
    OpenApiParameter("filter[to]", str, description="YYYY-MM-DD (custom range)"),
]


def _range(request) -> tuple:
    return filter_value(request, "range"), filter_value(request, "from"), filter_value(request, "to")


class ReportView(ProjectScopedView):
    required = {"GET": "report.view"}


class KpisView(ReportView):
    @extend_schema(
        tags=["reports"], responses=inline_serializer("ReportKpis", {"completedThisSprint": serializers.IntegerField()})
    )
    def get(self, request, project_id):
        return Response(services.kpis(self.scope))


class BurndownView(ReportView):
    @extend_schema(tags=["reports"], parameters=[OpenApiParameter("filter[sprint]", str)])
    def get(self, request, project_id):
        return Response(services.burndown(self.scope, filter_value(request, "sprint")))


class VelocityView(ReportView):
    @extend_schema(tags=["reports"], parameters=RANGE_PARAMS)
    def get(self, request, project_id):
        return Response(services.velocity(self.scope, *_range(request)))


class CycleTimeView(ReportView):
    @extend_schema(tags=["reports"], parameters=RANGE_PARAMS)
    def get(self, request, project_id):
        return Response(services.cycle_time_report(self.scope, *_range(request)))


class ThroughputView(ReportView):
    @extend_schema(tags=["reports"], parameters=RANGE_PARAMS)
    def get(self, request, project_id):
        return Response(services.throughput_report(self.scope, *_range(request)))


class ProgressView(ReportView):
    @extend_schema(tags=["reports"])
    def get(self, request, project_id):
        return Response(services.progress_rows(self.scope))


class SummaryView(ProjectScopedView):
    """Project overview KPIs; visible to every project member (not only report.view)."""

    required = {"GET": "project.view"}

    @extend_schema(
        tags=["reports"],
        responses=inline_serializer(
            "ProjectSummary",
            {
                "openTasks": serializers.IntegerField(),
                "doneThisSprint": serializers.IntegerField(),
                "cycleTimeDays": serializers.FloatField(),
                "dueThisWeek": serializers.IntegerField(),
            },
        ),
    )
    def get(self, request, project_id):
        return Response(services.summary(self.scope))
