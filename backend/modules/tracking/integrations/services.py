"""Integration writes and reads G1–G13 (docs/v2/37-integrations-github-gitlab.md §5.2–§5.4, §8).

Connect binds the provider round-trip with two secrets (§5.3): the hashed `state`, and a one-time confirm token
returned in the URL fragment that the authenticated client sends back to G6.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import logging
import secrets
import urllib.parse
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone

from core.access import services as access
from core.audit.services import record
from core.common.exceptions import ApiError, conflict, invalid, not_found
from core.realtime.services import publish
from modules.tracking.tasks.models import ExternalLink

from . import payloads, runner
from .automation import IntegrationActor
from .models import ConnectAttempt, Integration, Repository, RepositoryProject, SyncRun, WebhookDelivery
from .providers.base import ConnectError, ConnectResult, ProviderError, RepoInfo, TokenError, get_provider

logger = logging.getLogger("lightex.integrations")

ATTEMPT_TTL = dt.timedelta(minutes=10)
REPOS_CACHE_SECONDS = 60
MAX_TRACKED = 200
SYNC_COOLDOWN = payloads.SYNC_COOLDOWN
LISTED = ("active", "error")


def unavailable() -> ApiError:
    return ApiError(503, "integrations_unavailable", "Integrations aren’t available on this server.")


def provider_failed(provider: str, status: int | None = None, details: dict[str, Any] | None = None) -> ApiError:
    name = "GitHub" if provider == "github" else "GitLab"
    return ApiError(
        502,
        "provider_failed",
        f"{name} didn’t respond. Try again.",
        {"provider": provider, "status": status, **(details or {})},
    )


def ensure_enabled() -> None:
    if not settings.INTEGRATIONS_ENABLED:
        raise unavailable()


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _target(integration: Integration) -> str:
    return f"{integration.provider_name} · {integration.account_login}"


def publish_integration(integration: Integration, op: str) -> None:
    publish(
        "tracking.integration.changed",
        workspace=integration.workspace_id,
        data={"integrationId": str(integration.pk), "op": op},
    )


def publish_development_areas(workspace_id: Any, project_ids: Any = None) -> None:
    from modules.tracking.projects.models import Project

    if project_ids is None:
        project_ids = Project.objects.filter(workspace_id=workspace_id).values_list("pk", flat=True)
    for project_id in project_ids:
        publish("tracking.project.changed", workspace=workspace_id, project=project_id, data={"areas": ["development"]})


def _audit(integration: Integration, actor: Any, action: str, data: dict[str, Any], target: str | None = None) -> Any:
    return record(
        workspace=integration.workspace_id,
        actor=actor,
        action=action,
        target=target or _target(integration),
        entity_id=integration.pk,
        data=data,
    )


# ───────────────────────── reads ─────────────────────────


def integration_for(user: Any, integration_id: Any) -> Integration:
    """An integration of a workspace the user belongs to (else 404)."""
    from modules.tracking.tasks.selectors import is_uuid

    integration = (
        Integration.objects.select_related("workspace").filter(pk=integration_id, status__in=LISTED).first()
        if is_uuid(integration_id)
        else None
    )
    if integration is None or not access.is_workspace_member(user, integration.workspace):
        raise not_found("Integration not found.")
    return integration


def repository_for(user: Any, repo_id: Any) -> Repository:
    from modules.tracking.tasks.selectors import is_uuid

    repo = (
        Repository.objects.select_related("integration", "workspace").filter(pk=repo_id).first()
        if is_uuid(repo_id)
        else None
    )
    if repo is None or not access.is_workspace_member(user, repo.workspace):
        raise not_found("Repository not found.")
    return repo


def is_manager(user: Any, workspace: Any) -> bool:
    return access.can(user, "tracking.integration.manage", workspace)


def overview(user: Any, workspace: Any) -> dict[str, Any]:
    """G1. Side effect: a catch-up run for stale active integrations (§7.6)."""
    manager = is_manager(user, workspace)
    integrations = sorted(
        Integration.objects.filter(workspace=workspace, status__in=LISTED),
        key=lambda i: (i.provider != "github", i.connected_at or i.created_at),
    )
    for integration in integrations:
        maybe_catchup(integration)
    return {
        "providers": payloads.providers_info(),
        "integrations": [payloads.integration_data(i, user, manager=manager) for i in integrations],
    }


def integration_payload(user: Any, integration: Integration) -> dict[str, Any]:
    integration.refresh_from_db()
    return payloads.integration_data(integration, user, manager=is_manager(user, integration.workspace))


def maybe_catchup(integration: Integration) -> None:
    if integration.status != "active" or not integration.repositories.exists():
        return
    cutoff = timezone.now() - dt.timedelta(minutes=settings.INTEGRATION_CATCHUP_MINUTES)
    if integration.last_synced_at is None or integration.last_synced_at < cutoff:
        runner.enqueue(integration, None, "catchup")


# ───────────────────────── connect (§5.3) ─────────────────────────


def _provider_or_503(key: str) -> Any:
    ensure_enabled()
    provider = get_provider(key)
    if not provider.available():
        raise unavailable()
    return provider


def start_attempt(user: Any, workspace: Any, key: str, *, integration: Integration | None = None) -> dict[str, str]:
    provider = _provider_or_503(key)
    state = secrets.token_urlsafe(32)
    attempt = ConnectAttempt(
        workspace=workspace,
        user=user,
        provider=key,
        mode="reconnect" if integration else "connect",
        integration=integration,
        state_hash=_hash(state),
        expires_at=timezone.now() + ATTEMPT_TTL,
    )
    url = provider.authorize_url(attempt, state)
    attempt.save()
    return {"authorizeUrl": url}


def connect_gitlab(user: Any, workspace: Any, data: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """G3: OAuth → 200 {authorizeUrl}; token → 201 Integration."""
    provider = _provider_or_503("gitlab")
    method = data.get("method")
    if method == "oauth":
        if "oauth" not in provider.methods():
            raise unavailable()
        return start_attempt(user, workspace, "gitlab"), 200
    if method != "token":
        raise invalid({"method": "Choose GitLab.com or an access token."})
    result = _check_token(provider, data.get("baseUrl"), data.get("token"))
    existing = Integration.objects.filter(
        workspace=workspace, provider="gitlab", base_url=result.base_url, account_external_id=result.account_external_id
    ).first()
    if existing is not None:
        raise conflict(
            "integration_exists",
            "This GitLab account is already connected.",
            {"integrationId": str(existing.pk)},
        )
    with transaction.atomic():
        integration = Integration(
            workspace=workspace,
            provider="gitlab",
            auth_kind="gitlab_token",
            status="active",
            connected_by=user,
            connected_at=timezone.now(),
            last_synced_at=timezone.now(),
        )
        _apply_result(integration, result)
        integration.set_secret("webhook_secret", secrets.token_urlsafe(32))
        integration.save()
        _audit(integration, user, "tracking.integration.connected", _connect_data(integration))
        publish_integration(integration, "connected")
    return integration_payload(user, integration), 201


def _check_token(provider: Any, base_url: Any, token: Any) -> ConnectResult:
    fields = {}
    if not isinstance(base_url, str) or not base_url.strip():
        fields["baseUrl"] = "Use an https:// address."
    if not isinstance(token, str) or not token.strip():
        fields["token"] = "GitLab didn't accept this token."  # noqa: S105 (a message)
    if fields:
        raise invalid(fields)
    try:
        return provider.connect_with_token(base_url.strip(), token.strip())  # type: ignore[union-attr]
    except TokenError as exc:
        raise invalid({exc.field: exc.message}) from exc


def _apply_result(integration: Integration, result: ConnectResult) -> None:
    integration.base_url = result.base_url
    integration.account_external_id = result.account_external_id
    integration.account_login = result.account_login[:100]
    integration.account_kind = result.account_kind
    integration.account_url = result.account_url[:300]
    integration.scopes = result.scopes
    integration.token_expires_at = result.token_expires_at
    if not integration.pk:  # pragma: no cover - BaseModel assigns the UUID on construction
        raise RuntimeError("integration needs a primary key before its credentials are encrypted")
    integration.set_credentials(result.credentials)


def _connect_data(integration: Integration) -> dict[str, Any]:
    return {"provider": integration.provider, "account": integration.account_login, "authKind": integration.auth_kind}


def _attempt_for(state: str | None, provider: str) -> ConnectAttempt | None:
    if not state:
        return None
    return (
        ConnectAttempt.objects.select_related("workspace", "user")
        .filter(state_hash=_hash(state), provider=provider)
        .first()
    )


def _return_url(attempt: ConnectAttempt | None, fragment: str) -> str:
    if attempt is None or attempt.workspace.deleted_at is not None:
        return f"{settings.FRONTEND_URL}/#connect_error=state_invalid"
    return f"{settings.FRONTEND_URL}/{attempt.workspace.slug}/settings/integrations#{fragment}"


def _fail(attempt: ConnectAttempt | None, code: str) -> str:
    if attempt is not None and attempt.status == "started":
        attempt.status, attempt.error_code = "failed", code
        attempt.save(update_fields=["status", "error_code", "updated_at"])
    return _return_url(attempt, f"connect_error={code}")


def _attempt_usable(attempt: ConnectAttempt | None) -> bool:
    if attempt is None or attempt.status != "started" or attempt.expires_at <= timezone.now():
        return False
    user = attempt.user
    return bool(user.is_active and access.can(user, "tracking.integration.manage", attempt.workspace))


def github_setup(params: Any) -> str:
    """G4: the GitHub Setup URL leg → the OAuth leg (same state)."""
    if not settings.INTEGRATIONS_ENABLED:
        return f"{settings.FRONTEND_URL}/#connect_error=state_invalid"
    state = params.get("state")
    attempt = _attempt_for(state, "github")
    if not _attempt_usable(attempt):
        return _fail(attempt, "state_invalid")
    if attempt is None or not state:  # pragma: no cover - _attempt_usable() already checked both
        return _fail(attempt, "state_invalid")
    if params.get("setup_action") == "request":
        return _fail(attempt, "github_requested")
    attempt.installation_id = str(params.get("installation_id") or "")[:32]
    attempt.save(update_fields=["installation_id", "updated_at"])
    return get_provider("github").oauth_url(state)  # type: ignore[attr-defined]


def callback(key: str, params: Any) -> str:
    """G5: code exchange and verification, then the frontend URL with `#connect=<attempt>.<confirm>`."""
    if not settings.INTEGRATIONS_ENABLED:
        return f"{settings.FRONTEND_URL}/#connect_error=state_invalid"
    attempt = _attempt_for(params.get("state"), key)
    if not _attempt_usable(attempt):
        return _fail(attempt, "state_invalid")
    if attempt is None:  # pragma: no cover - _attempt_usable() already checked it
        return _fail(attempt, "state_invalid")
    if params.get("error"):
        return _fail(attempt, f"{key}_cancelled")
    try:
        result = get_provider(key).complete(attempt, params)
    except ConnectError as exc:
        return _fail(attempt, exc.code)
    except ProviderError:
        return _fail(attempt, "provider_failed")
    try:
        with transaction.atomic():
            integration = _claim(attempt, result)
            confirm = secrets.token_urlsafe(32)
            attempt.integration = integration
            attempt.confirm_hash = _hash(confirm)
            attempt.status = "called_back"
            attempt.expires_at = timezone.now() + ATTEMPT_TTL
            attempt.save()
    except ConnectError as exc:
        return _fail(attempt, exc.code)
    return _return_url(attempt, f"connect={attempt.pk}.{confirm}")


def _claim(attempt: ConnectAttempt, result: ConnectResult) -> Integration:
    key = attempt.provider
    if attempt.mode == "reconnect":
        integration = Integration.objects.select_for_update().filter(pk=str(attempt.integration_id)).first()
        if integration is None or integration.status not in LISTED:
            raise ConnectError("state_invalid")
        if integration.account_external_id != result.account_external_id:
            raise ConnectError("account_mismatch")
        _apply_result(integration, result)
        integration.save()
        return integration
    if key == "github":
        elsewhere = (
            Integration.objects.unscoped()  # an installation belongs to one workspace: look across all of them
            .filter(provider="github", base_url=result.base_url, account_external_id=result.account_external_id)
            .exclude(workspace=attempt.workspace)
            .exclude(status="disconnecting")
            .exists()
        )
        if elsewhere:
            raise ConnectError("installation_in_use")
    integration = Integration.objects.filter(
        workspace=attempt.workspace,
        provider=key,
        base_url=result.base_url,
        account_external_id=result.account_external_id,
    ).first()
    if integration is not None and integration.status == "disconnecting":
        raise ConnectError("provider_failed")
    if integration is None:
        integration = Integration(
            workspace=attempt.workspace,
            provider=key,
            auth_kind="github_app" if key == "github" else "gitlab_oauth",
            status="pending",
        )
        if key == "gitlab":
            integration.set_secret("webhook_secret", secrets.token_urlsafe(32))
    _apply_result(integration, result)
    try:
        with transaction.atomic():
            integration.save()
    except IntegrityError as exc:
        raise ConnectError("installation_in_use") from exc
    return integration


def fake_authorize(params: Any) -> str | None:
    """The fake provider's consent page (§7.8): straight back to the normal callback, or `access_denied`."""
    if settings.INTEGRATIONS_PROVIDER_BACKEND != "fake":
        return None
    key = params.get("provider") if params.get("provider") in ("github", "gitlab") else "github"
    query = {"state": params.get("state", "")}
    if params.get("deny"):
        query["error"] = "access_denied"
    else:
        query["code"] = params.get("code") or "fake-ok"
    return f"{settings.API_PUBLIC_URL}/api/v1/tracking/integrations/{key}/callback?" + urllib.parse.urlencode(query)


