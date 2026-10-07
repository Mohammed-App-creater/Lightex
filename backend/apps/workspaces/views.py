from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.permissions import ScopedView
from apps.accounts.authentication import BearerJWTAuthentication
from apps.accounts.views import session_response
from apps.common.pagination import paginate_queryset
from apps.common.params import body, filter_values
from apps.common.throttles import InvitationThrottle, InviteTokenThrottle

from . import selectors, services
from .models import WorkspaceAccessRequest
from .serializers import (
    AcceptInviteIn,
    AccessRequestSerializer,
    ConfirmIn,
    InviteIn,
    InviteSerializer,
    RoleIdIn,
    WorkspaceCreateIn,
    WorkspaceMemberSerializer,
    WorkspaceSerializer,
)


class WorkspaceScopedView(ScopedView):
    """Scope = the workspace named by the {slug} in the URL (404 for non-members)."""

    def get_scope(self):
        return selectors.workspace_for(self.request.user, self.kwargs["slug"])


def ws_data(request, ws) -> dict:
    return WorkspaceSerializer(ws, context={"user": request.user}).data


class WorkspaceListView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["workspaces"], responses={200: WorkspaceSerializer(many=True)})
    def get(self, request):
        items = selectors.workspaces_for(request.user)
        return Response(WorkspaceSerializer(items, many=True, context={"user": request.user}).data)

    @extend_schema(tags=["workspaces"], request=WorkspaceCreateIn, responses={201: WorkspaceSerializer})
    def post(self, request):
        data = body(request)
        ws = services.create_workspace(request.user, name=str(data.get("name", "")), slug=data.get("slug"))
        return Response(
            ws_data(request, selectors.workspace_for(request.user, ws.slug)), status=status.HTTP_201_CREATED
        )


class WorkspaceDetailView(WorkspaceScopedView):
    required = {"GET": "workspace.view", "PATCH": "workspace.update", "DELETE": "workspace.delete"}

    @extend_schema(tags=["workspaces"], responses={200: WorkspaceSerializer})
    def get(self, request, slug):
        return Response(ws_data(request, self.scope))

    @extend_schema(tags=["workspaces"], request=WorkspaceCreateIn, responses={200: WorkspaceSerializer})
    def patch(self, request, slug):
        ws = services.update_workspace(request.user, self.scope, body(request))
        return Response(ws_data(request, selectors.workspace_for(request.user, ws.slug)))

    @extend_schema(tags=["workspaces"], request=ConfirmIn, responses={204: None})
    def delete(self, request, slug):
        services.delete_workspace(request.user, self.scope, str(body(request).get("confirm", "")))
        return Response(status=status.HTTP_204_NO_CONTENT)


class SlugAvailabilityView(WorkspaceScopedView):
    required = {"GET": "workspace.view"}

    @extend_schema(
        tags=["workspaces"],
        parameters=[OpenApiParameter("q", str)],
        responses=inline_serializer(
            "SlugAvailability", {"slug": serializers.CharField(), "available": serializers.BooleanField()}
        ),
    )
    def get(self, request, slug):
        q = services.slugify(request.query_params.get("q", ""))
        return Response({"slug": q, "available": services.slug_available(q, exclude=self.scope)})


class MemberListView(WorkspaceScopedView):
    required = {"GET": "workspace.view"}

    @extend_schema(
        tags=["members"],
        parameters=[OpenApiParameter("q", str), OpenApiParameter("cursor", str), OpenApiParameter("limit", int)],
    )
    def get(self, request, slug):
        qs = selectors.members(
            self.scope, q=request.query_params.get("q", "").strip(), role_ids=filter_values(request, "role")
        )
        page = paginate_queryset(
            qs,
            request.query_params,
            order=[("sort_name", False), ("id", False)],
            serialize=lambda rows: WorkspaceMemberSerializer(rows, many=True).data,
            default_limit=100,
            max_limit=200,
        )
        return Response(page)


