from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.params import body, filter_value
from apps.workspaces.views import WorkspaceScopedView

from . import roles
from .models import Permission
from .permissions import ScopedView
from .serializers import PermissionInfoSerializer, ReassignIn, RoleIn, RolePermissionsIn, RoleSerializer


class PermissionCatalogueView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["roles"],
        parameters=[OpenApiParameter("scope", str, enum=["workspace", "project"])],
        responses={200: PermissionInfoSerializer(many=True)},
    )
    def get(self, request):
        qs = Permission.objects.all()
        scope = request.query_params.get("scope") or filter_value(request, "scope")
        if scope in ("workspace", "project"):
            qs = qs.filter(scope=scope)
        return Response(PermissionInfoSerializer(qs, many=True).data)


class RoleListView(WorkspaceScopedView):
    required = {"GET": "workspace.view", "POST": "workspace.manage_roles"}

    @extend_schema(tags=["roles"], responses={200: RoleSerializer(many=True)})
    def get(self, request, slug):
        scope = filter_value(request, "scope") or request.query_params.get("scope")
        return Response(RoleSerializer(roles.roles_for(self.scope, scope), many=True).data)

    @extend_schema(tags=["roles"], request=RoleIn, responses={201: RoleSerializer})
    def post(self, request, slug):
        role = roles.create_role(request.user, self.scope, body(request))
        return Response(
            RoleSerializer(roles.roles_for(self.scope).get(pk=role.pk)).data, status=status.HTTP_201_CREATED
        )


class RoleScopedView(ScopedView):
    """Scope = the workspace that owns the role (404 for non-members)."""

    def get_scope(self):
        from apps.workspaces.selectors import workspace_for

        self.role = roles.get_role(self.kwargs["role_id"])
        return workspace_for(self.request.user, self.role.workspace.slug)

    def role_data(self):
        return RoleSerializer(roles.roles_for(self.role.workspace).get(pk=self.role.pk)).data


class RoleDetailView(RoleScopedView):
    required = {"PATCH": "workspace.manage_roles", "DELETE": "workspace.manage_roles"}

    @extend_schema(tags=["roles"], request=RoleIn, responses={200: RoleSerializer})
    def patch(self, request, role_id):
        self.role = roles.update_role(request.user, self.role, body(request))
        return Response(self.role_data())

    @extend_schema(tags=["roles"], request=ReassignIn, responses={204: None})
    def delete(self, request, role_id):
        roles.delete_role(request.user, self.role, body(request).get("reassignTo"))
        return Response(status=status.HTTP_204_NO_CONTENT)


class RolePermissionsView(RoleScopedView):
    required = {"PUT": "workspace.manage_roles"}

    @extend_schema(tags=["roles"], request=RolePermissionsIn, responses={200: RoleSerializer})
    def put(self, request, role_id):
        self.role = roles.update_role(request.user, self.role, {"permissions": body(request).get("permissions")})
        return Response(self.role_data())
