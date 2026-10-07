from rest_framework import serializers

from apps.access.services import my_permissions
from apps.accounts.serializers import UserSerializer, user_brief
from apps.common.utils import iso

from .models import Invitation, Workspace, WorkspaceMember


class WorkspaceSerializer(serializers.ModelSerializer):
    createdAt = serializers.SerializerMethodField()
    memberCount = serializers.SerializerMethodField()
    myRoleId = serializers.SerializerMethodField()
    my_permissions = serializers.SerializerMethodField()

    class Meta:
        model = Workspace
        fields = ["id", "slug", "name", "hue", "createdAt", "memberCount", "myRoleId", "my_permissions"]

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)

    def get_memberCount(self, obj) -> int:
        count = getattr(obj, "member_count", None)
        return count if count is not None else obj.members.filter(status="active").count()

    def get_myRoleId(self, obj) -> str | None:
        rid = getattr(obj, "my_role_id", None)
        if rid is None:
            rid = obj.members.filter(user_id=self.context["user"].pk).values_list("role_id", flat=True).first()
        return str(rid) if rid else None

    def get_my_permissions(self, obj) -> list[str]:
        return my_permissions(self.context["user"], obj)


class WorkspaceMemberSerializer(serializers.ModelSerializer):
    userId = serializers.UUIDField(source="user_id")
    workspaceId = serializers.UUIDField(source="workspace_id")
    roleId = serializers.UUIDField(source="role_id")
    user = UserSerializer()
    joinedAt = serializers.SerializerMethodField()
    lastActiveAt = serializers.SerializerMethodField()

    class Meta:
        model = WorkspaceMember
        fields = ["userId", "workspaceId", "roleId", "user", "status", "joinedAt", "lastActiveAt"]

    def get_joinedAt(self, obj) -> str | None:
        return iso(obj.joined_at)

    def get_lastActiveAt(self, obj) -> str | None:
        return iso(obj.last_active_at)


class InviteSerializer(serializers.ModelSerializer):
    workspaceId = serializers.UUIDField(source="workspace_id")
    workspaceName = serializers.CharField(source="workspace.name")
    roleId = serializers.UUIDField(source="role_id")
    roleName = serializers.CharField(source="role.name")
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
            "invitedBy",
            "createdAt",
            "expiresAt",
            "status",
        ]

    def get_invitedBy(self, obj) -> dict | None:
        return user_brief(obj.invited_by) or {"id": "", "name": "Someone", "hue": 0}

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)

    def get_expiresAt(self, obj) -> str | None:
        return iso(obj.expires_at)


class WorkspaceCreateIn(serializers.Serializer):
    name = serializers.CharField(required=False, allow_blank=True)
    slug = serializers.CharField(required=False, allow_blank=True)


class ConfirmIn(serializers.Serializer):
    confirm = serializers.CharField(required=False, allow_blank=True)


class RoleIdIn(serializers.Serializer):
    roleId = serializers.CharField()


class InviteIn(serializers.Serializer):
    emails = serializers.ListField(child=serializers.CharField())
    roleId = serializers.CharField()


class AcceptInviteIn(serializers.Serializer):
    name = serializers.CharField(required=False, allow_blank=True)
    password = serializers.CharField(required=False, allow_blank=True, trim_whitespace=False)


class AccessRequestSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    workspaceId = serializers.UUIDField(source="workspace_id")
    userId = serializers.UUIDField(source="user_id")
    createdAt = serializers.SerializerMethodField()

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)
