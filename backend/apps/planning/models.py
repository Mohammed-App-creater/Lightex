from django.conf import settings
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone

from apps.common.models import BaseModel
from apps.common.utils import random_hue

# Progress (done / total / percent) for every planning entity is computed from tasks in
# planning.selectors and is never stored on these rows.


class Objective(BaseModel):
    STATUS_CHOICES = [("active", "Active"), ("achieved", "Achieved"), ("dropped", "Dropped")]

    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="objectives")
    title = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    quarter = models.CharField(max_length=16, blank=True, default="")
    due_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="active")

    class Meta:
        ordering = ["created_at"]


class Milestone(BaseModel):
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="milestones")
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    start_date = models.DateField()
    due_date = models.DateField()
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["due_date", "created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(start_date__lte=models.F("due_date")), name="milestone_dates_ordered"
            )
        ]


class Epic(BaseModel):
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="epics")
    name = models.CharField(max_length=80)
    description = models.TextField(blank=True, default="")
    hue = models.PositiveSmallIntegerField(default=random_hue)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    milestone = models.ForeignKey(Milestone, null=True, blank=True, on_delete=models.SET_NULL, related_name="epics")
    archived_at = models.DateTimeField(null=True, blank=True)
    # Board 32: explicit timeline span, both or neither (null = the client derives it from the tasks).
    start_date = models.DateField(null=True, blank=True)
    due_date = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint("project", Lower("name"), name="epic_name_unique_per_project"),
            models.CheckConstraint(
                condition=models.Q(start_date__isnull=True, due_date__isnull=True)
                | models.Q(start_date__isnull=False, due_date__isnull=False, start_date__lte=models.F("due_date")),
                name="epic_dates_ordered",
            ),
        ]


class Sprint(BaseModel):
    STATE_CHOICES = [("planned", "Planned"), ("active", "Active"), ("completed", "Completed")]

    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="sprints")
    name = models.CharField(max_length=60)
    number = models.PositiveIntegerField()
    goal = models.CharField(max_length=200, blank=True, default="")
    start_date = models.DateField()
    end_date = models.DateField()
    state = models.CharField(max_length=16, choices=STATE_CHOICES, default="planned")
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    # Commitment snapshot taken when the sprint starts (velocity "committed"). Not progress.
    committed_points = models.PositiveIntegerField(null=True, blank=True)
    committed_count = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["number"]
        constraints = [
            models.UniqueConstraint(fields=["project", "number"], name="sprint_number_unique"),
            models.UniqueConstraint(
                fields=["project"], condition=models.Q(state="active"), name="sprint_one_active_per_project"
            ),
            models.CheckConstraint(
                condition=models.Q(start_date__lte=models.F("end_date")), name="sprint_dates_ordered"
            ),
        ]


class SprintScopeChange(BaseModel):
    """A task added to or removed from a sprint after it started (scope-change tracking)."""

    KIND_CHOICES = [("added", "Added"), ("removed", "Removed")]

    sprint = models.ForeignKey(Sprint, on_delete=models.CASCADE, related_name="scope_changes")
    task = models.ForeignKey("tasks.Task", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    kind = models.CharField(max_length=8, choices=KIND_CHOICES)
    estimate = models.PositiveIntegerField(null=True, blank=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [models.Index(fields=["sprint", "at"], name="scope_change_sprint_at")]
