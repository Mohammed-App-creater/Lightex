"""Sales writes for activities and follow-ups (S3, docs/sales/api.md §14–§15). Same rules as `services.py`: one audit
row per mutation inside its transaction; the views have checked the method's permission code and the record's view
scope (404); the services check the action's scope on the record (403).

Targets: an activity is logged on a lead, opportunity, company or contact, a follow-up on a lead, opportunity or
company. The target must be a live record of the workspace inside the caller's view scope for its type (else 422
`targetId`). `company` is denormalized from the target and kept in sync when the target moves to another company
(`sync_company`).

`last_activity_at` (opportunities, leads and companies) is denormalized: the latest activity `occurred_at` or
follow-up `completed_at` on the record (on a company: on the company or any of its records). Every write that can
change it calls `refresh_last_activity` for the parents involved; it is a plain column update, so it never bumps an
opportunity's `version` or `updated_at`.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.db.models import DateTimeField, OuterRef, Subquery
from django.db.models.functions import Greatest
from django.utils import timezone

from core.access import services as access
from core.audit.services import change
from core.common.exceptions import conflict, forbidden, invalid
from core.events.services import emit
from core.workspaces.timezone import workspace_today

from . import module as perms
from . import scope
from .models import Activity, Company, Contact, FollowUp, Lead, Opportunity, Quotation
from .services import _apply, _audit, _owner_change

#: Logging an activity a little in the future is tolerated (clock skew); anything later is a plan: use a follow-up.
FUTURE_SLACK = dt.timedelta(minutes=5)

_VIEW_CODES = {
    Activity.LEAD: perms.LEAD_VIEW,
    Activity.OPPORTUNITY: perms.OPPORTUNITY_VIEW,
    Activity.COMPANY: perms.COMPANY_VIEW,
    Activity.CONTACT: perms.CONTACT_VIEW,
}
_MODELS: dict[str, Any] = {
    Activity.LEAD: Lead,
    Activity.OPPORTUNITY: Opportunity,
    Activity.COMPANY: Company,
    Activity.CONTACT: Contact,
}


# ───────────────────────── targets ─────────────────────────


@dataclass
class Target:
    type: str
    obj: Any

    @property
    def company_id(self) -> Any:
        if self.type == Activity.COMPANY:
            return self.obj.pk
        return self.obj.company_id

    def fields(self) -> dict[str, Any]:
        """The child's target columns: type, id, the matching foreign key and the denormalized company."""
        out: dict[str, Any] = {"target_type": self.type, "target_id": self.obj.pk}
        for kind, field in Activity.TARGET_FIELDS.items():
            out[f"{field}_id"] = self.obj.pk if kind == self.type else None
        out["company_id"] = self.company_id
        return out

    @property
    def name(self) -> str:
        if self.type == Activity.LEAD:
            return self.obj.display_name
        return self.obj.title if self.type == Activity.OPPORTUNITY else self.obj.name


def resolve_target(actor: Any, workspace: Any, target_type: str, target_id: Any, allowed: tuple[str, ...]) -> Target:
    """A live record of the workspace the caller can see under its type's view code; else 422."""
    if target_type not in allowed:
        raise invalid({"targetType": f"Use {', '.join(allowed)}"})
    model = _MODELS[target_type]
    qs = model.objects.for_workspace(workspace).filter(pk=target_id)
    if target_type == Activity.CONTACT:
        qs = qs.filter(company__deleted_at__isnull=True)
    obj = scope.visible(qs, actor, _VIEW_CODES[target_type], workspace).first()
    if obj is None:
        raise invalid({"targetId": "Pick a record you can see"})
    return Target(target_type, obj)


def target_of(child: Activity | FollowUp) -> Target:
    return Target(child.target_type, getattr(child, Activity.TARGET_FIELDS[child.target_type]))


def _label(child: Activity | FollowUp) -> str:
    """The audit row's target label: a follow-up's title, an activity's type and record."""
    if isinstance(child, FollowUp):
        return child.title
    target = target_of(child)
    kind = child.type.title()
    return f"{kind} · {target.name}" if target.obj is not None else kind


# ───────────────────────── last activity ─────────────────────────


def _latest(model: Any, field: str, value_field: str, **extra: Any) -> Subquery:
    rows = model.objects.unscoped().filter(**{field: OuterRef("pk")}, **extra).order_by(f"-{value_field}")
    return Subquery(rows.values(value_field)[:1], output_field=DateTimeField())


