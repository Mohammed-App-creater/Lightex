"""Reports, computed from TaskStatusHistory, sprint scope changes and task fields.

- Cycle time: first entry into an in-progress status → completion (done category, canceled excluded).
- Throughput: tasks completed per ISO week (Monday start, UTC), last complete weeks.
- Burndown: remaining work per day of a sprint, reconstructed from scope changes and status history.
- Velocity: committed (snapshot at sprint start) vs completed estimate for recent completed sprints.
"""

from __future__ import annotations

import datetime as dt
import statistics
from collections import defaultdict
from typing import Any

from django.db.models import F, IntegerField, Min, OuterRef, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone

from apps.common.exceptions import invalid, not_found
from apps.planning.models import Sprint, SprintScopeChange
from apps.planning.selectors import expected_percent, milestones_of, objectives_of, progress
from apps.tasks.models import Task, TaskStatusHistory

RANGES = ("last2", "last6", "last90", "custom")
RANGE_SPRINTS = {"last2": 2, "last6": 6}
RANGE_DAYS = {"last2": 28, "last6": 84, "last90": 90}
BINS = [("<1d", 1), ("1–2d", 2), ("2–3d", 3), ("3–5d", 5), ("5–8d", 8), ("8d+", float("inf"))]
DAY = dt.timedelta(days=1)


def today() -> dt.date:
    return timezone.now().date()


def _day_end(d: dt.date) -> dt.datetime:
    return dt.datetime.combine(d + DAY, dt.time.min, tzinfo=dt.UTC)


def window(range_: str | None, start: str | None, end: str | None) -> tuple[str, dt.date, dt.date]:
    range_ = range_ or "last6"
    if range_ not in RANGES:
        raise invalid({"filter[range]": "Pick last2, last6, last90 or custom"})
    if range_ == "custom":
        try:
            first = dt.date.fromisoformat(str(start))
            last = dt.date.fromisoformat(str(end))
        except ValueError as exc:
            raise invalid({"filter[from]": "Custom ranges need from and to dates"}) from exc
        if last < first:
            raise invalid({"filter[to]": "The end must be after the start"})
        return range_, first, last
    return range_, today() - dt.timedelta(days=RANGE_DAYS[range_]), today()


def _done_tasks(project: Any):
    return Task.objects.filter(project=project, status__category="done", completed_at__isnull=False).exclude(
        status__glyph="canceled"
    )


def cycle_times(project: Any, first: dt.date | None = None, last: dt.date | None = None) -> list[float]:
    qs = _done_tasks(project).annotate(
        first_progress=Min("status_history__at", filter=Q(status_history__to_category="in_progress"))
    )
    if first is not None and last is not None:
        qs = qs.filter(completed_at__gte=_day_end(first) - DAY, completed_at__lt=_day_end(last))
    out = []
    for started, completed in qs.values_list("first_progress", "completed_at"):
        if started and completed and completed >= started:
            out.append((completed - started).total_seconds() / 86400)
    return out


def _round(value: float) -> float:
    return round(value, 1)


def cycle_time_report(project: Any, range_: str | None, start: str | None, end: str | None) -> dict[str, Any]:
    _, first, last = window(range_, start, end)
    values = cycle_times(project, first, last)
    counts = [0] * len(BINS)
    for v in values:
        idx = next(i for i, (_, edge) in enumerate(BINS) if v < edge)
        counts[idx] += 1
    return {
        "bins": [{"label": label, "count": counts[i]} for i, (label, _) in enumerate(BINS)],
        "total": len(values),
        "medianDays": _round(statistics.median(values)) if values else 0,
        "insufficient": len(values) < 10,
    }


def _monday(d: dt.date) -> dt.date:
    return d - dt.timedelta(days=d.weekday())


