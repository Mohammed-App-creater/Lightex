"""Demo-data seeder registry (`manage.py seed_demo`).

Core's `seed_demo` creates users, workspaces, roles, members and invitations from the demo fixture, then runs each
registered seeder in registration order. A module registers one in its AppConfig `ready()`:

    register_seeder(TrackingSeeder)

A seeder subclasses `Seeder`; it shares the command's state (`users`, `workspaces`, `roles`, the date helpers,
`stdout`), loads its part of the fixture in `load(data)` and reports its counts in `counts(data)`.
"""

from __future__ import annotations

import datetime as dt
from typing import Any


class SeedContext:
    """State and date helpers shared by the command and every seeder. Every fixture date is shifted by `shift`."""

    shift: dt.timedelta
    users: dict[str, Any]
    workspaces: dict[str, Any]
    roles: dict[str, Any]

    def date(self, value: str | None) -> dt.date | None:
        return dt.date.fromisoformat(value) + self.shift if value else None

    def day(self, value: str) -> dt.date:
        return dt.date.fromisoformat(value) + self.shift

    def moment(self, value: str) -> dt.datetime:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")) + self.shift

    def ts(self, value: str | None) -> dt.datetime | None:
        if not value:
            return None
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")) + self.shift


class Seeder(SeedContext):
    module: str = ""

    @classmethod
    def bound(cls, context: SeedContext) -> Seeder:
        """A seeder that shares (reads and writes) the command's state."""
        seeder = cls.__new__(cls)
        seeder.__dict__ = context.__dict__
        return seeder

    def load(self, data: dict[str, Any]) -> None:
        raise NotImplementedError

    def counts(self, data: dict[str, Any]) -> dict[str, int]:
        """`{label: count}` for the command's summary line."""
        return {}


_SEEDERS: list[type[Seeder]] = []


def register_seeder(seeder: type[Seeder]) -> None:
    if seeder not in _SEEDERS:
        _SEEDERS.append(seeder)


def seeders() -> list[type[Seeder]]:
    return list(_SEEDERS)
