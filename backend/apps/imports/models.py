"""Board 40: import jobs (a file turned into tasks of one project) and their processed rows."""

from django.conf import settings
from django.db import models

from apps.common.models import BaseModel

SOURCES = [("csv", "CSV"), ("jira", "Jira")]
PRESETS = [("generic", "Generic"), ("jira", "Jira"), ("linear", "Linear"), ("asana", "Asana")]
STATUSES = [
    ("draft", "Draft"),
    ("ready", "Ready"),
    ("queued", "Queued"),
    ("running", "Running"),
    ("completed", "Completed"),
    ("failed", "Failed"),
    ("canceled", "Canceled"),
]
ACTIVE = ("queued", "running")
TERMINAL = ("completed", "failed", "canceled")
MAX_ROWS = 5000


class ImportJob(BaseModel):
    """One import. Status machine (§2.3): draft → ready → queued → running → completed | canceled | failed."""

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="imports")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    source = models.CharField(max_length=8, choices=SOURCES)
    preset = models.CharField(max_length=8, choices=PRESETS, default="generic")
    status = models.CharField(max_length=10, choices=STATUSES, default="draft")
    cancel_requested = models.BooleanField(default=False)
    file_name = models.CharField(max_length=120)
    file_size = models.PositiveIntegerField()
    source_key = models.CharField(max_length=300, unique=True)
    parsed_key = models.CharField(max_length=300, blank=True, default="")
    report_key = models.CharField(max_length=300, blank=True, default="")
    encoding = models.CharField(max_length=16, blank=True, default="")
    delimiter = models.CharField(max_length=1, blank=True, default="")
    row_count = models.PositiveIntegerField(default=0)
    column_count = models.PositiveIntegerField(default=0)
    analysis = models.JSONField(null=True, blank=True)
    # Normalised mapping (§4.5). The user's explicit value choices are kept under "_user" (never sent).
    mapping = models.JSONField(null=True, blank=True)
    mapping_revision = models.PositiveIntegerField(default=0)
    validation = models.JSONField(null=True, blank=True)
    phase = models.CharField(max_length=10, blank=True, default="")
    number_base = models.PositiveIntegerField(null=True, blank=True)
    planned_tasks = models.PositiveIntegerField(default=0)
    cursor = models.PositiveIntegerField(default=0)
    setup = models.JSONField(default=dict, blank=True)
    imported = models.PositiveIntegerField(default=0)
    # Epic rows processed (wire `progress.epics` / `result.epics`); epics created are counted in `setup`.
    epics_created = models.PositiveIntegerField(default=0)
    skipped = models.PositiveIntegerField(default=0)
    warnings = models.PositiveIntegerField(default=0)
    labels_created = models.PositiveIntegerField(default=0)
    options_created = models.PositiveIntegerField(default=0)
    first_key = models.CharField(max_length=24, blank=True, default="")
    last_key = models.CharField(max_length=24, blank=True, default="")
    recent = models.JSONField(default=list, blank=True)
    error_code = models.CharField(max_length=40, blank=True, default="")
    error_message = models.CharField(max_length=300, blank=True, default="")
    lease_token = models.UUIDField(null=True, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    request_id = models.CharField(max_length=64, blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    # created + 24 h until started; null while queued/running; finished + 30 days once terminal.
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["project"],
                condition=models.Q(status__in=["queued", "running"]),
                name="import_one_active_per_project",
            ),
            models.CheckConstraint(condition=models.Q(row_count__lte=MAX_ROWS), name="import_row_cap"),
        ]
        indexes = [
            models.Index(fields=["project", "-created_at"], name="import_project_recent"),
            models.Index(fields=["status", "heartbeat_at"], name="import_recovery"),
            models.Index(fields=["expires_at"], name="import_expiry"),
        ]

    @property
    def started(self) -> bool:
        """The job was started at least once (it has progress and, once terminal, a result)."""
        return bool(self.phase)


class ImportRow(BaseModel):
    """One processed data row of a started job: makes batches idempotent and feeds the report and I5."""

    OUTCOMES = [("task", "Task"), ("epic", "Epic"), ("skipped", "Skipped")]

    job = models.ForeignKey(ImportJob, on_delete=models.CASCADE, related_name="rows")
    row = models.PositiveIntegerField()  # spreadsheet row number: header = 1, first data row = 2
    outcome = models.CharField(max_length=8, choices=OUTCOMES)
    task = models.ForeignKey("tasks.Task", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    epic = models.ForeignKey("planning.Epic", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    refs = models.JSONField(default=list, blank=True)
    issues = models.JSONField(default=list, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["job", "row"], name="import_row_unique")]
        indexes = [models.Index(fields=["job", "outcome"], name="import_row_outcome")]
