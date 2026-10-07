"""Every /api/v1 route, one include per app."""

from django.urls import include, path

from apps.common.views import health

urlpatterns = [
    path("health", health, name="api-health"),
    path("", include("apps.accounts.urls")),
    path("", include("apps.workspaces.urls")),
    path("", include("apps.access.urls")),
]
