from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.response import Response

from apps.access.permissions import MEMBER, ScopedView
from apps.common.params import body, filter_value
from apps.workspaces.views import WorkspaceScopedView

from . import selectors, services
from .serializers import (
    AccessRequestSerializer,
    AccessRequestWithUserSerializer,
    IdsIn,
    LabelIn,
    LabelSerializer,
    MemberIn,
    ProjectIn,
    ProjectMemberSerializer,
    ProjectSerializer,
    StatusIn,
    StatusSerializer,
    project_context,
)


def project_data(request, project) -> dict:
    fresh = selectors.with_counts(type(project).objects.filter(pk=project.pk)).get()
    return ProjectSerializer(fresh, context=project_context(request.user, [fresh])).data


class ProjectScopedView(ScopedView):
    """Scope = the project in the URL; workspace non-members get 404, non-members 403."""

    #: methods whose scope only needs workspace membership (the service decides the rest)
    workspace_member_methods: tuple[str, ...] = ()

    def get_scope(self):
        if self.request.method in self.workspace_member_methods:
            return selectors.project_in_workspace(self.request.user, self.kwargs["project_id"])
        return selectors.project_for(self.request.user, self.kwargs["project_id"])


class ProjectListView(WorkspaceScopedView):
    required = {"GET": "workspace.view", "POST": "project.create"}

    @extend_schema(
        tags=["projects"],
        parameters=[OpenApiParameter("filter[status]", str, enum=["active", "archived", "all"])],
        responses={200: ProjectSerializer(many=True)},
    )
    def get(self, request, slug):
        projects = list(selectors.visible_projects(request.user, self.scope, status=filter_value(request, "status")))
        return Response(ProjectSerializer(projects, many=True, context=project_context(request.user, projects)).data)

    @extend_schema(tags=["projects"], request=ProjectIn, responses={201: ProjectSerializer})
    def post(self, request, slug):
        project = services.create_project(request.user, self.scope, body(request))
        return Response(project_data(request, project), status=status.HTTP_201_CREATED)


class ProjectDirectoryView(WorkspaceScopedView):
    required = {"GET": "workspace.view"}

    @extend_schema(
        tags=["projects"],
        responses=inline_serializer("ProjectDirectoryEntry", {"id": serializers.UUIDField()}, many=True),
    )
    def get(self, request, slug):
        return Response(selectors.project_directory(request.user, self.scope))


class ProjectByKeyView(ScopedView):
    required = {"GET": "project.view"}

    def get_scope(self):
        from apps.workspaces.selectors import workspace_for

        ws = workspace_for(self.request.user, self.kwargs["slug"])
        return selectors.project_by_key(self.request.user, ws, self.kwargs["key"])

    @extend_schema(tags=["projects"], responses={200: ProjectSerializer})
    def get(self, request, slug, key):
        services.record_recent(request.user, "project", self.scope.pk)
        return Response(project_data(request, self.scope))


class ProjectDetailView(ProjectScopedView):
    required = {"GET": "project.view", "PATCH": "project.update", "DELETE": "project.delete"}

    @extend_schema(tags=["projects"], responses={200: ProjectSerializer})
    def get(self, request, project_id):
        return Response(project_data(request, self.scope))

    @extend_schema(tags=["projects"], request=ProjectIn, responses={200: ProjectSerializer})
    def patch(self, request, project_id):
        return Response(project_data(request, services.update_project(request.user, self.scope, body(request))))

    @extend_schema(tags=["projects"], responses={204: None})
    def delete(self, request, project_id):
        services.delete_project(request.user, self.scope, str(body(request).get("confirm", "")))
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProjectArchiveView(ProjectScopedView):
    required = {"POST": "project.archive"}
    archived = True

    @extend_schema(tags=["projects"], request=None, responses={200: ProjectSerializer})
    def post(self, request, project_id):
        return Response(project_data(request, services.set_archived(request.user, self.scope, self.archived)))


class ProjectUnarchiveView(ProjectArchiveView):
    archived = False


class ProjectMembersView(ProjectScopedView):
    required = {"GET": "project.view", "POST": MEMBER}
    workspace_member_methods = ("POST",)

    @extend_schema(tags=["project members"], responses={200: ProjectMemberSerializer(many=True)})
    def get(self, request, project_id):
        return Response(ProjectMemberSerializer(selectors.members_of(self.scope), many=True).data)

    @extend_schema(tags=["project members"], request=MemberIn, responses={201: ProjectMemberSerializer})
    def post(self, request, project_id):
        data = body(request)
        member = services.add_member(request.user, self.scope, data.get("userId"), data.get("roleId"))
        return Response(ProjectMemberSerializer(member).data, status=status.HTTP_201_CREATED)


