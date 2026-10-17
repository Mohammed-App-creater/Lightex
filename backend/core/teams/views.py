from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response

from core.access.permissions import MEMBER, ScopedView
from core.common.params import body
from core.workspaces.views import WorkspaceScopedView

from . import services
from .serializers import (
    TeamDetailSerializer,
    TeamIn,
    TeamMemberIn,
    TeamMemberSerializer,
    TeamMemberUpdateIn,
    TeamSerializer,
    TeamUpdateIn,
)

MANAGE = "core.teams.manage"


class TeamListView(WorkspaceScopedView):
    required = {"GET": MEMBER, "POST": MANAGE}

    @extend_schema(tags=["teams"], responses={200: TeamSerializer(many=True)})
    def get(self, request, slug):
        return Response(TeamSerializer(services.teams_for(self.scope), many=True).data)

    @extend_schema(tags=["teams"], request=TeamIn, responses={201: TeamDetailSerializer})
    def post(self, request, slug):
        team = services.create_team(request.user, self.scope, body(request))
        return Response(TeamDetailSerializer(services.reload(team)).data, status=status.HTTP_201_CREATED)


class TeamScopedView(ScopedView):
    """Scope = the workspace that owns the team (404 for non-members, so a team in another workspace is a 404)."""

    def get_scope(self):
        from core.workspaces.selectors import workspace_for

        self.team = services.get_team(self.kwargs["team_id"])
        return workspace_for(self.request.user, self.team.workspace.slug)


class TeamDetailView(TeamScopedView):
    required = {"GET": MEMBER, "PATCH": MANAGE, "DELETE": MANAGE}

    @extend_schema(tags=["teams"], responses={200: TeamDetailSerializer})
    def get(self, request, team_id):
        return Response(TeamDetailSerializer(self.team).data)

    @extend_schema(tags=["teams"], request=TeamUpdateIn, responses={200: TeamDetailSerializer})
    def patch(self, request, team_id):
        team = services.update_team(request.user, self.team, body(request))
        return Response(TeamDetailSerializer(services.reload(team)).data)

    @extend_schema(tags=["teams"], responses={204: None})
    def delete(self, request, team_id):
        services.delete_team(request.user, self.team)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TeamMemberListView(TeamScopedView):
    required = {"GET": MEMBER, "POST": MANAGE}

    @extend_schema(tags=["teams"], responses={200: TeamMemberSerializer(many=True)})
    def get(self, request, team_id):
        return Response(TeamMemberSerializer(self.team.memberships.all(), many=True).data)

    @extend_schema(tags=["teams"], request=TeamMemberIn, responses={201: TeamMemberSerializer})
    def post(self, request, team_id):
        member = services.add_member(request.user, self.team, body(request))
        return Response(TeamMemberSerializer(member).data, status=status.HTTP_201_CREATED)


class TeamMemberDetailView(TeamScopedView):
    required = {"PATCH": MANAGE, "DELETE": MANAGE}

    @extend_schema(tags=["teams"], request=TeamMemberUpdateIn, responses={200: TeamMemberSerializer})
    def patch(self, request, team_id, user_id):
        member = services.update_member(request.user, self.team, user_id, body(request))
        return Response(TeamMemberSerializer(member).data)

    @extend_schema(tags=["teams"], responses={204: None})
    def delete(self, request, team_id, user_id):
        services.remove_member(request.user, self.team, user_id)
        return Response(status=status.HTTP_204_NO_CONTENT)
