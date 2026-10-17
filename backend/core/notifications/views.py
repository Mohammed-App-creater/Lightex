import re

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from core.access import scopes
from core.access.catalogue import PROJECT
from core.common.exceptions import invalid, not_found
from core.common.pagination import paginate_queryset
from core.common.params import body, filter_value
from core.common.utils import iso
from core.events.registry import preference_types
from core.realtime.services import publish_inbox

from .handlers import preferences_for
from .models import CHANNELS, Notification

TABS = {"all": Q(), "mentions": Q(type="mention"), "assigned": Q(type="assigned")}


def inbox(user, workspace_id=None):
    """In-app notifications the user may still see: rows scoped to a project need a live membership there (the
    `project` scope provider decides); other rows need an active membership of their workspace."""
    from core.workspaces.models import WorkspaceMember

    workspaces = WorkspaceMember.objects.filter(user=user, status="active").values("workspace_id")
    visible = Q(project_id__isnull=True, workspace_id__in=workspaces)
    provider = scopes.provider(PROJECT)
    if provider is not None:
        visible |= Q(project_id__in=provider.member_scope_ids(user))
    qs = Notification.objects.filter(recipient=user, in_app=True).filter(visible)
    if workspace_id:
        qs = qs.filter(workspace_id=workspace_id) if _uuid(workspace_id) else qs.none()
    return qs.select_related("project", "task")


def _uuid(value) -> bool:
    import uuid

    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def notification_data(n: Notification) -> dict:
    return {
        "id": str(n.pk),
        "type": n.type,
        "actorId": str(n.actor_id) if n.actor_id else None,
        "projectId": str(n.project_id) if n.project_id else None,
        "projectName": n.project.name if n.project is not None else None,
        "taskId": str(n.task_id) if n.task_id else None,
        "taskKey": n.task.key if n.task is not None else None,
        "taskTitle": n.task.title if n.task is not None else None,
        "payload": n.payload,
        "createdAt": iso(n.created_at),
        "readAt": iso(n.read_at),
        "targetType": n.target_type or None,
        "targetId": str(n.target_id) if n.target_id else None,
        "title": n.title or None,
        "link": n.link or None,
    }


NotificationOut = inline_serializer(
    "Notification",
    {
        "id": serializers.UUIDField(),
        "type": serializers.ChoiceField(
            choices=["assigned", "mention", "status", "comment", "due", "sprint", "access", "import"]
        ),
        "actorId": serializers.UUIDField(allow_null=True),
        "projectId": serializers.UUIDField(allow_null=True),
        "projectName": serializers.CharField(allow_null=True),
        "taskId": serializers.UUIDField(allow_null=True),
        "taskKey": serializers.CharField(allow_null=True),
        "taskTitle": serializers.CharField(allow_null=True),
        "payload": serializers.JSONField(),
        "createdAt": serializers.DateTimeField(),
        "readAt": serializers.DateTimeField(allow_null=True),
        "targetType": serializers.CharField(allow_null=True),
        "targetId": serializers.UUIDField(allow_null=True),
        "title": serializers.CharField(allow_null=True),
        "link": serializers.CharField(allow_null=True),
    },
)
QuietHoursSchema = inline_serializer(
    "QuietHours",
    {
        "enabled": serializers.BooleanField(),
        "from": serializers.CharField(),
        "to": serializers.CharField(),
        "timezone": serializers.CharField(allow_null=True),
        "days": serializers.ListField(child=serializers.BooleanField(), min_length=7, max_length=7),
        "urgentBypass": serializers.BooleanField(),
    },
)
PrefsSchema = inline_serializer(
    "NotificationPreferences",
    {
        "events": serializers.DictField(child=serializers.DictField(child=serializers.BooleanField())),
        "emailDelivery": serializers.CharField(),
        "quietHours": QuietHoursSchema,
        "labels": serializers.DictField(child=serializers.CharField(), read_only=True),
    },
)
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def prefs_data(prefs) -> dict:
    from core.channels.quiet import days_from_mask

    return {
        "events": prefs.events,
        "labels": {t.key: t.label for t in preference_types()},
        "emailDelivery": prefs.email_delivery,
        "quietHours": {
            "enabled": prefs.quiet_enabled,
            "from": prefs.quiet_from.strftime("%H:%M"),
            "to": prefs.quiet_to.strftime("%H:%M"),
            "timezone": prefs.timezone,
            "days": list(days_from_mask(prefs.quiet_days)),
            "urgentBypass": prefs.quiet_urgent_bypass,
        },
    }


def _quiet_fields(value) -> dict:
    """Board 38 §5.13: `quietHours` is replaced as a whole; 422 with dotted field paths."""
    import zoneinfo

    from core.channels.quiet import mask_from_days

    if not isinstance(value, dict):
        raise invalid({"quietHours": "Invalid quiet hours"})
    errors: dict[str, str] = {}
    start, end = value.get("from"), value.get("to")
    for key, t in (("from", start), ("to", end)):
        if not isinstance(t, str) or not _HHMM.match(t):
            errors[f"quietHours.{key}"] = "Use HH:MM"
    if not errors and start == end:
        errors["quietHours.to"] = "End must differ from start"
    tz = value.get("timezone")
    if tz is not None and (not isinstance(tz, str) or tz not in zoneinfo.available_timezones()):
        errors["quietHours.timezone"] = "Unknown time zone"
    days = value.get("days")
    if not isinstance(days, list) or len(days) != 7 or not all(isinstance(d, bool) for d in days):
        errors["quietHours.days"] = "Send 7 booleans, Monday first"
    if errors:
        raise invalid(errors)
    import datetime as _dt

    assert isinstance(start, str) and isinstance(end, str) and isinstance(days, list)  # noqa: S101
    return {
        "quiet_enabled": bool(value.get("enabled")),
        "quiet_from": _dt.time.fromisoformat(start),
        "quiet_to": _dt.time.fromisoformat(end),
        "timezone": tz,
        "quiet_days": mask_from_days(days),
        "quiet_urgent_bypass": bool(value.get("urgentBypass", True)),
    }


