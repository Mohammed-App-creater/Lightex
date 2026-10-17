from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.response import Response

from core.workspaces.views import WorkspaceScopedView

from .module import HEALTH_VIEW, KEY


class SalesHealthView(WorkspaceScopedView):
    """A placeholder route proving the module guard: 403 `module_disabled` while sales is off."""

    required = {"GET": HEALTH_VIEW}

    @extend_schema(
        tags=["sales"],
        responses=inline_serializer(
            "SalesHealth",
            {
                "status": serializers.CharField(),
                "module": serializers.CharField(),
                "workspace": serializers.CharField(),
            },
        ),
    )
    def get(self, request, slug):
        return Response({"status": "ok", "module": KEY, "workspace": self.scope.slug})
