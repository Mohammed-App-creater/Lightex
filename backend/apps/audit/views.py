from datetime import datetime

from django.db.models import Q
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.response import Response

from apps.access.permissions import MEMBER, ScopedView
from apps.common.exceptions import invalid
from apps.common.pagination import paginate_queryset
from apps.common.params import body, filter_value, filter_values
from apps.common.utils import iso
from apps.workspaces.views import WorkspaceScopedView

from . import trash
from .models import AuditLog

# The client groups audit rows into eight entity types; everything else shows as "workspace".
ENTITY_GROUPS = {
    "task": ["task", "attachment"],
    "project": ["project", "status", "label", "objective", "milestone", "epic"],
    "sprint": ["sprint"],
    "comment": ["comment"],
    "member": ["member", "project_member"],
    "view": ["view"],
    "role": ["role"],
}
GROUP_OF = {t: g for g, types in ENTITY_GROUPS.items() for t in types}

_STATUS = Q(action__endswith=".status_changed")
_ASSIGNED = Q(action__endswith=".assigned") | Q(action__endswith=".unassigned")
_ROLE = Q(action__endswith=".role_changed")
_INVITED = Q(action__endswith=".invited")
_DELETED = Q(action__endswith=".removed") | Q(action__endswith=".deleted")
_COMMENTED = Q(action="comment.created") | Q(action__endswith=".commented")
_CREATED = Q(action__endswith=".created") & ~Q(entity_type="comment")
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


def audit_data(row: AuditLog) -> dict:
    return {
        "id": str(row.pk),
        "actorId": str(row.actor_id) if row.actor_id else None,
        "action": row.action,
        "target": row.target,
        "createdAt": iso(row.created_at),
        "actorName": row.actor_name or None,
        "actorKind": "user",
        "entityType": GROUP_OF.get(row.entity_type, "workspace"),
        "entityKey": row.entity_key,
        "source": row.source,
        "requestId": row.request_id,
        "changes": row.changes or [],
    }


class AuditListView(WorkspaceScopedView):
    required = {"GET": "audit.view"}

    @extend_schema(
        tags=["audit"],
        parameters=[
            OpenApiParameter("filter[actor]", str, many=True),
            OpenApiParameter("filter[action]", str, enum=list(ACTION_KINDS)),
            OpenApiParameter("filter[entity]", str, enum=[*ENTITY_GROUPS, "workspace"]),
            OpenApiParameter("filter[since]", str, description="ISO-8601 timestamp"),
            OpenApiParameter("cursor", str),
            OpenApiParameter("limit", int),
        ],
    )
    def get(self, request, slug):
        qs = AuditLog.objects.filter(workspace=self.scope)
        actors = filter_values(request, "actor")
        if actors:
            from apps.tasks.selectors import is_uuid

            if not all(is_uuid(a) for a in actors):
                raise invalid({"filter[actor]": "Pick people from the list"})
            qs = qs.filter(actor_id__in=actors)
        action = filter_value(request, "action")
        if action:
            if action not in ACTION_KINDS:
                raise invalid({"filter[action]": "Unknown action type"})
            qs = qs.filter(ACTION_KINDS[action])
        entity = filter_value(request, "entity")
        if entity:
            if entity == "workspace":
                qs = qs.exclude(entity_type__in=list(GROUP_OF))
            elif entity in ENTITY_GROUPS:
                qs = qs.filter(entity_type__in=ENTITY_GROUPS[entity])
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


TrashRef = inline_serializer(
    "TrashRef", {"kind": serializers.ChoiceField(choices=list(trash.KINDS)), "id": serializers.UUIDField()}
)


class TrashListView(WorkspaceScopedView):
    required = {"GET": "workspace.view"}

    @extend_schema(tags=["trash"])
    def get(self, request, slug):
        return Response(trash.list_items(request.user, self.scope))


class TrashRestoreView(WorkspaceScopedView):
    required = {"POST": "workspace.view"}

    @extend_schema(tags=["trash"], request=inline_serializer("TrashItems", {"items": TrashRef}))
    def post(self, request, slug):
        return Response({"restored": trash.restore(request.user, self.scope, body(request).get("items"))})


class TrashPurgeView(WorkspaceScopedView):
    required = {"POST": "workspace.view"}

    @extend_schema(tags=["trash"], request=inline_serializer("TrashPurgeItems", {"items": TrashRef}))
    def post(self, request, slug):
        return Response({"purged": trash.purge(request.user, self.scope, body(request).get("items"))})


class TrashItemRestoreView(ScopedView):
    """POST trash/{type}/{id}/restore (brief): restore one item, wherever it lives."""

    required = {"POST": MEMBER}

    def get_scope(self):
        from apps.collaboration.models import Comment
        from apps.common.exceptions import not_found
        from apps.projects.models import Project
        from apps.tasks.models import Task
        from apps.workspaces.selectors import workspace_for

        kind, item_id = self.kwargs["kind"], self.kwargs["item_id"]
        model = {"task": Task, "comment": Comment, "project": Project}.get(kind)
        if model is None:
            raise not_found("Unknown trash type.")
        item = model.all_objects.filter(pk=item_id).first()
        if item is None:
            raise not_found("That item isn’t in the Trash any more.")
        project = item if kind == "project" else (item.project if kind == "task" else item.task.project)
        return workspace_for(self.request.user, project.workspace.slug)

    @extend_schema(tags=["trash"], request=None)
    def post(self, request, kind, item_id):
        return Response({"restored": trash.restore(request.user, self.scope, [{"kind": kind, "id": str(item_id)}])})