def refresh_last_activity(*, leads: Any = (), opportunities: Any = (), companies: Any = ()) -> None:
    """Recomputes `last_activity_at` = max(latest activity, latest completed follow-up) on the given parents."""
    for model, field, ids in (
        (Lead, "lead", leads),
        (Opportunity, "opportunity", opportunities),
        (Company, "company", companies),
    ):
        ids = {i for i in ids if i}
        if not ids:
            continue
        model.all_objects.unscoped().filter(pk__in=ids).update(
            last_activity_at=Greatest(
                _latest(Activity, field, "occurred_at"),
                _latest(FollowUp, field, "completed_at", status=FollowUp.DONE),
            )
        )


def _refresh(*children: Activity | FollowUp | None) -> None:
    rows = [c for c in children if c is not None]
    refresh_last_activity(
        leads=[c.lead_id for c in rows],
        opportunities=[c.opportunity_id for c in rows],
        companies=[c.company_id for c in rows],
    )


def _snapshot(child: Activity | FollowUp) -> Any:
    """The parent ids before a change (to refresh the old parents too)."""
    return type(child)(lead_id=child.lead_id, opportunity_id=child.opportunity_id, company_id=child.company_id)


def sync_company(field: str, obj: Any, before_company_id: Any) -> None:
    """The target (`field` = lead, opportunity or contact) moved to another company: its activities and follow-ups
    follow, and both companies' `last_activity_at` are recomputed."""
    after = getattr(obj, "company_id", None)
    if str(after or "") == str(before_company_id or ""):
        return
    for model in (Activity, FollowUp):
        model.objects.for_workspace(obj.workspace_id).filter(**{field: obj}).update(company_id=after)
    refresh_last_activity(companies=[before_company_id, after])


# ───────────────────────── activities ─────────────────────────

ACTIVITY_LABELS = {
    "type": "Type",
    "occurred_at": "When",
    "duration_minutes": "Duration",
    "summary": "Summary",
    "outcome": "Outcome",
}


def _occurred_at(raw: Any, now: dt.datetime) -> dt.datetime:
    if raw is None:
        return now
    if raw > now + FUTURE_SLACK:
        raise invalid({"occurredAt": "An activity can’t be in the future. Plan it as a follow-up."})
    return raw


def _require(actor: Any, workspace: Any, code: str) -> None:
    if not access.can(actor, code, _workspace(workspace)):
        raise forbidden(details={"permission": code})


def _new_activity(actor: Any, workspace: Any, target: Target, data: dict[str, Any], **extra: Any) -> Activity:
    now = timezone.now()
    a = Activity(
        workspace_id=getattr(workspace, "pk", workspace),
        owner=actor,
        type=data.get("type", Activity.CALL),
        occurred_at=_occurred_at(data.get("occurred_at"), now),
        duration_minutes=data.get("duration_minutes"),
        summary=data.get("summary", ""),
        outcome=data.get("outcome", ""),
        **target.fields(),
        **extra,
    )
    a.save()
    _audit(
        actor,
        workspace,
        "sales.activity.created",
        a,
        f"{a.type.title()} · {target.name}",
        data={"type": a.type, "targetType": a.target_type, "targetId": str(a.target_id)},
    )
    return a


@transaction.atomic
def log_activity(actor: Any, workspace: Any, data: dict[str, Any]) -> tuple[Activity, FollowUp | None]:
    """Logs an activity; an optional `follow_up` creates the next step on the same record (a contact's company) in
    the same transaction, which needs `sales.followup.create` too."""
    target = resolve_target(actor, workspace, data["target_type"], data["target_id"], Activity.TARGET_TYPES)
    follow = data.get("follow_up")
    if follow:
        _require(actor, workspace, perms.FOLLOWUP_CREATE)
    a = _new_activity(actor, workspace, target, data)
    nxt = None
    if follow:
        fu_target = target
        if target.type == Activity.CONTACT:
            fu_target = Target(Activity.COMPANY, target.obj.company)
        nxt = _new_followup(actor, workspace, fu_target, follow)
    _refresh(a)
    return a, nxt


def log_quotation_sent(q: Quotation, actor: Any) -> Activity:
    """Spec §5: sending a quotation logs a `quotation` activity on its opportunity (owned by whoever sent it)."""
    opp = q.opportunity
    a = _new_activity(
        actor,
        q.workspace_id,
        Target(Activity.OPPORTUNITY, opp),
        {"type": Activity.QUOTATION, "occurred_at": q.sent_at, "summary": f"{q.number} {q.title}"[:1000]},
        quotation=q,
    )
    _refresh(a)
    return a


def _lock(model: Any, obj: Any) -> Any:
    return model.objects.for_workspace(obj.workspace_id).select_for_update().get(pk=obj.pk)


