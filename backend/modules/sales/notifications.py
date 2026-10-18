"""Sales notifications (spec §9, S3): handlers that turn sales events into in-app notifications and emails through
the platform pipeline (`core.notifications.handlers.deliver`), honouring each recipient's preferences. The outbox
skips these handlers where sales is off, and `deliver` checks the module again at send time.

Preferences (event types), who sends them and to whom:

- `sales.followup.due_today` / `sales.followup.overdue`: the `sales_followup_digest` job (07:30), to owners of
  follow-ups due today / overdue.
- `sales.opportunity.reassigned`: reassignment, bulk assign, creating or converting a lead for someone else; to the
  new owner (not when they did it themselves).
- `sales.opportunity.won`: to the team leads of the credited user's teams and to reviewers whose
  `sales.dailyreport.review` scope reaches the credited user.
- `sales.quotation.expiring`: the nightly `sales_expire_quotations` job, to the quotation's owner.

The digest is one notification per user and day: it is delivered under `due_today` when something is due today
and that preference has a channel on, else under `overdue`.
"""

from __future__ import annotations

from typing import Any

from django.conf import settings

from core.accounts.models import User
from core.events.models import DomainEvent
from core.events.registry import register_handler
from core.notifications.emails import base_context
from core.notifications.handlers import deliver, recipients

from . import module as perms

MODULE = perms.KEY
EMAIL = "sales_notice"

DUE_TODAY = "sales.followup.due_today"
OVERDUE = "sales.followup.overdue"
DIGEST = "sales.followup.digest"
ASSIGNED = "sales.opportunity.reassigned"
WON = "sales.opportunity.won"
EXPIRING = "sales.quotation.expiring"


def _workspace(event: DomainEvent) -> Any:
    from core.workspaces.models import Workspace

    return Workspace.objects.filter(pk=event.workspace_id).first()


def _email(ws: Any, headline: str, body: str, path: str, cta: str, reason: str) -> dict[str, Any]:
    return {
        **base_context(ws.slug),
        "headline": headline,
        "body": body,
        "cta_label": cta,
        "cta_url": f"{settings.FRONTEND_URL}/{ws.slug}/sales/{path}",
        "reason": reason,
        "workspace_name": ws.name,
    }


def _actor(event: DomainEvent) -> str:
    return event.actor.name if event.actor is not None else "Someone"


# ───────────────────────── follow-up digest ─────────────────────────


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def on_digest(event: DomainEvent) -> None:
    """One notification for the user named in the payload, if they still work in sales here."""
    from core.access import services as access

    p = event.payload
    ws = _workspace(event)
    user = User.objects.filter(pk=p.get("userId"), is_active=True).first()
    if ws is None or user is None or not access.can(user, perms.FOLLOWUP_VIEW, ws):
        return
    due, overdue = int(p.get("dueToday") or 0), int(p.get("overdue") or 0)
    parts = [f"{_plural(due, 'follow-up')} due today"] if due else []
    if overdue:
        parts.append(f"{_plural(overdue, 'follow-up')} overdue")
    headline = " and ".join(parts) or "Your follow-ups"
    email = _email(
        ws,
        headline[:1].upper() + headline[1:],
        "Here is what is waiting for you in Sales today.",
        "follow-ups",
        "Open follow-ups",
        f"you own follow-ups in {ws.name}",
    )
    payload = {"date": p.get("date"), "dueToday": due, "overdue": overdue}
    for pref in [DUE_TODAY] * bool(due) + [OVERDUE] * bool(overdue):
        sent = deliver(
            event,
            user,
            kind="followup",
            pref=pref,
            target=("", None),
            payload=payload,
            email_template=EMAIL,
            email_context=email,
        )
        if sent is not None:
            return


# ───────────────────────── opportunities ─────────────────────────


def _opportunity(event: DomainEvent) -> Any:
    from .models import Opportunity

    oid = event.payload.get("opportunityId") or event.target_id
    return Opportunity.objects.unscoped().select_related("company").filter(pk=oid, deleted_at__isnull=True).first()


def _assigned(event: DomainEvent, owner_id: Any) -> None:
    opp = _opportunity(event)
    ws = _workspace(event)
    if opp is None or ws is None or not owner_id:
        return
    target = ("sales.opportunity", opp.pk)
    email = _email(
        ws,
        f"{opp.title} is yours",
        f"{_actor(event)} assigned you the opportunity {opp.title} ({opp.company.name}).",
        f"opportunities/{opp.pk}",
        "Open opportunity",
        f"an opportunity was assigned to you in {ws.name}",
    )
    for user in recipients(event, [owner_id], target=target):
        deliver(
            event,
            user,
            kind="assigned",
            pref=ASSIGNED,
            target=target,
            payload={"companyName": opp.company.name},
            email_template=EMAIL,
            email_context=email,
        )


