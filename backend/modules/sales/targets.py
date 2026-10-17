"""Targets (docs/sales/spec.md §4–§5, api.md §14): stored year / quarter / month targets, the effective (derived)
target of any period, allocation and the writes.

Effective targets (`TargetBook`):
- month: the stored month target, else the stored quarter's (else the stored year's) amount pro-rata by working-day
  weight;
- quarter: the stored quarter, else the sum of its months; year: the stored year, else the sum of its quarters;
- any other range (day, week, custom; weeks may span months): for each overlapping month, the month target x the
  range's weight in that month / the month's weight. Zero on non-working days and holidays.
None means "no target" (achievement is then null), never zero.

Subjects are `(subject_type, id)` with id "" for the company.
"""

from __future__ import annotations

import datetime as dt
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from django.db import transaction
from django.db.models import Q

from core.audit.services import change
from core.common.exceptions import forbidden, invalid
from core.events.services import emit

from . import module as perms
from . import people
from .defaults import ensure_defaults
from .models import Target
from .periods import MONTH, QUARTER, YEAR, Period, period_containing
from .services import _audit
from .workdays import ZERO, WorkCalendar

CENT = Decimal("0.01")
EVENT = "sales.target.changed"
METHODS = ("equal", "working_days", "manual")

Subject = tuple[str, str]


def money(v: Decimal | None) -> Decimal | None:
    return None if v is None else v.quantize(CENT, ROUND_HALF_UP)


def subject(subject_type: str, subject_id: Any) -> Subject:
    return (subject_type, "" if subject_type == Target.COMPANY or subject_id is None else str(subject_id))


def _period(kind: str, day: dt.date, settings: Any) -> Period:
    return period_containing(
        kind, day, week_start=settings.week_start, fiscal_start_month=settings.fiscal_year_start_month
    )


def fiscal_year(settings: Any, year: int) -> Period:
    """Fiscal year `year` = the one starting in calendar year `year` (a July start: 2026 = 2026-07-01..2027-06-30)."""
    return _period(YEAR, dt.date(year, settings.fiscal_year_start_month, 1), settings)


def fiscal_year_of(day: dt.date, settings: Any) -> int:
    """The fiscal year number (`fiscal_year`) containing `day`."""
    return _period(YEAR, day, settings).start.year


def children(period: Period, kind: str) -> list[Period]:
    """The quarters or months of a year (or the months of a quarter), in order."""
    out, day = [], period.start
    while day <= period.end:
        p = period_containing(kind, day, week_start=period.week_start, fiscal_start_month=period.fiscal_start_month)
        out.append(p)
        day = p.end + dt.timedelta(days=1)
    return out


def aligned(period_type: str, start: dt.date, settings: Any) -> Period:
    """The period a target row covers; 422 when `start` isn't the first day of a (fiscal) year, quarter or month."""
    p = _period(period_type, start, settings)
    if p.start != start:
        raise invalid({"periodStart": f"A {period_type} target starts on {p.start.isoformat()}"})
    return p


# ───────────────────────── effective targets ─────────────────────────


