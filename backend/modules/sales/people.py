"""Who a caller sees as people (not records) under a scopable sales code: the user ids whose targets, performance and
dashboards they may read, and the teams whose targets they may read or set.

- `all` → every active member of the workspace and every live team (and the company subject);
- `team` → the caller plus anyone sharing a live team with them, and the caller's own teams;
- `own` → the caller only, no teams; no grant → nobody.
"""

from __future__ import annotations

from typing import Any

from core.access.catalogue import ALL, OWN, TEAM

from .scope import scope_of, teammates


def _members(workspace: Any) -> set[str]:
    from core.workspaces.models import WorkspaceMember

    rows = WorkspaceMember.objects.for_workspace(workspace).filter(status="active", user__is_active=True)
    return {str(u) for u in rows.values_list("user_id", flat=True)}


def visible_user_ids(user: Any, workspace: Any, code: str) -> set[str]:
    level = scope_of(user, workspace, code)
    if level == ALL:
        return _members(workspace)
    if level == TEAM:
        return teammates(user, workspace) & _members(workspace)
    if level == OWN:
        return {str(user.pk)}
    return set()


def visible_team_ids(user: Any, workspace: Any, code: str) -> set[str]:
    from core.teams.models import Team, TeamMember

    level = scope_of(user, workspace, code)
    if level == ALL:
        return {str(t) for t in Team.objects.for_workspace(workspace).values_list("pk", flat=True)}
    if level == TEAM:
        rows = TeamMember.objects.for_workspace(workspace).filter(user_id=user.pk, team__deleted_at__isnull=True)
        return {str(t) for t in rows.values_list("team_id", flat=True)}
    return set()


def sees_company(user: Any, workspace: Any, code: str) -> bool:
    return scope_of(user, workspace, code) == ALL


def team_member_ids(workspace: Any, team_id: Any) -> set[str]:
    from core.teams.models import TeamMember

    rows = TeamMember.objects.for_workspace(workspace).filter(team_id=team_id, team__deleted_at__isnull=True)
    return {str(u) for u in rows.values_list("user_id", flat=True)}
