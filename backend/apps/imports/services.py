"""Board 40 import jobs: create (signed upload), analyze, map, start, cancel, dispatch, recover and retention.

The runner itself (preparing → rows → links → finishing) lives in `runner.py`.
"""

from __future__ import annotations

import datetime as dt
import gzip
import json
import logging
import threading
import uuid
from collections import OrderedDict
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.access import services as access
from apps.audit.services import record
from apps.collaboration.services import clean_file_name, extension
from apps.collaboration.storage import expires_at, get_storage
from apps.common.exceptions import ApiError, conflict, forbidden, invalid, not_found
from apps.common.middleware import current_request_id
from apps.common.utils import iso
from apps.planning.models import Epic, Sprint
from apps.projects.models import CustomField, Label, Project, ProjectMember
from apps.tasks.models import Task
from apps.tasks.services import _default_status

from . import parsing
from .models import ACTIVE, TERMINAL, ImportJob
from .planner import PlanProject, PlanResult, analyze_columns, plan_import
from .presets import FIELDS, default_unit, detect_preset, suggest_columns
from .report import report_file_name

logger = logging.getLogger("lightex.imports")

DRAFT_TTL = dt.timedelta(hours=24)
RETENTION = dt.timedelta(days=30)
QUEUED_GRACE = dt.timedelta(seconds=30)

ANALYSIS_TITLES = {
    "upload_missing": "Couldn’t read file",
    "too_large": "File is too large",
    "empty": "File is empty",
    "excel": "Only .csv files",
    "binary": "Not a text file",
    "unclosed_quote": "Unclosed quote",
    "cell_too_long": "A cell is too long",
    "no_rows": "No rows found",
    "header_only": "Header only, no rows",
    "too_many_columns": "Too many columns",
    "too_many_rows": "Too many rows",
}
STARTED_MESSAGE = "This import has already started."
FINISHED_MESSAGE = "This import has finished."
NOT_CREATOR = "Only the person who started this import can change it."
FILE_GONE = "The uploaded file is gone. Start a new import."


# ───────────────────────── permissions ─────────────────────────


def missing_import_permission(user: Any, project: Project) -> str | None:
    """`can_import` (§3.1): project.import and task.create. Returns the first missing code, or None."""
    for code in ("project.import", "task.create"):
        if not access.can(user, code, project):
            return code
    return None


def can_import(user: Any, project: Project) -> bool:
    return missing_import_permission(user, project) is None


def require_import(user: Any, project: Project) -> None:
    code = missing_import_permission(user, project)
    if code is not None:
        raise forbidden(details={"permission": code})


def _require_creator(user: Any, job: ImportJob) -> None:
    if job.created_by_id != user.pk or not can_import(user, job.project):
        raise forbidden(NOT_CREATOR)


def state_error(job: ImportJob) -> ApiError:
    message = FINISHED_MESSAGE if job.status in TERMINAL else STARTED_MESSAGE
    return conflict("import_state", message, {"status": job.status})


# ───────────────────────── storage ─────────────────────────


def _base_key(job: ImportJob) -> str:
    return f"ws/{job.workspace_id}/p/{job.project_id}/imports/{job.pk}"


_parsed_cache: OrderedDict[str, parsing.ParsedFile] = OrderedDict()
_parsed_lock = threading.Lock()
PARSED_CACHE_SIZE = 4


def save_parsed(job: ImportJob, parsed: parsing.ParsedFile) -> None:
    job.parsed_key = f"{_base_key(job)}/parsed.json.gz"
    raw = json.dumps(parsed.to_json(), separators=(",", ":")).encode()
    get_storage().put(job.parsed_key, gzip.compress(raw, compresslevel=5), "application/gzip")
    _remember(job, parsed)


def _remember(job: ImportJob, parsed: parsing.ParsedFile) -> None:
    with _parsed_lock:
        _parsed_cache[job.parsed_key] = parsed
        _parsed_cache.move_to_end(job.parsed_key)
        while len(_parsed_cache) > PARSED_CACHE_SIZE:
            _parsed_cache.popitem(last=False)


