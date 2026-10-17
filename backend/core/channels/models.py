"""Board 38 channels: Telegram, SMS and Web Push connections plus the delivery log (docs/v2/38-telegram-sms-push.md §3).

`ChannelDelivery` is the log, the retry queue and the dead letter at once. Rendered text is never stored: it is
rebuilt from `template` + `context` at send time.
"""

from django.conf import settings
from django.db import models
from django.db.models import Q

from core.common.models import BaseModel


class TelegramLinkRequest(BaseModel):
    STATUSES = ["pending", "linked", "expired", "canceled"]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    code_hash = models.CharField(max_length=64)
    start_hash = models.CharField(max_length=64, unique=True)
    status = models.CharField(max_length=10, default="pending")
    expires_at = models.DateTimeField()
    linked_at = models.DateTimeField(null=True, blank=True)
    connection = models.ForeignKey(
        "channels.TelegramConnection", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        indexes = [models.Index(fields=["code_hash", "status"], name="tglink_code_status")]
        constraints = [
            models.UniqueConstraint(fields=["user"], condition=Q(status="pending"), name="tglink_one_pending")
        ]


class TelegramLinkFailure(BaseModel):
    """A wrong code from a chat (§5.12): 5 per hour silence the chat for an hour, counted in the database."""

    chat_id = models.BigIntegerField(db_index=True)


class TelegramConnection(BaseModel):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="telegram_connection")
    chat_id = models.BigIntegerField(db_index=True)
    username = models.CharField(max_length=64, null=True, blank=True)
    first_name = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=10, default="active")
    connected_at = models.DateTimeField()
    last_error = models.TextField(null=True, blank=True)
    last_error_at = models.DateTimeField(null=True, blank=True)


class SmsVerification(BaseModel):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    phone_enc = models.TextField()
    phone_hash = models.CharField(max_length=64)
    country = models.CharField(max_length=2)
    code_hash = models.CharField(max_length=64)
    attempts_left = models.SmallIntegerField(default=3)
    send_count = models.SmallIntegerField(default=1)
    status = models.CharField(max_length=10, default="pending")
    expires_at = models.DateTimeField()
    resend_at = models.DateTimeField()
    verified_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["user", "created_at"], name="smsv_user_created"),
            models.Index(fields=["phone_hash", "created_at"], name="smsv_phone_created"),
        ]
        constraints = [models.UniqueConstraint(fields=["user"], condition=Q(status="pending"), name="smsv_one_pending")]


class OtpSend(BaseModel):
    """One row per OTP sent: the §7.5 limits count these, so they hold across processes and resends."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    phone_hash = models.CharField(max_length=64)
    ip = models.GenericIPAddressField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["user", "created_at"], name="otp_user_created"),
            models.Index(fields=["phone_hash", "created_at"], name="otp_phone_created"),
            models.Index(fields=["created_at"], name="otp_created"),
        ]


class SmsConnection(BaseModel):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="sms_connection")
    phone_enc = models.TextField()
    phone_hash = models.CharField(max_length=64, db_index=True)
    country = models.CharField(max_length=2)
    last4 = models.CharField(max_length=4)
    status = models.CharField(max_length=12, default="active")
    verified_at = models.DateTimeField()
    opted_out_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(null=True, blank=True)
    last_error_at = models.DateTimeField(null=True, blank=True)


class PushSubscription(BaseModel):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="push_subscriptions")
    endpoint = models.TextField()
    endpoint_hash = models.CharField(max_length=64, unique=True)
    p256dh = models.CharField(max_length=100)
    auth = models.CharField(max_length=32)
    expiration_time = models.DateTimeField(null=True, blank=True)
    label = models.CharField(max_length=60)
    user_agent = models.CharField(max_length=256, blank=True, default="")
    status = models.CharField(max_length=10, default="active")
    last_seen_at = models.DateTimeField()
    last_success_at = models.DateTimeField(null=True, blank=True)
    failure_count = models.SmallIntegerField(default=0)

    class Meta:
        indexes = [models.Index(fields=["user", "status"], name="push_user_status")]


class ChannelDelivery(BaseModel):
    STATUSES = ["queued", "deferred", "sending", "retry", "sent", "failed", "dead", "skipped", "coalesced"]
    PENDING = ("queued", "deferred", "retry")

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    workspace = models.ForeignKey(
        "workspaces.Workspace", null=True, blank=True, on_delete=models.CASCADE, related_name="+"
    )
    channel = models.CharField(max_length=10)
    kind = models.CharField(max_length=10, default="event")
    notification = models.ForeignKey(
        "notifications.Notification", null=True, blank=True, on_delete=models.CASCADE, related_name="+"
    )
    event = models.CharField(max_length=20)
    telegram = models.ForeignKey(TelegramConnection, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    sms = models.ForeignKey(SmsConnection, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    push = models.ForeignKey(PushSubscription, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    template = models.CharField(max_length=40)
    context = models.JSONField(default=dict, blank=True)
    urgent = models.BooleanField(default=False)
    status = models.CharField(max_length=10, default="queued")
    skip_reason = models.CharField(max_length=20, blank=True, default="")
    attempts = models.SmallIntegerField(default=0)
    next_attempt_at = models.DateTimeField()
    lease_until = models.DateTimeField(null=True, blank=True)
    provider_id = models.CharField(max_length=64, blank=True, default="")
    error_code = models.CharField(max_length=32, blank=True, default="")
    error = models.TextField(blank=True, default="")
    sent_at = models.DateTimeField(null=True, blank=True)
    summary = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="coalesced")

    class Meta:
        indexes = [
            models.Index(fields=["status", "next_attempt_at"], name="chdel_status_next"),
            models.Index(fields=["user", "channel", "created_at"], name="chdel_user_channel"),
            models.Index(fields=["provider_id"], name="chdel_provider_id"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["notification", "channel", "telegram", "sms", "push"],
                condition=Q(notification__isnull=False),
                name="chdel_once_per_target",
                nulls_distinct=False,
            ),
        ]
