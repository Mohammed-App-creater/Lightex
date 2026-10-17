from django.conf import settings as django_settings
from django.db import models
from django.utils import timezone

from core.common.models import WorkspaceScopedModel


class WorkspaceModule(WorkspaceScopedModel):
    """Whether a module is on for a workspace. `core` has no row (always on)."""

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="modules")
    module_key = models.CharField(max_length=32)
    enabled = models.BooleanField(default=True)
    enabled_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    enabled_at = models.DateTimeField(default=timezone.now)
    settings = models.JSONField(default=dict, blank=True)
    # Reserved for future entitlements; unused.
    plan = models.CharField(max_length=32, null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["workspace", "module_key"], name="workspace_module_unique")]

    def __str__(self) -> str:
        return f"{self.workspace_id}:{self.module_key}"
