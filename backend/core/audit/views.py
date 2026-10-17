from datetime import datetime

from django.db.models import Q
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import serializers
from rest_framework.response import Response

from core.access.permissions import MEMBER, ScopedView
from core.common.exceptions import invalid
from core.common.pagination import paginate_queryset
from core.common.params import body, filter_value, filter_values
from core.common.schema import page_of, shape
from core.common.targets import parse_id
from core.common.utils import iso
from core.workspaces.views import WorkspaceScopedView

from . import trash
from .models import AuditLog
from .registry import grouped_types, groups

_STATUS = Q(action__endswith=".status_changed")
_ASSIGNED = Q(action__endswith=".assigned") | Q(action__endswith=".unassigned")
_ROLE = Q(action__endswith=".role_changed")
_INVITED = Q(action__endswith=".invited")
_DELETED = Q(action__endswith=".removed") | Q(action__endswith=".deleted")
_COMMENTED = Q(action="core.comment.created") | Q(action__endswith=".commented")
_CREATED = (Q(action__endswith=".created") & ~Q(target_type="core.comment")) | Q(action__endswith=".imported")
ACTION_KINDS = {
    "status": _STATUS,
    "assigned": _ASSIGNED,
    "role": _ROLE,
    "invited": _INVITED,
    "deleted": _DELETED,
    "commented": _COMMENTED,
    "created": _CREATED,
    "updated": ~(_STATUS | _ASSIGNED | _ROLE | _INVITED | _DELETED | _COMMENTED | _CREATED),
}


AuditChange = shape(
    "AuditChange",
    {
        "field": serializers.CharField(),
        "kind": serializers.ChoiceField(choices=["text", "status", "priority", "person", "value"]),
        "before": serializers.JSONField(allow_null=True),
        "after": serializers.JSONField(allow_null=True),
    },
)
AuditEntry = shape(
    "AuditEntry",
    {
        "id": serializers.UUIDField(),
        "actorId": serializers.CharField(allow_null=True, help_text="A user id, or the integration id"),
        "action": serializers.CharField(help_text="<module>.<entity>.<verb>"),
        "target": serializers.CharField(),
        "createdAt": serializers.DateTimeField(),
        "actorName": serializers.CharField(allow_null=True),
        "actorKind": serializers.ChoiceField(choices=["user", "integration"]),
        "entityType": serializers.CharField(),
        "module": serializers.CharField(allow_null=True),
        "targetType": serializers.CharField(),
        "targetId": serializers.CharField(allow_null=True),
        "entityKey": serializers.CharField(allow_null=True),
        "source": serializers.CharField(),
        "requestId": serializers.CharField(allow_null=True),
        "changes": AuditChange(many=True),
    },
)
AuditPage = page_of("AuditPage", AuditEntry, total=serializers.IntegerField())


def _id(value) -> str | None:
    return str(value) if value else None


def audit_data(row: AuditLog) -> dict:
    return {
        "id": str(row.pk),
        "actorId": row.actor_ref or None if row.actor_kind == "integration" else _id(row.actor_id),
        "action": row.action,
        "target": row.target,
        "createdAt": iso(row.created_at),
        "actorName": row.actor_name or None,
        "actorKind": row.actor_kind or "user",
        "entityType": row.target_type,
        "module": row.module or None,
        "targetType": row.target_type,
        "targetId": row.target_id or None,
        "entityKey": row.entity_key,
        "source": row.source,
        "requestId": row.request_id,
        "changes": row.changes or [],
    }


