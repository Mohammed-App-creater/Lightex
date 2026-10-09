"""Board 40 runner (§5): preparing → rows (batches of IMPORT_BATCH_SIZE) → links → finishing.

`run()` first takes the job's **lease** with one conditional UPDATE, so duplicate deliveries and re-dispatches are
harmless. Every step is one transaction that re-reads the job FOR UPDATE, checks the lease, the cancel flag, the
project and the creator's permissions, does its work, then commits the counters, `cursor` and heartbeat together.
A restart re-plans (planning is deterministic) and continues at `phase` / `cursor`; `ImportRow` (unique per job and
row) keeps batches idempotent.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from django.conf import settings
from django.contrib.postgres.search import SearchVector
from django.db import InterfaceError, OperationalError, connection, transaction
from django.db.models import Case, DateTimeField, F, Q, TextField, Value, When
from django.db.models.functions import Coalesce
from django.utils import timezone

from apps.access import services as access
from apps.audit.services import change, record, record_many
from apps.collaboration.storage import get_storage
from apps.common import fractional
from apps.common.exceptions import ApiError
from apps.common.richtext import doc_text, plain_doc, sanitize_doc
from apps.notifications.events import emit
from apps.planning.models import Epic, Sprint, SprintScopeChange
from apps.projects.models import FIELD_COLORS, CustomField, CustomFieldOption, Label, Project, ProjectMember, Status
from apps.tasks.domain import apply_status
from apps.tasks.models import Task, TaskDependency, TaskFieldValue, TaskLabel, TaskStatusHistory
from apps.tasks.services import DEPENDENCY_LIMIT, rebalance_column

from . import services
from .models import ACTIVE, ImportJob, ImportRow
from .parsing import ParsedFile
from .planner import PlannedRow, PlanResult, plan_import
from .report import build_report

logger = logging.getLogger("lightex.imports")

DB_ERRORS = (OperationalError, InterfaceError)
MAX_OPTION_NAME = 32
MAX_EPIC_NAME = 80


class LeaseLost(Exception):
    """Another runner owns the job now (or it is no longer queued/running)."""


@dataclass
class Context:
    job_id: str
    token: uuid.UUID
    parsed: ParsedFile | None
    plan: PlanResult | None


# ───────────────────────── entry points ─────────────────────────


def take_lease(job_id: Any) -> uuid.UUID | None:
    """The §5.1 lease: one UPDATE that succeeds only for a queued/running job without a live heartbeat."""
    token = uuid.uuid4()
    now = timezone.now()
    stale = now - dt.timedelta(seconds=settings.IMPORT_LEASE_SECONDS)
    taken = (
        ImportJob.objects.filter(pk=job_id, status__in=ACTIVE)
        .filter(Q(heartbeat_at__isnull=True) | Q(heartbeat_at__lt=stale))
        .update(
            lease_token=token,
            heartbeat_at=now,
            status="running",
            started_at=Coalesce(F("started_at"), Value(now, output_field=DateTimeField())),
            updated_at=now,
        )
    )
    return token if taken else None


def run(job_id: str, *, retries: int | None = None, raise_db_errors: bool = False) -> None:
    """Runs (or resumes) a job to a terminal state. DB errors retry the step `retries` times (thread runner);
    with `raise_db_errors` they release the lease and propagate (Celery retries the task)."""
    token = take_lease(job_id)
    if token is None:
        return
    ctx = Context(job_id=str(job_id), token=token, parsed=None, plan=None)
    attempts = settings.IMPORT_RETRIES if retries is None else retries
    try:
        if not _attempt(ctx, _load, attempts, raise_db_errors):
            return
        while _attempt(ctx, _step, attempts, raise_db_errors):
            pass
    except LeaseLost:
        return


def run_import_safely(job_id: str) -> None:
    """Thread target (no broker): runs the job, then closes this thread's DB connection."""
    try:
        run(job_id)
    except Exception:
        logger.exception("Import %s crashed", job_id)
    finally:
        connection.close()


