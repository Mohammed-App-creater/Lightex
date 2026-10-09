"""Board 33 endpoints DB1–DB6 (docs/v2/33-dashboards-presence.md §5.2)."""

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response

from apps.access.permissions import MEMBER, ScopedView
from apps.common.params import body
from apps.projects.views import ProjectScopedView

from . import services
from .serializers import (
    DashboardCreateIn,
    DashboardLayoutIn,
    DashboardOut,
    DashboardPatchIn,
    DashboardSummariesOut,
)


class ProjectDashboardsView(ProjectScopedView):
    """DB1 list (shared, then your personal ones); DB2 create."""

    required = {"GET": "project.view", "POST": "dashboard.create"}

    @extend_schema(tags=["dashboards"], responses={200: DashboardSummariesOut})
    def get(self, request, project_id):
        return Response(services.summaries(request.user, self.scope))

    @extend_schema(tags=["dashboards"], request=DashboardCreateIn, responses={201: DashboardOut})
    def post(self, request, project_id):
        dashboard = services.create_dashboard(request.user, self.scope, body(request))
        return Response(services.current_payload(dashboard), status=status.HTTP_201_CREATED)


class DashboardScopedView(ScopedView):
    """Scope = the dashboard's project; another user's personal dashboard is 404 (§4.3)."""

    def get_scope(self):
        self.dashboard = services.dashboard_for(self.request.user, self.kwargs["dashboard_id"])
        return self.dashboard.project


class DashboardDetailView(DashboardScopedView):
    """DB3 read; DB4 rename / visibility; DB6 delete. Edit rules are decided by the service."""

    required = {"GET": "project.view", "PATCH": MEMBER, "DELETE": MEMBER}

    @extend_schema(tags=["dashboards"], responses={200: DashboardOut})
    def get(self, request, dashboard_id):
        return Response(services.current_payload(self.dashboard))

    @extend_schema(tags=["dashboards"], request=DashboardPatchIn, responses={200: DashboardOut})
    def patch(self, request, dashboard_id):
        dashboard = services.update_dashboard(request.user, self.dashboard, body(request))
        return Response(services.current_payload(dashboard))

    @extend_schema(tags=["dashboards"], responses={204: None})
    def delete(self, request, dashboard_id):
        services.delete_dashboard(request.user, self.dashboard)
        return Response(status=status.HTTP_204_NO_CONTENT)


class DashboardLayoutView(DashboardScopedView):
    """DB5: replace the ordered widget list (one version bump, one audit row)."""

    required = {"PUT": MEMBER}

    @extend_schema(tags=["dashboards"], request=DashboardLayoutIn, responses={200: DashboardOut})
    def put(self, request, dashboard_id):
        dashboard = services.save_layout(request.user, self.dashboard, body(request))
        return Response(services.current_payload(dashboard))
