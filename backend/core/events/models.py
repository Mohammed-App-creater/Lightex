from django.conf import settings
from django.db import models

from core.common.models import BaseModel


class DomainEvent(BaseModel):
    """Outbox row written by services inside their transaction and dispatched to registered handlers on commit.

    `target_type` / `target_id` name the record the event is about (core/common/targets.py); module-specific context
    (for example `projectId`) lives in `payload`.
    """

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    type = models.CharField(max_length=64)  # namespaced: "tracking.task.assigned"
    target_type = models.CharField(max_length=64, blank=True, default="")
    target_id = models.UUIDField(null=True, blank=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    payload = models.JSONField(default=dict)
    processed_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    error = models.TextField(blank=True, default="")

    class Meta:
        indexes = [
            models.Index(fields=["processed_at", "created_at"], name="event_unprocessed"),
            models.Index(fields=["target_type", "target_id"], name="event_target"),
        ]

    @property
    def project_id(self) -> str | None:
        """The project the event belongs to, when a module put one in the payload (`payload.projectId`)."""
        return (self.payload or {}).get("projectId")
