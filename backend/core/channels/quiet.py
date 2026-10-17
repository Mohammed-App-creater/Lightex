"""Quiet hours (docs/v2/38-telegram-sms-push.md §6.6). A day toggle means "the window that starts on this day"."""

from __future__ import annotations

import datetime as dt
import hashlib
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class Quiet:
    enabled: bool
    start: dt.time
    end: dt.time
    days: tuple[bool, ...]  # Mon..Sun
    timezone: str | None

    @classmethod
    def of(cls, prefs: Any) -> Quiet:
        return cls(
            bool(prefs.quiet_enabled),
            prefs.quiet_from,
            prefs.quiet_to,
            days_from_mask(prefs.quiet_days),
            prefs.timezone,
        )

    @property
    def zone(self) -> ZoneInfo | None:
        try:
            return ZoneInfo(self.timezone) if self.timezone else None
        except (ZoneInfoNotFoundError, ValueError):
            return None

    @property
    def active(self) -> bool:
        return self.enabled and self.zone is not None and self.start != self.end and any(self.days)


def days_from_mask(mask: int) -> tuple[bool, ...]:
    return tuple(bool(mask & (1 << i)) for i in range(7))


def mask_from_days(days: list[bool]) -> int:
    return sum(1 << i for i, on in enumerate(days) if on)


def _minutes(t: dt.time) -> int:
    return t.hour * 60 + t.minute


def is_quiet(q: Quiet, at: dt.datetime) -> bool:
    zone = q.zone
    if not q.active or zone is None:
        return False
    local = at.astimezone(zone)
    m, wd = local.hour * 60 + local.minute, local.weekday()
    start, end = _minutes(q.start), _minutes(q.end)
    if start < end:
        return q.days[wd] and start <= m < end
    return (q.days[wd] and m >= start) or (q.days[(wd - 1) % 7] and m < end)


def _to_utc(day: dt.date, wall: dt.time, zone: ZoneInfo) -> dt.datetime:
    """The local wall time as UTC; a time in a DST gap moves to the first valid minute after it, an overlap uses the
    first occurrence (fold=0)."""
    local = dt.datetime.combine(day, wall).replace(tzinfo=zone, fold=0)
    for _ in range(24 * 60):
        utc = local.astimezone(dt.UTC)
        if utc.astimezone(zone).replace(tzinfo=None) == local.replace(tzinfo=None):
            return utc
        local += dt.timedelta(minutes=1)
    return local.astimezone(dt.UTC)  # pragma: no cover - no zone has a gap this long


def window_end(q: Quiet, at: dt.datetime) -> dt.datetime:
    """End of the quiet window containing `at` (call only when `is_quiet`)."""
    zone = q.zone
    assert zone is not None  # noqa: S101 - callers check is_quiet first
    local = at.astimezone(zone)
    m = local.hour * 60 + local.minute
    day = local.date()
    if _minutes(q.start) > _minutes(q.end) and m >= _minutes(q.start):
        day += dt.timedelta(days=1)
    return _to_utc(day, q.end, zone)


def jitter(user_id: Any) -> dt.timedelta:
    """0–120 s per user, so not every summary leaves at 08:00:00."""
    return dt.timedelta(seconds=int(hashlib.sha256(str(user_id).encode()).hexdigest(), 16) % 121)


def release_at(q: Quiet, at: dt.datetime, user_id: Any) -> dt.datetime | None:
    """None when not quiet at `at`; else the jittered end of the window."""
    if not is_quiet(q, at):
        return None
    return window_end(q, at) + jitter(user_id)
