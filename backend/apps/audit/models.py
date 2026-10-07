from django.conf import settings
from django.db import models

from apps.common.models import BaseModel


class AuditLog(BaseModel):
    """Append-only record of every mutation. Also the source of the project/task activity feeds."""

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="audit_logs")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    actor_name = models.CharField(max_length=80, blank=True, default="")
    action = models.CharField(max_length=64)  # "<entity>.<verb>", e.g. task.status_changed
    entity_type = models.CharField(max_length=32)
    entity_id = models.CharField(max_length=64, blank=True, default="")
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
            models.Index(fields=["workspace", "actor", "-created_at"], name="audit_ws_actor"),
        ]