class TargetBook:
    """Reads stored targets lazily (one query per subject batch and fiscal year) and derives effective targets."""

    def __init__(self, workspace: Any, settings: Any = None, calendar: WorkCalendar | None = None) -> None:
        self.workspace = getattr(workspace, "pk", workspace)
        self.settings = settings or ensure_defaults(self.workspace)
        self.cal = calendar or WorkCalendar(self.workspace)
        self._rows: dict[tuple[Subject, str, dt.date], Decimal] = {}
        self._loaded: set[tuple[Subject, dt.date]] = set()

    def period(self, kind: str, day: dt.date) -> Period:
        return _period(kind, day, self.settings)

    def load(self, subjects: list[Subject], start: dt.date, end: dt.date) -> None:
        """Prefetches every stored target of `subjects` in the fiscal years covering [start, end]."""
        years = children(Period(YEAR, self.period(YEAR, start).start, self.period(YEAR, end).end), YEAR)
        todo = [s for s in subjects if any((s, y.start) not in self._loaded for y in years)]
        if not todo:
            return
        cond = Q()
        for kind in Target.SUBJECTS:
            ids = [sid for t, sid in todo if t == kind]
            if ids:
                cond |= Q(subject_type=kind) if kind == Target.COMPANY else Q(subject_type=kind, subject_id__in=ids)
        qs = Target.objects.for_workspace(self.workspace).filter(
            cond, period_start__gte=years[0].start, period_start__lte=years[-1].end
        )
        for row in qs.values_list("subject_type", "subject_id", "period_type", "period_start", "amount"):
            self._rows[(subject(row[0], row[1]), row[2], row[3])] = row[4]
        self._loaded.update((s, y.start) for s in todo for y in years)

    def stored(self, subj: Subject, period_type: str, start: dt.date) -> Decimal | None:
        if (subj, self.period(YEAR, start).start) not in self._loaded:
            self.load([subj], start, start)
        return self._rows.get((subj, period_type, start))

    def _share(self, amount: Decimal, part: tuple[dt.date, dt.date], whole: Period) -> Decimal:
        total = self.cal.total(whole.start, whole.end)
        return amount * self.cal.total(*part) / total if total else ZERO

    def month(self, subj: Subject, month: Period) -> Decimal | None:
        found = self.stored(subj, MONTH, month.start)
        if found is not None:
            return found
        for kind in (QUARTER, YEAR):
            parent = self.period(kind, month.start)
            amount = self.stored(subj, kind, parent.start)
            if amount is not None:
                return self._share(amount, (month.start, month.end), parent)
        return None

    def quarter(self, subj: Subject, quarter: Period) -> Decimal | None:
        found = self.stored(subj, QUARTER, quarter.start)
        return found if found is not None else _sum(self.month(subj, m) for m in children(quarter, MONTH))

    def year(self, subj: Subject, year: Period) -> Decimal | None:
        found = self.stored(subj, YEAR, year.start)
        return found if found is not None else _sum(self.quarter(subj, q) for q in children(year, QUARTER))

    def range(self, subj: Subject, start: dt.date, end: dt.date) -> Decimal | None:
        total: Decimal | None = None
        month = self.period(MONTH, start)
        while month.start <= end:
            amount = self.month(subj, month)
            if amount is not None:
                part = (max(start, month.start), min(end, month.end))
                total = (total or ZERO) + self._share(amount, part, month)
            month = self.period(MONTH, month.end + dt.timedelta(days=1))
        return total

    def for_period(self, subj: Subject, period: Period) -> Decimal | None:
        if period.kind == MONTH:
            return self.month(subj, period)
        if period.kind == QUARTER and period.fiscal_start_month == self.settings.fiscal_year_start_month:
            return self.quarter(subj, period)
        if period.kind == YEAR and period.fiscal_start_month == self.settings.fiscal_year_start_month:
            return self.year(subj, period)
        return self.range(subj, period.start, period.end)

    def users(self, user_ids: Any, period: Period) -> Decimal | None:
        """The sum of the users' own targets (None when none of them has one)."""
        subjects = [subject(Target.USER, u) for u in user_ids]
        self.load(subjects, period.start, period.end)
        return _sum(self.for_period(s, period) for s in subjects)


def _sum(values: Any) -> Decimal | None:
    found = [v for v in values if v is not None]
    return sum(found, ZERO) if found else None


# ───────────────────────── scope ─────────────────────────


def can_reach(user: Any, workspace: Any, code: str, subj: Subject) -> bool:
    kind, sid = subj
    if kind == Target.COMPANY:
        return people.sees_company(user, workspace, code)
    if kind == Target.TEAM:
        return sid in people.visible_team_ids(user, workspace, code)
    return sid in people.visible_user_ids(user, workspace, code)


def visible_targets(user: Any, workspace: Any) -> Any:
    code = perms.TARGET_VIEW
    cond = Q(subject_type=Target.USER, subject_id__in=list(people.visible_user_ids(user, workspace, code)))
    cond |= Q(subject_type=Target.TEAM, subject_id__in=list(people.visible_team_ids(user, workspace, code)))
    if people.sees_company(user, workspace, code):
        cond |= Q(subject_type=Target.COMPANY)
    return Target.objects.for_workspace(workspace).filter(cond)


