"""Base models: UUID keys, UTC timestamps, soft delete and workspace scoping."""

import uuid
from typing import Any, ClassVar

from django.conf import settings
from django.db import models
from django.utils import timezone

from core.common import scoping


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


# ───────────────────────── workspace scoping (platform architecture §8) ─────────────────────────


def _fill_workspaces(model: Any, objs: Any) -> None:
    """Sets `workspace_id` on unsaved rows from their `workspace_parent` (one query per batch)."""
    parent = getattr(model, "workspace_parent", None)
    if not parent:
        return
    missing = [o for o in objs if getattr(o, "workspace_id", None) is None]
    if not missing:
        return
    field = model._meta.get_field(parent)
    cached: dict[Any, Any] = {}
    need: set[Any] = set()
    for obj in missing:
        if field.is_cached(obj):
            rel = getattr(obj, parent)
            if rel is not None:
                cached[rel.pk] = rel.workspace_id
        else:
            need.add(getattr(obj, field.attname))
    need.discard(None)
    if need:
        cached.update(field.related_model._base_manager.filter(pk__in=need).values_list("pk", "workspace_id"))
    for obj in missing:
        obj.workspace_id = cached.get(getattr(obj, field.attname))


class WorkspaceScopedQuerySet(models.QuerySet):
    def for_workspace(self, workspace: Any) -> Any:
        return self.filter(workspace_id=getattr(workspace, "pk", workspace))

    def bulk_create(self, objs: Any, *args: Any, **kwargs: Any) -> Any:
        objs = list(objs)
        _fill_workspaces(self.model, objs)
        return super().bulk_create(objs, *args, **kwargs)


class ScopedSoftDeleteQuerySet(WorkspaceScopedQuerySet, SoftDeleteQuerySet):  # type: ignore[override]
    pass


class _ScopedManagerMixin:
    """The policy (core/common/scoping.py): an explicit workspace, the request's workspace, or `unscoped()`."""

    model: Any

    def _base_queryset(self) -> Any:
        return super().get_queryset()  # type: ignore[misc]

    def get_queryset(self) -> Any:
        qs = self._base_queryset()
        ws = scoping.current_workspace_id()
        if ws is not None:
            return qs.filter(workspace_id=ws)
        if scoping.is_unscoped():
            return qs
        raise scoping.UnscopedQueryError(
            f"{self.model.__name__} is workspace-scoped: use .for_workspace(ws), a scoped view, or .unscoped()"
        )

    def for_workspace(self, workspace: Any) -> Any:
        return self._base_queryset().filter(workspace_id=getattr(workspace, "pk", workspace))

    def unscoped(self) -> Any:
        """The explicit escape hatch: every workspace."""
        return self._base_queryset()

    # Writes name their workspace (or derive it from `workspace_parent`), so they skip the read policy.
    def create(self, **kwargs: Any) -> Any:
        return self._base_queryset().create(**kwargs)

    def bulk_create(self, objs: Any, *args: Any, **kwargs: Any) -> Any:
        return self._base_queryset().bulk_create(objs, *args, **kwargs)


class WorkspaceScopedManager(_ScopedManagerMixin, models.Manager.from_queryset(WorkspaceScopedQuerySet)):  # type: ignore[misc]
    pass


class ScopedAliveManager(_ScopedManagerMixin, models.Manager.from_queryset(ScopedSoftDeleteQuerySet)):  # type: ignore[misc]
    """Scoped, and hides soft-deleted rows."""

    def _base_queryset(self) -> Any:
        return super()._base_queryset().filter(deleted_at__isnull=True)


class ScopedAllManager(_ScopedManagerMixin, models.Manager.from_queryset(ScopedSoftDeleteQuerySet)):  # type: ignore[misc]
    """Scoped, soft-deleted rows included (trash, restore, purge)."""


class WorkspaceScopedMixin:
    """Shared by both scoped bases. Each model declares its own non-null `workspace` foreign key (so it keeps its
    related name); `workspace_parent` names a foreign key whose row already has a `workspace_id`, and an unsaved row
    without a workspace takes its parent's on save and bulk_create."""

    workspace_parent: ClassVar[str | None] = None

    def save(self, *args: Any, **kwargs: Any) -> None:
        if getattr(self, "workspace_id", None) is None:
            _fill_workspaces(type(self), [self])
        super().save(*args, **kwargs)  # type: ignore[misc]


class WorkspaceScopedModel(WorkspaceScopedMixin, BaseModel):
    objects = WorkspaceScopedManager()

    class Meta:
        abstract = True
        default_manager_name = "objects"


class WorkspaceScopedSoftDeleteModel(WorkspaceScopedMixin, SoftDeleteModel):
    objects = ScopedAliveManager()  # type: ignore[misc]
    all_objects = ScopedAllManager()  # type: ignore[misc]
    #: Unscoped, every row: Django's related-object access (task.project, …). Not for queries.
    base_objects = AllManager()

    class Meta:
        abstract = True
        default_manager_name = "objects"
        base_manager_name = "base_objects"


class OwnedModel(models.Model):
    """Sales S0: a record with an owner, read through data scope (`core.access.services.visible_to`). Combine with
    `WorkspaceScopedModel` or `WorkspaceScopedSoftDeleteModel`, listed first so its Meta is inherited:
    `class Lead(WorkspaceScopedModel, OwnedModel)`."""

    data_scope_owner_field: ClassVar[str] = "owner"

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        abstract = True