def load_parsed(job: ImportJob) -> parsing.ParsedFile | None:
    """The parsed rows (one process-local LRU entry per job), or None when the object is gone."""
    if not job.parsed_key:
        return None
    with _parsed_lock:
        cached = _parsed_cache.get(job.parsed_key)
    if cached is not None:
        return cached
    storage = get_storage()
    info = storage.head(job.parsed_key)
    if info is None:
        return None
    data = json.loads(gzip.decompress(storage.read_prefix(job.parsed_key, info.size)))
    parsed = parsing.ParsedFile.from_json(data)
    _remember(job, parsed)
    return parsed


def _job_keys(job: ImportJob) -> list[str]:
    return [k for k in (job.source_key, job.parsed_key, job.report_key) if k]


def _delete_keys(keys: list[str]) -> None:
    storage = get_storage()
    with _parsed_lock:
        for key in keys:
            _parsed_cache.pop(key, None)
    for key in keys:
        try:
            storage.delete(key)
        except Exception:  # a missing object is fine; anything else is retried by the next purge
            logger.warning("Could not delete import object %s", key)


def delete_project_files(project: Project) -> None:
    """Called by the project purge (Trash): the FK cascade would orphan the storage objects."""
    keys = [k for job in ImportJob.objects.filter(project=project) for k in _job_keys(job)]
    if keys:
        transaction.on_commit(lambda: _delete_keys(keys))


# ───────────────────────── I1 create ─────────────────────────


def create_job(actor: Any, project: Project, data: dict[str, Any]) -> tuple[ImportJob, str, dict[str, str]]:
    require_import(actor, project)
    errors: dict[str, str] = {}
    details: dict[str, Any] = {}
    source = data.get("source")
    if source == "trello":
        errors["source"] = "Trello import is coming soon"
    elif source not in ("csv", "jira"):
        errors["source"] = "Pick CSV or Jira"
    file_name = clean_file_name(data.get("fileName"))
    size = data.get("size")
    if extension(file_name) != "csv":
        errors["file"] = "Only .csv files"
    elif isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        errors["file"] = "File is empty"
    elif size > settings.MAX_UPLOAD_BYTES:
        errors["file"] = "File is too large"
        details["file"] = {"reason": "too_large", "size": size}
    if errors:
        raise ApiError(422, "validation_failed", next(iter(errors.values())), {"fields": errors, **details})
    job_id = uuid.uuid4()
    now = timezone.now()
    job = ImportJob(
        pk=job_id,
        workspace_id=project.workspace_id,
        project=project,
        created_by=actor,
        source=str(source),
        file_name=file_name,
        file_size=int(size),  # type: ignore[arg-type]
        created_at=now,
        expires_at=now + DRAFT_TTL,
    )
    job.source_key = f"{_base_key(job)}/source.csv"
    job.save()
    url, headers = get_storage().presigned_put(job.source_key, "text/csv", settings.UPLOAD_URL_TTL_SECONDS)
    return job, url, headers


# ───────────────────────── planning context ─────────────────────────