@transaction.atomic
def confirm(user: Any, workspace: Any, data: dict[str, Any]) -> dict[str, Any]:
    """G6: every mismatch is the same 404."""
    from modules.tracking.tasks.selectors import is_uuid

    attempt_id, token = data.get("attempt"), data.get("token")
    if not is_uuid(attempt_id) or not isinstance(token, str) or not token:
        raise invalid({"attempt" if not is_uuid(attempt_id) else "token": "Missing connection details."})
    attempt = ConnectAttempt.objects.select_for_update().filter(pk=str(attempt_id), workspace=workspace).first()
    ok = (
        attempt is not None
        and attempt.user_id == user.pk
        and bool(attempt.confirm_hash)
        and hmac.compare_digest(_hash(str(token)), attempt.confirm_hash)
        and attempt.status == "called_back"
        and attempt.expires_at > timezone.now()
        and attempt.integration_id is not None
        and access.can(user, "tracking.integration.manage", workspace)
    )
    if not ok:
        raise not_found("That connection link expired. Try again.")
    if attempt is None:  # pragma: no cover - ok already checked it
        raise not_found("That connection link expired. Try again.")
    integration = Integration.objects.select_for_update().get(pk=str(attempt.integration_id))
    was_new = integration.status == "pending" and attempt.mode == "connect"
    integration.status = "active"
    integration.error_code, integration.error_since = "", None
    if integration.connected_at is None:
        integration.connected_at, integration.connected_by = timezone.now(), user
        integration.last_synced_at = timezone.now()
    integration.version += 1
    integration.save()
    attempt.status = "confirmed"
    attempt.save(update_fields=["status", "updated_at"])
    action = "tracking.integration.reconnected" if attempt.mode == "reconnect" else "tracking.integration.connected"
    _audit(integration, user, action, _connect_data(integration))
    if attempt.mode == "reconnect":
        runner.enqueue(integration, None, "catchup", user)
    publish_integration(integration, "connected" if was_new else "updated")
    return payloads.integration_data(integration, user, manager=True)


