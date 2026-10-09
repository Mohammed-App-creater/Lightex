from django.conf import settings
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone

from apps.common.models import BaseModel, SoftDeleteModel
from apps.common.utils import random_hue

TEMPLATE_CHOICES = [("simple", "Simple"), ("scrum", "Scrum"), ("kanban", "Kanban"), ("bugs", "Bug tracking")]
CATEGORY_CHOICES = [("todo", "To do"), ("in_progress", "In progress"), ("done", "Done")]
GLYPH_CHOICES = [(g, g) for g in ("backlog", "todo", "progress", "review", "done", "canceled")]


class Project(SoftDeleteModel):
    STATUS_CHOICES = [("active", "Active"), ("archived", "Archived")]

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="projects")
    key = models.CharField(max_length=5)
    name = models.CharField(max_length=60)
    description = models.TextField(blank=True, default="")
    hue = models.PositiveSmallIntegerField(default=random_hue)
    lead = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="active")
    template = models.CharField(max_length=16, choices=TEMPLATE_CHOICES, default="kanban")
    # Per-project task counter; incremented under SELECT … FOR UPDATE when a task is created.
    task_seq = models.PositiveIntegerField(default=0)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta(SoftDeleteModel.Meta):
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "key"], condition=models.Q(deleted_at__isnull=True), name="project_key_unique_live"
            ),
            models.CheckConstraint(condition=models.Q(key__regex=r"^[A-Z]{2,5}$"), name="project_key_format"),
        ]
        indexes = [models.Index(fields=["workspace", "status"], name="project_ws_status")]

    def __str__(self) -> str:
        return self.key


class ProjectKeyAlias(BaseModel):
    """Every key a project has used. Task keys are immutable, so a retired prefix stays reserved."""

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="key_aliases")
    key = models.CharField(max_length=5)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "key"], name="project_key_alias_unique")]


class ProjectMember(BaseModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="project_memberships")
    role = models.ForeignKey("access.Role", on_delete=models.PROTECT, related_name="project_members")
    added_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["project", "user"], name="project_member_unique")]
        indexes = [models.Index(fields=["user", "project"], name="pmember_user_project")]


class Status(BaseModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="statuses")
    name = models.CharField(max_length=30)
    category = models.CharField(max_length=16, choices=CATEGORY_CHOICES)
    glyph = models.CharField(max_length=16, choices=GLYPH_CHOICES)
    color = models.CharField(max_length=40, null=True, blank=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "created_at"]
        indexes = [models.Index(fields=["project", "position"], name="status_project_position")]


class Label(BaseModel):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="labels")
    name = models.CharField(max_length=24)
    color = models.CharField(max_length=40, default="var(--text-3)")

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint("project", Lower("name"), name="label_name_unique_per_project")]


class AccessRequest(BaseModel):
    STATUS_CHOICES = [
        ("pending", "Pending"),
        ("approved", "Approved"),
        ("denied", "Denied"),
        ("withdrawn", "Withdrawn"),
    ]

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="access_requests")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    message = models.CharField(max_length=300, blank=True, default="")
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="pending")
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    decided_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["project", "user"], condition=models.Q(status="pending"), name="access_request_one_pending"
            )
        ]


class Recent(BaseModel):
    """Palette "Recent": the last tasks and projects a user opened."""

    KIND_CHOICES = [("task", "Task"), ("project", "Project")]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=8, choices=KIND_CHOICES)
    object_id = models.UUIDField()
    at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "object_id"], name="recent_unique")]
        indexes = [models.Index(fields=["user", "-at"], name="recent_user_at")]


class SavedView(BaseModel):
    """Board 30: a saved filter for one project, private ("me") or shared with the project."""

    ICONS = [(i, i) for i in ("filter", "star", "user", "calendar", "bolt", "flag")]

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="saved_views")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=40)
    icon = models.CharField(max_length=16, choices=ICONS, default="filter")
    visibility = models.CharField(max_length=8, choices=[("me", "Only me"), ("project", "Project")], default="me")
    layout = models.CharField(max_length=8, choices=[("board", "Board"), ("list", "List")], default="list")
    filters = models.JSONField(default=list)


class ViewPin(BaseModel):
    """A view pinned to one user's sidebar, in that user's order."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    view = models.ForeignKey(SavedView, on_delete=models.CASCADE, related_name="pins")
    position = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "view"], name="view_pin_unique")]


# ───────────────────────── custom fields (board 39) ─────────────────────────

FIELD_TYPES = [("text", "Text"), ("number", "Number"), ("select", "Select"), ("date", "Date"), ("user", "Person")]
FIELD_COLORS = (
    "var(--low)",
    "var(--accent-t)",
    "var(--info)",
    "var(--warn)",
    "var(--orange)",
    "var(--danger)",
    "var(--ok)",
    "var(--text-3)",
)


class CustomField(BaseModel):
    """A per-project task property. The type is fixed at creation; delete is a hard delete (values cascade)."""

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="custom_fields")
    name = models.CharField(max_length=40)
    type = models.CharField(max_length=8, choices=FIELD_TYPES)
    required = models.BooleanField(default=False)
    position = models.PositiveSmallIntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        constraints = [models.UniqueConstraint("project", Lower("name"), name="custom_field_name_unique")]
        indexes = [models.Index(fields=["project", "position"], name="custom_field_order")]


class CustomFieldOption(BaseModel):
    """One choice of a select field."""

    field = models.ForeignKey(CustomField, on_delete=models.CASCADE, related_name="options")
    name = models.CharField(max_length=32)
    color = models.CharField(max_length=24)
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint("field", Lower("name"), name="custom_field_option_unique")]
        indexes = [models.Index(fields=["field", "position"], name="custom_field_option_order")]
