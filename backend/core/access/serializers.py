from rest_framework import serializers

from core.modules.services import visible_codes

from . import catalogue
from .catalogue import DATA_SCOPES
from .models import Role


class PermissionInfoSerializer(serializers.Serializer):
    key = serializers.CharField(source="code")
    module = serializers.CharField()
    scope = serializers.CharField()
    group = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]
    description = serializers.CharField()
    scopable = serializers.BooleanField()


class RoleSerializer(serializers.ModelSerializer):
    workspaceId = serializers.UUIDField(source="workspace_id")
    isSystem = serializers.BooleanField(source="is_system")
    permissions = serializers.SerializerMethodField()
    dataScopes = serializers.SerializerMethodField()
    memberCount = serializers.SerializerMethodField()

    class Meta:
        model = Role
        fields = [
            "id", "workspaceId", "name", "description", "scope", "isSystem", "permissions", "dataScopes", "memberCount",
        ]  # fmt: skip

    def get_permissions(self, obj) -> list[str]:
        # Grants of modules disabled in the workspace are hidden (their rows are kept).
        return catalogue.ordered(visible_codes(obj.workspace_id, (p.code for p in obj.permissions.all())))

    def get_dataScopes(self, obj) -> dict[str, str]:
        """{code: scope} for the role's granted scopable codes (disabled modules hidden)."""
        found = {
            rp.permission.code: rp.data_scope
            for rp in obj.role_permissions.all()
            if rp.data_scope and rp.permission.scopable
        }
        return {c: found[c] for c in catalogue.ordered(visible_codes(obj.workspace_id, found))}

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
    #: {code: own | team | all} for granted scopable codes; left out, the stored scopes stay.
    dataScopes = serializers.DictField(child=serializers.ChoiceField(choices=list(DATA_SCOPES)), required=False)


class RolePermissionsIn(serializers.Serializer):
    permissions = serializers.ListField(child=serializers.CharField())
    dataScopes = serializers.DictField(child=serializers.ChoiceField(choices=list(DATA_SCOPES)), required=False)


class ReassignIn(serializers.Serializer):
    reassignTo = serializers.UUIDField(required=False)