def plan_project(job: ImportJob, project: Project | None = None) -> PlanProject:
    """A snapshot of the target project for planning, from the point of view of the job's creator."""
    project = project or job.project
    statuses = list(project.statuses.order_by("position", "created_at"))
    members = [
        {"id": str(uid), "name": name, "email": email}
        for uid, name, email in ProjectMember.objects.filter(project=project)
        .order_by("added_at", "user__name")
        .values_list("user_id", "user__name", "user__email")
    ]
    creator = job.created_by
    perms = access.project_permissions(creator, project) if creator is not None else frozenset()
    fields = list(CustomField.objects.filter(project=project).prefetch_related("options").order_by("position"))
    tasks = [
        {"id": str(i), "key": k, "parentId": p and str(p), "sprintId": s and str(s), "epicId": e and str(e)}
        for i, k, p, s, e in Task.objects.filter(project=project).values_list(
            "id", "key", "parent_id", "sprint_id", "epic_id"
        )
    ]
    return PlanProject(
        key=project.key,
        task_seq=project.task_seq,
        statuses=[{"id": str(s.pk), "name": s.name, "glyph": s.glyph, "position": s.position} for s in statuses],
        default_status_id=str(_default_status(project).pk),
        members=members,
        importer_id=str(job.created_by_id or ""),
        perms=frozenset(perms),
        labels=[{"id": str(i), "name": n} for i, n in Label.objects.filter(project=project).values_list("id", "name")],
        epics=[
            {"id": str(i), "name": n}
            for i, n in Epic.objects.filter(project=project).order_by("created_at").values_list("id", "name")
        ],
        sprints=[
            {"id": str(i), "name": n}
            for i, n in Sprint.objects.filter(project=project)
            .exclude(state="completed")
            .order_by("number")
            .values_list("id", "name")
        ],
        custom_fields=[
            {
                "id": str(f.pk),
                "name": f.name,
                "type": f.type,
                "options": [
                    {"id": str(o.pk), "name": o.name} for o in sorted(f.options.all(), key=lambda o: o.position)
                ],
            }
            for f in fields
        ],
        tasks=tasks,
    )


def user_maps(job: ImportJob) -> dict[str, dict[str, Any]]:
    stored = (job.mapping or {}).get("_user") or {}
    return {k: dict(stored.get(k) or {}) for k in ("statuses", "types", "people")}


def stored_columns(job: ImportJob) -> list[dict[str, Any]]:
    return list((job.mapping or {}).get("columns") or [])


def _replan(
    job: ImportJob, parsed: parsing.ParsedFile, columns: list[dict[str, Any]], maps: dict, revision: int
) -> PlanResult:
    """Plans with the user's explicit choices; keys that no longer occur are dropped from them (§4.5)."""
    plan = plan_import(parsed, columns, maps, plan_project(job), revision)
    values = plan.validation["values"]
    kept = {
        name: {k: v for k, v in (maps.get(name) or {}).items() if any(x["key"] == k for x in values[name])}
        for name in ("statuses", "types", "people")
    }
    job.mapping = {**plan.mapping, "_user": kept}
    job.mapping_revision = revision
    job.validation = plan.validation
    return plan


def dry_run(job: ImportJob) -> PlanResult | None:
    parsed = load_parsed(job)
    if parsed is None or job.mapping is None:
        return None
    return plan_import(parsed, stored_columns(job), user_maps(job), plan_project(job), job.mapping_revision)


# ───────────────────────── I2 analyze ─────────────────────────


def _analysis_error(reason: str, **detail: Any) -> ApiError:
    title = ANALYSIS_TITLES.get(reason, ANALYSIS_TITLES["upload_missing"])
    return ApiError(422, "validation_failed", title, {"fields": {"file": title}, "file": {"reason": reason, **detail}})


def analyze(actor: Any, job: ImportJob) -> ImportJob:
    _require_creator(actor, job)
    if job.status == "ready":
        return job
    if job.status != "draft":
        raise state_error(job)
    storage = get_storage()
    info = storage.head(job.source_key)
    if info is None:
        raise _analysis_error("upload_missing")
    limit = settings.MAX_UPLOAD_BYTES
    if info.size > limit:
        raise _analysis_error("too_large", size=info.size)
    if info.size == 0:
        raise _analysis_error("empty")
    data = storage.read_prefix(job.source_key, limit + 1)
    if len(data) > limit:
        raise _analysis_error("too_large", size=len(data))
    try:
        parsed, encoding = parsing.read_file(data, settings.IMPORT_MAX_ROWS)
    except parsing.ParseError as exc:
        raise _analysis_error(exc.reason, **exc.detail) from exc
    with transaction.atomic():
        job = ImportJob.objects.select_for_update(of=("self",)).select_related("project", "created_by").get(pk=job.pk)
        if job.status == "ready":
            return job
        if job.status != "draft":  # canceled while the file was being read
            raise state_error(job)
        save_parsed(job, parsed)
        context = plan_project(job)
        job.preset = detect_preset(parsed.raw_header)
        job.file_size = len(data)
        job.encoding = encoding
        job.delimiter = parsed.delimiter
        job.row_count = len(parsed.rows)
        job.column_count = len(parsed.header)
        job.analysis = {"columns": analyze_columns(parsed, context.members)}
        job.status = "ready"
        columns = suggest_columns(parsed.raw_header, job.preset, context.custom_fields)
        _replan(job, parsed, columns, {"statuses": {}, "types": {}, "people": {}}, 0)
        job.save()
    return job