def reconnect(user: Any, integration: Integration, data: dict[str, Any]) -> dict[str, Any]:
    """G12."""
    if integration.auth_kind != "gitlab_token":
        return start_attempt(user, integration.workspace, integration.provider, integration=integration)
    provider = _provider_or_503("gitlab")
    result = _check_token(provider, integration.base_url, data.get("token"))
    if result.account_external_id != integration.account_external_id:
        raise invalid({"token": "This token belongs to a different GitLab user."})
    with transaction.atomic():
        _apply_result(integration, result)
        integration.status, integration.error_code, integration.error_since = "active", "", None
        integration.version += 1
        integration.save()
        _audit(integration, user, "tracking.integration.reconnected", _connect_data(integration))
        runner.enqueue(integration, None, "catchup", user)
        publish_integration(integration, "updated")
    return integration_payload(user, integration)


# ───────────────────────── repositories (§5.4) ─────────────────────────


def _live_repositories(integration: Integration, *, cached: bool) -> list[RepoInfo]:
    key = f"lx:int:{integration.pk}:repos"
    if cached:
        hit = cache.get(key)
        if hit is not None:
            return hit
    try:
        repos = get_provider(integration.provider).list_repositories(integration)[:1000]
    except ProviderError as exc:
        raise provider_failed(integration.provider, exc.status) from exc
    cache.set(key, repos, REPOS_CACHE_SECONDS)
    return repos


