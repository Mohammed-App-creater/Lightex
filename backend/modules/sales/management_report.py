"""The management daily report (S6, docs/sales/spec.md §8, api.md §23): generated, not typed. For a business date and
a viewer's `sales.report.view` scope: the day's target, actual, achievement and counts (from `kpi.py`), daily report
submissions (S5's `team_report`), the month's top performer and at-risk people (status colors), the largest open
opportunities and the attention list (overdue follow-ups, quotations awaiting response, large deals closing this
week, people who have not submitted their daily report).

The `sales_management_daily_report` job (20:00 workspace time, working days only) sends it as the
`sales.report.management` notification (in-app and email) to every active member whose `sales.report.view` scope is
`team` or `all`, each limited to their own scope; one per recipient and date (`claim`).
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from core.access.catalogue import ALL, TEAM

from . import dashboard, kpi, people
from . import module as perms
from .models import DailyReport
from .periods import DAY, MONTH
from .scope import scope_of
from .targets import TargetBook
from .workdays import WorkCalendar

JOB = "sales_management_daily_report"
EVENT = "sales.report.management"
LIMIT = 5


def _j(value: Any) -> Any:
    """JSON-safe: Decimals as strings, dates ISO."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _j(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_j(v) for v in value]
    return value


def build(user: Any, workspace: Any, day: dt.date, *, book: TargetBook | None = None) -> dict[str, Any]:
    from .daily_reports import team_report

    book = book or TargetBook(workspace)
    settings = book.settings
    ids = people.visible_user_ids(user, workspace, perms.REPORT_VIEW)
    k = kpi.compute(workspace, book.period(DAY, day), ids, today=day, book=book, with_previous=False)

    team = team_report(user, workspace, day)
    rows = [r for r in team["users"] if r["user"]["id"] in ids]
    not_submitted = (
        [
            {"id": r["user"]["id"], "name": r["user"]["name"], "status": r["status"]}
            for r in rows
            if r["status"] not in (DailyReport.SUBMITTED, DailyReport.REVIEWED)
        ]
        if team["required"]
        else []
    )

    month = book.period(MONTH, day)
    ranking = dashboard.ranking_rows(workspace, month, ids, day)
    top = next((r for r in ranking if r["actual"] > 0), None)
    at_risk = [
        {"user": r["user"], "actual": r["actual"], "target": r["target"]} for r in ranking if r["status"] == kpi.RED
    ]

    week = book.period("week", day)
    major = dashboard.open_opportunities(workspace, ids).order_by("-expected_value", "id")[:LIMIT]
    attention = {
        "overdueFollowUps": dashboard._capped(
            dashboard.overdue_followups(workspace, ids, day), dashboard._followup_item, LIMIT
        ),
        "quotationsAwaitingResponse": dashboard._capped(
            dashboard.awaiting_quotations(workspace, ids), dashboard._quotation_item, LIMIT
        ),
        "largeClosingThisWeek": dashboard._capped(
            dashboard.large_closing(workspace, ids, day, settings), dashboard._opp_item, LIMIT
        ),
        "notSubmitted": not_submitted,
    }
    return _j(
        {
            "date": day,
            "scope": scope_of(user, workspace, perms.REPORT_VIEW),
            "people": len(ids),
            "summary": {
                "target": k.target,
                "actual": k.actual,
                "achievement": k.achievement,
                "newLeads": k.new_leads,
                "newOpportunities": k.new_opportunities,
                "quotationsSent": sum(int(r["metrics"].get("quotationsSent") or 0) for r in rows),
                "won": k.won_count,
                "lost": k.lost_count,
                "reportsSubmitted": sum(r["status"] in (DailyReport.SUBMITTED, DailyReport.REVIEWED) for r in rows),
                "reportsExpected": len(rows) if team["required"] else 0,
            },
            "month": {"start": month.start, "end": month.end},
            "topPerformer": None if top is None else {"user": top["user"], "actual": top["actual"]},
            "atRisk": at_risk,
            "majorOpportunities": [
                {
                    **dashboard._opp_item(o),
                    "closingThisWeek": bool(o.expected_close_date and week.contains(o.expected_close_date)),
                }
                for o in major
            ],
            "attention": attention,
        }
    )


def recipients(workspace: Any) -> list[Any]:
    """Active members whose `sales.report.view` scope is `team` or `all`."""
    from core.workspaces.models import WorkspaceMember

    rows = WorkspaceMember.objects.for_workspace(workspace).filter(status="active", user__is_active=True)
    return [
        m.user for m in rows.select_related("user") if scope_of(m.user, workspace, perms.REPORT_VIEW) in (TEAM, ALL)
    ]


def send(workspace: Any, *, now: dt.datetime) -> int:
    """The job: one `sales.report.management` event per recipient and date, carrying their report."""
    from core.events.services import emit
    from core.jobs.services import claim

    day = now.date()
    if WorkCalendar(workspace).weight(day) <= 0:
        return 0
    book = TargetBook(workspace)
    sent = 0
    for user in recipients(workspace):
        if not claim(workspace, JOB, f"{day.isoformat()}:{user.pk}"):
            continue
        emit(
            EVENT,
            workspace=workspace,
            payload={"userId": str(user.pk), "report": build(user, workspace, day, book=book)},
        )
        sent += 1
    return sent


# ───────────────────────── notification ─────────────────────────


def _body(r: dict[str, Any]) -> str:
    s = r["summary"]
    target = f" of ETB {s['target']} ({s['achievement']}%)" if s["target"] is not None else ""
    lines = [
        f"Sales ETB {s['actual']}{target}; {s['won']} won, {s['lost']} lost.",
        f"{s['newLeads']} new leads, {s['newOpportunities']} new opportunities, {s['quotationsSent']} quotations sent.",
    ]
    if r["topPerformer"]:
        lines.append(f"Top performer this month: {r['topPerformer']['user']['name']}.")
    if r["atRisk"]:
        lines.append("At risk: " + ", ".join(a["user"]["name"] for a in r["atRisk"]) + ".")
    a = r["attention"]
    lines.append(
        f"Attention: {a['overdueFollowUps']['count']} overdue follow-ups, "
        f"{a['quotationsAwaitingResponse']['count']} quotations awaiting response, "
        f"{a['largeClosingThisWeek']['count']} large deals closing this week, "
        f"{len(a['notSubmitted'])} daily reports not submitted."
    )
    return " ".join(lines)


def on_management(event: Any) -> None:
    from core.accounts.models import User
    from core.notifications.handlers import deliver

    from .notifications import EMAIL, _email, _workspace

    p = event.payload
    ws = _workspace(event)
    user = User.objects.filter(pk=p.get("userId"), is_active=True).first()
    report = p.get("report") or {}
    if ws is None or user is None or scope_of(user, ws, perms.REPORT_VIEW) not in (TEAM, ALL) or not report:
        return
    email = _email(
        ws,
        f"Sales report for {report['date']}",
        _body(report),
        "reports",
        "Open reports",
        f"you can see sales reports in {ws.name}",
    )
    deliver(
        event,
        user,
        kind="report",
        pref=EVENT,
        target=("", None),
        payload={"date": report["date"], "summary": report["summary"]},
        email_template=EMAIL,
        email_context=email,
    )


def register() -> None:
    from core.events.registry import register_handler

    register_handler(EVENT, on_management, module=perms.KEY)
