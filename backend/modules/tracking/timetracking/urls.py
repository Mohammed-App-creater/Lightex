from django.urls import path

from . import views

T = "tasks/<uuid:task_id>"

urlpatterns = [
    path(f"{T}/time-entries", views.TaskTimeEntriesView.as_view(), name="task-time-entries"),
    path(f"{T}/timer", views.TaskTimerView.as_view(), name="task-timer"),
    path("time-entries/<uuid:entry_id>", views.TimeEntryDetailView.as_view(), name="time-entry-detail"),
    path("me/timer", views.MyTimerView.as_view(), name="my-timer"),
    path("me/timer/stop", views.MyTimerStopView.as_view(), name="my-timer-stop"),
    path("workspaces/<str:slug>/timesheet", views.TimesheetView.as_view(), name="workspace-timesheet"),
]