def _in_error(integration: Integration) -> None:
    if integration.status == "error":
        raise conflict("integration_error", "Reconnect this integration first.", {"code": integration.error_code})


def _tracked_elsewhere(integration: Integration) -> set[str]:
    return set(
        Repository.objects.filter(workspace_id=integration.workspace_id, integration__base_url=integration.base_url)
        .exclude(integration=integration)
        .values_list("external_id", flat=True)
    )


def available_repositories(integration: Integration, q: str = "") -> list[dict[str, Any]]:
    """G8."""
    _in_error(integration)
    repos = _live_repositories(integration, cached=True)
    tracked = set(integration.repositories.values_list("external_id", flat=True))
    elsewhere = _tracked_elsewhere(integration)
    needle = (q or "").strip().lower()
    rows = [r for r in repos if needle in r.full_path.lower()]
    rows.sort(key=lambda r: (r.owner.lower(), r.name.lower()))
    from core.common.utils import iso

    return [
        {
            "externalId": r.external_id,
            "fullPath": r.full_path,
            "owner": r.owner,
            "name": r.name,
            "visibility": r.visibility,
            "updatedAt": iso(r.updated_at),
            "tracked": r.external_id in tracked,
            "trackedElsewhere": r.external_id in elsewhere,
        }
        for r in rows
    ]