def fail_after_error(job_id: str) -> None:
    """Celery's last retry failed: mark the job failed (tasks created so far are kept)."""
    with transaction.atomic():
        job = _job(job_id)
        if job is not None and job.status in ACTIVE:
            _fail(None, job, "import_failed", _failed_message(job.imported))


def _attempt(ctx: Context, step, attempts: int, raise_db_errors: bool) -> bool:
    tries = 0
    while True:
        try:
            return bool(step(ctx))
        except LeaseLost:
            raise
        except DB_ERRORS:
            if raise_db_errors:
                _release(ctx)
                raise
            tries += 1
            if tries > attempts:
                logger.exception("Import %s: database error, giving up", ctx.job_id)
                _fail_from_error(ctx)
                return False
            logger.warning("Import %s: database error, retrying (%s/%s)", ctx.job_id, tries, attempts)
            if not connection.in_atomic_block:
                connection.close_if_unusable_or_obsolete()
            time.sleep(settings.IMPORT_RETRY_DELAY_SECONDS)
        except Exception:
            logger.exception("Import %s failed", ctx.job_id)
            _fail_from_error(ctx)
            return False


def _release(ctx: Context) -> None:
    try:
        ImportJob.objects.filter(pk=ctx.job_id, lease_token=ctx.token).update(heartbeat_at=None)
    except Exception:  # the database may be unreachable; the stale heartbeat recovers the job later
        logger.warning("Import %s: could not release the lease", ctx.job_id)


def _fail_from_error(ctx: Context) -> None:
    try:
        with transaction.atomic():
            job = _job(ctx.job_id)
            if job is not None and job.status in ACTIVE and job.lease_token == ctx.token:
                _fail(ctx, job, "import_failed", _failed_message(job.imported))
    except Exception:
        logger.exception("Import %s: could not record the failure", ctx.job_id)


# ───────────────────────── steps ─────────────────────────


def _job(job_id: str) -> ImportJob | None:
    return (
        ImportJob.objects.select_for_update(of=("self",))
        .select_related("project", "project__workspace", "created_by")
        .filter(pk=job_id)
        .first()
    )


def _lock(ctx: Context) -> ImportJob:
    job = _job(ctx.job_id)
    if job is None or job.lease_token != ctx.token or job.status != "running":
        raise LeaseLost
    return job


def _load(ctx: Context) -> bool:
    """Reads the parsed file and plans every row (outside any transaction). A missing file fails the job."""
    job = ImportJob.objects.select_related("project", "created_by").get(pk=ctx.job_id)
    parsed = services.load_parsed(job)
    if parsed is None:
        with transaction.atomic():
            _fail(ctx, _lock(ctx), "file_missing", services.FILE_GONE)
        return False
    mapping = job.mapping or {}
    explicit = {k: dict(mapping.get(k) or {}) for k in ("statuses", "types", "people")}
    ctx.parsed = parsed
    ctx.plan = plan_import(
        parsed, services.stored_columns(job), explicit, services.plan_project(job), job.mapping_revision
    )
    return True


def _step(ctx: Context) -> bool:
    """One transaction. Returns True while there is more to do."""
    with transaction.atomic():
        job = _lock(ctx)
        problem = _guard(job)
        if problem is not None:
            _fail(ctx, job, *problem)
            return False
        phase = job.phase or "preparing"
        if job.cancel_requested:
            if phase == "preparing":
                _finish(ctx, job)
                return False
            if phase == "rows":
                # Stop after the batch that just committed: link what was imported, then finish as canceled.
                job.phase = "links"
                job.setup = {**job.setup, "onlyProcessed": True}
                _save(job)
                return True
        if phase == "preparing":
            _prepare(ctx, job)
        elif phase == "rows":
            _rows(ctx, job)
        elif phase == "links":
            _links(ctx, job)
        else:
            _finish(ctx, job)
            return False
        return True


