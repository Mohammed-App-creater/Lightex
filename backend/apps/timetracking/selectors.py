"""Time reads (board 39): a task's entries and the workspace timesheet. Always membership-scoped."""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.db.models import QuerySet, Sum

from apps.access import services as access
from apps.access.catalogue import ordered
from apps.accounts.models import User
from apps.common.exceptions import forbidden, invalid, not_found
from apps.common.utils import today
from apps.projects.models import Project, ProjectMember
from apps.projects.selectors import project_for

from .models import TimeEntry

MAX_SLICES = 5


def entries_of(task: Any) -> QuerySet[TimeEntry]:
    return TimeEntry.objects.filter(task=task).order_by("-date", "-created_at", "-id")


def week_start(raw: str | None) -> dt.date:
    """The Monday of the week containing `raw` (any `YYYY-MM-DD`); the current UTC week by default."""
    if raw:
        try:
            day = dt.date.fromisoformat(raw)
        except ValueError:
            raise invalid({"filter[week]": "Pick a date"}) from None
    else:
        day = today()
    return day - dt.timedelta(days=day.weekday())


def visible_projects(user: Any, workspace: Any) -> list[Project]:
    """Projects in the workspace where the user has `project.view` (archived included), name-sorted."""
    member_of = ProjectMember.objects.filter(user_id=user.pk).values("project_id")
    projects = list(Project.objects.filter(workspace=workspace, pk__in=member_of))
    perms = access.prefetch_project_permissions(user, projects)
    visible = [p for p in projects if "project.view" in perms.get(p.pk, ())]
    return sorted(visible, key=lambda p: (p.name.lower(), p.key))


def _scoped_project(user: Any, workspace: Any, project_id: str) -> Project:
    project = project_for(user, project_id)  # 404 / 403 project_membership_required
    if project.workspace_id != workspace.pk:
        raise not_found("Project not found.")
    if not access.can(user, "project.view", project):
        raise forbidden(details={"permission": "project.view"})
    return project


def _slices(raw: dict[Any, dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(raw.values(), key=lambda s: (-s["minutes"], s["key"]))[:MAX_SLICES]


def timesheet(user: Any, workspace: Any, week: str | None, project_id: str | None) -> dict[str, Any]:
    """Minutes per person per day for one week. Without a project: breakdown per project; with one: per task."""
    monday = week_start(week)
    days = [monday + dt.timedelta(days=i) for i in range(7)]
    projects = visible_projects(user, workspace)
    scope = [_scoped_project(user, workspace, project_id)] if project_id else projects
    by_project = {p.pk: p for p in scope}
    per_task = bool(project_id)
    columns = ["user_id", "date", "project_id"] + (["task_id", "task__key", "task__title"] if per_task else [])
    rows = (
        TimeEntry.objects.filter(
            project_id__in=list(by_project), date__gte=days[0], date__lte=days[-1], task__deleted_at__isnull=True
        )
        .values(*columns)
        .annotate(minutes=Sum("minutes"))
        .order_by()
    )
    cells: dict[Any, dict[dt.date, dict[str, Any]]] = {}
    for r in rows:
        cell = cells.setdefault(r["user_id"], {}).setdefault(r["date"], {"minutes": 0, "slices": {}})
        cell["minutes"] += r["minutes"]
        project = by_project[r["project_id"]]
        if per_task:
            key, slice_ = r["task_id"], {"taskId": str(r["task_id"]), "key": r["task__key"], "name": r["task__title"]}
        else:
            key, slice_ = project.pk, {"taskId": None, "key": project.key, "name": project.name}
        target = cell["slices"].setdefault(
            key, {"projectId": str(project.pk), **slice_, "hue": project.hue, "minutes": 0}
        )
        target["minutes"] += r["minutes"]
    users = sorted(User.objects.filter(pk__in=list(cells)), key=lambda u: (u.name.lower(), str(u.pk)))
    day_totals = [0] * 7
    out_rows: list[dict[str, Any]] = []
    for u in users:
        out_cells: list[dict[str, Any]] = []
        for i, day in enumerate(days):
            day_cell = cells[u.pk].get(day)
            minutes = day_cell["minutes"] if day_cell else 0
            day_totals[i] += minutes
            breakdown = _slices(day_cell["slices"]) if day_cell else []
            out_cells.append({"date": day.isoformat(), "minutes": minutes, "breakdown": breakdown})
        out_rows.append(
            {
                "user": {"id": str(u.pk), "name": u.name, "hue": u.hue, "avatarUrl": u.avatar_url},
                "cells": out_cells,
                "totalMinutes": sum(c["minutes"] for c in out_cells),
            }
        )
    return {
        "weekStart": monday.isoformat(),
        "days": [d.isoformat() for d in days],
        "projects": [
            {
                "id": str(p.pk),
                "key": p.key,
                "name": p.name,
                "hue": p.hue,
                "my_permissions": ordered(access.project_permissions(user, p)),
            }
            for p in projects
        ],
        "rows": out_rows,
        "dayTotals": day_totals,
        "totalMinutes": sum(day_totals),
    }