@transaction.atomic
def update_activity(actor: Any, a: Activity, data: dict[str, Any]) -> Activity:
    scope.require_in_scope(actor, a, perms.ACTIVITY_EDIT)
    a = _lock(Activity, a)
    if a.type == Activity.QUOTATION and data.get("type", a.type) != a.type:
        raise invalid({"type": "A quotation entry keeps its type"})
    if "occurred_at" in data:
        data = {**data, "occurred_at": _occurred_at(data["occurred_at"], timezone.now())}
    before = _snapshot(a)
    changes = _apply(a, data, ACTIVITY_LABELS)
    if "target_type" in data:
        target = resolve_target(actor, a.workspace_id, data["target_type"], data["target_id"], Activity.TARGET_TYPES)
        if (target.type, str(target.obj.pk)) != (a.target_type, str(a.target_id)):
            old = target_of(a)
            changes.append(change("Record", old.name if old.obj is not None else None, target.name))
            for key, value in target.fields().items():
                setattr(a, key, value)
    if changes:
        a.save()
        _audit(actor, a.workspace_id, "sales.activity.updated", a, _label(a), changes=changes)
        _refresh(before, a)
    return a


@transaction.atomic
def delete_activity(actor: Any, a: Activity) -> None:
    scope.require_in_scope(actor, a, perms.ACTIVITY_DELETE)
    label = _label(a)
    before = _snapshot(a)
    _audit(actor, a.workspace_id, "sales.activity.deleted", a, label)
    a.delete()
    _refresh(before)


# ───────────────────────── follow-ups ─────────────────────────

FOLLOWUP_LABELS = {"title": "Title", "notes": "Notes", "due_date": "Due"}


def _not_past(workspace: Any, day: dt.date, field: str = "dueDate") -> None:
    if day < workspace_today(_workspace(workspace)):
        raise invalid({field: "Pick today or a later date"})


def _workspace(ws: Any) -> Any:
    from core.workspaces.models import Workspace

    return ws if hasattr(ws, "timezone") else Workspace.objects.get(pk=ws)


def _transition(f: FollowUp, action: str) -> None:
    if f.status != FollowUp.PENDING:
        raise conflict(
            "invalid_transition",
            f"This follow-up is {f.status}; it can’t be {action}.",
            {"status": f.status, "action": action},
        )


def _new_followup(actor: Any, workspace: Any, target: Target, data: dict[str, Any], owner: Any = None) -> FollowUp:
    _not_past(workspace, data["due_date"])
    f = FollowUp(
        workspace_id=getattr(workspace, "pk", workspace),
        owner=owner or actor,
        created_by=actor,
        title=data.get("title") or "Follow up",
        notes=data.get("notes", ""),
        due_date=data["due_date"],
        **target.fields(),
    )
    if owner is None:
        _owner_change(actor, workspace, perms.FOLLOWUP_REASSIGN, f, data)
    f.save()
    _audit(
        actor,
        workspace,
        "sales.followup.created",
        f,
        f.title,
        data={
            "ownerId": str(f.owner_id),
            "dueDate": f.due_date.isoformat(),
            "targetType": f.target_type,
            "targetId": str(f.target_id),
        },
    )
    return f


@transaction.atomic
def create_followup(actor: Any, workspace: Any, data: dict[str, Any]) -> FollowUp:
    target = resolve_target(actor, workspace, data["target_type"], data["target_id"], FollowUp.TARGET_TYPES)
    return _new_followup(actor, workspace, target, data)


@transaction.atomic
def update_followup(actor: Any, f: FollowUp, data: dict[str, Any]) -> FollowUp:
    """Title, notes and due date of a pending follow-up; `status: cancelled` cancels it."""
    scope.require_in_scope(actor, f, perms.FOLLOWUP_EDIT)
    f = _lock(FollowUp, f)
    cancel = data.get("status") == FollowUp.CANCELLED
    _transition(f, "cancelled" if cancel else "edited")
    if "due_date" in data and data["due_date"] != f.due_date:
        _not_past(f.workspace_id, data["due_date"])
    changes = _apply(f, data, FOLLOWUP_LABELS)
    if cancel:
        changes.append(change("Status", f.status, FollowUp.CANCELLED, kind="status"))
        f.status, f.cancelled_at = FollowUp.CANCELLED, timezone.now()
    if changes:
        f.save()
        action = "sales.followup.cancelled" if cancel else "sales.followup.updated"
        _audit(actor, f.workspace_id, action, f, f.title, changes=changes)
    return f


@transaction.atomic
def reschedule_followup(actor: Any, f: FollowUp, due_date: dt.date) -> FollowUp:
    scope.require_in_scope(actor, f, perms.FOLLOWUP_EDIT)
    f = _lock(FollowUp, f)
    _transition(f, "rescheduled")
    if due_date == f.due_date:
        return f
    _not_past(f.workspace_id, due_date)
    changes = [change("Due", f.due_date, due_date)]
    f.due_date = due_date
    f.save()
    _audit(actor, f.workspace_id, "sales.followup.rescheduled", f, f.title, changes=changes)
    return f


