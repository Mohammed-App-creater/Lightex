from django.urls import path

from . import views

urlpatterns = [
    path("search", views.GlobalSearchView.as_view(), name="search"),
    path("workspaces/<str:slug>/search", views.WorkspaceSearchView.as_view(), name="workspace-search"),
]