class NotificationListView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["notifications"],
        parameters=[
            OpenApiParameter("filter[tab]", str, enum=list(TABS)),
            OpenApiParameter("filter[unread]", bool),
            OpenApiParameter("filter[workspace]", str),
            OpenApiParameter("cursor", str),
            OpenApiParameter("limit", int),
        ],
        responses=inline_serializer(
            "NotificationPage",
            {
                "data": NotificationOut,
                "nextCursor": serializers.CharField(allow_null=True),
                "counts": serializers.DictField(child=serializers.IntegerField()),
            },
        ),
    )
    def get(self, request):
        tab = filter_value(request, "tab", "all")
        if tab not in TABS:
            raise invalid({"filter[tab]": "Pick all, mentions or assigned"})
        base = inbox(request.user, filter_value(request, "workspace"))
        qs = base.filter(TABS[tab])
        if filter_value(request, "unread") == "true":
            qs = qs.filter(read_at__isnull=True)
        page = paginate_queryset(
            qs,
            request.query_params,
            order=[("created_at", True), ("id", True)],
            serialize=lambda rows: [notification_data(n) for n in rows],
            default_limit=100,
            max_limit=200,
        )
        counts = base.aggregate(
            all=Count("id"),
            mentions=Count("id", filter=Q(type="mention")),
            assigned=Count("id", filter=Q(type="assigned")),
            unread=Count("id", filter=Q(read_at__isnull=True)),
        )
        return Response({**page, "counts": counts})


class UnreadCountView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["notifications"],
        parameters=[OpenApiParameter("filter[workspace]", str)],
        responses=inline_serializer("UnreadCount", {"count": serializers.IntegerField()}),
    )
    def get(self, request):
        count = inbox(request.user, filter_value(request, "workspace")).filter(read_at__isnull=True).count()
        return Response({"count": count})


class MarkReadView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["notifications"],
        request=inline_serializer("MarkRead", {"read": serializers.BooleanField(required=False)}),
        responses={200: NotificationOut},
    )
    def post(self, request, notification_id):
        n = inbox(request.user).filter(pk=notification_id).first()
        if n is None:
            raise not_found("Notification not found.")
        n.read_at = timezone.now() if body(request).get("read", True) is not False else None
        n.save(update_fields=["read_at", "updated_at"])
        publish_inbox(request.user, [n.workspace_id])
        return Response(notification_data(n))


class ReadAllView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=["notifications"],
        request=inline_serializer(
            "ReadAll",
            {
                "ids": serializers.ListField(child=serializers.UUIDField(), required=False),
                "unread": serializers.BooleanField(required=False),
            },
        ),
        responses=inline_serializer("ReadAllOut", {"ids": serializers.ListField(child=serializers.UUIDField())}),
    )
    def post(self, request):
        data = body(request)
        ids = data.get("ids")
        undo = data.get("unread") is True
        qs = inbox(request.user)
        if ids is not None:
            if not isinstance(ids, list) or not all(_uuid(i) for i in ids):
                raise invalid({"ids": "Send a list of notification ids"})
            qs = qs.filter(pk__in=ids)
        qs = qs.filter(read_at__isnull=False) if undo else qs.filter(read_at__isnull=True)
        with transaction.atomic():
            changed = [str(i) for i in qs.values_list("pk", flat=True)]
            Notification.objects.filter(pk__in=changed).update(read_at=None if undo else timezone.now())
            if changed:
                publish_inbox(request.user)
        return Response({"ids": changed})


class PreferencesView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["notifications"], responses={200: PrefsSchema})
    def get(self, request):
        return Response(prefs_data(preferences_for(request.user)))

    @extend_schema(tags=["notifications"], request=PrefsSchema, responses={200: PrefsSchema})
    def put(self, request):
        data = body(request)
        events = data.get("events")
        delivery = data.get("emailDelivery")
        if not isinstance(events, dict) or delivery not in ("instant", "hourly", "daily"):
            raise invalid({"prefs": "Invalid preferences"})
        quiet = _quiet_fields(data["quietHours"]) if "quietHours" in data else None
        prefs = preferences_for(request.user)
        clean = {k: dict(v) for k, v in (prefs.events or {}).items() if isinstance(v, dict)}
        # Only the channel keys present change (a v1 client keeps the board 38 keys).
        for key in (t.key for t in preference_types()):
            value = events.get(key)
            if isinstance(value, dict):
                row = clean.setdefault(key, {})
                for channel in CHANNELS:
                    if channel in value:
                        row[channel] = bool(value[channel])
        with transaction.atomic():
            prefs.events = clean
            prefs.email_delivery = delivery
            fields = ["events", "email_delivery", "updated_at"]
            if quiet is not None:
                for k, v in quiet.items():
                    setattr(prefs, k, v)
                fields += list(quiet)
            prefs.save(update_fields=fields)
            if quiet is not None:
                from core.channels.services import retime_deferred

                retime_deferred(request.user, prefs)
        return Response(prefs_data(prefs))