class MemberDetailView(WorkspaceScopedView):
    required = {"PATCH": "workspace.manage_members", "DELETE": "workspace.manage_members"}

    @extend_schema(tags=["members"], request=RoleIdIn, responses={200: WorkspaceMemberSerializer})
    def patch(self, request, slug, user_id):
        member = services.change_member_role(request.user, self.scope, user_id, body(request).get("roleId"))
        return Response(WorkspaceMemberSerializer(member).data)

    @extend_schema(tags=["members"], responses={204: None})
    def delete(self, request, slug, user_id):
        services.remove_member(request.user, self.scope, user_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class InviteListView(WorkspaceScopedView):
    required = {"GET": "workspace.manage_members", "POST": "workspace.manage_members"}

    def get_throttles(self):
        return [InvitationThrottle()] if self.request.method == "POST" else super().get_throttles()

    @extend_schema(tags=["invites"], responses={200: InviteSerializer(many=True)})
    def get(self, request, slug):
        return Response(InviteSerializer(selectors.pending_invitations(self.scope), many=True).data)

    @extend_schema(tags=["invites"], request=InviteIn, responses={201: InviteSerializer(many=True)})
    def post(self, request, slug):
        data = body(request)
        invites = services.create_invitations(request.user, self.scope, data.get("emails"), data.get("roleId"))
        return Response(InviteSerializer(invites, many=True).data, status=status.HTTP_201_CREATED)


class InviteDetailView(WorkspaceScopedView):
    required = {"DELETE": "workspace.manage_members"}

    @extend_schema(tags=["invites"], responses={204: None})
    def delete(self, request, slug, invite_id):
        services.revoke_invitation(request.user, self.scope, invite_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class InviteResendView(WorkspaceScopedView):
    required = {"POST": "workspace.manage_members"}
    throttle_classes = [InvitationThrottle]

    @extend_schema(tags=["invites"], request=None, responses={200: InviteSerializer})
    def post(self, request, slug, invite_id):
        return Response(InviteSerializer(services.resend_invitation(request.user, self.scope, invite_id)).data)


class PublicInviteView(APIView):
    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_classes = [InviteTokenThrottle]

    @extend_schema(tags=["invites"], responses={200: InviteSerializer})
    def get(self, request, token):
        return Response(InviteSerializer(services.invitation_by_token(token)).data)


class AcceptInviteView(APIView):
    # Optional auth: a signed-in invitee joins without re-entering their password.
    authentication_classes = [BearerJWTAuthentication]
    permission_classes = [AllowAny]
    throttle_classes = [InviteTokenThrottle]

    @extend_schema(
        tags=["invites"],
        request=AcceptInviteIn,
        responses=inline_serializer(
            "AcceptInviteOut", {"accessToken": serializers.CharField(), "workspaceSlug": serializers.CharField()}
        ),
    )
    def post(self, request, token):
        data = body(request)
        user, ws = services.accept_invitation(
            token, request_user=request.user, name=str(data.get("name", "")), password=str(data.get("password", ""))
        )
        return session_response(user, extra={"workspaceSlug": ws.slug})


class MyAccessRequestView(WorkspaceScopedView):
    required = {"GET": "workspace.view", "DELETE": "workspace.view"}

    @extend_schema(
        tags=["workspaces"],
        responses=inline_serializer("MyWsAccessRequest", {"request": AccessRequestSerializer(allow_null=True)}),
    )
    def get(self, request, slug):
        req = WorkspaceAccessRequest.objects.filter(workspace=self.scope, user=request.user).first()
        return Response({"request": AccessRequestSerializer(req).data if req else None})

    @extend_schema(tags=["workspaces"], responses={204: None})
    def delete(self, request, slug):
        services.withdraw_workspace_access(request.user, self.scope)
        return Response(status=status.HTTP_204_NO_CONTENT)


class AccessRequestCreateView(WorkspaceScopedView):
    required = {"POST": "workspace.view"}

    @extend_schema(tags=["workspaces"], request=None, responses={201: AccessRequestSerializer})
    def post(self, request, slug):
        req = services.request_workspace_access(request.user, self.scope)
        return Response(AccessRequestSerializer(req).data, status=status.HTTP_201_CREATED)