def throughput_report(project: Any, range_: str | None, start: str | None, end: str | None) -> dict[str, Any]:
    range_, first, last = window(range_, start, end)
    if range_ == "custom":
        weeks_start = _monday(first)
        weeks = max(1, ((_monday(last) - weeks_start).days // 7) + 1)
    else:
        weeks = {"last2": 4, "last6": 12, "last90": 13}[range_]
        weeks_start = _monday(today()) - dt.timedelta(weeks=weeks)
    window_end = weeks_start + dt.timedelta(weeks=weeks)
    done_rows = (
        TaskStatusHistory.objects.filter(
            task__project=project,
            task__deleted_at__isnull=True,
            to_category="done",
            at__gte=_day_end(weeks_start) - DAY,
            at__lt=_day_end(window_end) - DAY,
        )
        .exclude(to_status__glyph="canceled")
        .values_list("task_id", "at")
    )
    per_week: dict[dt.date, set] = defaultdict(set)
    for task_id, at in done_rows:
        per_week[_monday(at.date())].add(task_id)
    counts = [len(per_week.get(weeks_start + dt.timedelta(weeks=i), ())) for i in range(weeks)]
    points = [{"week": (weeks_start + dt.timedelta(weeks=i)).isoformat(), "done": n} for i, n in enumerate(counts)]
    return {"points": points, "insufficient": sum(counts) < 5}


def _sprint_or_active(project: Any, sprint_id: str | None) -> Sprint | None:
    if sprint_id:
        from apps.tasks.selectors import is_uuid

        sprint = Sprint.objects.filter(project=project, pk=sprint_id).first() if is_uuid(sprint_id) else None
        if sprint is None:
            raise not_found("Sprint not found.")
        return sprint
    return Sprint.objects.filter(project=project, state="active").first()


def burndown(project: Any, sprint_id: str | None) -> dict[str, Any]:
    sprint = _sprint_or_active(project, sprint_id)
    if sprint is None:
        return {"sprint": None, "points": []}
    changes = list(SprintScopeChange.objects.filter(sprint=sprint).values_list("task_id", "kind", "at"))
    ids = set(Task.objects.filter(sprint=sprint).values_list("pk", flat=True)) | {c[0] for c in changes if c[0]}
    tasks = {t.pk: t for t in Task.objects.filter(pk__in=ids).select_related("status")}
    history: dict[Any, list[tuple[dt.datetime, str, str | None]]] = defaultdict(list)
    for task_id, at, category, glyph in (
        TaskStatusHistory.objects.filter(task_id__in=ids)
        .order_by("at")
        .values_list("task_id", "at", "to_category", "to_status__glyph")
    ):
        history[task_id].append((at, category, glyph))

    def in_sprint(task_id: Any, moment: dt.datetime) -> bool:
        """Membership at `moment`: replay scope changes backwards from today's state."""
        member = tasks[task_id].sprint_id == sprint.pk
        for tid, kind, at in sorted(changes, key=lambda c: c[2], reverse=True):
            if tid == task_id and at >= moment:
                member = kind == "removed"
        return member

    def state(task_id: Any, moment: dt.datetime) -> tuple[bool, bool]:
        done = canceled = False
        for at, category, glyph in history.get(task_id, []):
            if at >= moment:
                break
            done = category == "done" and glyph != "canceled"
            canceled = glyph == "canceled"
        return done, canceled

    def points(task: Task) -> int:
        return task.estimate if task.estimate is not None else 1

    length = (sprint.end_date - sprint.start_date).days + 1
    start_moment = _day_end(sprint.start_date)
    start_total = sum(
        points(t) for tid, t in tasks.items() if in_sprint(tid, start_moment) and not state(tid, start_moment)[1]
    )
    out = []
    for i in range(length):
        day = sprint.start_date + dt.timedelta(days=i)
        moment = _day_end(day)
        if sprint.completed_at is not None and moment > sprint.completed_at:
            moment = sprint.completed_at  # what was left when the sprint closed, before carry-over
        remaining: int | None = None
        if day <= today():
            remaining = 0
            for tid, t in tasks.items():
                if t.deleted_at is not None or not in_sprint(tid, moment):
                    continue
                done, canceled = state(tid, moment)
                if not done and not canceled:
                    remaining += points(t)
        ideal = round(start_total * (1 - i / max(1, length - 1)))
        out.append({"date": day.isoformat(), "remaining": remaining, "ideal": ideal})
    return {
        "sprint": {
            "id": str(sprint.pk),
            "name": sprint.name,
            "startDate": sprint.start_date.isoformat(),
            "endDate": sprint.end_date.isoformat(),
        },
        "points": out,
    }


def velocity(project: Any, range_: str | None, start: str | None, end: str | None) -> dict[str, Any]:
    range_, first, last = window(range_, start, end)
    completed = Sprint.objects.filter(project=project, state="completed").order_by("-end_date", "-number")
    if range_ in RANGE_SPRINTS:
        sprints = list(completed[: RANGE_SPRINTS[range_]])
    else:
        sprints = list(completed.filter(end_date__gte=first, end_date__lte=last))
    points = []
    for s in reversed(sprints):
        done = (
            Task.objects.filter(sprint=s, status__category="done")
            .exclude(status__glyph="canceled")
            .aggregate(p=Sum("estimate"))["p"]
            or 0
        )
        committed = s.committed_points
        if committed is None:
            committed = (
                Task.objects.filter(sprint=s).exclude(status__glyph="canceled").aggregate(p=Sum("estimate"))["p"] or 0
            )
        points.append({"sprint": f"S{s.number}", "committed": committed, "completed": done})
    return {"points": points, "insufficient": len(points) < 3, "completedSprints": completed.count()}


def progress_rows(project: Any) -> list[dict[str, Any]]:
    rows = []
    for o in objectives_of(project):
        p = progress(getattr(o, "p_done", 0), getattr(o, "p_total", 0))
        expected = expected_percent(o.created_at.date(), o.due_date) if o.due_date else None
        rows.append(
            {
                "id": str(o.pk),
                "kind": "objective",
                "name": o.title,
                "percent": p["percent"],
                "expected": expected,
                "dueDate": o.due_date.isoformat() if o.due_date else None,
                "quarter": o.quarter or None,
            }
        )
    for m in milestones_of(project):
        p = progress(getattr(m, "p_done", 0), getattr(m, "p_total", 0))
        percent = 100 if m.completed_at else p["percent"]
        rows.append(
            {
                "id": str(m.pk),
                "kind": "milestone",
                "name": m.name,
                "percent": percent,
                "expected": expected_percent(m.start_date, m.due_date),
                "dueDate": m.due_date.isoformat(),
                "quarter": None,
            }
        )
    return rows


def _overdue(project: Any):
    return (
        Task.objects.filter(project=project, due_date__lt=today())
        .exclude(status__category="done")
        .order_by("due_date", "number")
    )


def kpis(project: Any) -> dict[str, Any]:
    sprint = Sprint.objects.filter(project=project, state="active").first()
    sprint_info = None
    completed_this = planned_this = scope = 0
    if sprint is not None:
        length = (sprint.end_date - sprint.start_date).days + 1
        day_index = min(length, max(1, (today() - sprint.start_date).days + 1))
        sprint_info = {
            "name": sprint.name,
            "number": sprint.number,
            "startDate": sprint.start_date.isoformat(),
            "endDate": sprint.end_date.isoformat(),
            "dayIndex": day_index,
            "lengthDays": length,
        }
        in_sprint = Task.objects.filter(sprint=sprint).exclude(status__glyph="canceled")
        planned_this = in_sprint.count()
        completed_this = in_sprint.filter(status__category="done").count()
        scope = (
            SprintScopeChange.objects.filter(sprint=sprint, kind="added", task__deleted_at__isnull=True).aggregate(
                p=Sum("estimate")
            )["p"]
            or 0
        )
    cycles = sorted(cycle_times(project))
    overdue = _overdue(project)
    oldest = overdue.first()
    return {
        "sprint": sprint_info,
        "completedThisSprint": completed_this,
        "plannedThisSprint": planned_this,
        "avgCycleTimeDays": _round(sum(cycles) / len(cycles)) if cycles else 0,
        "p85CycleTimeDays": _round(cycles[min(len(cycles) - 1, int(len(cycles) * 0.85))]) if cycles else 0,
        "overdueCount": overdue.count(),
        "oldestOverdueKey": oldest.key if oldest else None,
        "scopeChangePts": scope,
        "completedSprints": Sprint.objects.filter(project=project, state="completed").count(),
    }


def summary(project: Any) -> dict[str, Any]:
    sprint = Sprint.objects.filter(project=project, state="active").first()
    cycles = cycle_times(project)
    live = Task.objects.filter(project=project)
    done_this_sprint = (
        live.filter(sprint=sprint, status__category="done").exclude(status__glyph="canceled").count() if sprint else 0
    )
    return {
        "openTasks": live.exclude(status__category="done").count(),
        "doneThisSprint": done_this_sprint,
        "cycleTimeDays": _round(sum(cycles) / len(cycles)) if cycles else 0,
        "dueThisWeek": live.filter(due_date__lte=today() + dt.timedelta(days=7))
        .exclude(status__category="done")
        .count(),
    }


# ───────────────────────── workload (board 33, W1) ─────────────────────────

UNITS = ("points", "hours")
CAPACITY_SPRINTS = 3


def nice_max(value: float, step: int) -> int:
    """A round maximum for the bars: 0 for nothing, else the next multiple of `step` (at least one step)."""
    return 0 if value <= 0 else max(step, -(-int(value) // step) * step)


def _round_half_up(value: float) -> int:
    return int(value + 0.5)


def _person_field(project: Any, raw: str | None) -> Any:
    from apps.projects.models import CustomField
    from apps.tasks.selectors import is_uuid

    if raw in (None, "", "assignee"):
        return None
    field = CustomField.objects.filter(project=project, pk=raw).first() if is_uuid(raw) else None
    if field is None or field.type != "user":
        raise invalid({"filter[person]": "Pick a person field from this project"})
    return field


def workload(project: Any, sprint_id: str | None, unit: str | None, person: str | None) -> dict[str, Any]:
    """Open work per person in a sprint (todo / in progress), with a capacity derived from the last 3 completed
    sprints (docs/v2/33-dashboards-presence.md §5.4). A constant number of queries whatever the task count."""
    from apps.accounts.models import User
    from apps.projects.models import ProjectMember
    from apps.tasks.models import TaskFieldValue
    from apps.timetracking.models import TimeEntry

    unit = unit or "points"
    if unit not in UNITS:
        raise invalid({"filter[unit]": "Pick points or hours"})
    field = _person_field(project, person)
    sprint = _sprint_or_active(project, sprint_id)
    person_field = {"id": str(field.pk), "name": field.name} if field else None
    zero = {"inProgress": 0, "todo": 0, "unestimated": 0}
    if sprint is None:
        return {"sprint": None, "unit": unit, "personField": person_field, "scale": 0, "rows": [], "unassigned": zero}

    def with_person(qs):
        if field is None:
            return qs.annotate(person=F("assignee_id"))
        value = TaskFieldValue.objects.filter(task=OuterRef("pk"), field=field).values("user_id")[:1]
        return qs.annotate(person=Subquery(value))

    logged = (
        TimeEntry.objects.filter(task=OuterRef("pk")).values("task").annotate(total=Sum("minutes")).values("total")[:1]
    )
    open_tasks = with_person(
        Task.objects.filter(sprint=sprint, status__category__in=("todo", "in_progress")).annotate(
            logged=Coalesce(Subquery(logged, output_field=IntegerField()), Value(0))
        )
    ).values_list("person", "status__category", "estimate", "time_estimate_minutes", "logged")
    work: dict[Any, dict[str, int]] = {}
    for who, category, estimate, minutes, spent in open_tasks:
        if unit == "points":
            amount, unestimated = (0, True) if estimate is None else (estimate, False)
        else:
            amount, unestimated = (0, True) if minutes is None else (max(0, minutes - spent), False)
        bucket = work.setdefault(who, dict(zero))
        bucket["inProgress" if category == "in_progress" else "todo"] += amount
        bucket["unestimated"] += int(unestimated)

    done_sprints = list(
        Sprint.objects.filter(project=project, state="completed").order_by("-end_date", "-number")[:CAPACITY_SPRINTS]
    )
    totals: dict[Any, int] = {}
    if done_sprints and unit == "points":
        completed = with_person(
            Task.objects.filter(sprint__in=done_sprints, status__category="done").exclude(status__glyph="canceled")
        )
        for who, points in completed.values("person").annotate(points=Sum("estimate")).values_list("person", "points"):
            if who is not None:
                totals[who] = points or 0
    elif done_sprints:
        sums = {
            f"s{i}": Sum("minutes", filter=Q(date__gte=s.start_date, date__lte=s.end_date))
            for i, s in enumerate(done_sprints)
        }
        per_user: Any = TimeEntry.objects.filter(project=project).values("user_id").annotate(**sums)
        for row in per_user:
            totals[row["user_id"]] = sum(row[k] or 0 for k in sums)

    members = list(ProjectMember.objects.filter(project=project).values_list("user_id", flat=True))
    people = {who for who in work if who is not None} | (set(members) if done_sprints else set())
    users = {u.pk: u for u in User.objects.filter(pk__in=people)}
    rows: list[dict[str, Any]] = []
    for who in people:
        user = users.get(who)
        bucket = work.get(who, zero)
        rows.append(
            {
                "user": {
                    "id": str(who),
                    "name": user.name if user else "Former member",
                    "hue": user.hue if user else 0,
                    "avatarUrl": user.avatar_url if user else None,
                },
                "inProgress": bucket["inProgress"],
                "todo": bucket["todo"],
                "capacity": _round_half_up(totals.get(who, 0) / len(done_sprints)) if done_sprints else None,
                "unestimated": bucket["unestimated"],
            }
        )
    rows.sort(key=lambda r: (r["user"]["name"].lower(), r["user"]["name"], r["user"]["id"]))
    top = max([max(r["inProgress"] + r["todo"], r["capacity"] or 0) for r in rows] or [0])
    return {
        "sprint": {
            "id": str(sprint.pk),
            "name": sprint.name,
            "number": sprint.number,
            "startDate": sprint.start_date.isoformat(),
            "endDate": sprint.end_date.isoformat(),
        },
        "unit": unit,
        "personField": person_field,
        "scale": nice_max(top, 2 if unit == "points" else 120),
        "rows": rows,
        "unassigned": work.get(None, dict(zero)),
    }
