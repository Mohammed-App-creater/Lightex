"""Every /api/v1 route, one include per app. Core routes sit at the root; each module's under `<module key>/`,
wrapped by `module_urls` so the module guard answers 403 `module_disabled` while the module is off."""

from django.urls import include, path

from core.common.views import health
from core.modules.urls_guard import module_urls

tracking_urlpatterns = [
    path("", include("modules.tracking.projects.urls")),
    path("", include("modules.tracking.imports.urls")),
    path("", include("modules.tracking.timetracking.urls")),  # tasks/<uuid>/… routes before tasks/<task_ref>
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
    path("", include("core.teams.urls")),
    path("", include("core.collab.urls")),
    path("", include("core.notifications.urls")),
    path("", include("core.search.urls")),
    path("", include("core.audit.urls")),
    path("", include("core.realtime.urls")),
    path("", include("core.channels.urls")),
    path("", include("core.modules.urls")),
    path("tracking/", include(module_urls("tracking", tracking_urlpatterns))),
    path("sales/", include(module_urls("sales", [path("", include("modules.sales.urls"))]))),
]
