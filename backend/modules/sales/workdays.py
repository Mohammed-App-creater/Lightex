"""Working-day weights (docs/sales/spec.md §5–§6): the SalesCalendar weekday weight of a business date (1 full day,
0.5 half day, 0 off), zero on holidays. Day targets, run rates and the pro-rata status all weigh days with this.

    cal = WorkCalendar(workspace)
    cal.weight(day)                 # Decimal
    cal.total(start, end)           # inclusive sum
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from .models import Holiday
from .selectors import get_calendar

ZERO = Decimal("0")


class WorkCalendar:
    def __init__(self, workspace: Any) -> None:
        self.workspace = getattr(workspace, "pk", workspace)
        self.weights = get_calendar(self.workspace).weights()
        self._holidays: set[dt.date] = set()
        self._years: set[int] = set()
        self._totals: dict[tuple[dt.date, dt.date], Decimal] = {}

    def _load(self, year: int) -> None:
        if year in self._years:
            return
        self._years.add(year)
        qs = Holiday.objects.for_workspace(self.workspace).filter(date__year=year)
        self._holidays.update(qs.values_list("date", flat=True))

    def is_holiday(self, day: dt.date) -> bool:
        self._load(day.year)
        return day in self._holidays

    def weight(self, day: dt.date) -> Decimal:
        if self.is_holiday(day):
            return ZERO
        return Decimal(self.weights[day.weekday()])

    def total(self, start: dt.date, end: dt.date) -> Decimal:
        """Sum of the weights from `start` to `end`, both included (zero when end < start)."""
        key = (start, end)
        if key not in self._totals:
            out, day = ZERO, start
            while day <= end:
                out += self.weight(day)
                day += dt.timedelta(days=1)
            self._totals[key] = out
        return self._totals[key]