class ProjectMemberDetailView(ProjectScopedView):
    required = {"PATCH": "project.manage_members", "DELETE": MEMBER}

    @extend_schema(tags=["project members"], request=MemberIn, responses={200: ProjectMemberSerializer})
    def patch(self, request, project_id, user_id):
        member = services.change_member_role(request.user, self.scope, user_id, body(request).get("roleId"))
        return Response(ProjectMemberSerializer(member).data)

    @extend_schema(tags=["project members"], responses={204: None})
    def delete(self, request, project_id, user_id):
        services.remove_member(request.user, self.scope, user_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class AccessRequestsView(ProjectScopedView):
    required = {"GET": "project.manage_members", "POST": MEMBER}
    workspace_member_methods = ("POST",)

    @extend_schema(tags=["access requests"], responses={200: AccessRequestWithUserSerializer(many=True)})
    def get(self, request, project_id):
        qs = self.scope.access_requests.filter(status="pending").select_related("user").order_by("created_at")
        return Response(AccessRequestWithUserSerializer(qs, many=True).data)

    @extend_schema(tags=["access requests"], request=None, responses={201: AccessRequestSerializer})
    def post(self, request, project_id):
        req = services.request_access(request.user, self.scope, str(body(request).get("message") or ""))
        return Response(AccessRequestSerializer(req).data, status=status.HTTP_201_CREATED)


class MyAccessRequestView(ProjectScopedView):
    required = {"DELETE": MEMBER}
    workspace_member_methods = ("DELETE",)

    @extend_schema(tags=["access requests"], responses={204: None})
    def delete(self, request, project_id):
        services.withdraw_access_request(request.user, self.scope)
        return Response(status=status.HTTP_204_NO_CONTENT)


class AccessRequestDenyView(ProjectScopedView):
    required = {"POST": "project.manage_members"}

    @extend_schema(tags=["access requests"], request=None, responses={200: AccessRequestSerializer})
    def post(self, request, project_id, request_id):
        return Response(
            AccessRequestSerializer(services.deny_access_request(request.user, self.scope, request_id)).data
        )


class StatusesView(ProjectScopedView):
    required = {"GET": "project.view", "POST": "status.manage"}

    @extend_schema(tags=["statuses"], responses={200: StatusSerializer(many=True)})
    def get(self, request, project_id):
        return Response(StatusSerializer(selectors.statuses_of(self.scope), many=True).data)

    @extend_schema(tags=["statuses"], request=StatusIn, responses={201: StatusSerializer})
    def post(self, request, project_id):
        st = services.create_status(request.user, self.scope, body(request))
        return Response(StatusSerializer(st).data, status=status.HTTP_201_CREATED)


class StatusDetailView(ProjectScopedView):
    required = {"PATCH": "status.manage", "DELETE": "status.manage"}

    @extend_schema(tags=["statuses"], request=StatusIn, responses={200: StatusSerializer})
    def patch(self, request, project_id, status_id):
        return Response(
            StatusSerializer(services.update_status(request.user, self.scope, status_id, body(request))).data
        )

    @extend_schema(tags=["statuses"], responses={204: None})
    def delete(self, request, project_id, status_id):
        services.delete_status(request.user, self.scope, status_id, body(request).get("moveTo"))
        return Response(status=status.HTTP_204_NO_CONTENT)


class StatusReorderView(ProjectScopedView):
    required = {"POST": "status.manage"}

    @extend_schema(tags=["statuses"], request=IdsIn, responses={200: StatusSerializer(many=True)})
    def post(self, request, project_id):
        services.reorder_statuses(request.user, self.scope, body(request).get("ids"))
        return Response(StatusSerializer(selectors.statuses_of(self.scope), many=True).data)


class LabelsView(ProjectScopedView):
    required = {"GET": "project.view", "POST": "task.create"}

    @extend_schema(tags=["labels"], responses={200: LabelSerializer(many=True)})
    def get(self, request, project_id):
        return Response(LabelSerializer(selectors.labels_of(self.scope), many=True).data)

    @extend_schema(tags=["labels"], request=LabelIn, responses={201: LabelSerializer})
    def post(self, request, project_id):
        label = services.create_label(request.user, self.scope, body(request))
        return Response(LabelSerializer(label).data, status=status.HTTP_201_CREATED)


class LabelDetailView(ProjectScopedView):
    required = {"PATCH": "project.update", "DELETE": "project.update"}

    @extend_schema(tags=["labels"], request=LabelIn, responses={200: LabelSerializer})
    def patch(self, request, project_id, label_id):
        return Response(LabelSerializer(services.update_label(request.user, self.scope, label_id, body(request))).data)

    @extend_schema(tags=["labels"], responses={204: None})
    def delete(self, request, project_id, label_id):
        services.delete_label(request.user, self.scope, label_id)
        return Response(status=status.HTTP_204_NO_CONTENT)
