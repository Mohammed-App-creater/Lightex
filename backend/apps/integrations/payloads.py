"""Wire shapes of docs/v2/37-integrations-github-gitlab.md §5.1, §5.6 and §5.7. No credential column is ever read."""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.conf import settings
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from apps.common.utils import iso

from .models import PROVIDER_NAME, Integration, Repository, RepositoryProject, SyncRun
from .providers.base import get_provider

SYNC_COOLDOWN = dt.timedelta(minutes=2)
HEADLINE_MERGED_DAYS = 14

ERROR_MESSAGES = {
    "token_expired": "{name} access expired. Reconnect to resume syncing.",
    "token_revoked": "{name} access was revoked. Reconnect to resume syncing.",
    "installation_suspended": "The GitHub App was suspended on the organization.",
    "installation_removed": "The GitHub App was uninstalled from the organization.",
    "insufficient_scope": "Lightex is missing permissions. Reconnect to grant them.",
    "unreachable": "Lightex can’t reach this GitLab instance.",
    "webhook_failing": "{name} webhooks are failing.",
}


def providers_info() -> list[dict[str, Any]]:
    out = []
    for key in ("github", "gitlab"):
        provider = get_provider(key)
        available = settings.INTEGRATIONS_ENABLED and provider.available()
        methods = provider.methods()
        out.append(
            {
                "provider": key,
                "name": PROVIDER_NAME[key],
                "available": available,
                "methods": methods,
                "oauthBaseUrl": settings.GITLAB_BASE_URL if key == "gitlab" and "oauth" in methods else None,
                "canCreateBranch": settings.GITHUB_BRANCH_CREATION if key == "github" else True,
            }
        )
    return out


def can_create_branch(repo: Repository, integration: Integration | None = None) -> bool:
    integration = integration or repo.integration
    allowed = settings.GITHUB_BRANCH_CREATION if integration.provider == "github" else True
    return bool(allowed and not repo.archived)


def repo_project_ids(repo: Repository) -> list[str]:
    cached = getattr(repo, "_project_ids", None)
    if cached is None:
        cached = [
            str(p) for p in RepositoryProject.objects.filter(repository=repo).values_list("project_id", flat=True)
        ]
    return sorted(cached)


def repository_data(repo: Repository, integration: Integration | None = None) -> dict[str, Any]:
    integration = integration or repo.integration
    state = "paused" if integration.status == "error" else repo.sync_state
    return {
        "id": str(repo.pk),
        "integrationId": str(integration.pk),
        "provider": integration.provider,
        "externalId": repo.external_id,
        "fullPath": repo.full_path,
        "owner": repo.owner_path,
        "name": repo.name,
        "visibility": repo.visibility,
        "defaultBranch": repo.default_branch,
        "url": repo.web_url,
        "allProjects": repo.all_projects,
        "projectIds": [] if repo.all_projects else repo_project_ids(repo),
        "openPullRequests": repo.open_pr_count,
        "syncState": state,
        "lastSyncedAt": iso(repo.last_synced_at),
        "canCreateBranch": can_create_branch(repo, integration),
    }


def _visible_project_ids(user: Any, workspace_id: Any) -> set[str]:
    from apps.projects.models import ProjectMember

    return {
        str(p)
        for p in ProjectMember.objects.filter(
            user_id=user.pk, project__workspace_id=workspace_id, project__deleted_at__isnull=True
        ).values_list("project_id", flat=True)
    }


def error_data(integration: Integration) -> dict[str, Any] | None:
    if integration.status != "error" or not integration.error_code:
        return None
    template = ERROR_MESSAGES.get(integration.error_code, "{name} needs attention.")
    return {
        "code": integration.error_code,
        "message": template.format(name=integration.provider_name),
        "since": iso(integration.error_since or integration.updated_at),
    }


