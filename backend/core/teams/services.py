"""Team reads and writes (platform Stage 4, contract §1). Reads are open to any workspace member; the views require
`core.teams.manage` for every write. Every write is audited (`core.team.*`) and publishes no realtime event."""

from __future__ import annotations

import uuid
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Prefetch, QuerySet
from django.db.models.functions import Lower
from django.utils import timezone

from core.audit.services import change, record
from core.common.exceptions import ApiError, conflict, invalid, not_found

from .models import DESCRIPTION_MAX, NAME_MAX, Team, TeamMember

# ───────────────────────── reads ─────────────────────────


def _with_members(qs: QuerySet[Team]) -> QuerySet[Team]:
    members = TeamMember.objects.select_related("user").order_by(Lower("user__name"), "user__email")
    return qs.prefetch_related(Prefetch("memberships", queryset=members))


def teams_for(workspace: Any) -> QuerySet[Team]:
    """The workspace's live teams, by name (case-insensitive). Not paginated."""
    return _with_members(Team.objects.filter(workspace=workspace)).order_by(Lower("name"), "created_at")


def get_team(team_id: Any) -> Team:
    """A live team in a live workspace (the view then checks workspace membership: 404 for outsiders)."""
    try:
        uuid.UUID(str(team_id))
    except (TypeError, ValueError) as exc:
        raise not_found("Team not found.") from exc
    team = (
        _with_members(Team.objects.select_related("workspace"))
        .filter(pk=team_id, workspace__deleted_at__isnull=True)
        .first()
    )
    if team is None:
        raise not_found("Team not found.")
    return team


def reload(team: Team) -> Team:
    return _with_members(Team.objects.select_related("workspace")).get(pk=team.pk)


def get_membership(team: Team, user_id: Any) -> TeamMember:
    try:
        uuid.UUID(str(user_id))
    except (TypeError, ValueError) as exc:
        raise not_found("That person isn’t in this team.") from exc
    m = TeamMember.objects.select_related("user").filter(team=team, user_id=user_id).first()
    if m is None:
        raise not_found("That person isn’t in this team.")
    return m


# ───────────────────────── validation ─────────────────────────


def _name(raw: Any) -> str:
    if raw is not None and not isinstance(raw, str):
        raise invalid({"name": "Must be text"})
    name = (raw or "").strip()
    if not name:
        raise invalid({"name": "Name is required"})
    if len(name) > NAME_MAX:
        raise invalid({"name": f"Use {NAME_MAX} characters or fewer"})
    return name


def _description(raw: Any) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise invalid({"description": "Must be text"})
    description = raw.strip()
    if len(description) > DESCRIPTION_MAX:
        raise invalid({"description": f"Use {DESCRIPTION_MAX} characters or fewer"})
    return description


def _is_lead(raw: Any) -> bool:
    if not isinstance(raw, bool):
        raise invalid({"isLead": "Must be true or false"})
    return raw


def _name_taken(name: str) -> ApiError:
    return conflict("team_name_taken", f"A team called “{name}” already exists.", {"name": name})


def _ensure_name_free(workspace: Any, name: str, exclude: Team | None = None) -> None:
    qs = Team.objects.filter(workspace=workspace, name__iexact=name)
    if exclude is not None:
        qs = qs.exclude(pk=exclude.pk)
    if qs.exists():
        raise _name_taken(name)


def _save(team: Team) -> None:
    """Saves under a savepoint so a concurrent duplicate name answers 409, not 500."""
    try:
        with transaction.atomic():
            team.save()
    except IntegrityError as exc:
        raise _name_taken(team.name) from exc


# ───────────────────────── team writes ─────────────────────────


@transaction.atomic
def create_team(actor: Any, workspace: Any, data: dict[str, Any]) -> Team:
    name = _name(data.get("name"))
    description = _description(data.get("description"))
    _ensure_name_free(workspace, name)
    team = Team(workspace=workspace, name=name, description=description)
    _save(team)
    record(workspace=workspace, actor=actor, action="core.team.created", target=team.name, entity_id=team.pk)
    return team