def _guard(job: ImportJob) -> tuple[str, str] | None:
    project = Project.all_objects.filter(pk=job.project_id).first()
    n = job.imported
    if project is None or project.deleted_at is not None or project.status == "archived":
        what = "archived" if project is not None and project.deleted_at is None else "deleted"
        return "project_unavailable", f"The project was {what} during the import. {_tasks_were(n)} imported."
    creator = job.created_by
    if creator is None or not creator.is_active or not services.can_import(creator, project):
        return (
            "permission_lost",
            f"You no longer have permission to import into {project.key}. {_tasks_were(n)} imported before it stopped.",
        )
    return None


def _tasks_were(n: int) -> str:
    return f"{n} task was" if n == 1 else f"{n} tasks were"


def _failed_message(n: int) -> str:
    return f"Something went wrong after {n} {'task' if n == 1 else 'tasks'}. They were kept. Retry to import the rest."


def _save(job: ImportJob) -> None:
    job.heartbeat_at = timezone.now()
    job.save()


def _audit(job: ImportJob, action: str, target: str, entity_id: Any, **extra: Any) -> None:
    record(
        workspace=job.workspace_id,
        project=job.project_id,
        actor=job.created_by,
        action=action,
        target=target,
        entity_id=entity_id,
        source="import",
        request_id=job.request_id or None,
        **extra,
    )


# ───────────────────────── preparing ─────────────────────────


def _prepare(ctx: Context, job: ImportJob) -> None:
    """Labels, epics and select options (get-or-create by case-insensitive name), then the number block."""
    assert ctx.plan is not None  # noqa: S101 - _load ran
    setup = dict(job.setup or {})
    if not setup.get("done"):
        plan = ctx.plan
        project = job.project
        perms = access.project_permissions(job.created_by, project)
        created = {"labels": 0, "epics": 0, "options": 0}

        labels: dict[str, str] = {}
        existing_labels = {lb.name.lower(): lb for lb in Label.objects.filter(project=project)}
        for name in plan.validation["creates"]["labels"]:
            label = existing_labels.get(name)
            if label is None:
                label = Label.objects.create(project=project, name=name, color="var(--text-3)")
                existing_labels[name] = label
                created["labels"] += 1
                _audit(job, "label.created", name, label.pk)
            labels[name] = str(label.pk)

        epics: dict[str, str] = {}
        existing_epics = {e.name.lower(): e for e in Epic.objects.filter(project=project)}

        def epic_for(name: str, start: Any, due: Any) -> str:
            name = name[:MAX_EPIC_NAME]
            epic = existing_epics.get(name.lower())
            if epic is None:
                dates = {"start_date": start, "due_date": due} if start and due else {}
                epic = Epic.objects.create(project=project, name=name, **dates)
                existing_epics[name.lower()] = epic
                created["epics"] += 1
                _audit(job, "epic.created", epic.name, epic.pk)
            return str(epic.pk)

        for r in plan.rows:
            if r.outcome == "epic":
                epics[f"row:{r.row}"] = epic_for(r.values["title"], r.values["startDate"], r.values["dueDate"])
        if "epic.manage" in perms:
            for r in plan.rows:
                if r.outcome == "task" and r.epic_row is None and not r.epic_id and r.epic_name:
                    key = f"name:{r.epic_name.lower()}"
                    if key not in epics:
                        epics[key] = epic_for(r.epic_name, None, None)

        options: dict[str, dict[str, str]] = {}
        for item in plan.validation["creates"]["options"]:
            field = CustomField.objects.filter(pk=item["customFieldId"], project=project).first()
            if field is None:
                continue
            current = list(field.options.order_by("position"))
            before = ", ".join(o.name for o in current)
            by_name = {o.name.lower(): o for o in current}
            options[str(field.pk)] = {}
            for name in item["names"]:
                option = by_name.get(name[:MAX_OPTION_NAME].lower())
                if option is None:
                    position = len(by_name)
                    option = CustomFieldOption.objects.create(
                        field=field,
                        name=name[:MAX_OPTION_NAME],
                        color=FIELD_COLORS[position % len(FIELD_COLORS)],
                        position=position,
                    )
                    by_name[option.name.lower()] = option
                    created["options"] += 1
                options[str(field.pk)][name.lower()] = str(option.pk)
            after = ", ".join(o.name for o in sorted(by_name.values(), key=lambda o: o.position))
            if after != before:
                _audit(
                    job,
                    "project.custom_field_updated",
                    field.name,
                    field.pk,
                    changes=[change("Options", before, after)],
                )

        planned = sum(1 for r in plan.rows if r.outcome == "task")
        locked = Project.objects.select_for_update().get(pk=project.pk)
        job.number_base = locked.task_seq + 1
        job.planned_tasks = planned
        locked.task_seq += planned
        locked.save(update_fields=["task_seq", "updated_at"])
        job.labels_created = created["labels"]
        job.options_created = created["options"]
        setup.update(done=True, labels=labels, epics=epics, options=options, created=created)
        job.setup = setup
    job.phase = "rows"
    _save(job)


