"""Board 40 reads: job lookup (job → project → membership), the ImportJob / ImportJobSummary payloads and I5 rows."""

from __future__ import annotations

import uuid
from typing import Any

from apps.common.exceptions import ApiError, invalid, not_found
from apps.common.pagination import paginate_list
from apps.common.utils import iso
from apps.projects.selectors import project_for

from . import services
from .models import TERMINAL, ImportJob, ImportRow
from .report import ordered_issues

OUTCOME_FILTERS = ("all", "task", "epic", "skipped", "warning")


def job_for(user: Any, job_id: Any) -> ImportJob:
    """A job id resolves like v1: unknown or another workspace → 404; not on the project → 403
    `project_membership_required` (raised by `project_for`)."""
    try:
        uuid.UUID(str(job_id))
    except (TypeError, ValueError) as exc:
        raise not_found("Import not found.") from exc
    job = ImportJob.objects.select_related("project", "project__workspace", "created_by").filter(pk=job_id).first()
    if job is None or job.project.deleted_at is not None:
        raise not_found("Import not found.")
    try:
        project_for(user, job.project_id)
    except ApiError as exc:
        if exc.status_code == 404:
            raise not_found("Import not found.") from exc
        raise
    return job


def _progress(job: ImportJob) -> dict[str, Any] | None:
    if not job.started:
        return None
    return {
        "phase": job.phase or "preparing",
        "total": job.row_count,
        "processed": job.cursor,
        "imported": job.imported,
        "epics": job.epics_created,
        "skipped": job.skipped,
        "warnings": job.warnings,
        "recent": job.recent or [],
    }


def _result(job: ImportJob) -> dict[str, Any] | None:
    if job.status not in TERMINAL or not job.started:
        return None
    issues: list[dict[str, Any]] = []
    for row, row_issues in ImportRow.objects.filter(job=job).exclude(issues=[]).values_list("row", "issues"):
        issues.extend({"row": row, **i} for i in row_issues)
    issues = ordered_issues(issues)
    created = (job.setup or {}).get("created") or {}
    return {
        "imported": job.imported,
        "epics": job.epics_created,
        "skipped": job.skipped,
        "warnings": job.warnings,
        "firstKey": job.first_key or None,
        "lastKey": job.last_key or None,
        "created": {
            "labels": int(created.get("labels", 0)),
            "epics": int(created.get("epics", 0)),
            "options": int(created.get("options", 0)),
        },
        "hasErrorReport": bool(job.report_key),
        "issueCount": len(issues),
        "issues": [
            {
                "row": i["row"],
                "severity": i["severity"],
                "field": i.get("field"),
                "reason": i["reason"],
                "value": i.get("value", ""),
            }
            for i in issues[:50]
        ],
    }


def _error(job: ImportJob) -> dict[str, str] | None:
    if job.status != "failed":
        return None
    return {"code": job.error_code, "message": job.error_message}


def _public_mapping(job: ImportJob) -> dict[str, Any] | None:
    if job.mapping is None or job.status == "draft":
        return None
    return {k: v for k, v in job.mapping.items() if not k.startswith("_")}


def job_data(job: ImportJob) -> dict[str, Any]:
    draft = job.status == "draft" or job.analysis is None
    return {
        "id": str(job.pk),
        "projectId": str(job.project_id),
        "source": job.source,
        "preset": job.preset,
        "status": job.status,
        "cancelRequested": job.cancel_requested,
        "file": {
            "name": job.file_name,
            "size": job.file_size,
            "encoding": job.encoding,
            "delimiter": job.delimiter,
            "rowCount": job.row_count,
            "columnCount": job.column_count,
        },
        "analysis": None if draft else job.analysis,
        "mapping": None if draft else _public_mapping(job),
        "validation": None if draft else job.validation,
        "progress": _progress(job),
        "result": _result(job),
        "error": _error(job),
        "createdById": str(job.created_by_id) if job.created_by_id else None,
        "createdAt": iso(job.created_at),
        "startedAt": iso(job.started_at),
        "finishedAt": iso(job.finished_at),
        "expiresAt": iso(job.expires_at),
    }


def summary_data(job: ImportJob) -> dict[str, Any]:
    return {
        "id": str(job.pk),
        "projectId": str(job.project_id),
        "source": job.source,
        "status": job.status,
        "fileName": job.file_name,
        "imported": job.imported,
        "skipped": job.skipped,
        "firstKey": job.first_key or None,
        "lastKey": job.last_key or None,
        "hasErrorReport": bool(job.report_key) and job.status in TERMINAL,
        "createdById": str(job.created_by_id) if job.created_by_id else None,
        "createdAt": iso(job.created_at),
        "startedAt": iso(job.started_at),
        "finishedAt": iso(job.finished_at),
        "expiresAt": iso(job.expires_at),
        "error": _error(job),
    }


def _fallback_values(title: str, outcome: str) -> dict[str, Any]:
    return {
        "title": title,
        "type": "epic" if outcome == "epic" else "feature",
        "statusId": None,
        "assigneeId": None,
        "priority": 0,
        "estimate": None,
        "timeEstimateMinutes": None,
        "startDate": None,
        "dueDate": None,
        "labels": [],
        "epic": None,
        "sprintId": None,
        "parent": None,
        "customFields": {},
    }


def rows_page(job: ImportJob, params: Any, outcome: str | None) -> dict[str, Any]:
    """I5: a dry run of the current mapping before start; actual outcomes and keys from ImportRow after."""
    outcome = outcome or "all"
    if outcome not in OUTCOME_FILTERS:
        raise invalid({"filter[outcome]": "Pick all, task, epic, skipped or warning"})
    rows: list[dict[str, Any]] = []
    if job.status == "ready":
        plan = services.dry_run(job)
        rows = [r.preview() for r in plan.rows] if plan is not None else []
    elif job.status != "draft":
        plan = services.dry_run(job)
        planned = {r.row: r for r in plan.rows} if plan is not None else {}
        for row, out, issues, key, title in (
            ImportRow.objects.filter(job=job)
            .order_by("row")
            .values_list("row", "outcome", "issues", "task__key", "task__title")
        ):
            p = planned.get(row)
            values = p.values if p is not None else _fallback_values(title or "", out)
            rows.append({"row": row, "outcome": out, "key": key, "issues": issues, "values": values})
    if outcome == "warning":
        rows = [r for r in rows if any(i["severity"] == "warning" for i in r["issues"])]
    elif outcome != "all":
        rows = [r for r in rows if r["outcome"] == outcome]
    return paginate_list(rows, params, default_limit=20, max_limit=100)
