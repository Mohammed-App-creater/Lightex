from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.permissions import MEMBER, ScopedView
from apps.common.params import body, filter_value
from apps.tasks.views import TaskScopedView
from apps.workspaces.views import WorkspaceScopedView

from . import selectors, services
from .serializers import (
    TimeEntryIn,
    TimeEntryOut,
    TimerStartIn,
    TimerStartOut,
    TimerStateOut,
    TimerStopIn,
    TimerStopOut,
    TimesheetOut,
    entry_data,
    timer_data,
)


class TaskTimeEntriesView(TaskScopedView):
    """A task's time entries. Readable on a deleted task; logging there is 409 `task_deleted`."""

    required = {"GET": "project.view", "POST": "time.log"}
    include_deleted = True

    @extend_schema(tags=["time"], responses={200: TimeEntryOut(many=True)})
    def get(self, request, task_id):
        return Response([entry_data(e) for e in selectors.entries_of(self.task)])

    @extend_schema(tags=["time"], request=TimeEntryIn, responses={201: TimeEntryOut})
    def post(self, request, task_id):
        entry = services.log_time(request.user, self.task, body(request))
        return Response(entry_data(entry), status=status.HTTP_201_CREATED)


class TimeEntryDetailView(ScopedView):
    """Own entry with `time.log`, anyone's with `time.delete_any` (decided by the service)."""

    required = {"DELETE": MEMBER}

    def get_scope(self):
        self.entry = services.get_entry(self.request.user, self.kwargs["entry_id"])
        return self.entry.task.project

    @extend_schema(tags=["time"], responses={204: None})
    def delete(self, request, entry_id):
        services.delete_entry(request.user, self.entry)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TaskTimerView(TaskScopedView):
    required = {"POST": "time.log"}
    include_deleted = True

    @extend_schema(tags=["time"], request=TimerStartIn, responses={201: TimerStartOut})
    def post(self, request, task_id):
        timer, stopped = services.start_timer(request.user, self.task, body(request))
        return Response(
            {"timer": timer_data(timer), "stopped": entry_data(stopped) if stopped else None},
            status=status.HTTP_201_CREATED,
        )


class MyTimerView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["time"], responses={200: TimerStateOut})
    def get(self, request):
        return Response({"timer": timer_data(services.current_timer(request.user))})


class MyTimerStopView(APIView):
    """Needs `time.log` on the timer's project (checked by the service, which also discards stale timers)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["time"], request=TimerStopIn, responses={200: TimerStopOut})
    def post(self, request):
        return Response({"entry": entry_data(services.stop_timer(request.user, body(request)))})


class TimesheetView(WorkspaceScopedView):
    """Any workspace member; the data comes only from projects where they have `project.view`."""

    required = {"GET": "workspace.view"}

    @extend_schema(
        tags=["time"],
        parameters=[
            OpenApiParameter("filter[week]", str, description="Any date in the week (snapped to its Monday)"),
            OpenApiParameter("filter[project]", str, description="One project id; omitted = every visible project"),
        ],
        responses={200: TimesheetOut},
    )
    def get(self, request, slug):
        week, project = filter_value(request, "week"), filter_value(request, "project")
        return Response(selectors.timesheet(request.user, self.scope, week, project))
