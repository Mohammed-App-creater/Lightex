"""OpenAPI shapes for board 33 dashboards (the payloads themselves are built in services.py)."""

from drf_spectacular.utils import inline_serializer
from rest_framework import serializers

from .widgets import WIDGET_TYPES

VISIBILITY = ["shared", "personal"]

OwnerOut = inline_serializer(
    "DashboardOwner",
    {
        "id": serializers.UUIDField(),
        "name": serializers.CharField(),
        "hue": serializers.IntegerField(),
        "avatarUrl": serializers.CharField(allow_null=True),
    },
)

WidgetOut = inline_serializer(
    "DashboardWidget",
    {
        "id": serializers.UUIDField(),
        "type": serializers.ChoiceField(choices=list(WIDGET_TYPES)),
        "w": serializers.IntegerField(min_value=3, max_value=12),
        "h": serializers.IntegerField(min_value=1, max_value=4),
        "config": serializers.JSONField(
            help_text="Per type (§3.3): burndown { sprintId }, my_tasks { showDone }, objectives { quarter }, "
            "workload { unit, sprintId, personField }, velocity { range }, activity {}"
        ),
    },
)

DashboardOut = inline_serializer(
    "Dashboard",
    {
        "id": serializers.UUIDField(),
        "projectId": serializers.UUIDField(),
        "name": serializers.CharField(),
        "visibility": serializers.ChoiceField(choices=VISIBILITY),
        "ownerId": serializers.UUIDField(),
        "owner": OwnerOut,
        "version": serializers.IntegerField(),
        "widgets": serializers.ListField(child=WidgetOut, help_text="Array order = layout order"),
        "createdAt": serializers.DateTimeField(),
        "updatedAt": serializers.DateTimeField(),
    },
)

DashboardSummariesOut = inline_serializer(
    "DashboardSummary",
    many=True,
    fields={
        "id": serializers.UUIDField(),
        "projectId": serializers.UUIDField(),
        "name": serializers.CharField(),
        "visibility": serializers.ChoiceField(choices=VISIBILITY),
        "ownerId": serializers.UUIDField(),
        "widgetCount": serializers.IntegerField(),
        "updatedAt": serializers.DateTimeField(),
    },
)

DashboardCreateIn = inline_serializer(
    "DashboardCreate",
    {
        "name": serializers.CharField(max_length=60),
        "visibility": serializers.ChoiceField(choices=VISIBILITY, required=False),
        "template": serializers.ChoiceField(choices=["blank", "sprint_health"], required=False),
    },
)

DashboardPatchIn = inline_serializer(
    "DashboardPatch",
    {
        "name": serializers.CharField(max_length=60, required=False),
        "visibility": serializers.ChoiceField(choices=VISIBILITY, required=False),
        "version": serializers.IntegerField(),
    },
)

WidgetIn = inline_serializer(
    "DashboardWidgetInput",
    {
        "id": serializers.UUIDField(required=False, help_text="Omit to add a widget"),
        "type": serializers.ChoiceField(choices=list(WIDGET_TYPES)),
        "w": serializers.IntegerField(min_value=3, max_value=12),
        "h": serializers.IntegerField(min_value=1, max_value=4),
        "config": serializers.JSONField(required=False),
    },
)

DashboardLayoutIn = inline_serializer(
    "DashboardLayout",
    {"version": serializers.IntegerField(), "widgets": serializers.ListField(child=WidgetIn, max_length=6)},
)
