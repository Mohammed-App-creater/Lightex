"""The "target set or changed" notification (spec §9, S4): `sales.target.changed` → the subject user, or every member
of the subject team (company targets notify nobody), never the actor; honours each recipient's preferences."""

from __future__ import annotations

from typing import Any

from core.events.models import DomainEvent
from core.events.registry import register_handler
from core.notifications.handlers import deliver, recipients

from . import module as perms
from .notifications import EMAIL, _actor, _email, _workspace

CHANGED = "sales.target.changed"


def _audience(workspace: Any, payload: dict[str, Any]) -> list[str]:
    from . import people

    kind, sid = payload.get("subjectType"), payload.get("subjectId")
    if kind == "user" and sid:
        return [str(sid)]
    if kind == "team" and sid:
        return sorted(people.team_member_ids(workspace, sid))
    return []


def on_changed(event: DomainEvent) -> None:
    ws = _workspace(event)
    if ws is None:
        return
    p = event.payload
    what = f"{p.get('periodType', '')} target from {p.get('periodStart', '')}"
    action = p.get("action")
    if action == "allocated":
        body = f"{_actor(event)} allocated your {what} into quarters and months."
    elif action == "deleted":
        body = f"{_actor(event)} removed your {what}."
    else:
        body = f"{_actor(event)} set your {what} to ETB {p.get('amount')}."
    email = _email(ws, "Your sales target changed", body, "targets", "Open targets", f"you have targets in {ws.name}")
    for user in recipients(event, _audience(ws, p), target=("", None)):
        deliver(
            event,
            user,
            kind="target",
            pref=CHANGED,
            target=("", None),
            payload={k: p.get(k) for k in ("action", "periodType", "periodStart", "amount", "subjectType")},
            email_template=EMAIL,
            email_context=email,
        )


def register() -> None:
    register_handler(CHANGED, on_changed, module=perms.KEY)
