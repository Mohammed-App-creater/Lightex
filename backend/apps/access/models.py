from django.db import models
from django.db.models.functions import Lower

from apps.common.models import BaseModel

SCOPE_CHOICES = [("workspace", "Workspace"), ("project", "Project")]


class Permission(BaseModel):
    """Catalogue row. The source of truth is access.catalogue; rows are synced on migrate."""

    code = models.CharField(max_length=64, unique=True)
    scope = models.CharField(max_length=16, choices=SCOPE_CHOICES)
    group = models.CharField(max_length=32)
    label = models.CharField(max_length=80)
    description = models.CharField(max_length=200)
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["position"]

    def __str__(self) -> str:
        return self.code


class Role(BaseModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="roles")
    name = models.CharField(max_length=40)
    description = models.CharField(max_length=120, blank=True, default="")
    scope = models.CharField(max_length=16, choices=SCOPE_CHOICES)
    is_system = models.BooleanField(default=False)
    # Stable identity of a seeded role (owner, admin, …). Never used in access checks.
    system_key = models.CharField(max_length=32, null=True, blank=True)
    permissions = models.ManyToManyField(Permission, through="RolePermission", related_name="roles")

    class Meta:
        constraints = [
            models.UniqueConstraint("workspace", "scope", Lower("name"), name="role_name_unique_per_scope"),
            models.UniqueConstraint(
                fields=["workspace", "system_key"],
                condition=models.Q(system_key__isnull=False),
                name="role_system_key_unique",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.scope})"


class RolePermission(BaseModel):
    role = models.ForeignKey(Role, on_delete=models.CASCADE, related_name="role_permissions")
    permission = models.ForeignKey(Permission, on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["role", "permission"], name="role_permission_unique")]