def _project_ids(workspace_id: Any, value: Any, field: str) -> list[Any]:
    from modules.tracking.projects.models import Project
    from modules.tracking.tasks.selectors import is_uuid

    if value is None:
        return []
    if not isinstance(value, list) or not all(is_uuid(v) for v in value):
        raise invalid({field: "Choose projects of this workspace."})
    ids = list(dict.fromkeys(str(v) for v in value))
    found = {str(p) for p in Project.objects.filter(workspace_id=workspace_id, pk__in=ids).values_list("pk", flat=True)}
    if len(found) != len(ids):
        raise invalid({field: "Choose projects of this workspace."})
    return ids


def _set_scope(repo: Repository, project_ids: list[Any]) -> None:
    repo.all_projects = not project_ids
    Repository.objects.filter(pk=repo.pk).update(all_projects=repo.all_projects)
    RepositoryProject.objects.filter(repository=repo).exclude(project_id__in=project_ids).delete()
    have = {str(p) for p in RepositoryProject.objects.filter(repository=repo).values_list("project_id", flat=True)}
    RepositoryProject.objects.bulk_create(
        [RepositoryProject(repository=repo, project_id=p) for p in project_ids if str(p) not in have]
    )


def set_repositories(user: Any, integration: Integration, data: dict[str, Any]) -> dict[str, Any]:
    """G9: the body is the complete tracked set."""
    _in_error(integration)
    items = data.get("repositories")
    if not isinstance(items, list) or not items:
        raise invalid({"repositories": "Choose at least one repository."})
    if len(items) > MAX_TRACKED:
        raise invalid({"repositories": f"Choose at most {MAX_TRACKED} repositories."})
    wanted: dict[str, list[Any]] = {}
    for i, item in enumerate(items):
        ext = item.get("externalId") if isinstance(item, dict) else None
        if not isinstance(ext, str) or not ext:
            raise invalid({f"repositories.{i}.externalId": "Choose a repository."})
        wanted[ext] = _project_ids(integration.workspace_id, item.get("projectIds"), f"repositories.{i}.projectIds")
    live = {r.external_id: r for r in _live_repositories(integration, cached=False)}
    elsewhere = _tracked_elsewhere(integration)
    for i, item in enumerate(items):
        ext = item["externalId"]
        if ext not in live:
            raise invalid({f"repositories.{i}.externalId": "This repository isn’t available to this connection."})
        if ext in elsewhere:
            raise invalid({f"repositories.{i}.externalId": "This repository is connected through another account."})
    provider = get_provider(integration.provider)
    current = {r.external_id: r for r in integration.repositories.all()}
    added, removed = [], []
    with transaction.atomic():
        for ext, project_ids in wanted.items():
            repo = current.get(ext)
            if repo is None:
                info = live[ext]
                repo = Repository(
                    integration=integration,
                    workspace_id=integration.workspace_id,
                    external_id=ext,
                    full_path=info.full_path[:300],
                    owner_path=info.owner[:255],
                    name=info.name[:100],
                    visibility=info.visibility,
                    default_branch=info.default_branch[:255],
                    web_url=info.web_url[:300],
                    archived=info.archived,
                    sync_state="queued",
                )
                try:
                    provider.enable_repository(integration, repo)
                except ProviderError as exc:
                    raise provider_failed(integration.provider, exc.status, {"repository": info.full_path}) from exc
                repo.save()
                added.append(repo)
            _set_scope(repo, project_ids)
        for ext, repo in current.items():
            if ext not in wanted:
                try:
                    provider.disable_repository(integration, repo)
                except ProviderError:
                    logger.warning("Deleting the hook of %s failed", repo.full_path)
                removed.append(repo.full_path)
                untrack(repo)
        for repo in added:
            ExternalLink.objects.filter(
                workspace_id=integration.workspace_id,
                provider=integration.provider,
                base_url=integration.base_url,
                repo_external_id=repo.external_id,
                repository__isnull=True,
            ).update(repository=repo, repo_full_path=repo.full_path)
            runner.enqueue(integration, repo, "backfill", user)
        _audit(
            integration,
            user,
            "tracking.integration.repositories_updated",
            {"added": [r.full_path for r in added], "removed": removed},
        )
        publish_integration(integration, "updated")
        publish_development_areas(integration.workspace_id)
    return integration_payload(user, integration)


