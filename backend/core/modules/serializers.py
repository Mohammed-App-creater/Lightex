from rest_framework import serializers


class NavItemSerializer(serializers.Serializer):
    key = serializers.CharField()
    label = serializers.CharField()  # type: ignore[assignment]
    icon = serializers.CharField()
    path = serializers.CharField()
    permission = serializers.CharField()


class WorkspaceModuleSerializer(serializers.Serializer):
    """Schema only: the data is built by `core.modules.services.modules_data`."""

    key = serializers.CharField()
    name = serializers.CharField()
    description = serializers.CharField()
    isCore = serializers.BooleanField()
    toggleable = serializers.BooleanField()
    enabled = serializers.BooleanField()
    dependsOn = serializers.ListField(child=serializers.CharField())
    enabledAt = serializers.DateTimeField(allow_null=True)
    enabledBy = serializers.UUIDField(allow_null=True)
    navItems = NavItemSerializer(many=True)


class ModuleToggleIn(serializers.Serializer):
    enabled = serializers.BooleanField()
