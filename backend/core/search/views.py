from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from core.common.exceptions import invalid
from core.common.pagination import parse_limit
from core.common.params import filter_values
from core.common.schema import page_of, shape
from core.workspaces.views import WorkspaceScopedView

from . import services

SearchResult = shape(
    "SearchResult",
    {
        "type": serializers.CharField(help_text="A registered result type: task, project, comment, user, …"),
        "targetType": serializers.CharField(),
        "targetId": serializers.UUIDField(),
        "title": serializers.CharField(),
        "link": serializers.CharField(allow_null=True),
    },
    "One search hit. Besides these keys each result carries its provider's record under the key named by `type` "
    "(`task`, `project`, `comment`, `user`) and a few display hints (projectKey, taskKey, …).",
)
SearchPage = page_of("SearchPage", SearchResult)


class WorkspaceSearchView(WorkspaceScopedView):
    required = {"GET": "core.workspace.view"}

    @extend_schema(
        tags=["search"],
        parameters=[
            OpenApiParameter("q", str),
            OpenApiParameter("filter[type]", str, many=True, description="Registered result types (and user)"),
            OpenApiParameter("limit", int),
        ],
        responses=SearchResult(many=True),
    )
    def get(self, request, slug):
        types = filter_values(request, "type")
        if any(t not in services.workspace_types() for t in types):
            raise invalid({"filter[type]": "Search tasks, projects or users"})
        limit = parse_limit(request.query_params.get("limit"), 20, 50)
        return Response(
            services.workspace_search(request.user, self.scope, request.query_params.get("q", ""), types, limit)
        )


class GlobalSearchView(APIView):
    """GET search?q=&type=: full-text search across every registered provider (tasks and comments for tracking)."""

    #: Not about one workspace: unscoped (core/common/scoping.py); reads are filtered by the user.
    cross_workspace = True

    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["search"],
        parameters=[
            OpenApiParameter("q", str, required=True),
            OpenApiParameter("type", str, description="A registered global result type (task, comment, …)"),
            OpenApiParameter("limit", int),
        ],
        responses=SearchPage,
    )
    def get(self, request):
        q = request.query_params.get("q", "").strip()
        if len(q) < 2:
            raise invalid({"q": "Type at least 2 characters"})
        kind = request.query_params.get("type")
        if kind not in (None, "") and kind not in services.global_types():
            raise invalid({"type": "Search tasks or comments"})
        limit = parse_limit(request.query_params.get("limit"), 20, 50)
        results = services.global_search(request.user, q, kind or None, limit)
        return Response({"data": results, "nextCursor": None})