# ───────────────────────── I4 mapping ─────────────────────────


def _check_mapping(actor: Any, job: ImportJob, data: dict[str, Any], raw_header: list[str]) -> list[dict[str, Any]]:
    project = job.project
    errors: dict[str, str] = {}
    raw_columns = data.get("columns")
    if not isinstance(raw_columns, list) or len(raw_columns) != job.column_count:
        errors["columns"] = "Send one entry per column"
        raw_columns = raw_columns if isinstance(raw_columns, list) else []
    field_ids = {str(i) for i in CustomField.objects.filter(project=project).values_list("id", flat=True)}
    columns: list[dict[str, Any]] = []
    for i, c in enumerate(raw_columns):
        fld = c.get("field") if isinstance(c, dict) else None
        if fld not in FIELDS:
            errors[f"columns.{i}.field"] = "Pick a field"
            columns.append({"field": "skip"})
        elif fld == "customField":
            cf = c.get("customFieldId")
            if str(cf) not in field_ids:
                errors[f"columns.{i}.customFieldId"] = "This field was deleted"
            columns.append({"field": fld, "customFieldId": str(cf)})
        elif fld == "timeEstimate":
            unit = c.get("unit")
            if unit not in ("minutes", "hours", "seconds"):
                unit = default_unit(job.preset, raw_header[i] if i < len(raw_header) else "")
            columns.append({"field": fld, "unit": unit})
        else:
            columns.append({"field": fld})
    perms = access.project_permissions(actor, project)
    status_ids = {str(i) for i in project.statuses.values_list("id", flat=True)}
    member_ids = {str(i) for i in ProjectMember.objects.filter(project=project).values_list("user_id", flat=True)}
    maps: dict[str, Any] = {}
    for name in ("statuses", "types", "people"):
        raw = data.get(name)
        maps[name] = raw if isinstance(raw, dict) else {}
    for k, v in maps["statuses"].items():
        if v is not None and str(v) not in status_ids:
            errors[f"statuses.{k}"] = "Pick a status from this project"
    for k, v in maps["types"].items():
        if v is None:
            continue
        if v not in ("feature", "bug", "chore", "spike", "epic"):
            errors[f"types.{k}"] = "Pick feature, bug, chore, spike or epic"
        elif v == "epic" and "epic.manage" not in perms:
            errors[f"types.{k}"] = "You can’t create epics in this project"
    for k, v in maps["people"].items():
        if v is None:
            continue
        if str(v) not in member_ids:
            errors[f"people.{k}"] = "Pick someone on this project"
        elif str(v) != str(actor.pk) and "task.assign" not in perms:
            errors[f"people.{k}"] = "You can only assign tasks to yourself"
    if errors:
        raise invalid(errors)
    return columns


def save_mapping(actor: Any, job: ImportJob, data: dict[str, Any]) -> ImportJob:
    from .selectors import job_data

    _require_creator(actor, job)
    with transaction.atomic():
        job = ImportJob.objects.select_for_update(of=("self",)).select_related("project", "created_by").get(pk=job.pk)
        if job.status != "ready":
            raise state_error(job)
        revision = data.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision <= job.mapping_revision:
            raise conflict("mapping_conflict", "This mapping was changed in another tab.", {"current": job_data(job)})
        parsed = load_parsed(job)
        if parsed is None:
            raise conflict("import_state", FILE_GONE, {"status": job.status})
        columns = _check_mapping(actor, job, data, parsed.raw_header)
        maps = {
            name: {str(k): v for k, v in (data.get(name) or {}).items()} for name in ("statuses", "types", "people")
        }
        _replan(job, parsed, columns, maps, revision)
        job.save()
    return job


