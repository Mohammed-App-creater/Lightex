"""Daily report routes (S5, docs/sales/api.md §20). `me/today` and the author's writes need
`sales.dailyreport.submit`; reads need `sales.dailyreport.view` (records outside its scope answer 404); review and
reopen need `sales.dailyreport.review` with the author in scope (403) and never on your own report."""

from __future__ import annotations

import datetime as dt
from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.response import Response

from core.common.exceptions import invalid
from core.common.pagination import paginate_queryset
from core.common.schema import page_of
from core.workspaces.timezone import workspace_today
from core.workspaces.views import WorkspaceScopedView

from . import daily_reports as svc
from . import module as perms
from . import scope
from .daily_report_serializers import (
    SalesDailyReportIn,
    SalesDailyReportSerializer,
    SalesDailyReviewIn,
    SalesTeamDailyReportSerializer,
)
from .defaults import ensure_defaults
from .models import DailyReport
from .pipeline_selectors import _choices, _date, _ids, team_members
from .selectors import as_uuid
from .views import PAGE_PARAMS, TAGS, SalesRecordView, valid
from .workdays import WorkCalendar

SalesDailyReportPage = page_of("SalesDailyReportPage", SalesDailyReportSerializer)


def _ref(user: Any) -> dict[str, Any] | None:
    return None if user is None else {"id": user.pk, "name": user.name}


def report_data(
    viewer: Any, reports: list[DailyReport], *, metrics: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    if not reports:
        return []
    ws = reports[0].workspace
    settings = ensure_defaults(ws)
    cal = WorkCalendar(ws)
    metrics = metrics if metrics is not None else svc.metrics_of(reports)
    rows = []
    for r in reports:
        rows.append(
            {
                "id": r.pk,
                "user": _ref(r.user),
                "reportDate": r.report_date,
                "status": r.status,
                "required": svc.is_required(ws, r.report_date, settings=settings, cal=cal),
                "cutoffAt": svc.cutoff_at(ws, r.report_date, settings),
                "comments": r.comments,
                "tomorrowPlan": r.tomorrow_plan,
                "submittedAt": r.submitted_at,
                "isLate": r.is_late,
                "reviewedBy": _ref(r.reviewed_by),
                "reviewedAt": r.reviewed_at,
                "reviewComment": r.review_comment,
                "metrics": metrics[str(r.pk)],
                "canEdit": str(r.user_id) == str(viewer.pk) and r.status != DailyReport.REVIEWED,
                "updatedAt": r.updated_at,
            }
        )
    return list(SalesDailyReportSerializer(rows, many=True).data)


def one(viewer: Any, report: DailyReport) -> dict[str, Any]:
    return report_data(viewer, [report])[0]


def _day(raw: str | None, name: str, default: dt.date) -> dt.date:
    if not raw:
        return default
    try:
        return dt.date.fromisoformat(raw)
    except ValueError:
        raise invalid({name: "Use a date (YYYY-MM-DD)"})


LIST_PARAMS = [
    OpenApiParameter("filter[date]", str, description="YYYY-MM-DD"),
    OpenApiParameter("filter[dateFrom]", str),
    OpenApiParameter("filter[dateTo]", str),
    OpenApiParameter("filter[user]", str, description="user id; repeatable"),
    OpenApiParameter("filter[team]", str, description="team id; repeatable"),
    OpenApiParameter("filter[status]", str, enum=list(DailyReport.STATUSES)),
    *PAGE_PARAMS,
]


class DailyReportListView(WorkspaceScopedView):
    required = {"GET": perms.DAILYREPORT_VIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_daily_reports_list",
        description="Reports in the caller's `sales.dailyreport.view` scope, newest date first.",
        parameters=LIST_PARAMS,
        responses={200: SalesDailyReportPage},
    )
    def get(self, request, slug):
        qs = svc.reports_for(request.user, self.scope).select_related("workspace", "user", "reviewed_by")
        for key, lookup in (("date", "report_date"), ("dateFrom", "report_date__gte"), ("dateTo", "report_date__lte")):
            day = _date(request, key)
            if day is not None:
                qs = qs.filter(**{lookup: day})
        users = _ids(request, "user", "user")
        if users:
            qs = qs.filter(user_id__in=users)
        teams = _ids(request, "team", "team")
        if teams:
            qs = qs.filter(user_id__in=team_members(self.scope, teams))
        statuses = _choices(request, "status", DailyReport.STATUSES)
        if statuses:
            qs = qs.filter(status__in=statuses)
        page = paginate_queryset(
            qs,
            request.query_params,
            order=[("report_date", True), ("id", True)],
            serialize=lambda rows: report_data(request.user, rows),
        )
        return Response(page)


class DailyReportTodayView(WorkspaceScopedView):
    required = {"GET": perms.DAILYREPORT_SUBMIT}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_daily_reports_me_today",
        description="The caller's report for today (workspace time), created as a draft on first read.",
        responses={200: SalesDailyReportSerializer},
    )
    def get(self, request, slug):
        return Response(one(request.user, svc.today_report(request.user, self.scope)))


