from django.conf import settings
from django.db import models

from core.common.models import WorkspaceScopedModel


class AuditLog(WorkspaceScopedModel):
    """Append-only record of every mutation. Also the source of the project/task activity feeds."""

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="audit_logs")
    # Generic hints, no foreign keys (core never links to module tables): `scope_id` is the module access scope the
    # row belongs to (tracking: the project) and `subject_id` the record its feed groups it under (tracking: the task,
    # also for a comment on that task).
    scope_id = models.UUIDField(null=True, blank=True)
    subject_id = models.UUIDField(null=True, blank=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    actor_name = models.CharField(max_length=80, blank=True, default="")
    # Board 37: "user" or "integration"; actor_ref holds the integration id for integration actors.
    actor_kind = models.CharField(max_length=12, default="user")
    actor_ref = models.CharField(max_length=64, blank=True, default="")
    action = models.CharField(max_length=64)  # "<module>.<entity>.<verb>", e.g. tracking.task.status_changed
    module = models.CharField(max_length=32, blank=True, default="")
    # The record acted on: `<module>.<entity>` (tracking.task, core.comment, core.role, …) and its id.
    target_type = models.CharField(max_length=64)
    target_id = models.CharField(max_length=64, blank=True, default="")
    entity_key = models.CharField(max_length=40, null=True, blank=True)
    target = models.CharField(max_length=300, blank=True, default="")
    task_key = models.CharField(max_length=40, null=True, blank=True)
    task_title = models.CharField(max_length=300, null=True, blank=True)
    changes = models.JSONField(default=list, blank=True)
    data = models.JSONField(default=dict, blank=True)
    source = models.CharField(max_length=8, default="web")
    request_id = models.CharField(max_length=64, null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["workspace", "-created_at"], name="audit_ws_created"),
            models.Index(fields=["scope_id", "-created_at"], name="audit_scope_created"),
            models.Index(fields=["subject_id", "-created_at"], name="audit_subject_created"),
            models.Index(fields=["workspace", "actor", "-created_at"], name="audit_ws_actor"),
            models.Index(
                fields=["workspace", "actor_ref", "-created_at"],
                condition=~models.Q(actor_ref=""),
                name="audit_ws_actor_ref",
            ),
        ]
