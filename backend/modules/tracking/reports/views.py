from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.response import Response

from core.common.params import filter_value
from core.common.schema import shape
from modules.tracking.projects.views import ProjectScopedView

from . import services

RANGE_PARAMS = [
    OpenApiParameter("filter[range]", str, enum=list(services.RANGES)),
    OpenApiParameter("filter[from]", str, description="YYYY-MM-DD (custom range)"),
    OpenApiParameter("filter[to]", str, description="YYYY-MM-DD (custom range)"),
]


def _obj(name: str, fields: dict, **kwargs) -> serializers.Serializer:
    return inline_serializer(name, fields, **kwargs)


BurndownOut = _obj(
    "BurndownReport",
    {
        "sprint": _obj(
            "BurndownSprint",
            {
                "id": serializers.UUIDField(),
                "name": serializers.CharField(),
                "startDate": serializers.DateField(),
                "endDate": serializers.DateField(),
            },
            allow_null=True,
        ),
        "points": serializers.ListField(
            child=_obj(
                "BurndownPoint",
                {
                    "date": serializers.DateField(),
                    "remaining": serializers.FloatField(allow_null=True),
                    "ideal": serializers.FloatField(),
                },
            )
        ),
    },
)
VelocityOut = _obj(
    "VelocityReport",
    {
        "points": serializers.ListField(
            child=_obj(
                "VelocityPoint",
                {
                    "sprint": serializers.CharField(),
                    "committed": serializers.IntegerField(),
                    "completed": serializers.IntegerField(),
                },
            )
        ),
        "insufficient": serializers.BooleanField(),
        "completedSprints": serializers.IntegerField(),
    },
)
CycleTimeOut = _obj(
    "CycleTimeReport",
    {
        "bins": serializers.ListField(
            child=_obj("CycleTimeBin", {"label": serializers.CharField(), "count": serializers.IntegerField()})
        ),
        "total": serializers.IntegerField(),
        "medianDays": serializers.FloatField(),
        "insufficient": serializers.BooleanField(),
    },
)
ThroughputOut = _obj(
    "ThroughputReport",
    {
        "points": serializers.ListField(
            child=_obj("ThroughputPoint", {"week": serializers.DateField(), "done": serializers.IntegerField()})
        ),
        "insufficient": serializers.BooleanField(),
    },
)
ProgressRowOut = shape(
    "ProgressRow",
    {
        "id": serializers.UUIDField(),
        "kind": serializers.ChoiceField(choices=["objective", "milestone"]),
        "name": serializers.CharField(),
        "percent": serializers.IntegerField(),
        "expected": serializers.IntegerField(allow_null=True),
        "dueDate": serializers.DateField(allow_null=True),
        "quarter": serializers.CharField(allow_null=True),
    },
)


def _range(request) -> tuple:
    return filter_value(request, "range"), filter_value(request, "from"), filter_value(request, "to")


class ReportView(ProjectScopedView):
    required = {"GET": "tracking.report.view"}


class KpisView(ReportView):
    @extend_schema(
        tags=["reports"], responses=inline_serializer("ReportKpis", {"completedThisSprint": serializers.IntegerField()})
    )
    def get(self, request, project_id):
        return Response(services.kpis(self.scope))


class BurndownView(ReportView):
    @extend_schema(
        tags=["reports"],
        parameters=[OpenApiParameter("filter[sprint]", str)],
        responses=BurndownOut,
        description="`sprint` is null (and `points` empty) when the project has no sprint to chart.",
    )
    def get(self, request, project_id):
        return Response(services.burndown(self.scope, filter_value(request, "sprint")))


class VelocityView(ReportView):
    @extend_schema(tags=["reports"], parameters=RANGE_PARAMS, responses=VelocityOut)
    def get(self, request, project_id):
        return Response(services.velocity(self.scope, *_range(request)))


class CycleTimeView(ReportView):
    @extend_schema(tags=["reports"], parameters=RANGE_PARAMS, responses=CycleTimeOut)
    def get(self, request, project_id):
        return Response(services.cycle_time_report(self.scope, *_range(request)))


class ThroughputView(ReportView):
    @extend_schema(tags=["reports"], parameters=RANGE_PARAMS, responses=ThroughputOut)
    def get(self, request, project_id):
        return Response(services.throughput_report(self.scope, *_range(request)))


class ProgressView(ReportView):
    @extend_schema(tags=["reports"], responses=ProgressRowOut(many=True))
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

    required = {"GET": "tracking.project.view"}

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
