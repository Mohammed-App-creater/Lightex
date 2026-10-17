"""Scheduled jobs (sales S0): modules register named, idempotent, per-workspace jobs from AppConfig `ready()`.

    register_job("sales_followup_digest", send_digest, module="sales", schedule="daily 07:30",
                 description="Morning digest of follow-ups due today")

`func(workspace, *, now)` runs once per live workspace, where `now` is the run's instant in the workspace time zone.
The runner (`core.jobs.services.run_job`) skips workspaces where `module` is disabled. Jobs are triggered by
`manage.py run_job`, `POST /api/v1/internal/jobs/{name}` (external cron) or the Celery task `core.jobs.run_job`.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

JobFunc = Callable[..., Any]
_NAME = re.compile(r"^[a-z][a-z0-9_]{1,63}$")


@dataclass(frozen=True)
class JobDef:
    name: str
    func: JobFunc
    #: The module the job belongs to (skipped where it is disabled), or None for a core job.
    module: str | None = None
    #: The suggested schedule, for whoever configures cron ("daily 07:30", "hourly", "0 18 * * 1-5").
    schedule: str = ""
    description: str = ""


_JOBS: dict[str, JobDef] = {}


def register_job(
    name: str, func: JobFunc, *, module: str | None = None, schedule: str = "", description: str = ""
) -> JobDef:
    """Registers (or replaces) a job. Names are lowercase snake case, prefixed with the module key."""
    if not _NAME.match(name):
        raise ValueError(f"Job name {name!r} must be lowercase letters, digits and underscores")
    job = JobDef(name, func, module, schedule, description)
    _JOBS[name] = job
    return job


def unregister_job(name: str) -> None:
    """Test helper."""
    _JOBS.pop(name, None)


def get_job(name: str) -> JobDef | None:
    return _JOBS.get(name)


def jobs() -> list[JobDef]:
    return sorted(_JOBS.values(), key=lambda j: j.name)
