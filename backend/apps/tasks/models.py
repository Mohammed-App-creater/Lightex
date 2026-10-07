from django.conf import settings
from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models
from django.utils import timezone

from apps.common.models import BaseModel, SoftDeleteModel

TYPE_CHOICES = [("feature", "Feature"), ("bug", "Bug"), ("chore", "Chore"), ("spike", "Spike")]


class Task(SoftDeleteModel):
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="tasks")
    number = models.PositiveIntegerField()
    # Project key + number at creation time. Immutable, even if the project key changes later.
    key = models.CharField(max_length=16)
    title = models.CharField(max_length=200)
    description = models.JSONField(null=True, blank=True)  # sanitised Tiptap JSON
    type = models.CharField(max_length=16, choices=TYPE_CHOICES, default="feature")
    priority = models.PositiveSmallIntegerField(default=0)
    status = models.ForeignKey("projects.Status", on_delete=models.PROTECT, related_name="tasks")
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="assigned_tasks"
    )
    reporter = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="reported_tasks"
    )
    estimate = models.PositiveSmallIntegerField(null=True, blank=True)
    due_date = models.DateField(null=True, blank=True)
    epic = models.ForeignKey("planning.Epic", null=True, blank=True, on_delete=models.SET_NULL, related_name="tasks")
    milestone = models.ForeignKey(
        "planning.Milestone", null=True, blank=True, on_delete=models.SET_NULL, related_name="tasks"
    )
    sprint = models.ForeignKey(
        "planning.Sprint", null=True, blank=True, on_delete=models.SET_NULL, related_name="tasks"
    )
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.CASCADE, related_name="subtasks")
    objectives = models.ManyToManyField("planning.Objective", through="TaskObjective", related_name="tasks", blank=True)
    labels = models.ManyToManyField("projects.Label", through="TaskLabel", related_name="tasks", blank=True)
    # Base-62 fractional index; "C" collation so the DB orders exactly like the client.
    position = models.CharField(max_length=64, db_collation="C")
    version = models.PositiveIntegerField(default=1)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    search_vector = SearchVectorField(null=True, editable=False)

    class Meta(SoftDeleteModel.Meta):
        constraints = [
            models.UniqueConstraint(fields=["project", "number"], name="task_number_unique_per_project"),
            models.CheckConstraint(condition=models.Q(priority__lte=4), name="task_priority_range"),
            models.CheckConstraint(condition=models.Q(estimate__lte=99), name="task_estimate_range"),
            models.CheckConstraint(condition=~models.Q(parent=models.F("id")), name="task_not_own_parent"),
        ]
        indexes = [
            models.Index(fields=["project", "status", "position"], name="task_board_order"),
            models.Index(fields=["key"], name="task_key"),
            models.Index(fields=["assignee", "deleted_at"], name="task_assignee"),
            models.Index(fields=["sprint", "deleted_at"], name="task_sprint"),
            models.Index(fields=["project", "completed_at"], name="task_completed"),
            models.Index(fields=["parent"], name="task_parent"),
            GinIndex(fields=["search_vector"], name="task_search_gin"),
        ]

    def __str__(self) -> str:
        return self.key


class TaskObjective(BaseModel):
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="+")
    objective = models.ForeignKey("planning.Objective", on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["task", "objective"], name="task_objective_unique")]


class TaskLabel(BaseModel):
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="+")
    label = models.ForeignKey("projects.Label", on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["task", "label"], name="task_label_unique")]


class TaskStatusHistory(BaseModel):
    """Every status change. Feeds burndown, cycle time and throughput."""

    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="status_history")
    from_status = models.ForeignKey(
        "projects.Status", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    to_status = models.ForeignKey("projects.Status", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    from_category = models.CharField(max_length=16, null=True, blank=True)
    to_category = models.CharField(max_length=16)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [
            models.Index(fields=["task", "at"], name="history_task_at"),
            models.Index(fields=["to_category", "at"], name="history_category_at"),
        ]


class ExternalLink(BaseModel):
    """Reserved for v2 integrations (GitHub/GitLab). No endpoints in v1."""

    PROVIDERS = [("github", "GitHub"), ("gitlab", "GitLab"), ("other", "Other")]
    TYPES = [("pull_request", "Pull request"), ("commit", "Commit"), ("branch", "Branch"), ("issue", "Issue")]

    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="external_links")
    provider = models.CharField(max_length=16, choices=PROVIDERS)
    url = models.URLField(max_length=500)
    type = models.CharField(max_length=16, choices=TYPES)
    external_id = models.CharField(max_length=120)