def subject_name(workspace: Any, subj: Subject) -> str:
    from core.accounts.models import User
    from core.teams.models import Team

    kind, sid = subj
    if kind == Target.COMPANY:
        return "Company"
    model: Any = Team if kind == Target.TEAM else User
    found = model.objects.filter(pk=sid).values_list("name", flat=True).first()
    return found or ""


def check_subject(workspace: Any, subj: Subject) -> None:
    """422 when the subject isn't a live team or an active member of the workspace."""
    from core.teams.models import Team

    kind, sid = subj
    if kind == Target.COMPANY:
        return
    if not sid:
        raise invalid({"subjectId": "Pick a user or a team"})
    if kind == Target.TEAM:
        ok = Team.objects.for_workspace(workspace).filter(pk=sid).exists()
    else:
        ok = sid in people._members(workspace)
    if not ok:
        raise invalid({"subjectId": f"Pick a {kind} of this workspace"})


def require_manage(user: Any, workspace: Any, subj: Subject) -> None:
    """`sales.target.manage`: own → yourself; team → your team-mates and your teams; all → anyone and the company."""
    check_subject(workspace, subj)
    if not can_reach(user, workspace, perms.TARGET_MANAGE, subj):
        raise forbidden(details={"permission": perms.TARGET_MANAGE})


# ───────────────────────── writes ─────────────────────────


def _label(workspace: Any, subj: Subject, period_type: str, start: dt.date) -> str:
    return f"{subject_name(workspace, subj)} {period_type} {start.isoformat()}"


def _event(actor: Any, workspace: Any, subj: Subject, payload: dict[str, Any], target: Any = None) -> None:
    emit(
        EVENT,
        workspace=workspace,
        target_type="sales.target",
        target_id=getattr(target, "pk", None),
        actor=actor,
        payload={"subjectType": subj[0], "subjectId": subj[1] or None, **payload},
    )


def _put(
    actor: Any, workspace: Any, subj: Subject, period_type: str, start: dt.date, amount: Decimal, note: str | None
) -> tuple[Target, bool, Decimal | None]:
    """Create or update one row (locked); audited when something changed. Returns (row, created, previous amount)."""
    qs = Target.objects.for_workspace(workspace).select_for_update()
    row = qs.filter(
        subject_type=subj[0], subject_id=subj[1] or None, period_type=period_type, period_start=start
    ).first()
    created = row is None
    before = None if row is None else row.amount
    if row is None:
        row = Target(
            workspace_id=getattr(workspace, "pk", workspace),
            subject_type=subj[0],
            subject_id=subj[1] or None,
            period_type=period_type,
            period_start=start,
            amount=amount,
            note=note or "",
            updated_by=actor,
        )
        row.save()
    else:
        changed = row.amount != amount or (note is not None and note != row.note)
        if not changed:
            return row, False, before
        row.amount, row.updated_by = amount, actor
        if note is not None:
            row.note = note
        row.save(update_fields=["amount", "note", "updated_by", "updated_at"])
    _audit(
        actor,
        workspace,
        "sales.target.set",
        row,
        _label(workspace, subj, period_type, start),
        changes=[change("amount", before, amount)],
        data={"subjectType": subj[0], "subjectId": subj[1] or None, "periodType": period_type},
    )
    return row, created, before


def set_target(actor: Any, workspace: Any, data: dict[str, Any]) -> tuple[Target, bool]:
    """Create or update the subject's target for one period (the unique key); returns (row, created)."""
    subj = subject(data["subjectType"], data.get("subjectId"))
    require_manage(actor, workspace, subj)
    settings = ensure_defaults(workspace)
    period = aligned(data["periodType"], data["periodStart"], settings)
    with transaction.atomic():
        row, created, before = _put(actor, workspace, subj, period.kind, period.start, data["amount"], data.get("note"))
        if created or before != row.amount:
            _event(
                actor,
                workspace,
                subj,
                {
                    "action": "created" if created else "updated",
                    "periodType": period.kind,
                    "periodStart": period.start.isoformat(),
                    "amount": str(row.amount),
                    "previousAmount": None if before is None else str(before),
                },
                row,
            )
    return row, created