class AuditListView(WorkspaceScopedView):
    required = {"GET": "core.audit.view"}

    @extend_schema(
        tags=["audit"],
        parameters=[
            OpenApiParameter("filter[actor]", str, many=True),
            OpenApiParameter("filter[action]", str, enum=list(ACTION_KINDS)),
            OpenApiParameter("filter[entity]", str, description="An audit group (task, project, …) or workspace"),
            OpenApiParameter("filter[since]", str, description="ISO-8601 timestamp"),
            OpenApiParameter("cursor", str),
            OpenApiParameter("limit", int),
        ],
        responses=AuditPage,
    )
    def get(self, request, slug):
        qs = AuditLog.objects.filter(workspace=self.scope)
        actors = filter_values(request, "actor")
        if actors:
            if not all(parse_id(a) for a in actors):
                raise invalid({"filter[actor]": "Pick people from the list"})
            # Board 37: an integration id matches the rows it wrote (actor_ref).
            qs = qs.filter(Q(actor_id__in=actors) | Q(actor_ref__in=actors))
        action = filter_value(request, "action")
        if action:
            if action not in ACTION_KINDS:
                raise invalid({"filter[action]": "Unknown action type"})
            qs = qs.filter(ACTION_KINDS[action])
        entity = filter_value(request, "entity")
        if entity:
            if entity == "workspace":
                qs = qs.exclude(target_type__in=grouped_types())
            elif entity in groups():
                qs = qs.filter(target_type__in=groups()[entity])
            else:
                raise invalid({"filter[entity]": "Unknown entity type"})
        since = filter_value(request, "since")
        if since:
            try:
                qs = qs.filter(created_at__gte=datetime.fromisoformat(since.replace(" ", "+").replace("Z", "+00:00")))
            except ValueError as exc:
                raise invalid({"filter[since]": "Use an ISO-8601 timestamp"}) from exc
        total = qs.count()
        page = paginate_queryset(
            qs,
            request.query_params,
            order=[("created_at", True), ("id", True)],
            serialize=lambda rows: [audit_data(r) for r in rows],
            default_limit=25,
            max_limit=100,
        )
        return Response({**page, "total": total})


TrashRef = shape(
    "TrashRef",
    {
        "kind": serializers.CharField(help_text="A registered trash kind: tracking.task, core.comment, …"),
        "id": serializers.UUIDField(),
    },
)
UserBrief = shape(
    "UserBrief", {"id": serializers.UUIDField(), "name": serializers.CharField(), "hue": serializers.IntegerField()}
)
TrashItem = shape(
    "TrashItem",
    {
        "kind": serializers.CharField(),
        "module": serializers.CharField(),
        "id": serializers.UUIDField(),
        "title": serializers.CharField(),
        "key": serializers.CharField(allow_null=True),
        "hue": serializers.IntegerField(allow_null=True),
        "parentKey": serializers.CharField(allow_null=True),
        "taskCount": serializers.IntegerField(allow_null=True),
        "project": serializers.JSONField(allow_null=True, help_text="{ id, key, name, hue } when the item has one"),
        "deletedBy": UserBrief(allow_null=True),
        "deletedAt": serializers.DateTimeField(),
        "purgeAt": serializers.DateTimeField(),
    },
)
TrashList = shape(
    "TrashList",
    {
        "data": TrashItem(many=True),
        "scope": serializers.ChoiceField(choices=["all", "own"]),
        "kinds": serializers.ListField(child=serializers.CharField()),
        "retentionDays": serializers.IntegerField(),
    },
)
TrashItemsIn = shape("TrashItemsIn", {"items": TrashRef(many=True)})
TrashRestored = shape("TrashRestored", {"restored": TrashRef(many=True)})
TrashPurged = shape("TrashPurged", {"purged": TrashRef(many=True)})


class TrashListView(WorkspaceScopedView):
    required = {"GET": "core.workspace.view"}

    @extend_schema(tags=["trash"], responses=TrashList)
    def get(self, request, slug):
        return Response(trash.list_items(request.user, self.scope))


class TrashRestoreView(WorkspaceScopedView):
    required = {"POST": "core.workspace.view"}

    @extend_schema(tags=["trash"], request=TrashItemsIn, responses=TrashRestored)
    def post(self, request, slug):
        return Response({"restored": trash.restore(request.user, self.scope, body(request).get("items"))})


class TrashPurgeView(WorkspaceScopedView):
    required = {"POST": "core.workspace.view"}

    @extend_schema(tags=["trash"], request=TrashItemsIn, responses=TrashPurged)
    def post(self, request, slug):
        return Response({"purged": trash.purge(request.user, self.scope, body(request).get("items"))})


class TrashItemRestoreView(ScopedView):
    """POST trash/{type}/{id}/restore (brief): restore one item, wherever it lives."""

    required = {"POST": MEMBER}

    def get_scope(self):
        from core.workspaces.selectors import workspace_for

        workspace_id = trash.workspace_of_item(self.kwargs["kind"], self.kwargs["item_id"])
        from core.workspaces.models import Workspace

        slug = Workspace.objects.filter(pk=workspace_id).values_list("slug", flat=True).first()
        if slug is None:
            from core.common.exceptions import not_found

            raise not_found("That item isn’t in the Trash any more.")
        return workspace_for(self.request.user, slug)

    @extend_schema(tags=["trash"], request=None, responses=TrashRestored)
    def post(self, request, kind, item_id):
        return Response({"restored": trash.restore(request.user, self.scope, [{"kind": kind, "id": str(item_id)}])})
