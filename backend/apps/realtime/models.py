"""Board 33 realtime storage (docs/v2/33-dashboards-presence.md §3.4, §3.5).

- `RealtimeEvent`: durable stream events, kept `REALTIME_EVENT_RETENTION_SECONDS` for `Last-Event-ID` replay. Ids are
  allocated under a global advisory lock after the business transaction commits, so they follow commit order.
- `PresenceSession`: one row per browser tab, refreshed by the heartbeat and deleted on leave or expiry.
"""

from django.conf import settings
from django.db import models

from apps.common.models import BaseModel

LOCATION_KINDS = [("board", "Board"), ("dashboard", "Dashboard"), ("task", "Task")]
STATES = [("viewing", "Viewing"), ("editing", "Editing")]


class RealtimeEvent(models.Model):
    id = models.BigAutoField(primary_key=True)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+", db_index=False)
    project = models.ForeignKey("projects.Project", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="+"
    )
    type = models.CharField(max_length=32)
    #: The envelope without its `id` (the row id is the event id).
    payload = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["workspace", "id"], name="rt_event_ws_id"),
            models.Index(fields=["created_at"], name="rt_event_created"),
        ]


class PresenceSession(BaseModel):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    session_id = models.UUIDField()
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="+")
    location_kind = models.CharField(max_length=10, choices=LOCATION_KINDS)
    location_id = models.UUIDField()
    #: A personal dashboard: stored, never broadcast or listed.
    private = models.BooleanField(default=False)
    state = models.CharField(max_length=8, choices=STATES, default="viewing")
    field = models.CharField(max_length=48, null=True, blank=True)
    typing_until = models.DateTimeField(null=True, blank=True)
    since = models.DateTimeField()
    expires_at = models.DateTimeField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "session_id"], name="presence_user_session_unique")]
        indexes = [
            models.Index(fields=["project", "expires_at"], name="presence_project_expiry"),
            models.Index(fields=["location_kind", "location_id"], name="presence_location"),
            models.Index(fields=["expires_at"], name="presence_expiry"),
        ]
