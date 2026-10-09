from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.exceptions import invalid, not_found
from apps.common.pagination import paginate_queryset
from apps.common.params import body, filter_value
from apps.common.utils import iso
from apps.projects.models import ProjectMember
from apps.realtime.services import publish_inbox

from .handlers import preferences_for
from .models import EVENTS, Notification

TABS = {"all": Q(), "mentions": Q(type="mention"), "assigned": Q(type="assigned")}


def inbox(user, workspace_id=None):
    """In-app notifications for projects the user still belongs to."""
    mine = ProjectMember.objects.filter(user=user, project__deleted_at__isnull=True).values("project_id")
    qs = Notification.objects.filter(recipient=user, in_app=True, project_id__in=mine)
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
        "projectId": str(n.project_id),
        "projectName": n.project.name,
        "taskId": str(n.task_id) if n.task_id else None,
        "taskKey": n.task.key if n.task is not None else None,
        "taskTitle": n.task.title if n.task is not None else None,
        "payload": n.payload,
        "createdAt": iso(n.created_at),
        "readAt": iso(n.read_at),
    }


NotificationOut = inline_serializer(
    "Notification",
    {
        "id": serializers.UUIDField(),
        "type": serializers.ChoiceField(
            choices=["assigned", "mention", "status", "comment", "due", "sprint", "access", "import"]
        ),
        "actorId": serializers.UUIDField(allow_null=True),
        "projectId": serializers.UUIDField(),
        "projectName": serializers.CharField(),
        "taskId": serializers.UUIDField(allow_null=True),
        "taskKey": serializers.CharField(allow_null=True),
        "taskTitle": serializers.CharField(allow_null=True),
        "payload": serializers.JSONField(),
        "createdAt": serializers.DateTimeField(),
        "readAt": serializers.DateTimeField(allow_null=True),
    },
)
PrefsSchema = inline_serializer(
    "NotificationPreferences",
    {
        "events": serializers.DictField(child=serializers.DictField(child=serializers.BooleanField())),
        "emailDelivery": serializers.CharField(),
    },
)


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
        prefs = preferences_for(request.user)
        return Response({"events": prefs.events, "emailDelivery": prefs.email_delivery})

    @extend_schema(tags=["notifications"], request=PrefsSchema, responses={200: PrefsSchema})
    def put(self, request):
        data = body(request)
        events = data.get("events")
        delivery = data.get("emailDelivery")
        if not isinstance(events, dict) or delivery not in ("instant", "hourly", "daily"):
            raise invalid({"prefs": "Invalid preferences"})
        prefs = preferences_for(request.user)
        clean = dict(prefs.events)
        for key in EVENTS:  # only in-app and email exist in v1; unknown events/channels are dropped
            value = events.get(key)
            if isinstance(value, dict):
                clean[key] = {"in_app": bool(value.get("in_app")), "email": bool(value.get("email"))}
        prefs.events = clean
        prefs.email_delivery = delivery
        prefs.save(update_fields=["events", "email_delivery", "updated_at"])
        return Response({"events": prefs.events, "emailDelivery": prefs.email_delivery})