def integration_data(integration: Integration, user: Any = None, *, manager: bool = True) -> dict[str, Any]:
    repos = list(integration.repositories.order_by("full_path"))
    links = RepositoryProject.objects.filter(repository__in=repos).values_list("repository_id", "project_id")
    by_repo: dict[Any, list[str]] = {}
    for repo_id, project_id in links:
        by_repo.setdefault(repo_id, []).append(str(project_id))
    for repo in repos:
        repo._project_ids = by_repo.get(repo.pk, [])  # type: ignore[attr-defined]
    if not manager and user is not None:
        visible = _visible_project_ids(user, integration.workspace_id)
        repos = [r for r in repos if r.all_projects or visible & set(r._project_ids)]  # type: ignore[attr-defined]
    now = timezone.now()
    next_sync = integration.sync_requested_at + SYNC_COOLDOWN if integration.sync_requested_at else None
    provider = get_provider(integration.provider)
    manage_url = getattr(provider, "manage_url", lambda i: None)(integration) if manager else None
    return {
        "id": str(integration.pk),
        "provider": integration.provider,
        "authKind": integration.auth_kind,
        "baseUrl": integration.base_url,
        "account": {
            "login": integration.account_login,
            "kind": integration.account_kind,
            "url": integration.account_url,
        },
        "status": "error" if integration.status == "error" else "active",
        "error": error_data(integration),
        "connectedBy": str(integration.connected_by_id) if integration.connected_by_id else None,
        "connectedAt": iso(integration.connected_at or integration.created_at),
        "lastSyncedAt": iso(integration.last_synced_at),
        "syncing": SyncRun.objects.filter(integration=integration, status__in=SyncRun.ACTIVE).exists(),
        "nextSyncAt": iso(next_sync) if next_sync and next_sync > now else None,
        "tokenExpiresAt": iso(integration.token_expires_at),
        "manageUrl": manage_url,
        "repositories": [repository_data(r, integration) for r in repos],
    }


# ───────────────────────── Project.devEnabled ─────────────────────────


def dev_enabled_annotations() -> dict[str, Any]:
    """`dev_all` / `dev_scoped` for Project querysets (one subquery each, whatever the number of projects)."""
    active = Repository.objects.filter(workspace=OuterRef("workspace"), integration__status="active", all_projects=True)
    scoped = RepositoryProject.objects.filter(
        project=OuterRef("pk"), repository__integration__status="active", repository__all_projects=False
    )
    return {"dev_all": Exists(active), "dev_scoped": Exists(scoped)}


def project_dev_enabled(project: Any) -> bool:
    if hasattr(project, "dev_all"):
        return bool(project.dev_all or project.dev_scoped)
    return applicable_repositories(project).exists()


def applicable_repositories(project: Any, *, active_only: bool = True) -> Any:
    qs = Repository.objects.filter(workspace_id=project.workspace_id).filter(
        Q(all_projects=True) | Q(pk__in=RepositoryProject.objects.filter(project=project).values("repository_id"))
    )
    if active_only:
        qs = qs.filter(integration__status="active")
    return qs


# ───────────────────────── development items (§5.6) ─────────────────────────


def _author(link: Any) -> dict[str, Any]:
    user = link.author_user if link.author_user_id else None
    return {
        "login": link.author_login or (user.name if user else ""),
        "name": (user.name if user else None) or link.author_name or None,
        "userId": str(link.author_user_id) if link.author_user_id else None,
    }


def _repo_ref(link: Any) -> dict[str, Any] | None:
    if not link.repository_id:
        return None
    return {"id": str(link.repository_id), "fullPath": link.repo_full_path}


def checks_data(link: Any) -> dict[str, Any] | None:
    items = link.checks or []
    if not items or not link.checks_state:
        return None
    return {
        "state": link.checks_state,
        "passed": sum(1 for c in items if c.get("state") == "passing"),
        "total": len(items),
        "items": [
            {"name": c.get("name"), "state": c.get("state"), "durationSec": c.get("durationSec"), "url": c.get("url")}
            for c in items
        ],
    }