# ───────────────────────── rows ─────────────────────────


def _description(text: str) -> dict[str, Any] | None:
    """Plain text → Tiptap doc: blank line = new paragraph, single newline = hardBreak. Nothing is interpreted."""
    t = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not t:
        return None
    content = []
    for para in [p for p in t.split("\n\n") if p.strip("\n")]:
        nodes: list[dict[str, Any]] = []
        for i, line in enumerate(para.strip("\n").split("\n")):
            if i > 0:
                nodes.append({"type": "hardBreak"})
            if line:
                nodes.append({"type": "text", "text": line})
        content.append({"type": "paragraph", "content": nodes})
    try:
        return sanitize_doc({"type": "doc", "content": content})
    except ApiError:  # too many nodes or bytes for one document: keep the text, lose the line breaks
        return plain_doc(" ".join(t.split()))


def _field_columns(kind: str, value: Any) -> dict[str, Any] | None:
    if kind == "text":
        return {"text": str(value)}
    if kind == "number":
        return {"number": Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)}
    if kind == "date":
        return {"date": dt.date.fromisoformat(value)}
    if kind == "select":
        return {"option_id": value}
    if kind == "user":
        return {"user_id": value}
    return None


def _log(r: PlannedRow, outcome: str, key: str | None, reason: str | None) -> dict[str, Any]:
    return {"row": r.row, "outcome": outcome, "key": key, "title": r.values["title"], "reason": reason}


