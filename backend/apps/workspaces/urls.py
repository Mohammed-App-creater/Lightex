from django.urls import path

from . import views

urlpatterns = [
    path("workspaces", views.WorkspaceListView.as_view(), name="workspace-list"),
    path("workspaces/<str:slug>", views.WorkspaceDetailView.as_view(), name="workspace-detail"),
    path(
        "workspaces/<str:slug>/slug-availability",
        views.SlugAvailabilityView.as_view(),
        name="workspace-slug-availability",
    ),
    path("workspaces/<str:slug>/members", views.MemberListView.as_view(), name="workspace-members"),
    path(
        "workspaces/<str:slug>/members/<uuid:user_id>", views.MemberDetailView.as_view(), name="workspace-member-detail"
    ),
    path("workspaces/<str:slug>/invites", views.InviteListView.as_view(), name="workspace-invites"),
    path(
        "workspaces/<str:slug>/invites/<uuid:invite_id>",
        views.InviteDetailView.as_view(),
        name="workspace-invite-detail",
    ),
    path(
        "workspaces/<str:slug>/invites/<uuid:invite_id>/resend",
        views.InviteResendView.as_view(),
        name="workspace-invite-resend",
    ),
    path(
        "workspaces/<str:slug>/access-requests",
        views.AccessRequestCreateView.as_view(),
        name="workspace-access-requests",
    ),
    path(
        "workspaces/<str:slug>/access-requests/mine",
        views.MyAccessRequestView.as_view(),
        name="workspace-access-request-mine",
    ),
    path("invites/<str:token>", views.PublicInviteView.as_view(), name="invite-public"),
    path("invites/<str:token>/accept", views.AcceptInviteView.as_view(), name="invite-accept"),
]
