"""Task development D1–D4 and automation rules A1–A2 (docs/v2/37-integrations-github-gitlab.md §5.6, §5.8)."""

from __future__ import annotations

import re
import urllib.parse
from typing import Any

from django.db import transaction
from django.db.models import Case, IntegerField, Value, When
from django.utils import timezone

from core.audit.services import change, record
from core.common.exceptions import conflict, invalid, not_found
from core.realtime.services import publish
from modules.tracking.tasks.models import ExternalLink, Task

from . import automation, matching, payloads, processor
from .models import AutomationRule, Repository
from .providers.base import BranchExists, ProviderError, Rejected, get_provider
from .services import maybe_catchup, provider_failed

MAX_PRS = 50
MAX_BRANCHES = 50
MAX_COMMITS = 20
KIND_NAMES = {
    "github": {"pull_request": "pull request", "commit": "commit", "branch": "branch"},
    "gitlab": {"pull_request": "merge request", "commit": "commit", "branch": "branch"},
}
_GITHUB_PATH = re.compile(
    r"^/(?P<full>[^/]+/[^/]+)/(?:pull/(?P<n>\d+)|commit/(?P<sha>[0-9a-fA-F]{7,40})|tree/(?P<branch>.+))$"
)
_GITLAB_PATH = re.compile(
    r"^/(?P<full>.+?)/-/(?:merge_requests/(?P<n>\d+)|commit/(?P<sha>[0-9a-fA-F]{7,40})|tree/(?P<branch>.+))$"
)


def _visible(task: Task) -> Any:
    return ExternalLink.objects.filter(task=task, suppressed=False).select_related("author_user")


def repositories_for(task: Task) -> list[Repository]:
    return list(payloads.applicable_repositories(task.project).select_related("integration").order_by("full_path"))


def _publish(task: Task) -> None:
    publish(
        "tracking.task.changed",
        workspace=task.project.workspace_id,
        project=task.project_id,
        data={"taskId": str(task.pk), "key": task.key, "op": "updated", "version": None, "fields": ["development"]},
    )


def development(task: Task) -> dict[str, Any]:
    """D1: never calls the provider; a stale integration gets a catch-up run."""
    repos = repositories_for(task)
    for integration in {r.integration_id: r.integration for r in repos}.values():
        maybe_catchup(integration)
    links = _visible(task)
    order = Case(
        When(state__in=("open", "draft"), then=Value(0)),
        When(state="merged", then=Value(1)),
        default=Value(2),
        output_field=IntegerField(),
    )
    prs = list(
        links.filter(type="pull_request").annotate(o=order).order_by("o", "-merged_at", "-source_updated_at")[:MAX_PRS]
    )
    branches = list(links.filter(type="branch", state="active").order_by("-source_updated_at")[:MAX_BRANCHES])
    commits = links.filter(type="commit").order_by("-source_created_at")
    synced = [r.integration.last_synced_at for r in repos if r.integration.last_synced_at]
    from core.common.utils import iso

    return {
        "taskId": str(task.pk),
        "taskKey": task.key,
        "enabled": bool(repos),
        "suggestedBranch": matching.suggest_branch(task.key, task.title),
        "repositories": [
            {
                "id": str(r.pk),
                "provider": r.integration.provider,
                "fullPath": r.full_path,
                "name": r.name,
                "defaultBranch": r.default_branch,
                "canCreateBranch": payloads.can_create_branch(r, r.integration),
            }
            for r in repos
        ],
        "pullRequests": [payloads.dev_item(link) for link in prs],
        "branches": [payloads.dev_item(link) for link in branches],
        "commits": [payloads.dev_item(link) for link in commits[:MAX_COMMITS]],
        "commitTotal": commits.count(),
        "syncedAt": iso(max(synced)) if synced else None,
    }


def _parse(url: str) -> tuple[str, str, str, str] | None:
    """(origin, full path, kind, ref) from a PR/MR, commit or branch URL (§5.6 D2)."""
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme not in ("https", "http") or not parts.hostname:
        return None
    origin = f"{parts.scheme}://{parts.netloc.lower()}"
    path = urllib.parse.unquote(parts.path).rstrip("/")
    path = re.sub(r"/(files|commits|diffs)$", "", path)
    for pattern in (_GITLAB_PATH, _GITHUB_PATH):
        m = pattern.match(path)
        if m:
            if m.group("n"):
                return origin, m.group("full"), "pull_request", m.group("n")
            if m.group("sha"):
                return origin, m.group("full"), "commit", m.group("sha").lower()
            return origin, m.group("full"), "branch", m.group("branch")
    return None


def _audit(user: Any, task: Task, action: str, data: dict[str, Any]) -> None:
    record(
        workspace=task.project.workspace_id,
        project=task.project_id,
        task=task,
        actor=user,
        action=action,
        target=task.title,
        entity_id=task.pk,
        entity_key=task.key,
        data=data,
    )


