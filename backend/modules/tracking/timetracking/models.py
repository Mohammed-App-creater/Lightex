from django.conf import settings
from django.db import models

from core.common.models import BaseModel, WorkspaceScopedModel

SOURCE_CHOICES = [("manual", "Manual"), ("timer", "Timer")]
MAX_ENTRY_MINUTES = 1440


class TimeEntry(WorkspaceScopedModel):
    """Time someone spent on a task on one day. Hard delete (audited)."""

    workspace_parent = "project"

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
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
    """At most one running timer per user, across all workspaces.

    Not a WorkspaceScopedModel: there is one timer per user across every workspace, so its reads are per user.
    The workspace is still stored (the task's), for cascades and tenant checks."""

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="running_timer")
    task = models.ForeignKey("tasks.Task", on_delete=models.CASCADE, related_name="+")
    started_at = models.DateTimeField()

    def save(self, *args, **kwargs):
        if self.workspace_id is None:
            self.workspace_id = self.task.workspace_id
        super().save(*args, **kwargs)
