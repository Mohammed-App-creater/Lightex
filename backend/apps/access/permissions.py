"""DRF integration. Every scoped view declares, per HTTP method, the permission it needs and how to
find the object (workspace or project) the permission is checked against. The permission class
below enforces it through `can()`; nothing else in a view decides access.
"""

from __future__ import annotations

from typing import Any, ClassVar

from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.views import APIView

from apps.common.exceptions import forbidden

from .services import can

# Sentinel: the method needs scope membership only (fine-grained checks happen in the service via can()).
MEMBER = "__member__"


class ScopedPermission(BasePermission):
    def has_permission(self, request, view) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method == "OPTIONS":
            return True
        code = getattr(view, "required", {}).get(request.method)
        if code is None:
            # Fail closed: a method without a declared permission is never allowed.
            raise forbidden("This action is not available.")
        obj = view.scope  # resolving the scope raises 404 / 403 membership errors
        if code != MEMBER and not can(request.user, code, obj):
            raise forbidden(details={"permission": code})
        return True


class ScopedView(APIView):
    """Base for workspace- and project-scoped endpoints."""

    permission_classes = [IsAuthenticated, ScopedPermission]
    #: {"GET": "project.view", "POST": "task.create", "PATCH": MEMBER, …}
    required: ClassVar[dict[str, str]] = {}

    def get_scope(self) -> Any:  # pragma: no cover - every subclass implements it
        raise NotImplementedError

    @property
    def scope(self) -> Any:
        if not hasattr(self, "_scope"):
            self._scope = self.get_scope()
        return self._scope
