from django.urls import path

from . import views

P = "projects/<uuid:project_id>"

urlpatterns = [
    path("workspaces/<str:slug>/projects", views.ProjectListView.as_view(), name="workspace-projects"),
    path("workspaces/<str:slug>/projects/<str:key>", views.ProjectByKeyView.as_view(), name="workspace-project-by-key"),
    path(
        "workspaces/<str:slug>/project-directory",
        views.ProjectDirectoryView.as_view(),
        name="workspace-project-directory",
    ),
    path(P, views.ProjectDetailView.as_view(), name="project-detail"),
    path(f"{P}/archive", views.ProjectArchiveView.as_view(), name="project-archive"),
    path(f"{P}/unarchive", views.ProjectUnarchiveView.as_view(), name="project-unarchive"),
    path(f"{P}/members", views.ProjectMembersView.as_view(), name="project-members"),
    path(f"{P}/members/<uuid:user_id>", views.ProjectMemberDetailView.as_view(), name="project-member-detail"),
    path(f"{P}/access-requests", views.AccessRequestsView.as_view(), name="project-access-requests"),
    path(f"{P}/access-requests/mine", views.MyAccessRequestView.as_view(), name="project-access-request-mine"),
    path(
        f"{P}/access-requests/<uuid:request_id>/deny",
        views.AccessRequestDenyView.as_view(),
        name="project-access-request-deny",
    ),
    path(f"{P}/statuses", views.StatusesView.as_view(), name="project-statuses"),
    path(f"{P}/statuses/reorder", views.StatusReorderView.as_view(), name="project-statuses-reorder"),
    path(f"{P}/statuses/<uuid:status_id>", views.StatusDetailView.as_view(), name="project-status-detail"),
    path(f"{P}/labels", views.LabelsView.as_view(), name="project-labels"),
    path(f"{P}/labels/<uuid:label_id>", views.LabelDetailView.as_view(), name="project-label-detail"),
]