def delete_target(actor: Any, target: Target) -> None:
    subj = subject(target.subject_type, target.subject_id)
    require_manage(actor, target.workspace_id, subj)
    with transaction.atomic():
        _audit(
            actor,
            target.workspace_id,
            "sales.target.deleted",
            target,
            _label(target.workspace_id, subj, target.period_type, target.period_start),
            changes=[change("amount", target.amount, None)],
        )
        _event(
            actor,
            target.workspace_id,
            subj,
            {
                "action": "deleted",
                "periodType": target.period_type,
                "periodStart": target.period_start.isoformat(),
                "amount": None,
                "previousAmount": str(target.amount),
            },
            target,
        )
        target.delete()


def split(total: Decimal, weights: list[Decimal]) -> list[Decimal]:
    """`total` shared by `weights` in cents; the rounding remainder goes to the heaviest part (equal when all zero)."""
    if not any(weights):
        weights = [Decimal(1)] * len(weights)
    whole = sum(weights, ZERO)
    out = [(total * w / whole).quantize(CENT, ROUND_HALF_UP) for w in weights]
    heaviest = max(range(len(weights)), key=lambda i: weights[i])
    out[heaviest] += total - sum(out, ZERO)
    return out


def _amounts(raw: list[Any] | None, n: int, name: str) -> list[Decimal] | None:
    if raw is None:
        return None
    if len(raw) != n:
        raise invalid({name: f"Give {n} amounts"})
    return [Decimal(v) for v in raw]


def allocate(actor: Any, workspace: Any, data: dict[str, Any]) -> dict[str, Any]:
    """Quarter and month targets from the subject's year target (`equal`, `working_days` or `manual`). Gaps between a
    year and its quarters or months are reported (`allocation_node`), never refused."""
    subj = subject(data["subjectType"], data.get("subjectId"))
    require_manage(actor, workspace, subj)
    settings = ensure_defaults(workspace)
    year = fiscal_year(settings, data["year"])
    quarters = children(year, QUARTER)
    months = children(year, MONTH)
    book = TargetBook(workspace, settings)
    total = book.stored(subj, YEAR, year.start)
    method = data["method"]
    q_amounts: list[Decimal] | None
    m_amounts: list[Decimal] | None
    if method == "manual":
        q_amounts = _amounts(data.get("quarters"), 4, "quarters")
        m_amounts = _amounts(data.get("months"), 12, "months")
        if q_amounts is None and m_amounts is None:
            raise invalid({"months": "Give quarter or month amounts"})
    else:
        if total is None:
            raise invalid({"year": "Set the year target first"})
        weigh = (lambda p: Decimal(1)) if method == "equal" else (lambda p: book.cal.total(p.start, p.end))
        q_amounts = split(total, [weigh(q) for q in quarters])
        m_amounts = []
        for q, amount in zip(quarters, q_amounts, strict=True):
            m_amounts += split(amount, [weigh(m) for m in children(q, MONTH)])
    written = 0
    with transaction.atomic():
        for periods, amounts in ((quarters, q_amounts), (months, m_amounts)):
            for p, amount in zip(periods, amounts or [], strict=False):
                _, created, before = _put(actor, workspace, subj, p.kind, p.start, amount, None)
                written += int(created or before != amount)
        if written:
            _event(
                actor,
                workspace,
                subj,
                {"action": "allocated", "method": method, "periodType": YEAR, "periodStart": year.start.isoformat()},
            )
    return allocation_node(workspace, subj, data["year"], book=TargetBook(workspace, settings))


# ───────────────────────── allocation view ─────────────────────────


def _gap(total: Decimal | None, parts: list[Decimal | None]) -> Decimal | None:
    found = [p for p in parts if p is not None]
    return None if total is None or not found else total - sum(found, ZERO)