@transaction.atomic
def update_team(actor: Any, team: Team, data: dict[str, Any]) -> Team:
    team = Team.objects.select_for_update().get(pk=team.pk)
    changes = []
    if "name" in data:
        name = _name(data.get("name"))
        if name != team.name:
            _ensure_name_free(team.workspace_id, name, exclude=team)
            changes.append(change("Name", team.name, name))
            team.name = name
    if "description" in data:
        description = _description(data.get("description"))
        if description != team.description:
            changes.append(change("Description", team.description, description, "text"))
            team.description = description
    if changes:
        _save(team)
        record(
            workspace=team.workspace_id,
            actor=actor,
            action="core.team.updated",
            target=team.name,
            entity_id=team.pk,
            changes=changes,
        )
    return team


@transaction.atomic
def delete_team(actor: Any, team: Team) -> None:
    """Soft delete: the team and its memberships stay in the database, hidden (and out of data scope)."""
    Team.objects.filter(pk=team.pk).update(deleted_at=timezone.now())
    record(workspace=team.workspace_id, actor=actor, action="core.team.deleted", target=team.name, entity_id=team.pk)


# ───────────────────────── membership writes ─────────────────────────


def _label(team: Team, user: Any) -> str:
    return f"{team.name}: {user.name}"


@transaction.atomic
def add_member(actor: Any, team: Team, data: dict[str, Any]) -> TeamMember:
    from core.workspaces.models import WorkspaceMember

    raw = data.get("userId")
    if not isinstance(raw, str) or not raw:
        raise invalid({"userId": "Pick a workspace member"})
    is_lead = _is_lead(data["isLead"]) if data.get("isLead") is not None else False
    try:
        user_id = uuid.UUID(raw)
    except ValueError as exc:
        raise invalid({"userId": "Pick a workspace member"}) from exc
    ws_member = (
        WorkspaceMember.objects.select_related("user")
        .filter(workspace_id=team.workspace_id, user_id=user_id, status="active")
        .first()
    )
    if ws_member is None:
        raise ApiError(
            400,
            "not_a_workspace_member",
            "Only members of this workspace can join its teams.",
            {"userId": str(user_id)},
        )
    if TeamMember.objects.filter(team=team, user_id=user_id).exists():
        raise conflict("already_a_member", "That person is already in this team.", {"userId": str(user_id)})
    try:
        with transaction.atomic():
            m = TeamMember.objects.create(
                workspace_id=team.workspace_id, team=team, user=ws_member.user, is_lead=is_lead
            )
    except IntegrityError as exc:
        raise conflict("already_a_member", "That person is already in this team.", {"userId": str(user_id)}) from exc
    record(
        workspace=team.workspace_id,
        actor=actor,
        action="core.team.member_added",
        target=_label(team, m.user),
        entity_id=team.pk,
        data={"userId": str(user_id), "isLead": is_lead},
    )
    return m


@transaction.atomic
def update_member(actor: Any, team: Team, user_id: Any, data: dict[str, Any]) -> TeamMember:
    m = get_membership(team, user_id)
    is_lead = _is_lead(data.get("isLead"))
    if is_lead != m.is_lead:
        before = m.is_lead
        m.is_lead = is_lead
        m.save(update_fields=["is_lead", "updated_at"])
        record(
            workspace=team.workspace_id,
            actor=actor,
            action="core.team.member_updated",
            target=_label(team, m.user),
            entity_id=team.pk,
            changes=[change("Lead", before, is_lead)],
            data={"userId": str(m.user_id)},
        )
    return m


@transaction.atomic
def remove_member(actor: Any, team: Team, user_id: Any) -> None:
    m = get_membership(team, user_id)
    m.delete()
    record(
        workspace=team.workspace_id,
        actor=actor,
        action="core.team.member_removed",
        target=_label(team, m.user),
        entity_id=team.pk,
        data={"userId": str(m.user_id)},
    )


def drop_workspace_member(workspace: Any, user_id: Any) -> int:
    """Removing someone from the workspace removes every team membership they had in it (deleted teams too)."""
    return TeamMember.objects.filter(workspace=workspace, user_id=user_id).delete()[0]
