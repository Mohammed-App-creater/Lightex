import datetime

from django.conf import settings
from django.db import models

from core.common.models import BaseModel

DELIVERY = [("instant", "Instant"), ("hourly", "Hourly digest"), ("daily", "Daily digest")]
CHANNELS = ["in_app", "email", "telegram", "sms", "push"]


def default_events() -> dict:
    """The preference matrix defaults, one row per registered event type (core/events/registry.py)."""
    from core.events.registry import preference_types

    return {t.key: {c: bool(t.default_channels.get(c, False)) for c in CHANNELS} for t in preference_types()}


class Notification(BaseModel):
    TYPES = [(t, t) for t in ("assigned", "mention", "status", "comment", "due", "sprint", "access", "import")]

    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    # The record the notification is about (core/common/targets.py); title and link come from its describe().
    target_type = models.CharField(max_length=64, blank=True, default="")
    target_id = models.UUIDField(null=True, blank=True)
    title = models.CharField(max_length=300, blank=True, default="")
    link = models.CharField(max_length=500, blank=True, default="")
    # Scope hints copied from the target's describe() (projectId / taskId): inbox visibility and cascades.
    project = models.ForeignKey("projects.Project", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    task = models.ForeignKey("tasks.Task", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    type = models.CharField(max_length=16)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    payload = models.JSONField(default=dict)
    event = models.ForeignKey(
        "events.DomainEvent", null=True, blank=True, on_delete=models.SET_NULL, related_name="notifications"
    )
    read_at = models.DateTimeField(null=True, blank=True)
    # False for email-only deliveries (the user turned the in-app channel off for this event).
    in_app = models.BooleanField(default=True)
    # Email bookkeeping: pending for digest users, emailed_at once sent.
    email_template = models.CharField(max_length=32, blank=True, default="")
    email_context = models.JSONField(default=dict, blank=True)
    email_pending = models.BooleanField(default=False)
    emailed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["recipient", "in_app", "-created_at"], name="notif_recipient_created"),
            models.Index(fields=["recipient", "read_at"], name="notif_recipient_unread"),
            models.Index(fields=["email_pending"], name="notif_email_pending"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "recipient"], condition=models.Q(event__isnull=False), name="notif_once_per_event"
            )
        ]


class NotificationPreference(BaseModel):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notification_preference"
    )
    events = models.JSONField(default=default_events)
    email_delivery = models.CharField(max_length=8, choices=DELIVERY, default="instant")
    # Board 38 §3.8: quiet hours hold Telegram, SMS and Push; inactive while `timezone` is null.
    quiet_enabled = models.BooleanField(default=True)
    quiet_from = models.TimeField(default=datetime.time(22, 0))
    quiet_to = models.TimeField(default=datetime.time(8, 0))
    quiet_days = models.PositiveSmallIntegerField(default=127)  # bitmask, Mon = bit 0
    quiet_urgent_bypass = models.BooleanField(default=True)
    timezone = models.CharField(max_length=64, null=True, blank=True)