def on_reassigned(event: DomainEvent) -> None:
    _assigned(event, event.payload.get("toOwnerId"))


def on_created(event: DomainEvent) -> None:
    """An opportunity created (or converted from a lead) for someone else counts as assigning it to them."""
    owner_id = event.payload.get("ownerId")
    if owner_id and str(owner_id) != str(event.actor_id):
        _assigned(event, owner_id)


def won_audience(workspace: Any, user_id: Any) -> set[str]:
    """Who hears about a deal won by `user_id`: the leads of the live teams they belong to, plus every active member
    whose `sales.dailyreport.review` scope reaches them (`all`; `team` sharing a team with them)."""
    from core.access.catalogue import ALL, TEAM
    from core.teams.models import TeamMember
    from core.workspaces.models import WorkspaceMember

    from .scope import scope_of, teammates

    members = TeamMember.objects.for_workspace(workspace)
    teams = members.filter(user_id=user_id, team__deleted_at__isnull=True).values("team_id")
    out = {str(u) for u in members.filter(team_id__in=teams, is_lead=True).values_list("user_id", flat=True)}
    owner = User.objects.filter(pk=user_id).first()
    mates = teammates(owner, workspace) if owner is not None else set()
    rows = WorkspaceMember.objects.for_workspace(workspace).filter(status="active", user__is_active=True)
    for member in rows.select_related("user"):
        level = scope_of(member.user, workspace, perms.DAILYREPORT_REVIEW)
        if level == ALL or (level == TEAM and str(member.user_id) in mates):
            out.add(str(member.user_id))
    out.discard(str(user_id))
    return out


def on_won(event: DomainEvent) -> None:
    opp = _opportunity(event)
    ws = _workspace(event)
    credited = event.payload.get("creditedUserId")
    if opp is None or ws is None or not credited:
        return
    winner = User.objects.filter(pk=credited).first()
    value = event.payload.get("wonValue") or ""
    target = ("sales.opportunity", opp.pk)
    email = _email(
        ws,
        f"{opp.title} won",
        f"{winner.name if winner else 'Your team'} won {opp.title} ({opp.company.name}) for ETB {value}.",
        f"opportunities/{opp.pk}",
        "Open opportunity",
        f"you lead or review a sales team in {ws.name}",
    )
    for user in recipients(event, won_audience(ws, credited), target=target):
        deliver(
            event,
            user,
            kind="won",
            pref=WON,
            target=target,
            payload={"wonValue": value, "creditedUserId": str(credited), "companyName": opp.company.name},
            email_template=EMAIL,
            email_context=email,
        )


# ───────────────────────── quotations ─────────────────────────


def on_expiring(event: DomainEvent) -> None:
    from .models import Quotation

    q = (
        Quotation.objects.unscoped()
        .select_related("opportunity")
        .filter(pk=event.target_id, deleted_at__isnull=True, status=Quotation.SENT)
        .first()
    )
    ws = _workspace(event)
    if q is None or ws is None or not q.owner_id:
        return
    until = q.valid_until.isoformat() if q.valid_until else ""
    target = ("sales.quotation", q.pk)
    email = _email(
        ws,
        f"Quotation {q.number} expires {until}",
        f"{q.title} on {q.opportunity.title} is still waiting for the customer's answer.",
        f"quotations/{q.pk}",
        "Open quotation",
        f"you own a sent quotation in {ws.name}",
    )
    for user in recipients(event, [q.owner_id], target=target):
        deliver(
            event,
            user,
            kind="expiring",
            pref=EXPIRING,
            target=target,
            payload={"validUntil": until, "number": q.number},
            email_template=EMAIL,
            email_context=email,
        )


def register() -> None:
    """Handlers only: the event types (labels, default channels, the email template) are in `module.py`."""
    register_handler(DIGEST, on_digest, module=MODULE)
    register_handler("sales.opportunity.reassigned", on_reassigned, module=MODULE)
    register_handler("sales.opportunity.created", on_created, module=MODULE)
    register_handler(WON, on_won, module=MODULE)
    register_handler(EXPIRING, on_expiring, module=MODULE)
