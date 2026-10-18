"""Workspace time (sales S0): "today" and business-date boundaries in the workspace's IANA time zone.

Timestamps are stored in UTC. A business date (a won date, a report date) is the date in the workspace zone, and
filtering timestamps by business dates uses the half-open UTC ranges from `day_bounds()` / `range_bounds()`.
"""

from __future__ import annotations

import datetime as dt
import functools
import zoneinfo
from typing import Any, TypeGuard

from django.utils import timezone as djtz

DEFAULT_TIMEZONE = "Africa/Addis_Ababa"


@functools.lru_cache(maxsize=1)
def _names() -> frozenset[str]:
    return frozenset(zoneinfo.available_timezones())


def is_valid_timezone(name: Any) -> TypeGuard[str]:
    return isinstance(name, str) and name in _names()


@functools.lru_cache(maxsize=256)
def _zone(name: str) -> zoneinfo.ZoneInfo:
    return zoneinfo.ZoneInfo(name)


def workspace_zone(workspace: Any) -> zoneinfo.ZoneInfo:
    """The workspace's zone (the default one if the stored name is somehow unusable)."""
    name = getattr(workspace, "timezone", None) or DEFAULT_TIMEZONE
    return _zone(name if is_valid_timezone(name) else DEFAULT_TIMEZONE)


def workspace_now(workspace: Any, now: dt.datetime | None = None) -> dt.datetime:
    """`now` (default: the current instant) as an aware datetime in the workspace zone."""
    return (now or djtz.now()).astimezone(workspace_zone(workspace))


def workspace_today(workspace: Any, now: dt.datetime | None = None) -> dt.date:
    return workspace_now(workspace, now).date()


def local_date(workspace: Any, instant: dt.datetime) -> dt.date:
    """The business date of a stored (UTC) timestamp."""
    return instant.astimezone(workspace_zone(workspace)).date()


def _start_of(workspace: Any, day: dt.date) -> dt.datetime:
    local = dt.datetime.combine(day, dt.time.min, tzinfo=workspace_zone(workspace))
    return local.astimezone(dt.UTC)


def day_bounds(workspace: Any, day: dt.date) -> tuple[dt.datetime, dt.datetime]:
    """[start, end) in UTC of a business date: filter with `field__gte=start, field__lt=end`."""
    return _start_of(workspace, day), _start_of(workspace, day + dt.timedelta(days=1))


def range_bounds(workspace: Any, first_day: dt.date, last_day: dt.date) -> tuple[dt.datetime, dt.datetime]:
    """[start, end) in UTC covering the business dates `first_day` … `last_day` (inclusive)."""
    return _start_of(workspace, first_day), _start_of(workspace, last_day + dt.timedelta(days=1))
