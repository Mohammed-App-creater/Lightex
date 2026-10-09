import datetime as dt
import re
import secrets
from typing import Any

from django.utils import timezone


def random_hue() -> int:
    return secrets.randbelow(360)


def today() -> dt.date:
    return timezone.now().date()


def iso(value: dt.datetime | dt.date | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        return value.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")
    return value.isoformat()


_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)


def iso_date(value: Any) -> dt.date | None:
    """A real calendar date written exactly YYYY-MM-DD, else None (2026-02-30, 2026-1-5, 20261005 are refused)."""
    if not isinstance(value, str) or not _ISO_DATE.fullmatch(value):
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


def as_list(value) -> list[str]:
    """Query param (single or repeated) → list of non-empty strings."""
    if value is None:
        return []
    items = value if isinstance(value, list | tuple) else [value]
    return [str(v) for v in items if v not in (None, "")]
