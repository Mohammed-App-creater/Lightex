from django.conf import settings
from django.db import models

from apps.common.models import BaseModel

SOURCE_CHOICES = [("manual", "Manual"), ("timer", "Timer")]
MAX_ENTRY_MINUTES = 1440


class TimeEntry(BaseModel):
    """Time someone spent on a task on one day. Hard delete (audited)."""

    task = models.ForeignKey("tasks.Task", on_delete=models.CASCADE, related_name="time_entries")
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="+")  # for the timesheet
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="time_entries")
    minutes = models.PositiveSmallIntegerField()
    date = models.DateField()
    note = models.CharField(max_length=140, blank=True, default="")
    source = models.CharField(max_length=8, choices=SOURCE_CHOICES)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(minutes__gte=1, minutes__lte=MAX_ENTRY_MINUTES), name="time_entry_minutes_range"
            )
        ]
        indexes = [
            models.Index(fields=["task", "date"], name="time_entry_task_date"),
            models.Index(fields=["project", "date"], name="time_entry_project_date"),
            models.Index(fields=["user", "date"], name="time_entry_user_date"),
        ]


class RunningTimer(BaseModel):
    """At most one running timer per user, across all workspaces."""

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="running_timer")
    task = models.ForeignKey("tasks.Task", on_delete=models.CASCADE, related_name="+")
    started_at = models.DateTimeField()
