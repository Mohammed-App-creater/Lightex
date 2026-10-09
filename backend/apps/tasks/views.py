from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.permissions import MEMBER, ScopedView
from apps.audit import selectors as audit_selectors
from apps.common.pagination import paginate_queryset
from apps.common.params import body, filter_values
from apps.projects.models import ProjectMember
from apps.projects.services import record_recent
from apps.projects.views import ProjectScopedView
from apps.workspaces.views import WorkspaceScopedView

from . import selectors, services
from .models import Task
from .serializers import (
    ActivityOut,
    BulkIn,
    DependencyIn,
    TaskDependenciesOut,
    TaskDetailOut,
    TaskOut,
    TaskPageOut,
    TaskWriteIn,
    dependencies_data,
    task_data,
    task_detail_data,
)

LIST_PARAMS = [
    OpenApiParameter("filter[status]", str, many=True),
    OpenApiParameter("filter[assignee]", str, many=True, description="user id, `me` or `none`"),
    OpenApiParameter("filter[sprint]", str, many=True, description="sprint id or `none`"),
    OpenApiParameter("filter[epic]", str, many=True),
    OpenApiParameter("filter[milestone]", str, many=True),
    OpenApiParameter("filter[priority]", int, many=True),
    OpenApiParameter("filter[label]", str, many=True),
    OpenApiParameter("filter[parent]", str, many=True),
    OpenApiParameter("filter[blocked]", str, enum=["true", "false"], description="has at least one open blocker"),
    OpenApiParameter("q", str),
    OpenApiParameter(
        "sort",
        str,
        description="number, title, priority, dueDate, estimate, createdAt, updatedAt or position; - for descending",
    ),
    OpenApiParameter("cursor", str),
    OpenApiParameter("limit", int),
]


def fresh(task_id) -> Task:
    return selectors.annotated(Task.all_objects.filter(pk=task_id)).select_related("status").get()


def detail(task: Task, user) -> dict:
    task = selectors.annotated(Task.objects.filter(pk=task.pk)).select_related("project", "status").get()
    subtasks = selectors.annotated(Task.objects.filter(parent=task)).order_by("number")
    return task_detail_data(task, user, subtasks)


def page_of(qs, request, *, default_limit=500, max_limit=500, default_sort="number"):
    sort = request.query_params.get("sort") or default_sort
    order = selectors.sort_spec(sort)
    qs = selectors.apply_sort_annotation(qs, sort)
    return paginate_queryset(
        selectors.annotated(qs).select_related("status"),
        request.query_params,
        order=order,
        serialize=lambda rows: [task_data(t) for t in rows],
        default_limit=default_limit,
        max_limit=max_limit,
    )


class TaskScopedView(ScopedView):
    """Scope = the task's project (resolved from the task id in the URL)."""

    include_deleted = False

    def get_scope(self):
        self.task = selectors.task_for(self.request.user, self.kwargs["task_id"], include_deleted=self.include_deleted)
        return self.task.project


class ProjectTasksView(ProjectScopedView):
    required = {"GET": "project.view", "POST": "task.create"}

    @extend_schema(tags=["tasks"], parameters=LIST_PARAMS, responses={200: TaskPageOut})
    def get(self, request, project_id):
        qs = selectors.filter_tasks(Task.objects.filter(project=self.scope), request.query_params, request.user)
        return Response(page_of(qs, request))

    @extend_schema(tags=["tasks"], request=TaskWriteIn, responses={201: TaskOut})
    def post(self, request, project_id):
        task = services.create_task(request.user, self.scope, body(request))
        return Response(task_data(fresh(task.pk)), status=status.HTTP_201_CREATED)


