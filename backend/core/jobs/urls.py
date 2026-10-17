from django.urls import path

from . import views

urlpatterns = [
    path("internal/jobs/<str:name>", views.JobRunView.as_view(), name="internal-job-run"),
]
