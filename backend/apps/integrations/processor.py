"""Applies normalised events to task links (docs/v2/37-integrations-github-gitlab.md §6, §7.2).

Used by the webhook processor and by sync runs. A `Context` carries the integration, whether this is history
(backfill: no audit rows, no automations) or news, the per-delivery link cap, and the tasks it touched (each gets one
`task.changed` `["development"]` event, or one `tasks.bulk_changed` per project after a run).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from django.db.models import QuerySet
from django.utils import timezone

from apps.audit.services import change, record
from apps.tasks.models import ExternalLink

from . import matching
from .automation import IntegrationActor
from .models import Integration, Repository
from .providers.base import BranchInfo, CheckInfo, CommitInfo, DevEvent, PullRequestInfo, first_line

logger = logging.getLogger("lightex.integrations")

LINK_CAP = 200
CHECKS_CAP = 20
OPEN = ("open", "draft")
_STATE_ORDER = {"failing": 0, "running": 1, "passing": 2}


@dataclass
class Context:
    integration: Integration
    provider: Any
    history: bool = False  # backfill: no audit rows, no automations, no per-task events
    links_created: int = 0
    capped: bool = False
    touched: dict[Any, tuple[str, Any]] = field(default_factory=dict)  # task id → (key, project id)
    stats: dict[str, int] = field(default_factory=dict)
    _members: dict[str, Any] | None = None

    @property
    def actor(self) -> IntegrationActor:
        return IntegrationActor.of(self.integration)

    def bump(self, name: str, n: int = 1) -> None:
        self.stats[name] = self.stats.get(name, 0) + n

    def touch(self, rows: list[ExternalLink]) -> None:
        for r in rows:
            self.touched[r.task_id] = (r.task.key, r.task.project_id)

    def member_for(self, email: str) -> Any:
        """§7.3 author matching: an active workspace member with this email (lower-case). noreply never matches."""
        email = (email or "").strip().lower()
        if not email or email.endswith("noreply.github.com"):
            return None
        if self._members is None:
            from apps.workspaces.models import WorkspaceMember

            self._members = {
                e.lower(): uid
                for uid, e in WorkspaceMember.objects.filter(
                    workspace_id=self.integration.workspace_id, status="active"
                ).values_list("user_id", "user__email")
            }
        return self._members.get(email)


def object_rows(ctx: Context, repo_external_id: str, type_: str, external_id: str) -> QuerySet[ExternalLink]:
    return ExternalLink.objects.filter(
        workspace_id=ctx.integration.workspace_id,
        provider=ctx.integration.provider,
        repo_external_id=repo_external_id,
        type=type_,
        external_id=external_id,
    )


def _repo_fields(ctx: Context, repo: Repository) -> dict[str, Any]:
    return {
        "repository": repo,
        "base_url": ctx.integration.base_url,
        "repo_external_id": repo.external_id,
        "repo_full_path": repo.full_path,
    }


def _create_links(ctx: Context, repo: Repository, tasks: list[Any], type_: str, ext: str, fields: dict) -> list:
    rows = []
    for task in tasks:
        if ctx.links_created >= LINK_CAP:
            ctx.capped = True
            break
        row = ExternalLink.objects.create(
            task=task,
            workspace_id=ctx.integration.workspace_id,
            provider=ctx.integration.provider,
            type=type_,
            external_id=ext,
            link_source="auto",
            **_repo_fields(ctx, repo),
            **fields,
        )
        row.task = task
        ctx.links_created += 1
        rows.append(row)
    ctx.bump("links", len(rows))
    return rows


def ref_of(provider: str, number: int | None) -> str:
    return f"!{number}" if provider == "gitlab" else f"#{number}"


def _audit_link(ctx: Context, row: ExternalLink, kind: str, ref: str, title: str = "") -> None:
    task = row.task
    record(
        workspace=ctx.integration.workspace_id,
        project=task.project_id,
        task=task,
        actor=ctx.actor,
        action="task.dev_linked",
        target=task.title,
        entity_id=task.pk,
        entity_key=task.key,
        data={
            "provider": ctx.integration.provider,
            "kind": kind,
            "ref": ref,
            "repo": row.repo_full_path,
            "url": row.url,
            "title": title,
        },
        source="webhook",
    )


# ───────────────────────── link fields ─────────────────────────


def pr_fields(ctx: Context, pr: PullRequestInfo) -> dict[str, Any]:
    return {
        "url": pr.url[:500],
        "number": pr.number,
        "title": pr.title[:300],
        "state": pr.state,
        "head_branch": pr.head_branch[:255],
        "base_branch": pr.base_branch[:255],
        "author_login": pr.author.login[:100],
        "author_name": pr.author.name[:100],
        "author_user_id": ctx.member_for(pr.author.email),
        "source_created_at": pr.created_at,
        "source_updated_at": pr.updated_at,
        "merged_at": pr.merged_at,
        "closed_at": pr.closed_at,
    }


def branch_fields(branch: BranchInfo) -> dict[str, Any]:
    return {
        "url": branch.url[:500],
        "title": branch.name[:300],
        "state": "active",
        "source_updated_at": branch.updated_at or timezone.now(),
    }


def commit_fields(ctx: Context, commit: CommitInfo) -> dict[str, Any]:
    return {
        "url": commit.url[:500],
        "title": first_line(commit.message),
        "sha": commit.sha[:40],
        "author_login": commit.author.login[:100],
        "author_name": commit.author.name[:100],
        "author_user_id": ctx.member_for(commit.author.email),
        "source_created_at": commit.committed_at,
        "source_updated_at": commit.committed_at,
    }


# ───────────────────────── pull requests ─────────────────────────


def upsert_pr(ctx: Context, repo: Repository, pr: PullRequestInfo) -> list[ExternalLink]:
    """§7.2 `pr_upsert`: fields on every link row of this PR, keys recomputed (§6.6), transitions → automations."""
    from . import automation

    ext = f"{repo.external_id}#{pr.number}"
    rows = list(object_rows(ctx, repo.external_id, "pull_request", ext).select_related("task"))
    stored = max((r.source_updated_at for r in rows if r.source_updated_at), default=None)
    if stored and pr.updated_at and pr.updated_at < stored:
        return []  # an older delivery arriving late
    prev_state = rows[0].state if rows else None
    fields = pr_fields(ctx, pr)
    if not rows or any(r.sha != pr.sha for r in rows):
        fields.update(sha=pr.sha[:40], checks=[], checks_state="")  # a new head sha clears the checks
    if rows:
        object_rows(ctx, repo.external_id, "pull_request", ext).update(**fields, **_repo_fields(ctx, repo))
    tasks = matching.resolve_keys(ctx.integration.workspace_id, [pr.title, pr.head_branch], repo)
    wanted = {t.pk for t in tasks}
    gone = [r for r in rows if r.link_source == "auto" and not r.suppressed and r.task_id not in wanted]
    if gone:
        ExternalLink.objects.filter(pk__in=[r.pk for r in gone]).delete()
    have = {r.task_id for r in rows}
    created = _create_links(ctx, repo, [t for t in tasks if t.pk not in have], "pull_request", ext, fields)
    ctx.bump("prs")
    current = [r for r in rows if r not in gone] + created
    ctx.touch(rows + created)
    ref = ref_of(ctx.integration.provider, pr.number)
    if not ctx.history:
        for row in created:
            _audit_link(ctx, row, "pull_request", ref, pr.title)
    if prev_state != pr.state:
        delta = int(pr.state in OPEN) - int(prev_state in OPEN)
        if delta and (rows or created or prev_state is None):
            Repository.objects.filter(pk=repo.pk).update(open_pr_count=max(0, repo.open_pr_count + delta))
            repo.open_pr_count = max(0, repo.open_pr_count + delta)
        if not ctx.history:
            visible = [r for r in current if not r.suppressed]
            if (
                prev_state is not None
                and pr.state in ("merged", "closed")
                or (prev_state == "closed" and pr.state in OPEN)
            ):
                for row in visible:
                    _audit_state(ctx, row, ref, prev_state or "", pr.state)
            if pr.state == "open":
                automation.apply(ctx, "pr_opened", visible, ref)
            elif pr.state == "merged":
                automation.apply(ctx, "pr_merged", visible, ref)
    return current


def _audit_state(ctx: Context, row: ExternalLink, ref: str, before: str, after: str) -> None:
    task = row.task
    record(
        workspace=ctx.integration.workspace_id,
        project=task.project_id,
        task=task,
        actor=ctx.actor,
        action="task.dev_pr_state",
        target=task.title,
        entity_id=task.pk,
        entity_key=task.key,
        changes=[change(f"PR {ref}", before, after, "text")],
        data={"ref": ref, "repo": row.repo_full_path, "url": row.url, "to": after},
        source="webhook",
    )


def refresh_approvals(ctx: Context, repo: Repository, number: int) -> None:
    rows = object_rows(ctx, repo.external_id, "pull_request", f"{repo.external_id}#{number}")
    if not rows.exists() or ctx.provider.low_budget(ctx.integration):
        return
    rows.update(approvals=ctx.provider.approvals(repo, number))
    ctx.touch(list(rows.select_related("task")))


# ───────────────────────── checks ─────────────────────────


def _check_dict(c: CheckInfo) -> dict[str, Any]:
    return {
        "name": c.name[:120],
        "state": c.state,
        "durationSec": c.duration_sec,
        "url": c.url,
        "startedAt": c.started_at.isoformat() if c.started_at else None,
    }


def update_checks(ctx: Context, repo: Repository, sha: str, checks: list[CheckInfo], replace: bool) -> None:
    """Checks apply only to PR links whose head is `sha`; upsert by name (GitHub) or replace (GitLab pipelines)."""
    if not sha:
        return
    rows = list(
        ExternalLink.objects.filter(
            workspace_id=ctx.integration.workspace_id,
            provider=ctx.integration.provider,
            repo_external_id=repo.external_id,
            type="pull_request",
            sha=sha,
        ).select_related("task")
    )
    for ext in {r.external_id for r in rows}:
        first = next(r for r in rows if r.external_id == ext)
        by_name = {} if replace else {c["name"]: c for c in first.checks or []}
        for c in checks:
            by_name[c.name[:120]] = _check_dict(c)
        items = sorted(by_name.values(), key=lambda c: (_STATE_ORDER.get(c["state"], 3), c["name"]))[:CHECKS_CAP]
        state = matching.aggregate_checks(c["state"] for c in items) or ""
        object_rows(ctx, repo.external_id, "pull_request", ext).filter(sha=sha).update(checks=items, checks_state=state)
    ctx.touch(rows)


# ───────────────────────── branches and commits ─────────────────────────


def upsert_branch(ctx: Context, repo: Repository, branch: BranchInfo, *, enrich: bool = True) -> list[ExternalLink]:
    ext = f"{repo.external_id}:{branch.name}"
    rows = list(object_rows(ctx, repo.external_id, "branch", ext).select_related("task"))
    fields = branch_fields(branch)
    if branch.sha:
        fields["sha"] = branch.sha[:40]
    if rows:
        object_rows(ctx, repo.external_id, "branch", ext).update(**fields, **_repo_fields(ctx, repo))
    tasks = matching.resolve_keys(ctx.integration.workspace_id, [branch.name], repo)
    have = {r.task_id for r in rows}
    created = _create_links(ctx, repo, [t for t in tasks if t.pk not in have], "branch", ext, fields)
    ctx.bump("branches", 1 if rows or created else 0)
    if not ctx.history:
        for row in created:
            _audit_link(ctx, row, "branch", branch.name)
    linked = rows + created
    if linked and enrich and not ctx.provider.low_budget(ctx.integration):
        ahead = ctx.provider.ahead_by(repo, branch.name)
        object_rows(ctx, repo.external_id, "branch", ext).update(ahead_by=ahead)
    if branch.sha:  # a push to a PR's head branch moves its head sha and clears its checks
        ExternalLink.objects.filter(
            workspace_id=ctx.integration.workspace_id,
            provider=ctx.integration.provider,
            repo_external_id=repo.external_id,
            type="pull_request",
            head_branch=branch.name,
            state__in=OPEN,
        ).exclude(sha=branch.sha[:40]).update(sha=branch.sha[:40], checks=[], checks_state="")
    ctx.touch(linked)
    return linked


def delete_branch(ctx: Context, repo: Repository, name: str) -> None:
    rows = object_rows(ctx, repo.external_id, "branch", f"{repo.external_id}:{name}")
    ctx.touch(list(rows.select_related("task")))
    rows.update(state="deleted", source_updated_at=timezone.now())


def upsert_commits(ctx: Context, repo: Repository, commits: list[CommitInfo]) -> None:
    """Commits are immutable: rows are created once, never changed (§6.6). No audit rows (§8.2)."""
    for commit in commits[-100:]:
        if not commit.sha:
            continue
        tasks = matching.resolve_keys(ctx.integration.workspace_id, [commit.message], repo)
        if not tasks:
            continue
        rows = object_rows(ctx, repo.external_id, "commit", commit.sha)
        have = set(rows.values_list("task_id", flat=True))
        fields = commit_fields(ctx, commit)
        created = _create_links(ctx, repo, [t for t in tasks if t.pk not in have], "commit", commit.sha, fields)
        ctx.bump("commits", 1)
        ctx.touch(created)


# ───────────────────────── events ─────────────────────────


def tracked_repo(integration: Integration, external_id: str) -> Repository | None:
    if not external_id:
        return None
    return Repository.objects.filter(integration=integration, external_id=external_id).first()


def apply(ctx: Context, events: list[DevEvent]) -> bool:
    """Applies one delivery's events. Returns False when nothing applied (the delivery is then `ignored`)."""
    from . import services

    applied = False
    for ev in events:
        if ev.kind == "integration_state":
            services.set_integration_error(ctx.integration, ev.error_code or "")
            applied = True
            continue
        if ev.kind == "repo_removed":
            for removed in Repository.objects.filter(integration=ctx.integration, external_id__in=ev.repo_ids):
                services.untrack(removed)
            applied = True
            continue
        repo = tracked_repo(ctx.integration, ev.repo_external_id)
        if repo is None:
            continue
        applied = True
        if ev.kind == "pr_upsert" and ev.pr:
            upsert_pr(ctx, repo, ev.pr)
        elif ev.kind == "review_update" and ev.number:
            refresh_approvals(ctx, repo, ev.number)
        elif ev.kind == "push" and ev.branch:
            upsert_branch(ctx, repo, ev.branch)
            commits = ev.commits
            if ev.compare:
                commits = ctx.provider.compare_commits(repo, ev.compare[0], ev.compare[1], limit=100)
            upsert_commits(ctx, repo, commits)
        elif ev.kind == "branch_upsert" and ev.branch:
            upsert_branch(ctx, repo, ev.branch)
        elif ev.kind == "branch_deleted":
            delete_branch(ctx, repo, ev.branch_name)
        elif ev.kind == "checks_update":
            update_checks(ctx, repo, ev.sha, ev.checks, ev.replace_checks)
        elif ev.kind == "repo_update":
            services.update_repository_meta(repo, ev.full_path, ev.archived, ev.deleted)
    return applied


def publish_touched(ctx: Context) -> None:
    """One `task.changed` `["development"]` per touched task (`version: null`: links don't bump it)."""
    from apps.realtime.services import publish

    for task_id, (key, project_id) in ctx.touched.items():
        publish(
            "task.changed",
            workspace=ctx.integration.workspace_id,
            project=project_id,
            data={"taskId": str(task_id), "key": key, "op": "updated", "version": None, "fields": ["development"]},
        )


def publish_bulk_touched(ctx: Context) -> None:
    from apps.realtime.services import MAX_BULK_IDS, publish

    by_project: dict[Any, list[str]] = {}
    for task_id, (_, project_id) in ctx.touched.items():
        by_project.setdefault(project_id, []).append(str(task_id))
    for project_id, ids in by_project.items():
        publish(
            "tasks.bulk_changed",
            workspace=ctx.integration.workspace_id,
            project=project_id,
            data={"taskIds": ids if len(ids) <= MAX_BULK_IDS else None, "op": "updated"},
        )
