"""Background work (docs/v2/37-integrations-github-gitlab.md §7.3–§7.6, §7.9): board 40's dispatch pattern, no Redis.

`dispatch()` runs after commit: Celery when a broker exists (`INTEGRATIONS_RUNNER=celery`/`auto`), else it wakes the
**one** daemon drain thread of this process (`thread`), or drains synchronously (`inline`, tests). `drain()` repeats
until idle: claim up to 20 deliveries (`FOR UPDATE SKIP LOCKED`, stale leases after 120 s are reclaimed), process
each in its own transaction, then one due sync run, then one integration waiting to be disconnected.
"""

from __future__ import annotations

import datetime as dt
import logging
import threading
import uuid
from typing import Any

from django.conf import settings
from django.db import connection, transaction
from django.db.models import F, Q
from django.utils import timezone

from core.audit.models import AuditLog
from core.audit.services import record

from . import matching, processor
from .models import Integration, Repository, SyncRun, WebhookDelivery
from .providers.base import AuthError, ProviderError, RateLimited, get_provider

logger = logging.getLogger("lightex.integrations")

LEASE = dt.timedelta(seconds=120)
CLAIM = 20
MAX_ATTEMPTS = 5
REQUEST_BUDGET = 120
PR_COMMITS = 50
BRANCH_CAP = 1000
COMMIT_CAP = 300
ENRICH_CAP = 50


def runner_mode() -> str:
    mode = getattr(settings, "INTEGRATIONS_RUNNER", "auto")
    if mode == "auto":
        return "thread" if settings.CELERY_TASK_ALWAYS_EAGER else "celery"
    return mode


# ───────────────────────── dispatch ─────────────────────────

_lock = threading.Lock()
_wake = threading.Event()
_thread: threading.Thread | None = None


def dispatch() -> None:
    mode = runner_mode()
    if mode == "inline":
        drain()
    elif mode == "celery":
        from .tasks import drain as drain_task

        drain_task.delay()
    else:
        _wake_thread()


def dispatch_on_commit() -> None:
    transaction.on_commit(dispatch)


def _wake_thread() -> None:
    global _thread
    with _lock:
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(target=_loop, name="lightex-integrations-drain", daemon=True)
            _thread.start()
    _wake.set()


def _loop() -> None:  # pragma: no cover - exercised through the thread runner test with drain() patched
    while True:
        _wake.wait(timeout=60)
        _wake.clear()
        try:
            drain()
        except Exception:
            logger.exception("Integration drain failed")
        finally:
            connection.close()  # idle: give the connection back


def drain(max_rounds: int = 1000) -> int:
    """Processes everything due; returns the number of work items handled."""
    handled = 0
    for _ in range(max_rounds):
        ids, token = claim_deliveries()
        for delivery_id in ids:
            process_delivery(delivery_id, token)
        run = claim_run()
        if run is not None:
            execute_run(*run)
        gone = finish_one_disconnect()
        work = len(ids) + (run is not None) + gone
        handled += work
        if not work:
            break
    return handled


# ───────────────────────── deliveries ─────────────────────────


def claim_deliveries(limit: int = CLAIM) -> tuple[list[Any], uuid.UUID]:
    now = timezone.now()
    token = uuid.uuid4()
    with transaction.atomic():
        ids = list(
            WebhookDelivery.objects.select_for_update(skip_locked=True)
            .filter(Q(status="received") | Q(status="processing", locked_at__lt=now - LEASE))
            .order_by("received_at")
            .values_list("pk", flat=True)[:limit]
        )
        if ids:
            WebhookDelivery.objects.filter(pk__in=ids).update(
                status="processing", lease_token=token, locked_at=now, attempts=F("attempts") + 1
            )
    return ids, token


def process_delivery(delivery_id: Any, token: uuid.UUID) -> None:
    try:
        with transaction.atomic():
            delivery = (
                WebhookDelivery.objects.select_for_update(of=("self",))
                .select_related("integration")
                .get(pk=delivery_id)
            )
            if delivery.lease_token != token or delivery.status != "processing":
                return
            integration = delivery.integration
            status, error = "ignored", ""
            if integration is not None and integration.status in ("active", "error"):
                provider = get_provider(integration.provider)
                ctx = processor.Context(integration, provider)
                try:
                    applied = processor.apply(ctx, provider.normalize(delivery))
                except AuthError as exc:
                    from .services import set_integration_error

                    set_integration_error(integration, exc.code)
                    applied = True
                if applied:
                    status = "processed"
                    Integration.objects.filter(pk=integration.pk).update(last_synced_at=timezone.now())
                if ctx.capped:
                    error = "link_cap"
                processor.publish_touched(ctx)
            delivery.status, delivery.error = status, error
            delivery.processed_at = timezone.now()
            delivery.save(update_fields=["status", "error", "processed_at", "updated_at"])
    except Exception as exc:
        logger.exception("Webhook delivery %s failed", delivery_id)
        failed = WebhookDelivery.objects.filter(pk=delivery_id, lease_token=token).first()
        if failed is not None:
            failed.status = "received" if failed.attempts < MAX_ATTEMPTS else "failed"
            failed.error = str(exc)[:300]
            failed.save(update_fields=["status", "error", "updated_at"])


