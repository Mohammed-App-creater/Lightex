from django.db import models
from django.db.models.functions import Lower

from core.common.models import BaseModel

SCOPE_CHOICES = [("workspace", "Workspace"), ("project", "Project")]
DATA_SCOPE_CHOICES = [("own", "Own"), ("team", "Team"), ("all", "All")]


class Permission(BaseModel):
    """Catalogue row. The source of truth is the module definitions (access.catalogue assembles them); rows are
    synced on migrate and by `manage.py sync_permissions`."""

    code = models.CharField(max_length=64, unique=True)
    scope = models.CharField(max_length=16, choices=SCOPE_CHOICES)
    module = models.CharField(max_length=32, default="core")
    group = models.CharField(max_length=32)
    label = models.CharField(max_length=80)
    description = models.CharField(max_length=200)
    position = models.PositiveSmallIntegerField(default=0)
    #: Granted with a data scope (own, team or all) on every role; workspace scope only (platform Stage 4).
    scopable = models.BooleanField(default=False)

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
    #: Required when the permission is scopable, null otherwise (enforced by the role services, the catalogue sync and
    #: the seeders).
    data_scope = models.CharField(max_length=8, choices=DATA_SCOPE_CHOICES, null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["role", "permission"], name="role_permission_unique"),
            models.CheckConstraint(
                condition=models.Q(data_scope__isnull=True) | models.Q(data_scope__in=["own", "team", "all"]),
                name="role_permission_data_scope_valid",
            ),
        ]
