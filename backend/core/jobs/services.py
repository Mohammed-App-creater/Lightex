"""Running jobs, and the idempotency helper jobs use."""

from __future__ import annotations

import datetime as dt
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from core.common import scoping
from core.common.exceptions import not_found
from core.modules.services import is_enabled, request_cache
from core.workspaces.timezone import workspace_now

from .models import JobMark
from .registry import JobDef, get_job

logger = logging.getLogger("lightex.jobs")

RAN, SKIPPED, FAILED = "ran", "skipped", "failed"


@dataclass
class JobResult:
    job: str
    workspaces: list[dict[str, Any]] = field(default_factory=list)

    def count(self, status: str) -> int:
        return sum(1 for w in self.workspaces if w["status"] == status)

    def as_dict(self) -> dict[str, Any]:
        return {
            "job": self.job,
            "ran": self.count(RAN),
            "skipped": self.count(SKIPPED),
            "failed": self.count(FAILED),
            "workspaces": self.workspaces,
        }


def claim(workspace: Any, job: str, key: str) -> bool:
    """Marks (workspace, job, key) as done. True the first time, False once it is claimed: guard the work with it so a
    second run does nothing (`if claim(ws, "sales_followup_digest", str(today)): send(...)`). Inside a job the mark
    commits or rolls back with the job's work."""
    wid = getattr(workspace, "pk", workspace)
    try:
        with transaction.atomic():
            JobMark.objects.create(workspace_id=wid, job=job, key=str(key)[:200])
    except IntegrityError:
        return False
    return True


def resolve(name: str) -> JobDef:
    job = get_job(name)
    if job is None:
        raise not_found("Job not found.")
    return job


def _workspaces(workspace_id: Any = None) -> list[Any]:
    from core.workspaces.models import Workspace

    if workspace_id is None:
        return list(Workspace.objects.order_by("created_at"))  # live workspaces only (soft delete)
    try:
        pk = uuid.UUID(str(workspace_id))
    except (TypeError, ValueError):
        pk = None
    ws = Workspace.objects.filter(pk=pk).first() if pk else None
    if ws is None:
        raise not_found("Workspace not found.")
    return [ws]


def run_job(name: str, *, workspace_id: Any = None, now: dt.datetime | None = None) -> JobResult:
    """Runs job `name` for every live workspace (or one), each in its own transaction scoped to that workspace, with
    `now` in the workspace time zone. A failure in one workspace is logged and reported; the others still run."""
    job = resolve(name)
    instant = now or timezone.now()
    result = JobResult(job.name)
    for ws in _workspaces(workspace_id):
        result.workspaces.append(_run_one(job, ws, instant))
    logger.info(
        "job %s ran=%d skipped=%d failed=%d", job.name, result.count(RAN), result.count(SKIPPED), result.count(FAILED)
    )
    return result


def _run_one(job: JobDef, ws: Any, instant: dt.datetime) -> dict[str, Any]:
    row: dict[str, Any] = {"workspaceId": str(ws.pk)}
    with request_cache(), scoping.workspace_context(ws):
        if job.module is not None and not is_enabled(ws, job.module):
            return {**row, "status": SKIPPED}
        try:
            with transaction.atomic():
                job.func(ws, now=workspace_now(ws, instant))
        except Exception as exc:
            logger.exception("job %s failed in workspace %s", job.name, ws.pk)
            return {**row, "status": FAILED, "error": type(exc).__name__}
    return {**row, "status": RAN}
