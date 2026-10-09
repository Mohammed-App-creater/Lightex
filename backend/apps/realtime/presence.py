"""Presence (docs/v2/33-dashboards-presence.md §2.8, §5.3): one `PresenceSession` row per browser tab.

- The heartbeat `PUT` upserts the row (`expires_at = now + PRESENCE_TTL_SECONDS`) and returns the roster of the
  location's whole project, which keeps presence fresh in polling mode.
- A change of location, state, field or typing (or a new row) publishes `presence.updated` for the old location (if
  it changed) and the new one; a pure refresh publishes nothing.
- Personal dashboards are stored `private`: never broadcast or listed.
- Housekeeping deletes expired rows (`DELETE … RETURNING`, so each row is handled by exactly one process) and
  publishes for each affected location.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from collections import OrderedDict
from typing import Any

from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.access import services as access
from apps.common.exceptions import forbidden, invalid, not_found
from apps.common.utils import iso
from apps.projects.selectors import project_for

from .models import PresenceSession
from .services import publish

FIELD_RE = re.compile(r"^[a-zA-Z.]{1,10}[a-zA-Z0-9.\-]{0,38}$")
TYPING_SECONDS = 8
HEARTBEAT_SECONDS = 20
TYPING_FIELDS = ("comment", "description")
NOT_VISIBLE = "That location doesn’t exist, or you can’t see it."


# ───────────────────────── validation ─────────────────────────


def validate(data: dict[str, Any]) -> dict[str, Any]:
    """The P1 body → {kind, id, state, field, typing} (§5.3 messages, all reported at once)."""
    raw_location = data.get("location")
    location: dict[str, Any] = raw_location if isinstance(raw_location, dict) else {}
    errors: dict[str, str] = {}
    kind = location.get("kind")
    if kind not in ("board", "dashboard", "task"):
        errors["location.kind"] = "Pick board, dashboard or task"
    location_id = location.get("id")
    if not isinstance(location_id, str) or not location_id:
        errors["location.id"] = "Pick a location"
    state = data.get("state") or "viewing"
    if state not in ("viewing", "editing"):
        errors["state"] = "Pick viewing or editing"
    field = data.get("field")
    if state == "editing" and not field:
        errors["field"] = "Name the field being edited"
    elif field is not None and (state != "editing" or not isinstance(field, str) or not FIELD_RE.match(field)):
        errors["field"] = "Unknown field"
    typing = data.get("typing") is True
    if typing and field not in TYPING_FIELDS:
        errors["typing"] = "Typing needs the comment or description field"
    if errors:
        raise invalid(errors)
    return {
        "kind": kind,
        "id": location_id,
        "state": state,
        "field": field if state == "editing" else None,
        "typing": typing,
    }


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _require_view(user: Any, project: Any) -> Any:
    project = project_for(user, project.pk)  # not on the project → v1 403 project_membership_required
    if not access.can(user, "project.view", project):
        raise forbidden(details={"permission": "project.view"})
    return project


def resolve_location(user: Any, workspace: Any, kind: str, raw_id: str) -> tuple[Any, bool]:
    """A location → (its project, private?). Unknown or invisible → 404 (§2.8)."""
    from apps.dashboards.models import Dashboard
    from apps.projects.models import Project
    from apps.tasks.models import Task

    location_id = _uuid(raw_id)
    if location_id is None:
        raise not_found(NOT_VISIBLE)
    alive = {"workspace": workspace, "deleted_at__isnull": True}
    if kind == "board":
        project = Project.objects.filter(pk=location_id, **alive).first()
        if project is None:
            raise not_found(NOT_VISIBLE)
        return _require_view(user, project), False
    if kind == "task":
        task = (
            Task.objects.select_related("project")
            .filter(pk=location_id, project__workspace=workspace, project__deleted_at__isnull=True)
            .first()
        )
        if task is None:
            raise not_found(NOT_VISIBLE)
        return _require_view(user, task.project), False
    dashboard = (
        Dashboard.objects.select_related("project")
        .filter(pk=location_id, project__workspace=workspace, project__deleted_at__isnull=True)
        .first()
    )
    if dashboard is None or (dashboard.visibility == "personal" and dashboard.owner_id != user.pk):
        raise not_found(NOT_VISIBLE)
    return _require_view(user, dashboard.project), dashboard.visibility == "personal"


# ───────────────────────── rosters ─────────────────────────


def _person(rows: list[PresenceSession], now: dt.datetime) -> tuple[dt.datetime, dict[str, Any]]:
    """One user's rows at one location: editing beats viewing; field and since from the earliest editing row;
    typing if any row is typing. Returns (since, person)."""
    editing = sorted((r for r in rows if r.state == "editing"), key=lambda r: r.since)
    first = editing[0] if editing else min(rows, key=lambda r: r.since)
    user = first.user
    return first.since, {
        "user": {"id": str(user.pk), "name": user.name, "hue": user.hue, "avatarUrl": user.avatar_url},
        "state": "editing" if editing else "viewing",
        "field": first.field if editing else None,
        "typing": any(r.typing_until is not None and r.typing_until > now for r in rows),
        "since": iso(first.since),
    }


def _people(rows: list[PresenceSession], now: dt.datetime) -> list[dict[str, Any]]:
    """Aggregated per user, the first arrival first."""
    by_user: OrderedDict[Any, list[PresenceSession]] = OrderedDict()
    for row in rows:
        by_user.setdefault(row.user_id, []).append(row)
    people = [_person(group, now) for group in by_user.values()]
    people.sort(key=lambda p: (p[0], p[1]["user"]["name"], p[1]["user"]["id"]))
    return [person for _, person in people]


def _live(now: dt.datetime):
    return PresenceSession.objects.filter(private=False, expires_at__gt=now).select_related("user")


def people_at(kind: str, location_id: Any, now: dt.datetime | None = None) -> list[dict[str, Any]]:
    now = now or timezone.now()
    return _people(list(_live(now).filter(location_kind=kind, location_id=location_id)), now)


def roster(project: Any, now: dt.datetime | None = None) -> dict[str, Any]:
    """`PresenceRoster` of a whole project: only non-empty locations, the earliest arrival first."""
    now = now or timezone.now()
    rows = list(_live(now).filter(project=project).order_by("since"))
    locations: OrderedDict[tuple[str, str], list[PresenceSession]] = OrderedDict()
    for row in rows:
        locations.setdefault((row.location_kind, str(row.location_id)), []).append(row)
    return {
        "projectId": str(getattr(project, "pk", project)),
        "at": iso(now),
        "locations": [
            {"location": {"kind": kind, "id": location_id}, "people": _people(group, now)}
            for (kind, location_id), group in locations.items()
        ],
    }


def broadcast(workspace_id: Any, project_id: Any, kind: str, location_id: Any, actor: Any = None) -> None:
    """`presence.updated` (volatile) with the full roster of one location."""
    now = timezone.now()
    publish(
        "presence.updated",
        workspace=workspace_id,
        project=project_id,
        actor=actor,
        durable=False,
        data={
            "location": {"kind": kind, "id": str(location_id)},
            "people": people_at(kind, location_id, now),
            "at": iso(now),
        },
    )


# ───────────────────────── writes ─────────────────────────


@transaction.atomic
def heartbeat(
    user: Any, workspace: Any, session_id: Any, data: dict[str, Any]
) -> tuple[PresenceSession, dict[str, Any]]:
    """P1: upsert this tab's session; returns it and the roster of its project."""
    clean = validate(data)
    project, private = resolve_location(user, workspace, clean["kind"], clean["id"])
    now = timezone.now()
    location_id = _uuid(clean["id"])
    prev = PresenceSession.objects.select_for_update().filter(user=user, session_id=session_id).first()
    typing_now = bool(prev and prev.typing_until and prev.typing_until > now)
    moved = prev is None or prev.location_kind != clean["kind"] or prev.location_id != location_id
    changed = (
        prev is None
        or moved
        or prev.state != clean["state"]
        or prev.field != clean["field"]
        or typing_now != clean["typing"]
        or prev.expires_at <= now
    )
    old = (prev.workspace_id, prev.project_id, prev.location_kind, prev.location_id, prev.private) if prev else None
    values = {
        "workspace": workspace,
        "project": project,
        "location_kind": clean["kind"],
        "location_id": location_id,
        "private": private,
        "state": clean["state"],
        "field": clean["field"],
        "typing_until": now + dt.timedelta(seconds=TYPING_SECONDS) if clean["typing"] else None,
        "since": prev.since if prev is not None and not moved and prev.state == clean["state"] else now,
        "expires_at": now + dt.timedelta(seconds=settings.PRESENCE_TTL_SECONDS),
    }
    if prev is None:
        try:
            with transaction.atomic():
                session = PresenceSession.objects.create(user=user, session_id=session_id, **values)
        except IntegrityError:  # the same tab's first two heartbeats raced
            session = PresenceSession.objects.select_for_update().get(user=user, session_id=session_id)
            for key, value in values.items():
                setattr(session, key, value)
            session.save()
    else:
        session = prev
        for key, value in values.items():
            setattr(session, key, value)
        session.save()
    if changed:
        if old is not None and moved and not old[4]:
            broadcast(old[0], old[1], old[2], old[3], actor=user)
        if not private:
            broadcast(workspace.pk, project.pk, clean["kind"], location_id, actor=user)
    return session, roster(project, now)


@transaction.atomic
def leave(user: Any, session_id: Any) -> None:
    """P2: idempotent; publishes for the location it left."""
    session = PresenceSession.objects.filter(user=user, session_id=session_id).first()
    if session is None:
        return
    session.delete()
    if not session.private:
        broadcast(session.workspace_id, session.project_id, session.location_kind, session.location_id, actor=user)


def sweep_presence() -> int:
    """Deletes expired sessions and publishes `presence.updated` once per affected location."""
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM realtime_presencesession WHERE expires_at < %s "
                "RETURNING workspace_id, project_id, location_kind, location_id, private",
                [timezone.now()],
            )
            rows = cursor.fetchall()
        for ws_id, project_id, kind, location_id in dict.fromkeys(r[:4] for r in rows if not r[4]):
            broadcast(ws_id, project_id, kind, location_id)
    return len(rows)


def heartbeat_response(session: PresenceSession, roster_data: dict[str, Any]) -> dict[str, Any]:
    return {"expiresAt": iso(session.expires_at), "heartbeatSec": HEARTBEAT_SECONDS, "roster": roster_data}
