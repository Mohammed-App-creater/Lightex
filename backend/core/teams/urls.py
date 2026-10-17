from django.urls import path

from . import views

urlpatterns = [
    path("workspaces/<str:slug>/teams", views.TeamListView.as_view(), name="workspace-teams"),
    path("teams/<uuid:team_id>", views.TeamDetailView.as_view(), name="team-detail"),
    path("teams/<uuid:team_id>/members", views.TeamMemberListView.as_view(), name="team-members"),
    path(
        "teams/<uuid:team_id>/members/<uuid:user_id>", views.TeamMemberDetailView.as_view(), name="team-member-detail"
    ),
]