def allocation_node(
    workspace: Any, subj: Subject, year: int, *, book: TargetBook, name: str | None = None
) -> dict[str, Any]:
    """One subject's fiscal year: its year target, stored quarters and months, and the period gaps."""
    fy = fiscal_year(book.settings, year)
    total = book.stored(subj, YEAR, fy.start)
    quarters: list[dict[str, Any]] = []
    for q in children(fy, QUARTER):
        months: list[dict[str, Any]] = [
            {"start": m.start, "end": m.end, "amount": book.stored(subj, MONTH, m.start)} for m in children(q, MONTH)
        ]
        q_amount = book.stored(subj, QUARTER, q.start)
        quarters.append(
            {
                "start": q.start,
                "end": q.end,
                "amount": q_amount,
                "months": months,
                "allocationGap": _gap(q_amount, [m["amount"] for m in months]),
            }
        )
    all_months = [m["amount"] for q in quarters for m in q["months"]]
    return {
        "subjectType": subj[0],
        "subjectId": subj[1] or None,
        "name": name if name is not None else subject_name(workspace, subj),
        "year": year,
        "start": fy.start,
        "end": fy.end,
        "target": total,
        "quarters": quarters,
        "quarterGap": _gap(total, [q["amount"] for q in quarters]),
        "monthGap": _gap(total, all_months),
    }


def _with_children(node: dict[str, Any], kids: list[dict[str, Any]]) -> dict[str, Any]:
    allocated = _sum(k["target"] for k in kids)
    total = node["target"]
    gap = None if total is None else total - (allocated or ZERO)
    node.update(
        children=kids,
        allocated=allocated or ZERO,
        unallocated=None if gap is None else max(gap, ZERO),
        allocationGap=gap,
    )
    return node


def allocation_tree(user: Any, workspace: Any, raw_subject: str, year: int) -> dict[str, Any]:
    """`company` → its teams → their members, `team:<id>` → its members, or `user:<id>`; only what the caller's
    `sales.target.view` scope reaches (403 for an unreachable subject)."""
    from core.accounts.models import User
    from core.teams.models import Team, TeamMember

    code = perms.TARGET_VIEW
    kind, _, sid = raw_subject.partition(":")
    if kind not in Target.SUBJECTS:
        raise invalid({"subject": "Use company, team:<id> or user:<id>"})
    subj = subject(kind, sid)
    check_subject(workspace, subj)
    if not can_reach(user, workspace, code, subj):
        raise forbidden(details={"permission": code})
    settings = ensure_defaults(workspace)
    book = TargetBook(workspace, settings)
    fy = fiscal_year(settings, year)
    users = people.visible_user_ids(user, workspace, code)
    teams = list(
        Team.objects.for_workspace(workspace).filter(pk__in=list(people.visible_team_ids(user, workspace, code)))
    )
    members = TeamMember.objects.for_workspace(workspace).filter(team__in=teams, user_id__in=list(users))
    names = {str(k): v for k, v in User.objects.filter(pk__in=list(users)).values_list("pk", "name")}
    by_team: dict[str, list[str]] = {}
    for m in members.order_by("user__name"):
        by_team.setdefault(str(m.team_id), []).append(str(m.user_id))
    subjects = [subject(Target.COMPANY, None)] + [subject(Target.TEAM, t.pk) for t in teams]
    book.load(subjects + [subject(Target.USER, u) for u in users], fy.start, fy.end)

    def user_node(uid: str) -> dict[str, Any]:
        node = allocation_node(workspace, subject(Target.USER, uid), year, book=book, name=names.get(uid, ""))
        return _with_children(node, [])

    def team_node(team: Any) -> dict[str, Any]:
        node = allocation_node(workspace, subject(Target.TEAM, team.pk), year, book=book, name=team.name)
        return _with_children(node, [user_node(u) for u in by_team.get(str(team.pk), [])])

    if kind == Target.USER:
        return user_node(subj[1])
    if kind == Target.TEAM:
        return team_node(next(t for t in teams if str(t.pk) == subj[1]))
    node = allocation_node(workspace, subj, year, book=book, name="Company")
    return _with_children(node, [team_node(t) for t in sorted(teams, key=lambda t: t.name.lower())])