@transaction.atomic
def reassign_followup(actor: Any, f: FollowUp, owner_id: Any) -> FollowUp:
    """Needs `sales.followup.reassign` reaching the follow-up and §3's owner rule; audited."""
    scope.require_in_scope(actor, f, perms.FOLLOWUP_REASSIGN)
    f = _lock(FollowUp, f)
    _transition(f, "reassigned")
    owner = _owner_change(actor, f.workspace_id, perms.FOLLOWUP_REASSIGN, f, {"owner_id": owner_id})
    if owner is not None:
        f.save()
        _audit(actor, f.workspace_id, "sales.followup.reassigned", f, f.title, changes=[owner])
    return f


@transaction.atomic
def complete_followup(actor: Any, f: FollowUp, data: dict[str, Any]) -> dict[str, Any]:
    """pending → done. `activity` logs what happened (needs `sales.activity.create`) and `create_next` plans the next
    follow-up for the same owner on the same record (needs `sales.followup.create`), in the same transaction.
    Updates `last_activity_at`; emits `sales.followup.completed`."""
    scope.require_in_scope(actor, f, perms.FOLLOWUP_COMPLETE)
    f = _lock(FollowUp, f)
    _transition(f, "completed")
    ws = f.workspace_id
    if data.get("activity"):
        _require(actor, ws, perms.ACTIVITY_CREATE)
    if data.get("create_next"):
        _require(actor, ws, perms.FOLLOWUP_CREATE)
    target = target_of(f)
    activity = _new_activity(actor, ws, target, data["activity"]) if data.get("activity") else None
    nxt = None
    if data.get("create_next"):
        spec = data["create_next"]
        nxt = _new_followup(
            actor, ws, target, {"title": spec.get("title") or f.title, "due_date": spec["due_date"]}, owner=f.owner
        )
    f.status, f.completed_at, f.completed_activity = FollowUp.DONE, timezone.now(), activity
    f.save()
    payload = {
        "followUpId": str(f.pk),
        "ownerId": str(f.owner_id) if f.owner_id else None,
        "targetType": f.target_type,
        "targetId": str(f.target_id),
        "activityId": str(activity.pk) if activity else None,
        "nextFollowUpId": str(nxt.pk) if nxt else None,
    }
    _audit(
        actor,
        ws,
        "sales.followup.completed",
        f,
        f.title,
        changes=[change("Status", FollowUp.PENDING, FollowUp.DONE, kind="status")],
        data=payload,
    )
    emit(
        "sales.followup.completed",
        workspace=ws,
        target_type=f.target_type,
        target_id=f.target_id,
        actor=actor,
        payload=payload,
    )
    _refresh(f)
    return {"followUp": f, "activity": activity, "next": nxt}


@transaction.atomic
def delete_followup(actor: Any, f: FollowUp) -> None:
    scope.require_in_scope(actor, f, perms.FOLLOWUP_DELETE)
    before = _snapshot(f)
    done = f.status == FollowUp.DONE
    _audit(actor, f.workspace_id, "sales.followup.deleted", f, f.title)
    f.delete()
    if done:
        _refresh(before)


# ───────────────────────── the morning digest ─────────────────────────

DIGEST_JOB = "sales_followup_digest"


def followup_digest(workspace: Any, *, now: dt.datetime) -> int:
    """The `sales_followup_digest` job (07:30 workspace time): one `sales.followup.digest` event per owner of pending
    follow-ups due today or overdue, with both counts. Idempotent per (workspace, user, date): a second run the same
    day sends nothing (`core.jobs.services.claim`)."""
    from django.db.models import Count, Q

    from core.jobs.services import claim

    from .activity_selectors import live_targets

    today = now.date()
    rows = (
        FollowUp.objects.for_workspace(workspace)
        .filter(live_targets(), status=FollowUp.PENDING, due_date__lte=today, owner__isnull=False)
        .values("owner_id")
        .annotate(due=Count("id", filter=Q(due_date=today)), overdue=Count("id", filter=Q(due_date__lt=today)))
        .order_by("owner_id")
    )
    sent = 0
    for row in rows:
        if not claim(workspace, DIGEST_JOB, f"{today.isoformat()}:{row['owner_id']}"):
            continue
        emit(
            "sales.followup.digest",
            workspace=workspace,
            payload={
                "userId": str(row["owner_id"]),
                "date": today.isoformat(),
                "dueToday": row["due"],
                "overdue": row["overdue"],
            },
        )
        sent += 1
    return sent
