from django.urls import path

from . import views

D = "dashboards/<uuid:dashboard_id>"

urlpatterns = [
    path("projects/<uuid:project_id>/dashboards", views.ProjectDashboardsView.as_view(), name="project-dashboards"),
    path(D, views.DashboardDetailView.as_view(), name="dashboard-detail"),
    path(f"{D}/layout", views.DashboardLayoutView.as_view(), name="dashboard-layout"),
]
