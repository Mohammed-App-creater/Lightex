"""Sales periods (docs/sales/spec.md §6): day, week (from `week_start`), month, quarter and year (fiscal, from
`fiscal_year_start_month`), always as business dates in the workspace time zone.

    period = current_period(workspace, MONTH)          # this month, today in the workspace zone
    start, end = period.bounds(workspace)              # UTC [start, end) for timestamp filters (won_at, …)
    period.previous()                                  # the immediately preceding equal period (growth %)

S2 uses it for the won-date back-dating rule; S4 (KPIs, targets) and S6 (reports) reuse it.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

from core.workspaces.timezone import range_bounds, workspace_today

from .models import WEEKDAYS

DAY, WEEK, MONTH, QUARTER, YEAR = "day", "week", "month", "quarter", "year"
KINDS = (DAY, WEEK, MONTH, QUARTER, YEAR)
#: A free date range (reports, S6): its previous period is the equal-length range just before it.
CUSTOM = "custom"

#: The period a won date may be back-dated within (api.md §10.4): closed months stay closed.
CLOSING_PERIOD = MONTH


@dataclass(frozen=True)
class Period:
    kind: str
    start: dt.date
    #: Inclusive.
    end: dt.date
    week_start: str = "monday"
    fiscal_start_month: int = 1

    def contains(self, day: dt.date) -> bool:
        return self.start <= day <= self.end

    def days(self) -> int:
        return (self.end - self.start).days + 1

    def bounds(self, workspace: Any) -> tuple[dt.datetime, dt.datetime]:
        """[start, end) in UTC: filter timestamps with `field__gte=start, field__lt=end`."""
        return range_bounds(workspace, self.start, self.end)

    def previous(self) -> Period:
        if self.kind == CUSTOM:
            return custom_period(self.start - dt.timedelta(days=self.days()), self.start - dt.timedelta(days=1), self)
        return period_containing(
            self.kind,
            self.start - dt.timedelta(days=1),
            week_start=self.week_start,
            fiscal_start_month=self.fiscal_start_month,
        )

    def next(self) -> Period:
        if self.kind == CUSTOM:
            return custom_period(self.end + dt.timedelta(days=1), self.end + dt.timedelta(days=self.days()), self)
        return period_containing(
            self.kind,
            self.end + dt.timedelta(days=1),
            week_start=self.week_start,
            fiscal_start_month=self.fiscal_start_month,
        )


def _add_months(year: int, month: int, months: int) -> tuple[int, int]:
    """(year, month) moved by `months` (month is 1–12)."""
    index = year * 12 + (month - 1) + months
    return index // 12, index % 12 + 1


def _month_start(year: int, month: int) -> dt.date:
    return dt.date(year, month, 1)


def _span(year: int, month: int, months: int) -> tuple[dt.date, dt.date]:
    """The `months` months starting at (year, month), as inclusive dates."""
    end_year, end_month = _add_months(year, month, months)
    return _month_start(year, month), _month_start(end_year, end_month) - dt.timedelta(days=1)


def fiscal_year_start(day: dt.date, fiscal_start_month: int = 1) -> dt.date:
    """The first day of the fiscal year containing `day` (a July start: 2026-03-10 → 2025-07-01)."""
    year = day.year if day.month >= fiscal_start_month else day.year - 1
    return dt.date(year, fiscal_start_month, 1)


def period_containing(kind: str, day: dt.date, *, week_start: str = "monday", fiscal_start_month: int = 1) -> Period:
    """The `kind` period containing business date `day`."""
    if not 1 <= fiscal_start_month <= 12:
        raise ValueError("fiscal_start_month must be 1–12")
    if kind == DAY:
        start, end = day, day
    elif kind == WEEK:
        offset = (day.weekday() - WEEKDAYS.index(week_start)) % 7
        start = day - dt.timedelta(days=offset)
        end = start + dt.timedelta(days=6)
    elif kind == MONTH:
        start, end = _span(day.year, day.month, 1)
    elif kind == QUARTER:
        fy = fiscal_year_start(day, fiscal_start_month)
        months_in = (day.year - fy.year) * 12 + day.month - fy.month
        year, month = _add_months(fy.year, fy.month, months_in - months_in % 3)
        start, end = _span(year, month, 3)
    elif kind == YEAR:
        fy = fiscal_year_start(day, fiscal_start_month)
        start, end = _span(fy.year, fy.month, 12)
    else:
        raise ValueError(f"Unknown period kind {kind!r}; use one of {', '.join(KINDS)}")
    return Period(kind, start, end, week_start, fiscal_start_month)


def current_period(workspace: Any, kind: str, settings: Any = None, now: dt.datetime | None = None) -> Period:
    """The `kind` period containing today in the workspace zone, with the workspace's week and fiscal settings
    (`settings`: the workspace's SalesSettings, read when not given)."""
    if settings is None:
        from .defaults import ensure_defaults

        settings = ensure_defaults(workspace)
    return period_containing(
        kind,
        workspace_today(workspace, now),
        week_start=settings.week_start,
        fiscal_start_month=settings.fiscal_year_start_month,
    )


def custom_period(start: dt.date, end: dt.date, like: Any = None) -> Period:
    """A free inclusive date range; `like` (a Period or SalesSettings) supplies the week and fiscal settings."""
    if end < start:
        raise ValueError("end must not be before start")
    week = getattr(like, "week_start", "monday")
    fiscal: Any = getattr(like, "fiscal_start_month", None) or getattr(like, "fiscal_year_start_month", 1)
    return Period(CUSTOM, start, end, week, int(fiscal))