def _rows(ctx: Context, job: ImportJob) -> None:
    """One batch (§5.3): tasks, history, labels, field values, scope changes, search vectors, ImportRow rows and
    audit rows, each written with one statement, then the counters and `cursor`."""
    assert ctx.plan is not None  # noqa: S101
    start = job.cursor
    batch = ctx.plan.rows[start : start + settings.IMPORT_BATCH_SIZE]
    if not batch:
        job.phase = "links"
        _save(job)
        return
    project = job.project
    creator = job.created_by
    setup = job.setup
    now = timezone.now()

    statuses = {str(s.pk): s for s in Status.objects.filter(project=project).order_by("position", "created_at")}
    ordered_statuses = list(statuses.values())
    default = next((s for s in ordered_statuses if s.glyph == "todo"), None) or next(
        (s for s in ordered_statuses if s.category == "todo"), ordered_statuses[0]
    )
    members = {str(u) for u in ProjectMember.objects.filter(project=project).values_list("user_id", flat=True)}
    labels = {n.lower(): str(i) for i, n in Label.objects.filter(project=project).values_list("id", "name")}
    epic_ids = {str(i) for i in Epic.objects.filter(project=project).values_list("id", flat=True)}
    sprints = dict(Sprint.objects.filter(project=project).values_list("id", "state"))
    sprint_state = {str(k): v for k, v in sprints.items()}
    fields = {str(i): t for i, t in CustomField.objects.filter(project=project).values_list("id", "type")}
    option_ids = {str(i) for i in CustomFieldOption.objects.filter(field__project=project).values_list("id", flat=True)}
    done = set(ImportRow.objects.filter(job=job, row__in=[r.row for r in batch]).values_list("row", flat=True))

    import_rows: list[ImportRow] = []
    recent: list[dict[str, Any]] = []
    counts = {"imported": 0, "epics": 0, "skipped": 0, "warnings": 0}
    drafts: list[tuple[PlannedRow, Task, list[dict[str, Any]], list[str], dict[str, Any]]] = []

    for r in batch:
        if r.row in done:
            continue
        if r.outcome == "skipped":
            import_rows.append(ImportRow(job=job, row=r.row, outcome="skipped", refs=r.refs, issues=r.issues))
            counts["skipped"] += 1
            recent.append(_log(r, "skipped", None, r.issues[0]["reason"] if r.issues else None))
            continue
        if r.outcome == "epic":
            epic_id = setup.get("epics", {}).get(f"row:{r.row}")
            import_rows.append(
                ImportRow(
                    job=job,
                    row=r.row,
                    outcome="epic",
                    epic_id=epic_id if epic_id in epic_ids else None,
                    refs=r.refs,
                    issues=r.issues,
                )
            )
            counts["epics"] += 1
            counts["warnings"] += sum(1 for i in r.issues if i["severity"] == "warning")
            recent.append(_log(r, "epic", None, None))
            continue

        values = r.values
        issues = list(r.issues)
        status = statuses.get(str(values["statusId"])) if values["statusId"] else default
        if status is None:
            label = r.status_value or "this"
            issues.append(
                {
                    "severity": "warning",
                    "field": "status",
                    "reason": f"Status “{label}” was deleted · used {default.name}",
                    "value": r.status_value,
                }
            )
            status = default
        assignee = values["assigneeId"]
        if assignee and assignee not in members:
            issues.append(
                {
                    "severity": "warning",
                    "field": "assignee",
                    "reason": "Assignee left the project · left unassigned",
                    "value": "",
                }
            )
            assignee = None
        epics = setup.get("epics", {})
        if r.epic_row is not None:
            epic_id = epics.get(f"row:{r.epic_row}")
        else:
            epic_id = r.epic_id or (epics.get(f"name:{r.epic_name.lower()}") if r.epic_name else None)
        sprint_id = values["sprintId"] if sprint_state.get(str(values["sprintId"])) in ("planned", "active") else None
        label_ids = list(
            dict.fromkeys(i for i in (setup.get("labels", {}).get(n) or labels.get(n) for n in values["labels"]) if i)
        )
        custom: dict[str, Any] = {}
        for fid, v in values["customFields"].items():
            kind = fields.get(fid)
            if kind is None or (kind == "select" and v not in option_ids) or (kind == "user" and v not in members):
                continue
            custom[fid] = _field_columns(kind, v)
        for fid, name in r.new_options.items():
            oid = setup.get("options", {}).get(fid, {}).get(name.lower())
            if oid in option_ids and fields.get(fid) == "select":
                custom[fid] = {"option_id": oid}
        number = (job.number_base or 1) + job.imported + counts["imported"]
        task = Task(
            id=uuid.uuid4(),
            project=project,
            number=number,
            key=f"{project.key}-{number}",
            title=values["title"],
            description=_description(r.description),
            type=values["type"] if values["type"] in ("feature", "bug", "chore", "spike") else "feature",
            priority=values["priority"],
            assignee_id=assignee,
            reporter=creator,
            estimate=values["estimate"],
            time_estimate_minutes=values["timeEstimateMinutes"],
            start_date=dt.date.fromisoformat(values["startDate"]) if values["startDate"] else None,
            due_date=dt.date.fromisoformat(values["dueDate"]) if values["dueDate"] else None,
            epic_id=epic_id if epic_id in epic_ids else None,
            sprint_id=sprint_id,
            position="",
            version=1,
            created_at=now,
        )
        apply_status(task, status, creator, at=now)
        counts["imported"] += 1
        counts["warnings"] += sum(1 for i in issues if i["severity"] == "warning")
        drafts.append((r, task, issues, label_ids, custom))
        recent.append(_log(r, "task", task.key, None))

    # Positions: file order within each column, after the column's current last card.
    by_status: dict[Any, list[Task]] = {}
    for _, task, _, _, _ in drafts:
        by_status.setdefault(task.status_id, []).append(task)
    long_columns = []
    for status_id, column in by_status.items():
        last = (
            Task.objects.filter(project=project, status_id=status_id)
            .order_by("-position")
            .values_list("position", flat=True)
            .first()
        )
        keys = fractional.keys_after(last, len(column))
        for task, key in zip(column, keys, strict=True):
            task.position = key
        if len(keys[-1]) > fractional.REBALANCE_LENGTH:
            long_columns.append(status_id)

    tasks = [d[1] for d in drafts]
    Task.objects.bulk_create(tasks)
    TaskStatusHistory.objects.bulk_create(
        [
            TaskStatusHistory(
                task=t,
                from_status=None,
                to_status=t.status,
                from_category=None,
                to_category=t.status.category,
                changed_by=creator,
                at=now,
            )
            for t in tasks
        ]
    )
    TaskLabel.objects.bulk_create([TaskLabel(task=t, label_id=i) for _, t, _, ids, _ in drafts for i in ids])
    empty = {"text": None, "number": None, "date": None, "option_id": None, "user_id": None}
    TaskFieldValue.objects.bulk_create(
        [
            TaskFieldValue(task=t, field_id=fid, **{**empty, **cols})
            for _, t, _, _, custom in drafts
            for fid, cols in custom.items()
            if cols
        ]
    )
    active = next((str(k) for k, v in sprints.items() if v == "active"), None)
    SprintScopeChange.objects.bulk_create(
        [
            SprintScopeChange(sprint_id=active, task=t, kind="added", estimate=t.estimate, actor=creator, at=now)
            for t in tasks
            if active and str(t.sprint_id) == active
        ]
    )
    if tasks:
        texts = [When(pk=t.pk, then=Value(doc_text(t.description, mention_prefix=False))) for t in tasks]
        Task.all_objects.filter(pk__in=[t.pk for t in tasks]).update(
            search_vector=SearchVector("key", config="simple", weight="A")
            + SearchVector("title", config="english", weight="A")
            + SearchVector(Case(*texts, default=Value(""), output_field=TextField()), config="english", weight="B")
        )
    for status_id in long_columns:
        rebalance_column(project.pk, status_id)

    for r, task, issues, _, _ in drafts:
        import_rows.append(ImportRow(job=job, row=r.row, outcome="task", task=task, refs=r.refs, issues=issues))
    ImportRow.objects.bulk_create(import_rows)
    record_many(
        [
            {
                "workspace": job.workspace_id,
                "project": job.project_id,
                "task": t,
                "actor": creator,
                "action": "task.imported",
                "target": t.title,
                "entity_id": t.pk,
                "entity_key": t.key,
                "changes": [change("Title", None, t.title, "text"), change("Status", None, t.status.glyph, "status")],
                "data": {"importId": str(job.pk), "row": r.row, "fileName": job.file_name},
                "source": "import",
                "request_id": job.request_id or None,
            }
            for r, t, _, _, _ in drafts
        ]
    )

    job.imported += counts["imported"]
    job.epics_created += counts["epics"]
    job.skipped += counts["skipped"]
    job.warnings += counts["warnings"]
    job.recent = [*(job.recent or []), *recent][-10:]
    job.cursor = start + len(batch)
    if job.cursor >= len(ctx.plan.rows):
        job.phase = "links"
    _save(job)


