"""Every /api/v1 route, one include per app."""

from django.urls import path

from apps.common.views import health

urlpatterns = [
    path("health", health, name="api-health"),
]
