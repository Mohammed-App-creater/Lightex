"""Base models: UUID keys, UTC timestamps and soft delete."""

import uuid

from django.db import models
from django.utils import timezone


class BaseModel(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class SoftDeleteQuerySet(models.QuerySet):
    def alive(self):
        return self.filter(deleted_at__isnull=True)

    def dead(self):
        return self.filter(deleted_at__isnull=False)


class AliveManager(models.Manager.from_queryset(SoftDeleteQuerySet)):  # type: ignore[misc]
    """Default manager: hides soft-deleted rows."""

    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)


class AllManager(models.Manager.from_queryset(SoftDeleteQuerySet)):  # type: ignore[misc]
    """Sees every row, deleted or not (trash, restore, purge)."""


class SoftDeleteModel(BaseModel):
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    objects = AliveManager()
    all_objects = AllManager()

    class Meta:
        abstract = True
        # Related-object access (task.project, …) must still resolve deleted rows.
        base_manager_name = "all_objects"

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None
