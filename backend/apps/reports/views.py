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


class WorkloadView(ReportView):
    """Board 33 W1: open sprint work per person (points or remaining minutes) against a derived capacity."""

    @extend_schema(
        tags=["reports"],
        parameters=[
            OpenApiParameter("filter[sprint]", str, description="Sprint id; default = the active sprint"),
            OpenApiParameter("filter[unit]", str, enum=["points", "hours"]),
            OpenApiParameter("filter[person]", str, description="`assignee` (default) or a Person custom field id"),
        ],
        responses=inline_serializer(
            "WorkloadReport",
            {
                "sprint": serializers.JSONField(allow_null=True, help_text="{ id, name, number, startDate, endDate }"),
                "unit": serializers.ChoiceField(choices=["points", "hours"]),
                "personField": serializers.JSONField(allow_null=True, help_text="{ id, name } when used"),
                "scale": serializers.IntegerField(),
                "rows": serializers.JSONField(
                    help_text="[{ user: { id, name, hue, avatarUrl }, inProgress, todo, capacity | null, unestimated }]"
                ),
                "unassigned": serializers.JSONField(help_text="{ inProgress, todo, unestimated }"),
            },
        ),
    )
    def get(self, request, project_id):
        return Response(
            services.workload(
                self.scope,
                filter_value(request, "sprint"),
                filter_value(request, "unit"),
                filter_value(request, "person"),
            )
        )


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