# ───────────────────────── links ─────────────────────────


def _reaches(adjacency: dict[str, set[str]], start: str, target: str) -> bool:
    seen = {start}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        if node == target:
            return True
        for nxt in adjacency.get(node, ()):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return False


def _links(ctx: Context, job: ImportJob) -> None:
    """Parents of sub-tasks, then dependencies with board 39's rules (§5.5), IMPORT_LINK_BATCH rows per step."""
    assert ctx.plan is not None  # noqa: S101
    setup = dict(job.setup or {})
    only_processed = bool(setup.get("onlyProcessed"))
    pos = int(setup.get("linksCursor") or 0)
    candidates = [r for r in ctx.plan.rows if r.outcome == "task" and (r.parent or r.blocked_by or r.blocks)]
    chunk = candidates[pos : pos + settings.IMPORT_LINK_BATCH]
    if not chunk:
        job.phase = "finishing"
        _save(job)
        return
    project_id = job.project_id
    Project.objects.select_for_update().get(pk=project_id)  # board 39: dependency writes are serialised per project
    row_task = {
        row: str(task_id)
        for row, task_id in ImportRow.objects.filter(job=job, outcome="task", task__isnull=False).values_list(
            "row", "task_id"
        )
    }

    def target_id(t: dict[str, Any] | None) -> str | None:
        if not t:
            return None
        return row_task.get(t["row"]) if "row" in t else t.get("taskId")

    involved: set[str] = set()
    for r in chunk:
        for t in [r.parent, *r.blocked_by, *r.blocks]:
            tid = target_id(t)
            if tid:
                involved.add(tid)
        if r.row in row_task:
            involved.add(row_task[r.row])
    tasks = {
        str(i): {"parent": p and str(p)}
        for i, p in Task.objects.filter(pk__in=involved, project_id=project_id).values_list("id", "parent_id")
    }
    adjacency: dict[str, set[str]] = {}
    pairs: set[tuple[str, str]] = set()
    as_blocked: dict[str, int] = {}
    as_blocker: dict[str, int] = {}
    links = TaskDependency.objects.filter(
        project_id=project_id, blocker__deleted_at__isnull=True, blocked__deleted_at__isnull=True
    ).values_list("blocker_id", "blocked_id")
    for blocker_id, blocked_id in links:
        a, b = str(blocker_id), str(blocked_id)
        adjacency.setdefault(a, set()).add(b)
        pairs.add((a, b))
        as_blocker[a] = as_blocker.get(a, 0) + 1
        as_blocked[b] = as_blocked.get(b, 0) + 1

    warnings: dict[int, list[dict[str, Any]]] = {}
    new_links: list[TaskDependency] = []
    parents: dict[str, list[str]] = {}

    def warn(row: int, fld: str, reason: str, value: str) -> None:
        warnings.setdefault(row, []).append({"severity": "warning", "field": fld, "reason": reason, "value": value})

    for r in chunk:
        if only_processed and r.row - 2 >= job.cursor:
            continue
        me = row_task.get(r.row)
        if me is None or me not in tasks:
            continue
        if r.parent and tasks[me]["parent"] is None:
            pid = target_id(r.parent)
            if pid and pid in tasks and pid != me and tasks[pid]["parent"] is None:
                parents.setdefault(pid, []).append(me)
                tasks[me]["parent"] = pid
        for fld, targets in (("blockedBy", r.blocked_by), ("blocks", r.blocks)):
            for t in targets:
                other = target_id(t)
                if not other or other not in tasks:
                    continue  # not imported (stopped early) or gone: nothing to link
                blocker, blocked = (other, me) if fld == "blockedBy" else (me, other)
                if blocker == blocked or tasks[blocker]["parent"] == blocked or tasks[blocked]["parent"] == blocker:
                    warn(r.row, fld, "Would create a loop · dependency skipped", t["ref"])
                    continue
                if (blocker, blocked) in pairs:
                    continue
                if as_blocked.get(blocked, 0) >= DEPENDENCY_LIMIT or as_blocker.get(blocker, 0) >= DEPENDENCY_LIMIT:
                    warn(r.row, fld, "Dependency limit reached", t["ref"])
                    continue
                if _reaches(adjacency, blocked, blocker):
                    warn(r.row, fld, "Would create a loop · dependency skipped", t["ref"])
                    continue
                adjacency.setdefault(blocker, set()).add(blocked)
                pairs.add((blocker, blocked))
                as_blocker[blocker] = as_blocker.get(blocker, 0) + 1
                as_blocked[blocked] = as_blocked.get(blocked, 0) + 1
                new_links.append(
                    TaskDependency(
                        blocker_id=blocker, blocked_id=blocked, project_id=project_id, created_by_id=job.created_by_id
                    )
                )

    for pid, children in parents.items():
        Task.all_objects.filter(pk__in=children, parent__isnull=True).update(parent_id=pid)
    TaskDependency.objects.bulk_create(new_links, ignore_conflicts=True)
    added = 0
    if warnings:
        rows = list(ImportRow.objects.filter(job=job, row__in=list(warnings)))
        for row in rows:
            have = {(i["severity"], i["reason"]) for i in row.issues}
            for w in warnings[row.row]:
                if (w["severity"], w["reason"]) not in have:
                    row.issues = [*row.issues, w]
                    have.add((w["severity"], w["reason"]))
                    added += 1
        ImportRow.objects.bulk_update(rows, ["issues"])
    job.warnings += added
    setup["linksCursor"] = pos + len(chunk)
    job.setup = setup
    if pos + len(chunk) >= len(candidates):
        job.phase = "finishing"
    _save(job)