class DailyReportTeamView(WorkspaceScopedView):
    required = {"GET": perms.DAILYREPORT_VIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_daily_reports_team",
        description="Every person in the caller's view scope expected to report (or who reported) on `date`: status, "
        "comments, plan and metrics, plus totals.",
        parameters=[
            OpenApiParameter("date", str, description="YYYY-MM-DD; default today (workspace time)"),
            OpenApiParameter("teamId", str),
        ],
        responses={200: SalesTeamDailyReportSerializer},
    )
    def get(self, request, slug):
        day = _day(request.query_params.get("date"), "date", workspace_today(self.scope))
        raw_team = request.query_params.get("teamId")
        team_id = None
        if raw_team:
            team_id = as_uuid(raw_team)
            if team_id is None:
                raise invalid({"teamId": "Use a team id"})
            team_members(self.scope, [team_id])  # 422 for teams of other workspaces
        data = svc.team_report(request.user, self.scope, day, team_id)
        return Response(SalesTeamDailyReportSerializer(data).data)


class _ReportView(SalesRecordView):
    model = DailyReport
    kwarg = "daily_report_id"
    not_found_message = svc.NOT_FOUND

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        # The author always reaches their own report; others need it in their view scope.
        if str(self.record.user_id) != str(request.user.pk):
            scope.require_visible(request.user, self.record, perms.DAILYREPORT_VIEW, svc.NOT_FOUND)


class DailyReportDetailView(_ReportView):
    required = {"GET": perms.DAILYREPORT_VIEW, "PUT": perms.DAILYREPORT_SUBMIT}

    @extend_schema(tags=TAGS, operation_id="sales_daily_reports_retrieve", responses={200: SalesDailyReportSerializer})
    def get(self, request, daily_report_id):
        return Response(one(request.user, self.record))

    @extend_schema(
        tags=TAGS,
        operation_id="sales_daily_reports_update",
        description="The author's comments and tomorrow's plan (each replaced when given); 409 once reviewed.",
        request=SalesDailyReportIn,
        responses={200: SalesDailyReportSerializer},
    )
    def put(self, request, daily_report_id):
        report = svc.update_report(request.user, self.record, valid(SalesDailyReportIn, request))
        return Response(one(request.user, report))


class DailyReportSubmitView(_ReportView):
    required = {"POST": perms.DAILYREPORT_SUBMIT}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_daily_reports_submit",
        description="Freeze the metrics; `isLate` when after the cutoff. 409 unless a draft.",
        request=None,
        responses={200: SalesDailyReportSerializer},
    )
    def post(self, request, daily_report_id):
        return Response(one(request.user, svc.submit(request.user, self.record)))


class DailyReportReviewView(_ReportView):
    required = {"POST": perms.DAILYREPORT_REVIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_daily_reports_review",
        description="Review a submitted report (locks it). Not your own.",
        request=SalesDailyReviewIn,
        responses={200: SalesDailyReportSerializer},
    )
    def post(self, request, daily_report_id):
        data = valid(SalesDailyReviewIn, request)
        return Response(one(request.user, svc.review(request.user, self.record, data.get("comment", ""))))


class DailyReportReopenView(_ReportView):
    required = {"POST": perms.DAILYREPORT_REVIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_daily_reports_reopen",
        description="Back to a draft (submitted or reviewed). Not your own.",
        request=None,
        responses={200: SalesDailyReportSerializer},
    )
    def post(self, request, daily_report_id):
        return Response(one(request.user, svc.reopen(request.user, self.record)))
