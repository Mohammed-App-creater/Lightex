from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.exceptions import invalid
from apps.common.pagination import parse_limit
from apps.common.params import filter_values
from apps.workspaces.views import WorkspaceScopedView

from . import services


class WorkspaceSearchView(WorkspaceScopedView):
    required = {"GET": "workspace.view"}

    @extend_schema(
        tags=["search"],
        parameters=[
            OpenApiParameter("q", str),
            OpenApiParameter("filter[type]", str, many=True, enum=["task", "project", "user"]),
            OpenApiParameter("limit", int),
        ],
    )
    def get(self, request, slug):
        types = filter_values(request, "type")
        if any(t not in ("task", "project", "user") for t in types):
            raise invalid({"filter[type]": "Search tasks, projects or users"})
        limit = parse_limit(request.query_params.get("limit"), 20, 50)
        return Response(
            services.workspace_search(request.user, self.scope, request.query_params.get("q", ""), types, limit)
        )


class GlobalSearchView(APIView):
    """GET search?q=&type=task|comment: full-text search across every project the user belongs to."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["search"],
        parameters=[
            OpenApiParameter("q", str, required=True),
            OpenApiParameter("type", str, enum=["task", "comment"]),
            OpenApiParameter("limit", int),
        ],
    )
    def get(self, request):
        q = request.query_params.get("q", "").strip()
        if len(q) < 2:
            raise invalid({"q": "Type at least 2 characters"})
        kind = request.query_params.get("type")
        if kind not in (None, "", "task", "comment"):
            raise invalid({"type": "Search tasks or comments"})
        limit = parse_limit(request.query_params.get("limit"), 20, 50)
        results: list[dict] = []
        if kind in (None, "", "task"):
            results.extend(services.task_result(t) for t in services.search_tasks(request.user, q, limit=limit))
        if kind in (None, "", "comment"):
            results.extend(services.comment_result(c) for c in services.search_comments(request.user, q, limit=limit))
        return Response({"data": results, "nextCursor": None})
