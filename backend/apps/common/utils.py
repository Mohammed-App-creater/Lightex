import datetime as dt
import secrets

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


def as_list(value) -> list[str]:
    """Query param (single or repeated) → list of non-empty strings."""
    if value is None:
        return []
    items = value if isinstance(value, list | tuple) else [value]
    return [str(v) for v in items if v not in (None, "")]