# ───────────────────────── sync runs (§7.4, §7.6) ─────────────────────────


def enqueue(integration: Integration, repo: Repository | None, kind: str, user: Any = None) -> SyncRun:
    """One active run per (integration, repository) (`sync_one_active`): a second request returns the existing one."""
    existing = SyncRun.objects.filter(integration=integration, repository=repo, status__in=SyncRun.ACTIVE).first()
    if existing is not None:
        return existing
    from django.db import IntegrityError

    try:
        with transaction.atomic():
            run = SyncRun.objects.create(integration=integration, repository=repo, kind=kind, requested_by=user)
    except IntegrityError:
        return SyncRun.objects.filter(integration=integration, repository=repo, status__in=SyncRun.ACTIVE).get()
    if repo is not None:
        Repository.objects.filter(pk=repo.pk).update(sync_state="queued")
    dispatch_on_commit()
    return run


def claim_run() -> tuple[Any, uuid.UUID] | None:
    now = timezone.now()
    token = uuid.uuid4()
    with transaction.atomic():
        run_id = (
            SyncRun.objects.select_for_update(skip_locked=True)
            .filter(
                Q(status__in=("queued", "deferred"), run_after__lte=now)
                | Q(status="running", heartbeat_at__lt=now - LEASE)
            )
            .order_by("run_after")
            .values_list("pk", flat=True)
            .first()
        )
        if run_id is None:
            return None
        SyncRun.objects.filter(pk=run_id).update(status="running", lease_token=token, heartbeat_at=now, started_at=now)
    return run_id, token


class BudgetExhausted(Exception):
    pass


class _Counted:
    """Counts provider requests against the per-repository budget (§7.4: 120; then `stats.partial = true`)."""

    UNCOUNTED = {"low_budget", "normalize", "key", "available", "methods", "verify", "delivery_meta"}

    def __init__(self, provider: Any, stats: dict[str, Any]):
        self._provider = provider
        self._stats = stats
        self.limit = REQUEST_BUDGET

    def reset(self) -> None:
        self.used = 0

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._provider, name)
        if name in self.UNCOUNTED or not callable(attr):
            return attr

        def counted(*args: Any, **kwargs: Any) -> Any:
            self.used = getattr(self, "used", 0) + 1
            self._stats["requests"] = self._stats.get("requests", 0) + 1
            if self.used > self.limit:
                raise BudgetExhausted
            return attr(*args, **kwargs)

        return counted


def execute_run(run_id: Any, token: uuid.UUID) -> None:
    run = SyncRun.objects.select_related("integration", "repository").get(pk=run_id)
    integration = run.integration
    if integration.status != "active":
        _finish(run, "failed", "integration_error")
        return
    raw = get_provider(integration.provider)
    stats: dict[str, Any] = dict(run.stats or {})
    provider = _Counted(raw, stats)
    ctx = processor.Context(integration, provider, history=run.kind == "backfill")
    repos = [run.repository] if run.repository else list(integration.repositories.all())
    try:
        if run.repository is None and run.kind == "catchup":
            since = timezone.now() - dt.timedelta(days=3)
            known = set(
                WebhookDelivery.objects.filter(integration=integration, received_at__gte=since).values_list(
                    "delivery_id", flat=True
                )
            )
            raw.recover(integration, known)
        for repo in repos:
            provider.reset()
            Repository.objects.filter(pk=repo.pk).update(sync_state="syncing")
            partial = False
            try:
                with transaction.atomic():
                    sync_repository(ctx, run, repo, raw)
            except BudgetExhausted:
                partial = True
            stats["partial"] = bool(stats.get("partial")) or partial
            _repo_done(ctx, run, repo, stats, partial)
    except RateLimited as exc:
        SyncRun.objects.filter(pk=run.pk).update(
            status="deferred", run_after=exc.reset_at, stats=stats, lease_token=None
        )
        return
    except AuthError as exc:
        from .services import set_integration_error

        set_integration_error(integration, exc.code)
        Repository.objects.filter(pk__in=[r.pk for r in repos]).update(sync_state="idle")
        _finish(run, "failed", exc.code, stats)
        return
    except ProviderError as exc:
        Repository.objects.filter(pk__in=[r.pk for r in repos]).update(sync_state="failed")
        _finish(run, "failed", str(exc)[:300], stats)
        return
    now = timezone.now()
    Integration.objects.filter(pk=integration.pk).update(last_synced_at=now)
    stats.update({k: v for k, v in ctx.stats.items() if k != "requests"})
    _finish(run, "done", "", stats)
    processor.publish_bulk_touched(ctx)
    from .services import publish_integration

    publish_integration(integration, "synced")


