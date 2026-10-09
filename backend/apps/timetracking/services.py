"""Time writes (board 39): manual entries, the per-user timer, deletes. Every logged or deleted entry is audited;
starting a timer and discarding one are not (no time was recorded)."""

from __future__ import annotations

import datetime as dt
import math
import re
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.access import services as access
from apps.audit.services import record
from apps.common.exceptions import ApiError, conflict, forbidden, invalid, not_found
from apps.common.utils import today
from apps.tasks.models import Task
from apps.tasks.selectors import is_uuid

from .models import MAX_ENTRY_MINUTES, RunningTimer, TimeEntry

MAX_NOTE = 140
FUTURE_TOLERANCE_DAYS = 1  # time zones ahead of UTC
MAX_AGE_DAYS = 365
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DELETED = "This task was deleted. Restore it to make changes."


# ───────────────────────── validation ─────────────────────────


def clean_date(raw: Any, errors: dict[str, str], key: str = "date") -> dt.date | None:
    """A `YYYY-MM-DD` work date: up to UTC today + 1 day, back to UTC today − 365 days."""
    try:
        if not isinstance(raw, str) or not _ISO_DATE.match(raw):
            raise ValueError
        day = dt.date.fromisoformat(raw)
    except ValueError:
        errors[key] = "Pick a date"
        return None
    now = today()
    if day > now + dt.timedelta(days=FUTURE_TOLERANCE_DAYS):
        errors[key] = "Can’t log future time"
    elif day < now - dt.timedelta(days=MAX_AGE_DAYS):
        errors[key] = "Date is too far back"
    return day


def _clean_minutes(raw: Any, errors: dict[str, str]) -> int:
    if isinstance(raw, float) and raw.is_integer():
        raw = int(raw)
    if isinstance(raw, bool) or not isinstance(raw, int):
        errors["minutes"] = "Enter a duration"
        return 0
    if raw <= 0:
        errors["minutes"] = "Duration must be over 0"
    elif raw > MAX_ENTRY_MINUTES:
        errors["minutes"] = "Max 24h per entry"
    return raw


def _note(raw: Any) -> str:
    return raw.strip()[:MAX_NOTE] if isinstance(raw, str) else ""


def _audit(task: Task, actor: Any, action: str, entry: TimeEntry, data: dict[str, Any]) -> None:
    record(
        workspace=task.project.workspace_id,
        project=task.project_id,
        task=task,
        actor=actor,
        action=action,
        target=task.title,
        entity_id=entry.pk,
        entity_key=task.key,
        data=data,
    )


def _create_entry(actor: Any, task: Task, minutes: int, day: dt.date, note: str, source: str) -> TimeEntry:
    entry = TimeEntry.objects.create(
        task=task, project_id=task.project_id, user=actor, minutes=minutes, date=day, note=note, source=source
    )
    _audit(task, actor, "task.time_logged", entry, {"minutes": minutes, "date": day.isoformat(), "source": source})
    return entry


# ───────────────────────── entries ─────────────────────────


@transaction.atomic
def log_time(actor: Any, task: Task, data: dict[str, Any]) -> TimeEntry:
    task = Task.all_objects.select_related("project").get(pk=task.pk)
    if not access.can(actor, "time.log", task.project):
        raise forbidden(details={"permission": "time.log"})
    if task.deleted_at is not None:
        raise conflict("task_deleted", _DELETED)
    errors: dict[str, str] = {}
    minutes = _clean_minutes(data.get("minutes"), errors)
    day = clean_date(data.get("date"), errors)
    if errors or day is None:
        raise invalid(errors)
    return _create_entry(actor, task, minutes, day, _note(data.get("note")), "manual")


def get_entry(user: Any, entry_id: Any) -> TimeEntry:
    """An entry in a project the user is on. Unknown and invisible ids are both 404."""
    entry = (
        TimeEntry.objects.select_related("task", "task__project", "user")
        .filter(pk=entry_id, task__project__deleted_at__isnull=True)
        .first()
        if is_uuid(entry_id)
        else None
    )
    if entry is None or not access.project_permissions(user, entry.task.project):
        raise not_found("Time entry not found.")
    return entry


