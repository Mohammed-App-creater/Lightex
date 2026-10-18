"""Daily report notifications (spec §9, S5), through the platform pipeline like `notifications.py`:

- `sales.dailyreport.submitted` → the author's reviewers: leads of their teams and members whose
  `sales.dailyreport.review` scope reaches them (`notifications.won_audience`), never the author;
- `sales.dailyreport.reviewed` → the author;
- `sales.dailyreport.reminder` (the `sales_report_reminder` job) → the user named in the payload, if they still
  hold `sales.dailyreport.submit`.
"""

from __future__ import annotations

from typing import Any

from core.accounts.models import User
from core.events.models import DomainEvent
from core.events.registry import register_handler
from core.notifications.handlers import deliver, recipients

from . import module as perms
from .daily_reports import REMINDER_EVENT, REVIEWED_EVENT, SUBMITTED_EVENT
from .notifications import EMAIL, _actor, _email, _workspace, won_audience

NONE = ("", None)


def _send(event: DomainEvent, ws: Any, user_ids: Any, pref: str, kind: str, email: dict[str, Any]) -> None:
    p = event.payload
    payload = {k: p.get(k) for k in ("userId", "date", "isLate", "comment") if k in p}
    payload["reportId"] = str(event.target_id) if event.target_id else None
    for user in recipients(event, user_ids, target=NONE):
        deliver(
            event, user, kind=kind, pref=pref, target=NONE, payload=payload, email_template=EMAIL, email_context=email
        )


def on_submitted(event: DomainEvent) -> None:
    ws = _workspace(event)
    author = event.payload.get("userId")
    if ws is None or not author:
        return
    late = " (late)" if event.payload.get("isLate") else ""
    email = _email(
        ws,
        f"{_actor(event)} submitted a daily report{late}",
        f"The daily report for {event.payload.get('date')} is ready for review.",
        f"daily-reports/{event.target_id}",
        "Open report",
        f"you review sales daily reports in {ws.name}",
    )
    _send(event, ws, won_audience(ws, author), SUBMITTED_EVENT, "dailyreport", email)


def on_reviewed(event: DomainEvent) -> None:
    ws = _workspace(event)
    author = event.payload.get("userId")
    if ws is None or not author:
        return
    email = _email(
        ws,
        "Your daily report was reviewed",
        f"{_actor(event)} reviewed your report for {event.payload.get('date')}. {event.payload.get('comment') or ''}",
        f"daily-reports/{event.target_id}",
        "Open report",
        f"you submit sales daily reports in {ws.name}",
    )
    _send(event, ws, [author], REVIEWED_EVENT, "dailyreport", email)


def on_reminder(event: DomainEvent) -> None:
    from core.access import services as access

    ws = _workspace(event)
    user = User.objects.filter(pk=event.payload.get("userId"), is_active=True).first()
    if ws is None or user is None or not access.can(user, perms.DAILYREPORT_SUBMIT, ws):
        return
    email = _email(
        ws,
        "Submit your daily report",
        f"Today's report is due by {event.payload.get('cutoff')}.",
        "daily-reports/me",
        "Open my report",
        f"you submit sales daily reports in {ws.name}",
    )
    _send(event, ws, [user.pk], REMINDER_EVENT, "reminder", email)


def register() -> None:
    register_handler(SUBMITTED_EVENT, on_submitted, module=perms.KEY)
    register_handler(REVIEWED_EVENT, on_reviewed, module=perms.KEY)
    register_handler(REMINDER_EVENT, on_reminder, module=perms.KEY)