# ───────────────────────── finishing / failure ─────────────────────────


def _issues(job: ImportJob) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row, issues in ImportRow.objects.filter(job=job).exclude(issues=[]).values_list("row", "issues"):
        out.extend({**i, "row": row} for i in issues)
    return out


def _close(ctx: Context | None, job: ImportJob, status: str) -> None:
    """Report, keys, status, audit summary and the import_finished event (shared by finish and fail)."""
    issues = _issues(job)
    if issues:
        parsed = ctx.parsed if ctx is not None else None
        if parsed is None:
            parsed = services.load_parsed(job)
        header = parsed.header if parsed is not None else []
        rows = parsed.rows if parsed is not None else []
        job.report_key = f"{services._base_key(job)}/report.csv"
        get_storage().put(job.report_key, build_report(header, rows, issues).encode(), "text/csv; charset=utf-8")
    keys = list(
        ImportRow.objects.filter(job=job, outcome="task", task__isnull=False)
        .order_by("row")
        .values_list("task__key", flat=True)
    )
    job.first_key = keys[0] if keys else ""
    job.last_key = keys[-1] if keys else ""
    now = timezone.now()
    job.status = status
    job.finished_at = now
    job.expires_at = now + services.RETENTION
    job.lease_token = None
    if job.phase:
        job.phase = "finishing" if status != "failed" else job.phase
    _save(job)
    _audit(
        job,
        "project.import_completed",
        job.file_name,
        job.pk,
        entity_key=job.project.key,
        data={
            "importId": str(job.pk),
            "fileName": job.file_name,
            "source": job.source,
            "status": status,
            "imported": job.imported,
            "epics": job.epics_created,
            "skipped": job.skipped,
            "warnings": job.warnings,
            "firstKey": job.first_key or None,
            "lastKey": job.last_key or None,
        },
    )
    emit("import_finished", workspace=job.workspace_id, project=job.project_id, payload={"jobId": str(job.pk)})


def _finish(ctx: Context, job: ImportJob) -> None:
    _close(ctx, job, "canceled" if job.cancel_requested else "completed")


def _fail(ctx: Context | None, job: ImportJob, code: str, message: str) -> None:
    job.error_code = code
    job.error_message = message[:300]
    _close(ctx, job, "failed")