def link(user: Any, task: Task, data: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """D2: manual link by URL; re-linking lifts a suppression; an already-visible link answers 200."""
    url = data.get("url")
    parsed = _parse(url) if isinstance(url, str) and len(url) <= 500 else None
    if parsed is None:
        raise invalid({"url": "Paste a pull request, merge request, commit or branch link."})
    origin, full_path, kind, ref = parsed
    repo = (
        Repository.objects.select_related("integration")
        .filter(workspace_id=task.project.workspace_id, integration__base_url=origin, full_path__iexact=full_path)
        .exclude(integration__status__in=("pending", "disconnecting"))
        .first()
    )
    if repo is None:
        raise invalid({"url": "Connect this repository first."})
    if not payloads.applicable_repositories(task.project, active_only=False).filter(pk=repo.pk).exists():
        raise invalid({"url": f"This repository isn’t used by {task.project.key}."})
    integration = repo.integration
    provider = get_provider(integration.provider)
    try:
        resolved = provider.resolve_url(integration, repo, kind, ref)
    except ProviderError as exc:
        raise provider_failed(integration.provider, exc.status) from exc
    if resolved is None:
        raise invalid({"url": f"{integration.provider_name} can’t find this {KIND_NAMES[integration.provider][kind]}."})
    ctx = processor.Context(integration, provider)
    label: Any
    if resolved.pr is not None:
        ext, fields, label = (
            f"{repo.external_id}#{resolved.pr.number}",
            processor.pr_fields(ctx, resolved.pr),
            resolved.pr,
        )
        fields["sha"] = resolved.pr.sha[:40]
    elif resolved.commit is not None:
        ext, fields, label = resolved.commit.sha, processor.commit_fields(ctx, resolved.commit), resolved.commit
    elif resolved.branch is not None:
        ext, fields, label = (
            f"{repo.external_id}:{resolved.branch.name}",
            processor.branch_fields(resolved.branch),
            resolved.branch,
        )
        if resolved.branch.sha:
            fields["sha"] = resolved.branch.sha[:40]
    else:  # pragma: no cover - resolve_url always fills one object
        raise invalid({"url": "Paste a pull request, merge request, commit or branch link."})
    with transaction.atomic():
        row = (
            ExternalLink.objects.select_for_update()
            .filter(task=task, provider=integration.provider, type=kind, external_id=ext)
            .first()
        )
        status = 201
        if row is not None and not row.suppressed:
            status = 200
        elif row is not None:
            row.suppressed, row.linked_by = False, user
            row.save(update_fields=["suppressed", "linked_by", "updated_at"])
        else:
            row = ExternalLink.objects.create(
                task=task,
                workspace_id=task.project.workspace_id,
                provider=integration.provider,
                type=kind,
                external_id=ext,
                repository=repo,
                base_url=integration.base_url,
                repo_external_id=repo.external_id,
                repo_full_path=repo.full_path,
                link_source="manual",
                linked_by=user,
                **fields,
            )
        if status == 201:
            if kind != "commit":
                ref_text = payloads.ref_of(integration.provider, row.number) if kind == "pull_request" else row.title
                _audit(
                    user,
                    task,
                    "tracking.task.dev_linked",
                    {
                        "provider": integration.provider,
                        "kind": kind,
                        "ref": ref_text,
                        "repo": repo.full_path,
                        "url": row.url,
                        "title": getattr(label, "title", "") or "",
                    },
                )
            _publish(task)
    row.refresh_from_db()
    return payloads.dev_item(row), status


def unlink(user: Any, task: Task, link_id: Any) -> None:
    """D3: a manual link is deleted; an auto/created one is suppressed (matching never brings it back)."""
    from modules.tracking.tasks.selectors import is_uuid

    row = ExternalLink.objects.filter(pk=link_id, task=task, suppressed=False).first() if is_uuid(link_id) else None
    if row is None:
        raise not_found("Link not found.")
    with transaction.atomic():
        if row.link_source == "manual":
            row.delete()
        else:
            ExternalLink.objects.filter(pk=row.pk).update(suppressed=True)
        ref = payloads.ref_of(row.provider, row.number) if row.type == "pull_request" else (row.title or row.sha[:7])
        _audit(
            user,
            task,
            "tracking.task.dev_unlinked",
            {"provider": row.provider, "kind": row.type, "ref": ref, "repo": row.repo_full_path},
        )
        _publish(task)


def create_branch(user: Any, task: Task, data: dict[str, Any]) -> dict[str, Any]:
    """D4: from the repository's default branch; linked even without a key; `branch_created` automation."""
    from modules.tracking.tasks.selectors import is_uuid

    name = data.get("name")
    message = matching.validate_branch(name) if isinstance(name, str) else "Use letters, numbers, - _ . / only."
    if message:
        raise invalid({"name": message})
    name = str(name)
    repo_id = data.get("repositoryId")
    repo = (
        Repository.objects.select_related("integration")
        .filter(pk=str(repo_id), workspace_id=task.project.workspace_id)
        .first()
        if is_uuid(repo_id)
        else None
    )
    if repo is None or not payloads.applicable_repositories(task.project).filter(pk=repo.pk).exists():
        raise invalid({"repositoryId": f"Choose a repository used by {task.project.key}."})
    if not payloads.can_create_branch(repo, repo.integration):
        raise invalid({"repositoryId": "Branches can’t be created in this repository."})
    integration = repo.integration
    provider = get_provider(integration.provider)
    try:
        branch = provider.create_branch(repo, name, repo.default_branch)
    except BranchExists as exc:
        raise conflict("branch_exists", f"That branch already exists in {repo.full_path}.") from exc
    except Rejected as exc:
        raise invalid({"name": str(exc)[:200]}) from exc
    except ProviderError as exc:
        raise provider_failed(integration.provider, exc.status) from exc
    ext = f"{repo.external_id}:{branch.name}"
    with transaction.atomic():
        row, _ = ExternalLink.objects.update_or_create(
            task=task,
            provider=integration.provider,
            type="branch",
            external_id=ext,
            defaults={
                "workspace_id": task.project.workspace_id,
                "repository": repo,
                "base_url": integration.base_url,
                "repo_external_id": repo.external_id,
                "repo_full_path": repo.full_path,
                "url": branch.url[:500],
                "title": branch.name,
                "state": "active",
                "sha": branch.sha[:40],
                "ahead_by": 0,
                "source_created_at": timezone.now(),
                "source_updated_at": timezone.now(),
                "link_source": "created",
                "linked_by": user,
                "suppressed": False,
            },
        )
        _audit(
            user,
            task,
            "tracking.task.dev_branch_created",
            {"provider": integration.provider, "repo": repo.full_path, "branch": branch.name},
        )
        ctx = processor.Context(integration, provider)
        automation.apply(ctx, "branch_created", [row], branch.name)
        _publish(task)
    row.refresh_from_db()
    return payloads.dev_item(row)


# ───────────────────────── automation rules (§5.8) ─────────────────────────


def rules(project: Any) -> list[dict[str, Any]]:
    by_trigger = {r.trigger: r for r in AutomationRule.objects.filter(project=project)}
    out = []
    for trigger in automation.TRIGGERS:
        rule = by_trigger.get(trigger)
        out.append(
            {
                "trigger": trigger,
                "enabled": bool(rule and rule.enabled),
                "statusId": str(rule.status_id) if rule else None,
            }
        )
    return out


def set_rules(user: Any, project: Any, data: Any) -> list[dict[str, Any]]:
    """A2: all three triggers; an enabled trigger needs a status of this project; merges target Done."""
    items = data.get("rules") if isinstance(data, dict) else data
    if not isinstance(items, list) or len(items) != len(automation.TRIGGERS):
        raise invalid({"rules": "Send the three rules."})
    statuses = {str(s.pk): s for s in project.statuses.all()}
    fields: dict[str, str] = {}
    clean = []
    for i, item in enumerate(items):
        trigger = item.get("trigger") if isinstance(item, dict) else None
        if trigger != automation.TRIGGERS[i]:
            raise invalid({f"rules.{i}.trigger": "Send branch_created, pr_opened and pr_merged in that order."})
        enabled = item.get("enabled") is True
        status = statuses.get(str(item.get("statusId"))) if item.get("statusId") else None
        if enabled and status is None:
            fields[f"rules.{i}.statusId"] = "Choose a status."
        elif enabled and trigger == "pr_merged" and status is not None and status.category != "done":
            fields[f"rules.{i}.statusId"] = "Pick a Done status."
        clean.append((trigger, enabled, status))
    if fields:
        raise invalid(fields)
    before = {r["trigger"]: r for r in rules(project)}
    changes = []
    with transaction.atomic():
        for trigger, enabled, status in clean:
            if status is None:
                AutomationRule.objects.filter(project=project, trigger=trigger).delete()
            else:
                AutomationRule.objects.update_or_create(
                    project=project,
                    trigger=trigger,
                    defaults={"status": status, "enabled": enabled, "updated_by": user},
                )
            old = before[trigger]
            old_text = statuses[old["statusId"]].name if old["enabled"] and old["statusId"] in statuses else "Off"
            new_text = status.name if enabled and status is not None else "Off"
            if old_text != new_text:
                changes.append(change(trigger, old_text, new_text, "text"))
        if changes:
            record(
                workspace=project.workspace_id,
                project=project,
                actor=user,
                action="tracking.project.dev_automation_updated",
                target=project.name,
                entity_id=project.pk,
                entity_key=project.key,
                changes=changes,
            )
            publish(
                "tracking.project.changed",
                workspace=project.workspace_id,
                project=project.pk,
                data={"areas": ["development"]},
            )
    return rules(project)
