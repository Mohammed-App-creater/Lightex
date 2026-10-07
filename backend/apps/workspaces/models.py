from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.common.models import BaseModel, SoftDeleteModel
from apps.common.utils import random_hue


class Workspace(SoftDeleteModel):
    # Globally unique (including soft-deleted workspaces, so a restore never collides).
    slug = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=40)
    hue = models.PositiveSmallIntegerField(default=random_hue)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    def __str__(self) -> str:
        return self.slug


class WorkspaceMember(BaseModel):
    STATUS_CHOICES = [("active", "Active"), ("deactivated", "Deactivated")]

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="workspace_memberships")
    role = models.ForeignKey("access.Role", on_delete=models.PROTECT, related_name="workspace_members")
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="active")
    joined_at = models.DateTimeField(default=timezone.now)
    last_active_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "user"], name="workspace_member_unique")]
        indexes = [models.Index(fields=["user", "status"], name="wsmember_user_status")]


class Invitation(BaseModel):
    STATUS_CHOICES = [("pending", "Pending"), ("accepted", "Accepted"), ("revoked", "Revoked")]

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField()
    role = models.ForeignKey("access.Role", on_delete=models.CASCADE, related_name="invitations")
    invited_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    # SHA-256 of the token. The raw token only ever exists in the emailed link.
    token_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="pending")
    accepted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    accepted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "email"],
                condition=models.Q(status="pending"),
                name="invitation_one_pending_per_email",
            )
        ]

    @property
    def effective_status(self) -> str:
        if self.status == "pending" and self.expires_at <= timezone.now():
            return "expired"
        return self.status


class WorkspaceAccessRequest(BaseModel):
    """Board 24: a member asks the workspace admins to be added to a project."""

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="access_requests")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "user"], name="ws_access_request_unique")]
