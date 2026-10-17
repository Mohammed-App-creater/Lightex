"""Every /api/v1 route, one include per app. Core routes sit at the root; tracking routes under `tracking/`."""

from django.urls import include, path

from core.common.views import health

tracking_urlpatterns = [
    path("", include("modules.tracking.projects.urls")),
    path("", include("modules.tracking.imports.urls")),
    path("", include("modules.tracking.timetracking.urls")),  # tasks/<uuid>/… routes before tasks/<task_ref>
    path("", include("core.collab.task_urls")),  # task-scoped comments and attachments (Stage 2 makes them generic)
    path("", include("modules.tracking.tasks.urls")),
    path("", include("modules.tracking.planning.urls")),
    path("", include("modules.tracking.reports.urls")),
    path("", include("modules.tracking.dashboards.urls")),
    path("", include("modules.tracking.integrations.urls")),
]

urlpatterns = [
    path("health", health, name="api-health"),
    path("", include("core.accounts.urls")),
    path("", include("core.workspaces.urls")),
    path("", include("core.access.urls")),
    path("", include("core.collab.urls")),
    path("", include("core.notifications.urls")),
    path("", include("core.search.urls")),
    path("", include("core.audit.urls")),
    path("", include("core.realtime.urls")),
    path("", include("core.channels.urls")),
    path("tracking/", include(tracking_urlpatterns)),
]
