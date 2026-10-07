from rest_framework import serializers

from . import catalogue
from .models import Role


class PermissionInfoSerializer(serializers.Serializer):
    key = serializers.CharField(source="code")
    scope = serializers.CharField()
    group = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]
    description = serializers.CharField()


class RoleSerializer(serializers.ModelSerializer):
    workspaceId = serializers.UUIDField(source="workspace_id")
    isSystem = serializers.BooleanField(source="is_system")
    permissions = serializers.SerializerMethodField()
    memberCount = serializers.SerializerMethodField()

    class Meta:
        model = Role
        fields = ["id", "workspaceId", "name", "description", "scope", "isSystem", "permissions", "memberCount"]

    def get_permissions(self, obj) -> list[str]:
        return catalogue.ordered(p.code for p in obj.permissions.all())

    def get_memberCount(self, obj) -> int:
        if obj.scope == "workspace":
            count = getattr(obj, "ws_member_count", None)
            return count if count is not None else obj.workspace_members.filter(status="active").count()
        count = getattr(obj, "project_member_count", None)
        return count if count is not None else obj.project_members.values("user").distinct().count()


class RoleIn(serializers.Serializer):
    name = serializers.CharField(required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    scope = serializers.ChoiceField(choices=["workspace", "project"], required=False)
    permissions = serializers.ListField(child=serializers.CharField(), required=False)


class RolePermissionsIn(serializers.Serializer):
    permissions = serializers.ListField(child=serializers.CharField())


class ReassignIn(serializers.Serializer):
    reassignTo = serializers.UUIDField(required=False)
