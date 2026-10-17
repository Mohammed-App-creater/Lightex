from django.urls import path

from . import views

urlpatterns = [
    path("workspaces/<str:slug>/modules", views.ModuleListView.as_view(), name="workspace-modules"),
    path("workspaces/<str:slug>/modules/<str:key>", views.ModuleDetailView.as_view(), name="workspace-module"),
]
