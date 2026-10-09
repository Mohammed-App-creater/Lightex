"""Board 33 endpoints: presence P1–P3 and the realtime stream S1 (docs/v2/33-dashboards-presence.md §5.3, §2.3)."""

from django.conf import settings
from django.http import StreamingHttpResponse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema, inline_serializer
from rest_framework import renderers, serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.permissions import MEMBER
from apps.common.exceptions import ApiError, invalid, not_found
from apps.common.params import body, filter_value
from apps.common.throttles import PresenceThrottle, StreamThrottle
from apps.projects.selectors import project_for
from apps.workspaces.selectors import workspace_for
from apps.workspaces.views import WorkspaceScopedView

from . import presence
from .hub import hub
from .protocol import SUPPORTED_VERSIONS
from .stream import StreamContext, stream_events, visible_project_ids

PresencePersonOut = inline_serializer(
    "PresencePerson",
    {
        "user": serializers.JSONField(help_text="{ id, name, hue, avatarUrl }"),
        "state": serializers.ChoiceField(choices=["viewing", "editing"]),
        "field": serializers.CharField(allow_null=True),
        "typing": serializers.BooleanField(),
        "since": serializers.DateTimeField(),
    },
)
PresenceRosterOut = inline_serializer(
    "PresenceRoster",
    {
        "projectId": serializers.UUIDField(),
        "at": serializers.DateTimeField(),
        "locations": serializers.JSONField(
            help_text="[{ location: { kind: board | dashboard | task, id }, people: PresencePerson[] }] "
            "(non-empty locations only)"
        ),
    },
)
PresenceUpdateIn = inline_serializer(
    "PresenceUpdate",
    {
        "location": serializers.JSONField(help_text="{ kind: board | dashboard | task, id }"),
        "state": serializers.ChoiceField(choices=["viewing", "editing"]),
        "field": serializers.CharField(allow_null=True, required=False),
        "typing": serializers.BooleanField(required=False),
    },
)
PresenceHeartbeatOut = inline_serializer(
    "PresenceHeartbeat",
    {"expiresAt": serializers.DateTimeField(), "heartbeatSec": serializers.IntegerField(), "roster": PresenceRosterOut},
)
ErrorOut = inline_serializer(
    "RealtimeError",
    {"code": serializers.CharField(), "message": serializers.CharField(), "details": serializers.JSONField()},
)


