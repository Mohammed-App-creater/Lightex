from rest_framework import serializers

from apps.common.utils import iso

from .models import User


class UserSerializer(serializers.ModelSerializer):
    avatarUrl = serializers.CharField(source="avatar_url", allow_null=True, read_only=True)
    createdAt = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "name", "email", "hue", "avatarUrl", "createdAt"]

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)


def user_brief(user) -> dict | None:
    """Pick<User, "id" | "name" | "hue">"""
    if user is None:
        return None
    return {"id": str(user.pk), "name": user.name, "hue": user.hue}


class LoginIn(serializers.Serializer):
    email = serializers.CharField(required=False, allow_blank=True)
    password = serializers.CharField(required=False, allow_blank=True, trim_whitespace=False)


class RegisterIn(LoginIn):
    name = serializers.CharField(required=False, allow_blank=True)


class EmailIn(serializers.Serializer):
    email = serializers.CharField(required=False, allow_blank=True)


class ResetIn(serializers.Serializer):
    token = serializers.CharField(required=False, allow_blank=True)
    password = serializers.CharField(required=False, allow_blank=True, trim_whitespace=False)


class ChangePasswordIn(serializers.Serializer):
    currentPassword = serializers.CharField(required=False, allow_blank=True, trim_whitespace=False)
    newPassword = serializers.CharField(required=False, allow_blank=True, trim_whitespace=False)


class ProfileIn(serializers.Serializer):
    name = serializers.CharField(required=False)
    avatarUrl = serializers.CharField(required=False, allow_null=True)


class AuthOut(serializers.Serializer):
    accessToken = serializers.CharField()
    user = UserSerializer()


class AccessOut(serializers.Serializer):
    accessToken = serializers.CharField()
