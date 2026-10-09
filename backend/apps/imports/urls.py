from django.urls import path

from . import views

JOB = "imports/<uuid:import_id>"

urlpatterns = [
    path("projects/<uuid:project_id>/imports", views.ProjectImportsView.as_view(), name="project-imports"),
    path(JOB, views.ImportDetailView.as_view(), name="import-detail"),
    path(f"{JOB}/analyze", views.ImportAnalyzeView.as_view(), name="import-analyze"),
    path(f"{JOB}/mapping", views.ImportMappingView.as_view(), name="import-mapping"),
    path(f"{JOB}/rows", views.ImportRowsView.as_view(), name="import-rows"),
    path(f"{JOB}/start", views.ImportStartView.as_view(), name="import-start"),
    path(f"{JOB}/cancel", views.ImportCancelView.as_view(), name="import-cancel"),
    path(f"{JOB}/error-report", views.ImportErrorReportView.as_view(), name="import-error-report"),
]