class PresenceView(WorkspaceScopedView):
    """P1 heartbeat (upsert this tab's session, returns the project roster); P2 leave (idempotent)."""

    required = {"PUT": MEMBER, "DELETE": MEMBER}
    throttle_classes = [PresenceThrottle]

    @extend_schema(tags=["presence"], request=PresenceUpdateIn, responses={200: PresenceHeartbeatOut})
    def put(self, request, slug, session_id):
        session, roster = presence.heartbeat(request.user, self.scope, session_id, body(request))
        return Response(presence.heartbeat_response(session, roster))

    @extend_schema(tags=["presence"], responses={204: None})
    def delete(self, request, slug, session_id):
        presence.leave(request.user, session_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PresenceRosterView(WorkspaceScopedView):
    """P3: the roster of one project (`filter[project]`, required)."""

    required = {"GET": MEMBER}
    throttle_classes = [PresenceThrottle]

    @extend_schema(
        tags=["presence"],
        parameters=[OpenApiParameter("filter[project]", str, required=True)],
        responses={200: PresenceRosterOut},
    )
    def get(self, request, slug):
        project_id = filter_value(request, "project")
        if not project_id:
            raise invalid({"filter[project]": "Pick a project"})
        try:
            project = project_for(request.user, project_id)
        except ApiError as exc:
            if exc.status_code == 404:
                raise not_found("Project not found.") from exc
            raise
        if project.workspace_id != self.scope.pk:
            raise not_found("Project not found.")
        if not presence.access.can(request.user, "project.view", project):
            from apps.common.exceptions import forbidden

            raise forbidden(details={"permission": "project.view"})
        return Response(presence.roster(project))


class EventStreamRenderer(renderers.BaseRenderer):
    """Lets content negotiation accept `text/event-stream`; the body is a StreamingHttpResponse, never rendered."""

    media_type = "text/event-stream"
    format = "sse"
    charset = "utf-8"

    def render(self, data, accepted_media_type=None, renderer_context=None):  # pragma: no cover - never used
        return b""


STREAM_DESCRIPTION = """Server-Sent Events for one workspace (docs/v2/33-dashboards-presence.md §2).

Authenticate with the normal `Authorization: Bearer <access>` header (fetch-based clients; never a token in the URL)
and send `Accept: text/event-stream`. Send `Last-Event-ID` to replay retained durable events (15 minutes) after that
id. Errors before the stream starts are JSON.

The body starts with `retry: 3000`, then `hello`, then the replay. A `: ping <time>` comment is written after 15 s of
silence. The stream ends itself with `reconnect` after 5 minutes (plus jitter), when the access token has less than
30 s left, when the caller's access changes, or on shutdown.

Every `data:` line is one envelope `{ v: 1, type, id?, ws?, projectId?, actorId?, at?, data }`. Clients must ignore
unknown types and fields. Events carry ids, keys, versions and field names only; refetch through the normal
endpoints.

Event catalogue (protocol version 1; durable events have an `id` and are replayable):

- `hello` (control): `{ connectionId, serverTime, heartbeatSec, maxLifetimeSec, projects: ID[], replayed,
  degraded? }`.
- `reset` (control): `{ reason: unknown_cursor | gap | slow_consumer | broker_restart }`; refetch everything live.
- `reconnect` (control): `{ reason: lifetime | token_expiry | access_changed | shutdown, retryMs }`; the stream
  then closes.
- `task.changed` (durable): `{ taskId, key, op: created | updated | moved | deleted | restored, version | null,
  fields: string[] }`.
- `tasks.bulk_changed` (durable): `{ taskIds: ID[] | null (more than 200, or an import), op }`.
- `comment.changed` (durable): `{ taskId, key, commentId, op: created | updated | deleted }`.
- `attachment.changed` (durable): `{ taskId, key, op: created | deleted }`.
- `project.changed` (durable): `{ areas: (settings | statuses | labels | members | sprints | epics | objectives |
  milestones | custom_fields | dependencies | time)[] }`.
- `dashboard.changed` (durable): `{ dashboardId, op: created | updated | layout | deleted, version | null }`;
  personal dashboards reach their owner only.
- `inbox.changed` (durable, one user): `{ unread }`.
- `access.changed` (durable, one user): `{ projectId | null }`; the stream then ends with `reconnect`.
- `presence.updated` (volatile): `{ location: { kind, id }, people: PresencePerson[], at }`.
- `import.progress` (volatile): reserved, not emitted in this release.
"""


class StreamView(APIView):
    """S1. Throttled by the `stream` scope only (one request per connection), never by the default user rate."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [StreamThrottle]
    renderer_classes = [renderers.JSONRenderer, EventStreamRenderer]

    def handle_exception(self, exc):
        # Errors before the stream starts are JSON, whatever the client accepted.
        self.request.accepted_renderer = renderers.JSONRenderer()
        self.request.accepted_media_type = "application/json"
        return super().handle_exception(exc)

    @extend_schema(
        tags=["realtime"],
        operation_id="workspaces_stream",
        description=STREAM_DESCRIPTION,
        parameters=[
            OpenApiParameter("v", int, description="Protocol version the client speaks (default 1)"),
            OpenApiParameter("Last-Event-ID", str, location=OpenApiParameter.HEADER),
        ],
        responses={
            (200, "text/event-stream"): OpenApiResponse(OpenApiTypes.STR, description="The event stream"),
            400: OpenApiResponse(ErrorOut, description="`unsupported_version` (`details.supported`)"),
            401: OpenApiResponse(ErrorOut, description="Not authenticated"),
            404: OpenApiResponse(ErrorOut, description="Not a member of the workspace"),
            406: OpenApiResponse(ErrorOut, description="`not_acceptable`: send `Accept: text/event-stream`"),
            429: OpenApiResponse(ErrorOut, description="More than 30 connects per minute (`Retry-After`)"),
            503: OpenApiResponse(
                ErrorOut,
                description="`realtime_unavailable` (kill switch, `Retry-After: 300`) or `realtime_busy` "
                "(this process's stream cap, `Retry-After: 60`): poll instead",
            ),
        },
    )
    def get(self, request, slug):
        workspace = workspace_for(request.user, slug)
        if "text/event-stream" not in request.META.get("HTTP_ACCEPT", ""):
            raise ApiError(406, "not_acceptable", "This endpoint only streams text/event-stream.")
        version = request.query_params.get("v")
        if version not in (None, "") and version not in {str(v) for v in SUPPORTED_VERSIONS}:
            raise ApiError(
                400, "unsupported_version", "Unsupported protocol version.", {"supported": list(SUPPORTED_VERSIONS)}
            )
        if not settings.REALTIME_ENABLED:
            raise ApiError(
                503,
                "realtime_unavailable",
                "Live updates are off. Refresh to see changes.",
                headers={"Retry-After": "300"},
            )
        project_ids = visible_project_ids(request.user, workspace)
        slot = hub.admit()
        if slot is None:
            raise ApiError(503, "realtime_busy", "Too many live connections right now.", headers={"Retry-After": "60"})
        exp = request.auth.get("exp") if request.auth is not None else None
        ctx = StreamContext(
            workspace_id=str(workspace.pk),
            user_id=str(request.user.pk),
            project_ids=project_ids,
            token_exp=float(exp) if exp is not None else None,
            last_event_id=request.headers.get("Last-Event-ID"),
            slot=slot,
        )
        response = StreamingHttpResponse(stream_events(ctx), content_type="text/event-stream; charset=utf-8")
        response["Cache-Control"] = "no-cache, no-transform"
        response["X-Accel-Buffering"] = "no"
        response._resource_closers.append(slot.release)
        return response
