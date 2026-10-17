from django.urls import path

from . import views

urlpatterns = [
    path("workspaces/<str:slug>/stream", views.StreamView.as_view(), name="workspace-stream"),
    path("workspaces/<str:slug>/presence", views.PresenceRosterView.as_view(), name="workspace-presence"),
    path(
        "workspaces/<str:slug>/presence/<uuid:session_id>",
        views.PresenceView.as_view(),
        name="workspace-presence-session",
    ),
]
