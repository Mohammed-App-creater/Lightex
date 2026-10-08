from django.conf import settings
from django.db import models

from apps.common.models import BaseModel

EVENTS = ["assigned", "mentioned", "status_change", "comment", "due_soon", "sprint_started"]
DELIVERY = [("instant", "Instant"), ("hourly", "Hourly digest"), ("daily", "Daily digest")]


def default_events() -> dict:
    return {
        "assigned": {"in_app": True, "email": True},
        "mentioned": {"in_app": True, "email": True},
        "status_change": {"in_app": True, "email": False},
        "comment": {"in_app": True, "email": False},
        "due_soon": {"in_app": True, "email": True},
        "sprint_started": {"in_app": True, "email": False},
    }


class DomainEvent(BaseModel):
    """Outbox row written by services inside their transaction; consumed by the notification handler."""

    type = models.CharField(max_length=32)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    project = models.ForeignKey("projects.Project", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    payload = models.JSONField(default=dict)
    processed_at = models.DateTimeField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    error = models.TextField(blank=True, default="")

    class Meta:
        indexes = [models.Index(fields=["processed_at", "created_at"], name="event_unprocessed")]


class Notification(BaseModel):
    TYPES = [(t, t) for t in ("assigned", "mention", "status", "comment", "due", "sprint", "access")]

    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    project = models.ForeignKey("projects.Project", on_delete=models.CASCADE, related_name="+")
    task = models.ForeignKey("tasks.Task", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    type = models.CharField(max_length=16, choices=TYPES)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    payload = models.JSONField(default=dict)
    event = models.ForeignKey(
        DomainEvent, null=True, blank=True, on_delete=models.SET_NULL, related_name="notifications"
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
