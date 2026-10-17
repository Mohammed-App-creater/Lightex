from drf_spectacular.utils import extend_schema_serializer
from rest_framework import serializers

from core.access.services import my_data_scopes, my_permissions
from core.accounts.serializers import UserSerializer, user_brief
from core.common.utils import iso
from core.modules.services import enabled_modules

from .models import Invitation, Workspace, WorkspaceMember
from .selectors import my_roles


class WorkspaceSerializer(serializers.ModelSerializer):
    createdAt = serializers.SerializerMethodField()
    memberCount = serializers.SerializerMethodField()
    myRoleId = serializers.SerializerMethodField()
    myRoleIds = serializers.SerializerMethodField()
    my_permissions = serializers.SerializerMethodField()
    myDataScopes = serializers.SerializerMethodField()
    notificationPolicy = serializers.SerializerMethodField()
    enabledModules = serializers.SerializerMethodField()

    class Meta:
        model = Workspace
        fields = [
            "id", "slug", "name", "hue", "timezone", "createdAt", "memberCount", "myRoleId", "myRoleIds",
            "my_permissions", "myDataScopes", "notificationPolicy", "enabledModules",
        ]  # fmt: skip

    def get_enabledModules(self, obj) -> list[str]:
        return enabled_modules(obj)

    def get_notificationPolicy(self, obj) -> dict[str, bool]:
        return {"sms": obj.sms_enabled}

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)

    def get_memberCount(self, obj) -> int:
        count = getattr(obj, "member_count", None)
        return count if count is not None else obj.members.filter(status="active").count()

    def get_myRoleId(self, obj) -> str | None:
        """The primary role (the first of `myRoleIds`)."""
        roles = my_roles(self.context["user"], obj)
        return str(roles[0].pk) if roles else None

    def get_myRoleIds(self, obj) -> list[str]:
        return [str(r.pk) for r in my_roles(self.context["user"], obj)]

    def get_my_permissions(self, obj) -> list[str]:
        return my_permissions(self.context["user"], obj)

    def get_myDataScopes(self, obj) -> dict[str, str]:
        return my_data_scopes(self.context["user"], obj)


class WorkspaceMemberSerializer(serializers.ModelSerializer):
    userId = serializers.UUIDField(source="user_id")
    workspaceId = serializers.UUIDField(source="workspace_id")
    roleId = serializers.SerializerMethodField()
    roleIds = serializers.SerializerMethodField()
    user = UserSerializer()
    joinedAt = serializers.SerializerMethodField()
    lastActiveAt = serializers.SerializerMethodField()

    class Meta:
        model = WorkspaceMember
        fields = ["userId", "workspaceId", "roleId", "roleIds", "user", "status", "joinedAt", "lastActiveAt"]

    def get_roleId(self, obj) -> str:
        """The primary role (the first of `roleIds`)."""
        roles = obj.role_list()
        return str(roles[0].pk) if roles else ""

    def get_roleIds(self, obj) -> list[str]:
        return [str(r.pk) for r in obj.role_list()]

    def get_joinedAt(self, obj) -> str | None:
        return iso(obj.joined_at)

    def get_lastActiveAt(self, obj) -> str | None:
        return iso(obj.last_active_at)


class InviteSerializer(serializers.ModelSerializer):
    workspaceId = serializers.UUIDField(source="workspace_id")
    workspaceName = serializers.CharField(source="workspace.name")
    roleId = serializers.SerializerMethodField()
    roleName = serializers.SerializerMethodField()
    roleIds = serializers.SerializerMethodField()
    roleNames = serializers.SerializerMethodField()
    invitedBy = serializers.SerializerMethodField()
    createdAt = serializers.SerializerMethodField()
    expiresAt = serializers.SerializerMethodField()
    status = serializers.CharField(source="effective_status")

    class Meta:
        model = Invitation
        fields = [
            "id",
            "workspaceId",
            "workspaceName",
            "email",
            "roleId",
            "roleName",
            "roleIds",
            "roleNames",
            "invitedBy",
            "createdAt",
            "expiresAt",
            "status",
        ]

    def get_roleId(self, obj) -> str:
        roles = obj.role_list()
        return str(roles[0].pk) if roles else ""

    def get_roleName(self, obj) -> str:
        roles = obj.role_list()
        return roles[0].name if roles else ""

    def get_roleIds(self, obj) -> list[str]:
        return [str(r.pk) for r in obj.role_list()]

    def get_roleNames(self, obj) -> list[str]:
        return [r.name for r in obj.role_list()]

    def get_invitedBy(self, obj) -> dict | None:
        return user_brief(obj.invited_by) or {"id": "", "name": "Someone", "hue": 0}

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)

    def get_expiresAt(self, obj) -> str | None:
        return iso(obj.expires_at)


class WorkspaceCreateIn(serializers.Serializer):
    name = serializers.CharField(required=False, allow_blank=True)
    slug = serializers.CharField(required=False, allow_blank=True)
    modules = serializers.ListField(child=serializers.CharField(), required=False)


class NotificationPolicyIn(serializers.Serializer):
    sms = serializers.BooleanField(required=False)


class WorkspaceUpdateIn(serializers.Serializer):
    name = serializers.CharField(required=False, allow_blank=True)
    slug = serializers.CharField(required=False, allow_blank=True)
    timezone = serializers.CharField(required=False, help_text="An IANA time zone name, e.g. Africa/Addis_Ababa.")
    notificationPolicy = NotificationPolicyIn(required=False)


class ConfirmIn(serializers.Serializer):
    confirm = serializers.CharField(required=False, allow_blank=True)


class MemberRolesIn(serializers.Serializer):
    roleIds = serializers.ListField(
        child=serializers.CharField(), required=False, help_text="Replaces the member's roles (one or more)."
    )
    roleId = serializers.CharField(required=False, help_text="Deprecated: the same as roleIds: [roleId].")


class InviteIn(serializers.Serializer):
    emails = serializers.ListField(child=serializers.CharField())
    roleIds = serializers.ListField(
        child=serializers.CharField(), required=False, help_text="The roles the invitee gets (one or more)."
    )
    roleId = serializers.CharField(required=False, help_text="Deprecated: the same as roleIds: [roleId].")


class AcceptInviteIn(serializers.Serializer):
    name = serializers.CharField(required=False, allow_blank=True)
    password = serializers.CharField(required=False, allow_blank=True, trim_whitespace=False)


@extend_schema_serializer(component_name="WorkspaceAccessRequest")
class AccessRequestSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    workspaceId = serializers.UUIDField(source="workspace_id")
    userId = serializers.UUIDField(source="user_id")
    createdAt = serializers.SerializerMethodField()

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)
