"""Board, backlog and move endpoints."""

from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.response import Response

from apps.access.permissions import ScopedView
from apps.common.params import body, filter_value
from apps.planning.models import Sprint
from apps.projects.selectors import statuses_of
from apps.projects.serializers import StatusSerializer
from apps.projects.services import record_recent
from apps.projects.views import ProjectScopedView

from . import selectors, services
from .models import Task
from .serializers import TaskOut, task_data
from .views import TaskScopedView, fresh

BoardOut = inline_serializer(
    "Board",
    {
        "statuses": StatusSerializer(many=True),
        "tasks": TaskOut(many=True),
        "sprintId": serializers.UUIDField(allow_null=True),
    },
)


def board_payload(project, sprint_id) -> dict:
    """Top-level tasks ordered by position. With no sprint: everything not in a backlog status."""
    statuses = list(statuses_of(project))
    qs = Task.objects.filter(project=project, parent__isnull=True)
    if sprint_id:
        qs = qs.filter(sprint_id=sprint_id)
    else:
        qs = qs.exclude(status__glyph="backlog")
    tasks = selectors.annotated(qs).select_related("status").order_by("position", "created_at")
    return {
        "statuses": StatusSerializer(statuses, many=True).data,
        "tasks": [task_data(t) for t in tasks],
        "sprintId": str(sprint_id) if sprint_id else None,
    }


class BoardView(ProjectScopedView):
    required = {"GET": "project.view"}

    @extend_schema(
        tags=["board"],
        parameters=[OpenApiParameter("filter[sprint]", str, description="`active` (default), `all` or a sprint id")],
        responses={200: BoardOut},
    )
    def get(self, request, project_id):
        wanted = filter_value(request, "sprint", "active")
        if wanted == "active":
            sprint_id = Sprint.objects.filter(project=self.scope, state="active").values_list("id", flat=True).first()
        elif wanted == "all":
            sprint_id = None
        else:
            sprint = Sprint.objects.filter(project=self.scope, pk=wanted).first() if selectors.is_uuid(wanted) else None
            if sprint is None:
                from apps.common.exceptions import not_found

                raise not_found("Sprint not found.")
            sprint_id = sprint.pk
        record_recent(request.user, "project", self.scope.pk)
        return Response(board_payload(self.scope, sprint_id))


class SprintBoardView(ScopedView):
    """GET sprints/{id}/board (brief): the board for one sprint."""

    required = {"GET": "project.view"}

    def get_scope(self):
        from apps.planning.selectors import sprint_for

        self.sprint = sprint_for(self.request.user, self.kwargs["sprint_id"])
        return self.sprint.project

    @extend_schema(tags=["board"], responses={200: BoardOut})
    def get(self, request, sprint_id):
        return Response(board_payload(self.scope, self.sprint.pk))


class BacklogView(ProjectScopedView):
    required = {"GET": "project.view"}

    @extend_schema(
        tags=["board"],
        responses=inline_serializer(
            "Backlog",
            {
                "sprints": inline_serializer(
                    "BacklogSprint", {"sprintId": serializers.UUIDField(), "tasks": TaskOut(many=True)}, many=True
                ),
                "backlog": TaskOut(many=True),
            },
        ),
    )
    def get(self, request, project_id):
        sprints = list(Sprint.objects.filter(project=self.scope).exclude(state="completed").order_by("number"))
        sprints.sort(key=lambda s: (s.state != "active", s.number))
        tasks = list(
            selectors.annotated(Task.objects.filter(project=self.scope, parent__isnull=True))
            .select_related("status")
            .order_by("position", "created_at")
        )
        by_sprint: dict = {}
        backlog = []
        for t in tasks:
            if t.sprint_id is None:
                backlog.append(task_data(t))
            else:
                by_sprint.setdefault(t.sprint_id, []).append(task_data(t))
        return Response(
            {
                "sprints": [{"sprintId": str(s.pk), "tasks": by_sprint.get(s.pk, [])} for s in sprints],
                "backlog": backlog,
            }
        )


class MoveView(TaskScopedView):
    required = {"POST": "task.move"}

    @extend_schema(
        tags=["board"],
        request=inline_serializer(
            "TaskMove",
            {
                "statusId": serializers.UUIDField(required=False),
                "sprintId": serializers.UUIDField(required=False, allow_null=True),
                "position": serializers.CharField(),
                "version": serializers.IntegerField(),
            },
        ),
        responses={200: TaskOut},
    )
    def post(self, request, task_id):
        task = services.move_task(request.user, self.task, body(request))
        return Response(task_data(fresh(task.pk)))
