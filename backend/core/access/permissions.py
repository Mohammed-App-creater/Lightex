"""DRF integration. Every scoped view declares, per HTTP method, the permission it needs and how to
find the object (workspace or project) the permission is checked against. The permission class
below enforces it through `can()`; nothing else in a view decides access.
"""

from __future__ import annotations

import contextvars
from typing import Any, ClassVar

from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.views import APIView

from core.common import scoping
from core.common.exceptions import forbidden
from core.modules.services import ensure_enabled
from core.modules.urls_guard import module_of_request

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
        module = module_of_request(request)
        if module is not None:
            ensure_enabled(module, obj)  # the module guard: 403 module_disabled
        if code != MEMBER and not can(request.user, code, obj):
            raise forbidden(details={"permission": code})
        return True


class ScopedView(APIView):
    """Base for workspace- and project-scoped endpoints."""

    permission_classes = [IsAuthenticated, ScopedPermission]
    #: {"GET": "tracking.project.view", "POST": "tracking.task.create", "PATCH": MEMBER, …}
    required: ClassVar[dict[str, str]] = {}

    def get_scope(self) -> Any:  # pragma: no cover - every subclass implements it
        raise NotImplementedError

    def dispatch(self, request, *args, **kwargs):
        # The workspace set below stays inside this request, even without WorkspaceScopeMiddleware.
        return contextvars.copy_context().run(super().dispatch, request, *args, **kwargs)

    @property
    def scope(self) -> Any:
        """Resolved once, unscoped (this is the membership check that decides the tenant); the rest of the request is
        then scoped to the scope's workspace (core/common/scoping.py)."""
        if not hasattr(self, "_scope"):
            with scoping.unscoped():
                self._scope = self.get_scope()
            scoping.enter_workspace(scoping.workspace_id_of(self._scope))
        return self._scope
