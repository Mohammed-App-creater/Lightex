from typing import Any

from django.conf import settings
from django.db import models
from django.utils import timezone

from core.common.models import SoftDeleteModel, WorkspaceScopedModel
from core.common.utils import random_hue

from .timezone import DEFAULT_TIMEZONE


class Workspace(SoftDeleteModel):
    # Globally unique (including soft-deleted workspaces, so a restore never collides).
    slug = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=40)
    hue = models.PositiveSmallIntegerField(default=random_hue)
    # Board 38 §3.9: `notificationPolicy.sms` (workspace.update). Off skips SMS for this workspace's events.
    sms_enabled = models.BooleanField(default=True)
    # Sales S0: an IANA name; "today" and period boundaries are computed in it (core/workspaces/timezone.py).
    timezone = models.CharField(max_length=64, default=DEFAULT_TIMEZONE)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    def __str__(self) -> str:
        return self.slug


class WorkspaceMember(WorkspaceScopedModel):
    STATUS_CHOICES = [("active", "Active"), ("deactivated", "Deactivated")]

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="workspace_memberships")
    #: Sales S0: one or more workspace-scope roles; permissions are their union (core/access/services.py).
    roles = models.ManyToManyField("access.Role", through="WorkspaceMemberRole", related_name="workspace_members")
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="active")
    joined_at = models.DateTimeField(default=timezone.now)
    last_active_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "user"], name="workspace_member_unique")]
        indexes = [models.Index(fields=["user", "status"], name="wsmember_user_status")]

    def role_list(self) -> list[Any]:
        """The member's roles in precedence order (prefetched `role_links` are used when present)."""
        return _ordered_roles(self, WorkspaceMemberRole, "member")


class WorkspaceMemberRole(WorkspaceScopedModel):
    workspace_parent = "member"

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="+")
    member = models.ForeignKey(WorkspaceMember, on_delete=models.CASCADE, related_name="role_links")
    role = models.ForeignKey("access.Role", on_delete=models.PROTECT, related_name="member_links")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["member", "role"], name="workspace_member_role_unique")]


def _ordered_roles(obj: Any, link_model: Any, parent: str) -> list[Any]:
    """`obj`'s roles through `link_model` (its `role_links`), in precedence order."""
    from core.access.catalogue import role_precedence_key

    links = getattr(obj, "_prefetched_objects_cache", {}).get("role_links")
    if links is None:
        links = link_model.objects.for_workspace(obj.workspace_id).filter(**{parent: obj}).select_related("role")
    return sorted((link.role for link in links), key=role_precedence_key)


class Invitation(WorkspaceScopedModel):
    STATUS_CHOICES = [("pending", "Pending"), ("accepted", "Accepted"), ("revoked", "Revoked")]

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField()
    #: Sales S0: the workspace roles the invitee gets on accept (one or more).
    roles = models.ManyToManyField("access.Role", through="InvitationRole", related_name="invitations")
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

    def role_list(self) -> list[Any]:
        return _ordered_roles(self, InvitationRole, "invitation")


class InvitationRole(WorkspaceScopedModel):
    workspace_parent = "invitation"

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="+")
    invitation = models.ForeignKey(Invitation, on_delete=models.CASCADE, related_name="role_links")
    role = models.ForeignKey("access.Role", on_delete=models.CASCADE, related_name="invitation_links")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["invitation", "role"], name="invitation_role_unique")]


class WorkspaceAccessRequest(WorkspaceScopedModel):
    """Board 24: a member asks the workspace admins to be added to a project."""

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="access_requests")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "user"], name="ws_access_request_unique")]