# ───────────────────────── I6 start ─────────────────────────


def start(actor: Any, job: ImportJob) -> ImportJob:
    _require_creator(actor, job)
    with transaction.atomic():
        job = ImportJob.objects.select_for_update(of=("self",)).select_related("project", "created_by").get(pk=job.pk)
        if job.status in ACTIVE:
            return job
        if job.status not in ("ready", "failed"):
            raise state_error(job)
        if job.status == "failed" and job.error_code == "file_missing":
            raise conflict("import_state", FILE_GONE, {"status": job.status})
        if job.status == "ready":
            parsed = load_parsed(job)
            if parsed is None:
                raise conflict("import_state", FILE_GONE, {"status": job.status})
            _replan(job, parsed, stored_columns(job), user_maps(job), job.mapping_revision)
            blockers = (job.validation or {}).get("blockers") or []
            if blockers:
                job.save(update_fields=["mapping", "validation", "updated_at"])
                message = blockers[0]["message"]
                raise ApiError(
                    422, "validation_failed", message, {"fields": {"mapping": message}, "blockers": blockers}
                )
        busy = ImportJob.objects.filter(project_id=job.project_id, status__in=ACTIVE).exclude(pk=job.pk).first()
        if busy is not None:
            raise _in_progress(busy.pk)
        first_start = not job.started
        job.status = "queued"
        job.request_id = job.request_id or current_request_id() or f"req_{uuid.uuid4().hex[:16]}"
        job.phase = job.phase or "preparing"
        job.error_code = job.error_message = ""
        job.finished_at = None
        job.expires_at = None
        job.heartbeat_at = None
        job.lease_token = None
        job.cancel_requested = False
        try:
            with transaction.atomic():
                job.save()
        except IntegrityError:
            busy = ImportJob.objects.filter(project_id=job.project_id, status__in=ACTIVE).exclude(pk=job.pk).first()
            raise _in_progress(busy.pk if busy else None) from None
        if first_start:
            record(
                workspace=job.workspace_id,
                project=job.project_id,
                actor=actor,
                action="project.import_started",
                target=job.file_name,
                entity_id=job.pk,
                entity_key=job.project.key,
                data={
                    "importId": str(job.pk),
                    "fileName": job.file_name,
                    "source": job.source,
                    "preset": job.preset,
                    "rows": job.row_count,
                },
                source="import",
                request_id=job.request_id,
            )
        job_id = job.pk
        transaction.on_commit(lambda: dispatch(job_id))
    job.refresh_from_db()
    return job


def _in_progress(job_id: Any) -> ApiError:
    return conflict(
        "import_in_progress",
        "Another import is running in this project. Try again when it finishes.",
        {"jobId": str(job_id) if job_id else None},
    )


# ───────────────────────── I7 cancel ─────────────────────────


def cancel(actor: Any, job: ImportJob) -> ImportJob:
    if job.created_by_id != actor.pk and not access.can(actor, "project.update", job.project):
        raise forbidden("Only the person who started this import can stop it.", {"permission": "project.update"})
    keys: list[str] = []
    with transaction.atomic():
        job = ImportJob.objects.select_for_update().get(pk=job.pk)
        if job.status in ("completed", "canceled"):
            raise state_error(job)
        now = timezone.now()
        if job.status == "running":
            job.cancel_requested = True
            job.save(update_fields=["cancel_requested", "updated_at"])
            return job
        if job.status in ("draft", "ready"):
            # The file goes now; the row is purged by retention.
            keys = _job_keys(job)
            job.finished_at = now
        elif job.status == "queued":
            job.finished_at = now
            job.expires_at = now + RETENTION
        job.status = "canceled"
        job.save()
    if keys:
        transaction.on_commit(lambda: _delete_keys(keys))
    return job