def ref_of(provider: str, number: int | None) -> str:
    return f"!{number}" if provider == "gitlab" else f"#{number}"


def dev_item(link: Any) -> dict[str, Any]:
    base = {
        "id": str(link.pk),
        "kind": link.type,
        "provider": link.provider,
        "repository": _repo_ref(link),
        "repoFullPath": link.repo_full_path,
    }
    if link.type == "pull_request":
        return {
            **base,
            "number": link.number,
            "ref": ref_of(link.provider, link.number),
            "title": link.title,
            "url": link.url,
            "state": link.state,
            "headBranch": link.head_branch,
            "baseBranch": link.base_branch,
            "author": _author(link),
            "checks": checks_data(link),
            "approvals": link.approvals,
            "linkSource": link.link_source,
            "createdAt": iso(link.source_created_at or link.created_at),
            "updatedAt": iso(link.source_updated_at or link.updated_at),
            "mergedAt": iso(link.merged_at),
            "closedAt": iso(link.closed_at),
        }
    if link.type == "branch":
        return {
            **base,
            "name": link.title,
            "url": link.url,
            "state": link.state or "active",
            "aheadBy": link.ahead_by,
            "linkSource": link.link_source,
            "updatedAt": iso(link.source_updated_at or link.updated_at),
        }
    return {
        **base,
        "sha": link.sha,
        "shortSha": link.sha[:7],
        "message": link.title,
        "url": link.url,
        "author": _author(link),
        "committedAt": iso(link.source_created_at or link.created_at),
        "linkSource": link.link_source,
    }


# ───────────────────────── Task.dev (§5.7) ─────────────────────────


def task_dev(task: Any) -> dict[str, Any] | None:
    """The board chip summary. Uses `tasks.selectors.annotated()` counters and the PR prefetch when present."""
    from apps.tasks.models import ExternalLink

    counts = [getattr(task, a, None) for a in ("dev_pr_count", "dev_branch_count", "dev_commit_count")]
    if any(c is None for c in counts):
        visible = ExternalLink.objects.filter(task=task, suppressed=False)
        counts = [
            visible.filter(type="pull_request").count(),
            visible.filter(type="branch", state="active").count(),
            visible.filter(type="commit").count(),
        ]
    if not any(counts):
        return None
    prs = getattr(task, "dev_pr_links", None)
    if prs is None:
        prs = list(
            ExternalLink.objects.filter(
                task=task, suppressed=False, type="pull_request", state__in=("open", "draft", "merged")
            )
        )
    return {"pr": _headline(prs), "prCount": counts[0], "branchCount": counts[1], "commitCount": counts[2]}


def _headline(prs: list[Any]) -> dict[str, Any] | None:
    def updated(link: Any) -> dt.datetime:
        return link.source_updated_at or link.updated_at

    open_prs = sorted((p for p in prs if p.state in ("open", "draft")), key=updated, reverse=True)
    pick = open_prs[0] if open_prs else None
    if pick is None:
        cutoff = timezone.now() - dt.timedelta(days=HEADLINE_MERGED_DAYS)
        merged = sorted(
            (p for p in prs if p.state == "merged" and p.merged_at and p.merged_at >= cutoff),
            key=lambda p: p.merged_at,
            reverse=True,
        )
        pick = merged[0] if merged else None
    if pick is None:
        return None
    checks = checks_data(pick)
    return {
        "provider": pick.provider,
        "number": pick.number,
        "ref": ref_of(pick.provider, pick.number),
        "state": pick.state,
        "checks": checks["state"] if checks else None,
        "checksPassed": checks["passed"] if checks else 0,
        "checksTotal": checks["total"] if checks else 0,
        "approvals": pick.approvals,
        "baseBranch": pick.base_branch,
        "mergedAt": iso(pick.merged_at),
    }