class TaskDetailView(ScopedView):
    """GET/PATCH/DELETE tasks/{id or key}."""

    required = {"GET": "project.view", "PATCH": MEMBER, "DELETE": "task.delete"}

    def get_scope(self):
        self.task = selectors.task_by_id_or_key(self.request.user, self.kwargs["task_ref"])
        return self.task.project

    @extend_schema(tags=["tasks"], responses={200: TaskDetailOut})
    def get(self, request, task_ref):
        record_recent(request.user, "task", self.task.pk)
        return Response(detail(self.task, request.user))

    @extend_schema(tags=["tasks"], request=TaskWriteIn, responses={200: TaskOut})
    def patch(self, request, task_ref):
        task = services.update_task(request.user, self.task, body(request))
        return Response(task_data(fresh(task.pk)))

    @extend_schema(tags=["tasks"], responses={204: None})
    def delete(self, request, task_ref):
        services.delete_task(request.user, self.task)
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceTaskByKeyView(ScopedView):
    required = {"GET": "project.view"}

    def get_scope(self):
        from apps.workspaces.selectors import workspace_for

        ws = workspace_for(self.request.user, self.kwargs["slug"])
        self.task = selectors.task_by_key(self.request.user, self.kwargs["key"], workspace=ws)
        return self.task.project

    @extend_schema(tags=["tasks"], responses={200: TaskDetailOut})
    def get(self, request, slug, key):
        record_recent(request.user, "task", self.task.pk)
        return Response(detail(self.task, request.user))


class TaskRestoreView(TaskScopedView):
    required = {"POST": "task.delete"}
    include_deleted = True

    @extend_schema(tags=["tasks"], request=None, responses={200: TaskOut})
    def post(self, request, task_id):
        task = services.restore_task(request.user, self.task)
        return Response(task_data(fresh(task.pk)))


class BulkView(ProjectScopedView):
    required = {"POST": MEMBER}

    @extend_schema(tags=["tasks"], request=BulkIn, responses={200: TaskOut(many=True)})
    def post(self, request, project_id):
        tasks = services.bulk(request.user, self.scope, body(request))
        ids = [t.pk for t in tasks]
        rows = {t.pk: t for t in selectors.annotated(Task.all_objects.filter(pk__in=ids)).select_related("status")}
        return Response([task_data(rows[i]) for i in ids])


class SubtasksView(TaskScopedView):
    required = {"GET": "project.view", "POST": "task.create"}

    @extend_schema(tags=["tasks"], responses={200: TaskOut(many=True)})
    def get(self, request, task_id):
        subtasks = (
            selectors.annotated(Task.objects.filter(parent=self.task)).select_related("status").order_by("number")
        )
        return Response([task_data(t) for t in subtasks])

    @extend_schema(tags=["tasks"], request=TaskWriteIn, responses={201: TaskOut})
    def post(self, request, task_id):
        task = services.create_task(request.user, self.task.project, {**body(request), "parentId": str(self.task.pk)})
        return Response(task_data(fresh(task.pk)), status=status.HTTP_201_CREATED)


class TaskObjectivesView(TaskScopedView):
    required = {"PUT": MEMBER}

    @extend_schema(
        tags=["tasks"],
        request=inline_serializer(
            "TaskObjectivesIn", {"objectiveIds": serializers.ListField(child=serializers.UUIDField())}
        ),
        responses={200: TaskOut},
    )
    def put(self, request, task_id):
        task = services.set_task_objectives(request.user, self.task, body(request).get("objectiveIds"))
        return Response(task_data(fresh(task.pk)))


class TaskLabelsView(TaskScopedView):
    required = {"PUT": MEMBER}

    @extend_schema(
        tags=["tasks"],
        request=inline_serializer("TaskLabelsIn", {"labelIds": serializers.ListField(child=serializers.UUIDField())}),
        responses={200: TaskOut},
    )
    def put(self, request, task_id):
        task = services.set_task_labels(request.user, self.task, body(request).get("labelIds"))
        return Response(task_data(fresh(task.pk)))


class TaskDependenciesView(TaskScopedView):
    """Board 39: blocked by / blocks. Readable on a deleted task; writes there are 409 `task_deleted`."""

    required = {"GET": "project.view", "POST": MEMBER}
    include_deleted = True

    @extend_schema(tags=["dependencies"], responses={200: TaskDependenciesOut})
    def get(self, request, task_id):
        return Response(dependencies_data(self.task))

    @extend_schema(tags=["dependencies"], request=DependencyIn, responses={201: TaskDependenciesOut})
    def post(self, request, task_id):
        services.add_dependency(request.user, self.task, body(request))
        return Response(dependencies_data(self.task), status=status.HTTP_201_CREATED)