# ───────────────────────── dispatch and recovery (§5.1) ─────────────────────────


def runner_mode() -> str:
    mode = getattr(settings, "IMPORT_RUNNER", "auto")
    if mode == "auto":
        return "thread" if settings.CELERY_TASK_ALWAYS_EAGER else "celery"
    return mode


def dispatch(job_id: Any) -> None:
    """Hands the job to a runner: Celery with a broker, a daemon thread without one, inline in tests."""
    from . import runner

    mode = runner_mode()
    if mode == "inline":
        runner.run(str(job_id))
    elif mode == "celery":
        from .tasks import run_import

        run_import.delay(str(job_id))
    else:
        threading.Thread(target=runner.run_import_safely, args=(str(job_id),), daemon=True).start()


def is_stale(job: ImportJob, now: dt.datetime | None = None) -> bool:
    if job.status not in ACTIVE:
        return False
    now = now or timezone.now()
    lease = dt.timedelta(seconds=settings.IMPORT_LEASE_SECONDS)
    if job.heartbeat_at is not None:
        return job.heartbeat_at < now - lease
    return job.status == "queued" and job.updated_at < now - QUEUED_GRACE


def recover_if_stale(job: ImportJob) -> bool:
    """The I3 poll's side effect: re-dispatch a job whose runner died. The lease makes it idempotent."""
    if is_stale(job):
        transaction.on_commit(lambda: dispatch(job.pk))
        return True
    return False


def resume_stale() -> int:
    """`manage.py resume_imports`: re-dispatches every stale queued/running job."""
    count = 0
    for job in ImportJob.objects.filter(status__in=ACTIVE).defer("analysis", "mapping", "validation"):
        if is_stale(job):
            dispatch(job.pk)
            count += 1
    return count


# ───────────────────────── I8 error report ─────────────────────────


def error_report(job: ImportJob) -> dict[str, Any]:
    if job.status not in TERMINAL or not job.report_key:
        raise not_found("This import has no error report.")
    ttl = settings.IMPORT_REPORT_URL_TTL_SECONDS
    url = get_storage().presigned_get(
        job.report_key,
        file_name=report_file_name(job.project.key, job.finished_at),
        content_type="text/csv; charset=utf-8",
        inline=False,
        expires=ttl,
    )
    return {
        "url": url,
        "fileName": report_file_name(job.project.key, job.finished_at),
        "expiresAt": iso(expires_at(ttl)),
    }


# ───────────────────────── retention (§2.5) ─────────────────────────


def purge_expired(now: dt.datetime | None = None) -> dict[str, int]:
    """Untouched drafts → canceled; expired jobs that aren't running → storage objects, then the row."""
    now = now or timezone.now()
    canceled = ImportJob.objects.filter(status__in=("draft", "ready"), expires_at__lt=now).update(
        status="canceled", finished_at=now, updated_at=now
    )
    expired = list(
        ImportJob.objects.filter(expires_at__lt=now)
        .exclude(status__in=ACTIVE)
        .only("id", "source_key", "parsed_key", "report_key")
    )
    for job in expired:
        _delete_keys(_job_keys(job))
    deleted = ImportJob.objects.filter(pk__in=[j.pk for j in expired]).delete()[0] if expired else 0
    return {"drafts canceled": canceled, "jobs deleted": len(expired), "rows deleted": max(0, deleted - len(expired))}


def recent_jobs(project: Project) -> list[ImportJob]:
    """I9: newest first, max 20, drafts excluded (jobs purged by retention are simply gone)."""
    return list(
        ImportJob.objects.filter(project=project)
        .exclude(status="draft")
        .defer("analysis", "mapping", "validation")
        .order_by("-created_at", "-id")[:20]
    )