def _finish(run: SyncRun, status: str, error: str, stats: dict[str, Any] | None = None) -> None:
    SyncRun.objects.filter(pk=run.pk).update(
        status=status, error=error, finished_at=timezone.now(), stats=stats or run.stats, lease_token=None
    )


def _repo_done(ctx: processor.Context, run: SyncRun, repo: Repository, stats: dict[str, Any], partial: bool) -> None:
    now = timezone.now()
    fields: dict[str, Any] = {"sync_state": "idle", "last_synced_at": now}
    if run.kind == "backfill":
        fields["backfilled_at"] = now
        record(
            workspace=ctx.integration.workspace_id,
            actor=ctx.actor,
            action="tracking.integration.backfilled",
            target=repo.full_path,
            entity_id=ctx.integration.pk,
            data={
                "repository": repo.full_path,
                "prs": ctx.stats.get("prs", 0),
                "branches": ctx.stats.get("branches", 0),
                "commits": ctx.stats.get("commits", 0),
                "links": ctx.stats.get("links", 0),
                "partial": partial,
            },
            source="webhook",
        )
    Repository.objects.filter(pk=repo.pk).update(**fields)


def sync_repository(ctx: processor.Context, run: Any, repo: Repository, raw: Any) -> None:
    """Backfill (history: no automations) or incremental sync of one repository (§7.4)."""
    from modules.tracking.tasks.models import ExternalLink

    provider = ctx.provider
    now = timezone.now()
    if run.kind == "backfill":
        since = now - dt.timedelta(days=settings.INTEGRATION_BACKFILL_DAYS)
    else:
        since = (repo.last_synced_at or ctx.integration.last_synced_at or now - dt.timedelta(days=1)) - dt.timedelta(
            minutes=5
        )
    open_count = 0
    linked_open = []
    for pr in provider.pull_requests(repo, updated_since=since, limit=settings.INTEGRATION_BACKFILL_MAX_PRS):
        rows = processor.upsert_pr(ctx, repo, pr)
        if pr.state in processor.OPEN:
            open_count += 1
            if rows:
                linked_open.append(pr)
        if rows and run.kind == "backfill":
            processor.upsert_commits(ctx, repo, list(provider.pull_request_commits(repo, pr.number, limit=PR_COMMITS)))
    linked_branches = set(
        ExternalLink.objects.filter(
            workspace_id=ctx.integration.workspace_id, repo_external_id=repo.external_id, type="branch"
        ).values_list("title", flat=True)
    )
    for branch in provider.branches(repo, limit=BRANCH_CAP):
        if matching.key_pairs([branch.name]) or branch.name in linked_branches:
            processor.upsert_branch(ctx, repo, branch, enrich=False)
    processor.upsert_commits(ctx, repo, list(provider.commits(repo, ref=None, since=since, limit=COMMIT_CAP)))
    for pr in linked_open[:ENRICH_CAP]:
        processor.update_checks(ctx, repo, pr.sha, provider.checks(repo, pr.sha), True)
        processor.refresh_approvals(ctx, repo, pr.number)
    if not raw.low_budget(ctx.integration):
        active = ExternalLink.objects.filter(
            workspace_id=ctx.integration.workspace_id, repo_external_id=repo.external_id, type="branch", state="active"
        )
        for name in list(dict.fromkeys(active.values_list("title", flat=True)))[:ENRICH_CAP]:
            active.filter(title=name).update(ahead_by=provider.ahead_by(repo, name))
    if run.kind == "backfill":
        fake_count = getattr(raw, "open_pr_count", None)
        repo.open_pr_count = fake_count(repo.name) if fake_count else open_count
        Repository.objects.filter(pk=repo.pk).update(open_pr_count=repo.open_pr_count)


# ───────────────────────── disconnect (§7.9) ─────────────────────────


def finish_one_disconnect() -> int:
    with transaction.atomic():
        integration = Integration.objects.select_for_update(skip_locked=True).filter(status="disconnecting").first()
        if integration is None:
            return 0
        revoked = False
        try:
            revoked = bool(get_provider(integration.provider).revoke(integration))
        except Exception:
            logger.exception("Revoking integration %s failed", integration.pk)
        Integration.objects.filter(pk=integration.pk).update(credentials="", webhook_secret="")
        row = (
            AuditLog.objects.filter(action="tracking.integration.disconnected", target_id=str(integration.pk))
            .order_by("-created_at")
            .first()
        )
        if row is not None:
            row.data = {**(row.data or {}), "revoked": revoked}
            row.save(update_fields=["data", "updated_at"])
        integration.delete()
    return 1