def untrack(repo: Repository) -> None:
    """Links stay, with `repository` NULL (§3.2)."""
    ExternalLink.objects.filter(repository=repo).update(repository=None)
    repo.delete()


def update_repository_meta(repo: Repository, full_path: str | None, archived: bool | None, deleted: bool) -> None:
    """GitHub `repository` events: renames, transfers, archive state, deletion."""
    if deleted:
        untrack(repo)
        return
    if full_path and full_path != repo.full_path:
        owner, _, name = full_path.rpartition("/")
        repo.web_url = repo.web_url.replace(repo.full_path, full_path)
        repo.full_path, repo.owner_path, repo.name = full_path, owner, name
        ExternalLink.objects.filter(repository=repo).update(repo_full_path=full_path)
    if archived is not None:
        repo.archived = archived
    repo.save()


def scope_repository(user: Any, repo: Repository, data: dict[str, Any]) -> dict[str, Any]:
    """G10."""
    if "projectIds" not in data:
        raise invalid({"projectIds": "Choose projects, or none for all projects."})
    project_ids = _project_ids(repo.workspace_id, data.get("projectIds"), "projectIds")
    before = set(RepositoryProject.objects.filter(repository=repo).values_list("project_id", flat=True))
    with transaction.atomic():
        _set_scope(repo, project_ids)
        from modules.tracking.projects.models import Project

        keys = list(Project.objects.filter(pk__in=project_ids).order_by("key").values_list("key", flat=True))
        _audit(
            repo.integration,
            user,
            "tracking.integration.repository_scoped",
            {"repository": repo.full_path, "projects": keys or "all"},
            target=repo.full_path,
        )
        publish_integration(repo.integration, "updated")
        affected = None if not project_ids or not before else before | set(project_ids)
        publish_development_areas(repo.workspace_id, affected)
    repo.refresh_from_db()
    return payloads.repository_data(repo)


def request_sync(user: Any, integration: Integration) -> dict[str, Any]:
    """G11: once per 2 minutes per integration."""
    _in_error(integration)
    now = timezone.now()
    if integration.sync_requested_at and integration.sync_requested_at + SYNC_COOLDOWN > now:
        next_at = integration.sync_requested_at + SYNC_COOLDOWN
        wait = max(1, int((next_at - now).total_seconds()))
        from core.common.utils import iso

        raise ApiError(
            429,
            "sync_throttled",
            "Synced recently. Try again in a moment.",
            {"nextSyncAt": iso(next_at)},
            headers={"Retry-After": str(wait)},
        )
    with transaction.atomic():
        Integration.objects.filter(pk=integration.pk).update(sync_requested_at=now)
        for repo in integration.repositories.all():
            runner.enqueue(integration, repo, "sync", user)
        _audit(integration, user, "tracking.integration.sync_requested", {})
    return integration_payload(user, integration)