class TaskDependencyDetailView(TaskScopedView):
    required = {"DELETE": MEMBER}
    include_deleted = True

    @extend_schema(tags=["dependencies"], responses={204: None})
    def delete(self, request, task_id, dependency_id):
        services.remove_dependency(request.user, self.task, dependency_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TaskActivityView(TaskScopedView):
    required = {"GET": "project.view"}

    @extend_schema(tags=["activity"], responses={200: ActivityOut(many=True)})
    def get(self, request, task_id):
        return Response([audit_selectors.activity_data(r) for r in audit_selectors.task_activity(self.task)[:200]])


class ProjectActivityView(ProjectScopedView):
    required = {"GET": "project.view"}

    @extend_schema(tags=["activity"], parameters=[OpenApiParameter("cursor", str), OpenApiParameter("limit", int)])
    def get(self, request, project_id):
        return Response(
            paginate_queryset(
                audit_selectors.activity([self.scope.pk]),
                request.query_params,
                order=[("created_at", True), ("id", True)],
                serialize=lambda rows: [audit_selectors.activity_data(r) for r in rows],
                default_limit=20,
                max_limit=100,
            )
        )


class WorkspaceActivityView(WorkspaceScopedView):
    required = {"GET": "workspace.view"}

    @extend_schema(tags=["activity"], parameters=[OpenApiParameter("cursor", str), OpenApiParameter("limit", int)])
    def get(self, request, slug):
        mine = ProjectMember.objects.filter(
            user=request.user, project__workspace=self.scope, project__deleted_at__isnull=True
        ).values("project_id")
        return Response(
            paginate_queryset(
                audit_selectors.activity(mine),
                request.query_params,
                order=[("created_at", True), ("id", True)],
                serialize=lambda rows: [audit_selectors.activity_data(r) for r in rows],
                default_limit=20,
                max_limit=100,
            )
        )


def _assigned_tasks(user, assignees, workspace=None):
    mine = ProjectMember.objects.filter(user=user, project__deleted_at__isnull=True)
    if workspace is not None:
        mine = mine.filter(project__workspace=workspace)
    qs = Task.objects.filter(project_id__in=mine.values("project_id"), project__workspace__deleted_at__isnull=True)
    ids = [user.pk if a == "me" else a for a in assignees]
    bad = [a for a in ids if not selectors.is_uuid(a)]
    if bad:
        from apps.common.exceptions import invalid

        raise invalid({"filter[assignee]": "Pick a person"})
    if ids:
        qs = qs.filter(assignee_id__in=ids)
    return qs


class WorkspaceTasksView(WorkspaceScopedView):
    required = {"GET": "workspace.view"}

    @extend_schema(
        tags=["tasks"],
        parameters=[
            OpenApiParameter("filter[assignee]", str, many=True),
            OpenApiParameter("cursor", str),
            OpenApiParameter("limit", int),
        ],
        responses={200: TaskPageOut},
    )
    def get(self, request, slug):
        qs = _assigned_tasks(request.user, filter_values(request, "assignee"), self.scope)
        return Response(page_of(qs, request, default_limit=200, max_limit=500, default_sort="dueDate"))


class MyTasksView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["tasks"],
        parameters=[OpenApiParameter("cursor", str), OpenApiParameter("limit", int)],
        responses={200: TaskPageOut},
    )
    def get(self, request):
        qs = _assigned_tasks(request.user, ["me"])
        return Response(page_of(qs, request, default_limit=200, max_limit=500, default_sort="dueDate"))


class RecentsView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["tasks"],
        responses=inline_serializer(
            "Recent",
            {"kind": serializers.CharField(), "id": serializers.UUIDField(), "at": serializers.DateTimeField()},
            many=True,
        ),
    )
    def get(self, request):
        from apps.common.utils import iso
        from apps.projects.models import Project, Recent

        rows = list(Recent.objects.filter(user=request.user).order_by("-at")[:20])
        task_ids = {r.object_id for r in rows if r.kind == "task"}
        project_ids = {r.object_id for r in rows if r.kind == "project"}
        mine = set(ProjectMember.objects.filter(user=request.user).values_list("project_id", flat=True))
        ok_tasks = set(Task.objects.filter(pk__in=task_ids, project_id__in=mine).values_list("pk", flat=True))
        ok_projects = set(Project.objects.filter(pk__in=project_ids & mine).values_list("pk", flat=True))
        out = [
            {"kind": r.kind, "id": str(r.object_id), "at": iso(r.at)}
            for r in rows
            if (r.kind == "task" and r.object_id in ok_tasks) or (r.kind == "project" and r.object_id in ok_projects)
        ]
        return Response(out[:8])
