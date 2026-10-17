from drf_spectacular.utils import extend_schema
from rest_framework.response import Response

from core.access.permissions import MEMBER
from core.common.exceptions import invalid
from core.common.params import body
from core.workspaces.views import WorkspaceScopedView

from . import services
from .serializers import ModuleToggleIn, WorkspaceModuleSerializer


class ModuleListView(WorkspaceScopedView):
    """Every registered module (core included) and whether it is on. Any member may read it."""

    required = {"GET": MEMBER}

    @extend_schema(tags=["modules"], responses={200: WorkspaceModuleSerializer(many=True)})
    def get(self, request, slug):
        return Response(services.modules_data(self.scope))


class ModuleDetailView(WorkspaceScopedView):
    required = {"PUT": "core.modules.manage"}

    @extend_schema(tags=["modules"], request=ModuleToggleIn, responses={200: WorkspaceModuleSerializer})
    def put(self, request, slug, key):
        enabled = body(request).get("enabled")
        if not isinstance(enabled, bool):
            raise invalid({"enabled": "Send true or false"})
        return Response(services.set_module_enabled(request.user, self.scope, key, enabled))
