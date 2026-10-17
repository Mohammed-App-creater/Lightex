from rest_framework import serializers

from core.common.utils import iso

from .models import DESCRIPTION_MAX, NAME_MAX, Team, TeamMember


class TeamMemberSerializer(serializers.ModelSerializer):
    """User fields as in the workspace member serializer's `user` (no hue: the client reads it from the members)."""

    userId = serializers.UUIDField(source="user_id")
    name = serializers.CharField(source="user.name")
    email = serializers.CharField(source="user.email")
    avatarUrl = serializers.CharField(source="user.avatar_url", allow_null=True)
    isLead = serializers.BooleanField(source="is_lead")

    class Meta:
        model = TeamMember
        fields = ["userId", "name", "email", "avatarUrl", "isLead"]


class TeamSerializer(serializers.ModelSerializer):
    """A team list item. Reads `memberships` (prefetched by the selectors)."""

    memberCount = serializers.SerializerMethodField()
    leadIds = serializers.SerializerMethodField()
    createdAt = serializers.SerializerMethodField()

    class Meta:
        model = Team
        fields = ["id", "name", "description", "memberCount", "leadIds", "createdAt"]

    def get_memberCount(self, obj) -> int:
        return len(obj.memberships.all())

    def get_leadIds(self, obj) -> list[str]:
        return [str(m.user_id) for m in obj.memberships.all() if m.is_lead]

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)


class TeamDetailSerializer(TeamSerializer):
    members = TeamMemberSerializer(source="memberships", many=True)

    class Meta(TeamSerializer.Meta):
        fields = [*TeamSerializer.Meta.fields, "members"]


class TeamIn(serializers.Serializer):
    name = serializers.CharField(max_length=NAME_MAX)
    description = serializers.CharField(max_length=DESCRIPTION_MAX, required=False, allow_blank=True)


class TeamUpdateIn(serializers.Serializer):
    name = serializers.CharField(max_length=NAME_MAX, required=False)
    description = serializers.CharField(max_length=DESCRIPTION_MAX, required=False, allow_blank=True)


class TeamMemberIn(serializers.Serializer):
    userId = serializers.UUIDField()
    isLead = serializers.BooleanField(required=False)


class TeamMemberUpdateIn(serializers.Serializer):
    isLead = serializers.BooleanField()
