from django.urls import path

from . import views

R = "projects/<uuid:project_id>/reports"

urlpatterns = [
    path(f"{R}/kpis", views.KpisView.as_view(), name="report-kpis"),
    path(f"{R}/burndown", views.BurndownView.as_view(), name="report-burndown"),
    path(f"{R}/velocity", views.VelocityView.as_view(), name="report-velocity"),
    path(f"{R}/cycle-time", views.CycleTimeView.as_view(), name="report-cycle-time"),
    path(f"{R}/throughput", views.ThroughputView.as_view(), name="report-throughput"),
    path(f"{R}/progress", views.ProgressView.as_view(), name="report-progress"),
    path("projects/<uuid:project_id>/summary", views.SummaryView.as_view(), name="project-summary"),
]