@transaction.atomic
def delete_entry(actor: Any, entry: TimeEntry) -> None:
    task = entry.task
    project = task.project
    own = entry.user_id == actor.pk and access.can(actor, "time.log", project)
    if not own and not access.can(actor, "time.delete_any", project):
        raise forbidden("You can’t delete this time entry.", {"permission": "time.delete_any"})
    if task.deleted_at is not None:
        raise conflict("task_deleted", _DELETED)
    _audit(
        task,
        actor,
        "task.time_entry_deleted",
        entry,
        {"minutes": entry.minutes, "date": entry.date.isoformat(), "owner": entry.user.name},
    )
    entry.delete()


# ───────────────────────── timer ─────────────────────────


def timer_minutes(started_at: dt.datetime, now: dt.datetime | None = None) -> int:
    """Whole minutes since `started_at`, half up (30 s → 1), clamped to 1…1440."""
    seconds = ((now or timezone.now()) - started_at).total_seconds()
    return max(1, min(MAX_ENTRY_MINUTES, math.floor(seconds / 60 + 0.5)))


def _usable(user: Any, timer: RunningTimer) -> bool:
    return timer.task.deleted_at is None and access.can(user, "project.view", timer.task.project)


def current_timer(user: Any) -> RunningTimer | None:
    """The user's timer. One whose task was deleted, or whose project they can no longer see, is dropped."""
    timer = RunningTimer.objects.select_related("task", "task__project").filter(user_id=user.pk).first()
    if timer is not None and not _usable(user, timer):
        timer.delete()
        return None
    return timer


def _finish(actor: Any, timer: RunningTimer, day: dt.date, note: str) -> TimeEntry | None:
    """Stops `timer`: logs an entry when the actor may still log time on its task, otherwise discards it."""
    task = timer.task
    minutes = timer_minutes(timer.started_at)
    allowed = task.deleted_at is None and access.can(actor, "time.log", task.project)
    timer.delete()
    return _create_entry(actor, task, minutes, day, note, "timer") if allowed else None


def _work_date(raw: Any) -> dt.date:
    if raw is None:
        return today()
    errors: dict[str, str] = {}
    day = clean_date(raw, errors)
    if errors or day is None:
        raise invalid(errors)
    return day


@transaction.atomic
def start_timer(actor: Any, task: Task, data: dict[str, Any]) -> tuple[RunningTimer, TimeEntry | None]:
    """Starts a timer on `task`. Idempotent on the same task; switching stops (and logs) the previous one."""
    task = Task.all_objects.select_related("project").get(pk=task.pk)
    if not access.can(actor, "time.log", task.project):
        raise forbidden(details={"permission": "time.log"})
    if task.deleted_at is not None:
        raise conflict("task_deleted", _DELETED)
    current = (
        RunningTimer.objects.select_for_update().select_related("task", "task__project").filter(user=actor).first()
    )
    if current is not None and current.task_id == task.pk:
        return current, None
    stopped = None
    if current is not None:
        stopped = _finish(actor, current, _work_date(data.get("date")), "")
    timer = RunningTimer.objects.create(user=actor, task=task, started_at=timezone.now())
    return timer, stopped


def stop_timer(actor: Any, data: dict[str, Any]) -> TimeEntry:
    """Stops the actor's timer and logs it. A timer that can't be logged any more is discarded (and the
    discard is committed even though the request fails)."""
    problem: ApiError | None = None
    with transaction.atomic():
        timer = (
            RunningTimer.objects.select_for_update().select_related("task", "task__project").filter(user=actor).first()
        )
        if timer is None:
            raise not_found("No timer is running.")
        task = timer.task
        if task.deleted_at is not None:
            problem = conflict("task_deleted", "This task was deleted. The timer was discarded.")
        elif not access.can(actor, "time.log", task.project):
            problem = forbidden(
                "You can’t log time on this project any more. The timer was discarded.", {"permission": "time.log"}
            )
        if problem is None:
            day = _work_date(data.get("date"))
            minutes = timer_minutes(timer.started_at)
            timer.delete()
            return _create_entry(actor, task, minutes, day, _note(data.get("note")), "timer")
        timer.delete()
    raise problem
