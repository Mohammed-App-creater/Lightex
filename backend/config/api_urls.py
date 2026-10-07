"""Every /api/v1 route, one include per app."""

from django.urls import include, path

from apps.common.views import health

urlpatterns = [
    path("health", health, name="api-health"),
    path("", include("apps.accounts.urls")),
    path("", include("apps.workspaces.urls")),
    path("", include("apps.access.urls")),
    path("", include("apps.projects.urls")),
    path("", include("apps.tasks.urls")),
    path("", include("apps.planning.urls")),
    path("", include("apps.collaboration.urls")),
    path("", include("apps.notifications.urls")),
    path("", include("apps.search.urls")),
    path("", include("apps.audit.urls")),
    path("", include("apps.reports.urls")),
]