def disconnect(user: Any, integration: Integration) -> None:
    """G13: marked `disconnecting` now; the runner revokes, wipes and deletes after commit (§7.9)."""
    with transaction.atomic():
        integration = Integration.objects.select_for_update().get(pk=integration.pk)
        repos = list(integration.repositories.all())
        integration.status = "disconnecting"
        integration.save(update_fields=["status", "updated_at"])
        WebhookDelivery.objects.filter(integration=integration, status__in=("received", "processing")).update(
            status="ignored"
        )
        SyncRun.objects.filter(integration=integration, status__in=SyncRun.ACTIVE).update(
            status="failed", error="disconnected", finished_at=timezone.now()
        )
        ExternalLink.objects.filter(repository__in=repos).update(repository=None)
        _audit(
            integration,
            user,
            "tracking.integration.disconnected",
            {
                "provider": integration.provider,
                "account": integration.account_login,
                "repositories": len(repos),
                "revoked": None,
            },
        )
        publish_integration(integration, "disconnected")
        publish_development_areas(integration.workspace_id)
        runner.dispatch_on_commit()


def set_integration_error(integration: Integration, code: str) -> None:
    """Error transitions from the processor and runs (`""` clears). Audited and published once per change."""
    integration.refresh_from_db()
    if integration.status not in LISTED:
        return
    actor = IntegrationActor.of(integration)
    if not code:
        if integration.status != "error":
            return
        integration.status, integration.error_code, integration.error_since = "active", "", None
        action, op = "tracking.integration.recovered", "updated"
    else:
        if integration.status == "error" and integration.error_code == code:
            return
        integration.status, integration.error_code, integration.error_since = "error", code, timezone.now()
        action, op = "tracking.integration.error", "error"
    integration.version += 1
    integration.save(update_fields=["status", "error_code", "error_since", "version", "updated_at"])
    record(
        workspace=integration.workspace_id,
        actor=actor,
        action=action,
        target=_target(integration),
        entity_id=integration.pk,
        data={"errorCode": code or None},
        source="webhook",
    )
    publish_integration(integration, op)


def check_tokens() -> int:
    """§7.5: GitLab token mode, `token_expires_at` in the past → `token_expired`."""
    count = 0
    now = timezone.now()
    for integration in Integration.objects.filter(auth_kind="gitlab_token", status="active", token_expires_at__lt=now):
        set_integration_error(integration, "token_expired")
        count += 1
    return count


def enqueue_catchups() -> int:
    count = 0
    for integration in Integration.objects.filter(status="active"):
        before = SyncRun.objects.filter(integration=integration).count()
        maybe_catchup(integration)
        count += SyncRun.objects.filter(integration=integration).count() - before
    return count


def purge(now: dt.datetime | None = None) -> dict[str, int]:
    """`purge_integrations`: deliveries past retention; stale attempts (a pending integration is revoked/deleted)."""
    now = now or timezone.now()
    cutoff = now - dt.timedelta(days=settings.WEBHOOK_RETENTION_DAYS)
    deliveries, _ = WebhookDelivery.objects.filter(received_at__lt=cutoff).delete()
    expired = 0
    for attempt in ConnectAttempt.objects.filter(status__in=("started", "called_back"), expires_at__lt=now):
        if attempt.status == "called_back" and attempt.integration_id:
            pending = Integration.objects.filter(pk=attempt.integration_id, status="pending").first()
            if pending is not None:
                try:
                    get_provider(pending.provider).revoke(pending)
                except Exception:
                    logger.warning("Revoking pending integration %s failed", pending.pk)
                pending.delete()
        ConnectAttempt.objects.filter(pk=attempt.pk).update(status="expired")
        expired += 1
    ConnectAttempt.objects.filter(
        status__in=("confirmed", "failed", "expired"), expires_at__lt=now - dt.timedelta(days=1)
    ).delete()
    return {"deliveries": deliveries, "attempts": expired}
