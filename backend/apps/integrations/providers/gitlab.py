"""GitLab provider: OAuth (PKCE S256, rotating refresh tokens) or a pasted access token, gitlab.com or self-managed
(docs/v2/37-integrations-github-gitlab.md §2.2, §2.4, §7). Every call goes through the SSRF guard (`SafeTarget`)."""

from __future__ import annotations

import base64
import contextlib
import datetime as dt
import hashlib
import secrets
import urllib.parse
from collections.abc import Iterator, Mapping
from typing import Any

from django.conf import settings
from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone

from .. import http
from .base import (
    AuthError,
    Author,
    BranchExists,
    BranchInfo,
    CheckInfo,
    CommitInfo,
    ConnectError,
    ConnectResult,
    DeliveryMeta,
    DevEvent,
    NotFoundError,
    ProviderError,
    PullRequestInfo,
    RateLimited,
    Rejected,
    RepoInfo,
    ResolvedObject,
    TokenError,
    body_delivery_id,
    parse_time,
    verify_gitlab_token,
)

LOW_BUDGET = 50
ZERO_SHA = "0" * 40
EVENTS = ("Push Hook", "Merge Request Hook", "Pipeline Hook")
APPROVAL_ACTIONS = ("approved", "unapproved", "approval", "unapproval")

PIPELINE_STATES = {
    "success": "passing",
    "skipped": "passing",
    "manual": "passing",
    "failed": "failing",
    "canceled": "failing",
}


def job_state(status: str, allow_failure: bool = False) -> str:
    state = PIPELINE_STATES.get(status, "running")
    return "passing" if state == "failing" and allow_failure else state


def mr_state(attrs: Mapping[str, Any]) -> str:
    state = attrs.get("state")
    if state == "merged":
        return "merged"
    if state == "closed":
        return "closed"
    if attrs.get("draft") or attrs.get("work_in_progress"):
        return "draft"
    return "open"  # opened, locked


def _mr_info(attrs: Mapping[str, Any], author: Author) -> PullRequestInfo:
    state = mr_state(attrs)
    sha = (attrs.get("last_commit") or {}).get("id") or attrs.get("sha") or ""
    return PullRequestInfo(
        number=int(attrs["iid"]),
        title=(attrs.get("title") or "")[:300],
        state=state,
        head_branch=attrs.get("source_branch") or "",
        base_branch=attrs.get("target_branch") or "",
        sha=sha,
        url=attrs.get("url") or attrs.get("web_url") or "",
        author=author,
        created_at=parse_time(attrs.get("created_at")),
        updated_at=parse_time(attrs.get("updated_at")),
        merged_at=parse_time(attrs.get("merged_at"))
        or (parse_time(attrs.get("updated_at")) if state == "merged" else None),
        closed_at=parse_time(attrs.get("closed_at"))
        or (parse_time(attrs.get("updated_at")) if state == "closed" else None),
    )


def _commit(c: Mapping[str, Any]) -> CommitInfo:
    author = c.get("author") or {}
    return CommitInfo(
        sha=c.get("id") or "",
        message=c.get("message") or "",
        url=c.get("url") or c.get("web_url") or "",
        author=Author(
            login="",
            name=author.get("name") or c.get("author_name") or "",
            email=author.get("email") or c.get("author_email") or "",
        ),
        committed_at=parse_time(c.get("timestamp") or c.get("committed_date") or c.get("created_at")),
    )


def normalize(event: str, payload: Mapping[str, Any]) -> list[DevEvent]:
    """Provider-shaped GitLab hook payload → DevEvents (§7.2). Pure; used by the real and the fake provider."""
    project = payload.get("project") or {}
    repo = str(project.get("id") or payload.get("project_id") or "")
    if event == "Merge Request Hook":
        attrs = payload.get("object_attributes") or {}
        if attrs.get("action") in APPROVAL_ACTIONS:
            return [DevEvent("review_update", repo, number=int(attrs["iid"]))]
        user = payload.get("user") or {}
        author = Author(login=user.get("username") or "", name=user.get("name") or "", email=user.get("email") or "")
        return [DevEvent("pr_upsert", repo, pr=_mr_info(attrs, author))]
    if event == "Push Hook":
        ref = payload.get("ref") or ""
        if not ref.startswith("refs/heads/"):
            return []
        name = ref[len("refs/heads/") :]
        if payload.get("after") == ZERO_SHA:
            return [DevEvent("branch_deleted", repo, branch_name=name)]
        commits = [_commit(c) for c in (payload.get("commits") or [])]
        latest = max((c.committed_at for c in commits if c.committed_at), default=None)
        web = project.get("web_url") or ""
        branch = BranchInfo(name=name, sha=payload.get("after") or "", url=f"{web}/-/tree/{name}", updated_at=latest)
        total = int(payload.get("total_commits_count") or len(commits))
        before = payload.get("before") or ""
        compare = (
            (before, payload.get("after") or "") if total > len(commits) and before and before != ZERO_SHA else None
        )
        return [DevEvent("push", repo, branch=branch, commits=commits, compare=compare)]
    if event == "Pipeline Hook":
        attrs = payload.get("object_attributes") or {}
        checks = [
            CheckInfo(
                name=b.get("name") or "job",
                state=job_state(b.get("status") or "", bool(b.get("allow_failure"))),
                duration_sec=int(b["duration"]) if isinstance(b.get("duration"), int | float) else None,
                url=None,
                started_at=parse_time(b.get("started_at")),
            )
            for b in payload.get("builds") or []
            if b.get("status") not in ("skipped", "manual")
        ]
        return [DevEvent("checks_update", repo, sha=attrs.get("sha") or "", checks=checks, replace_checks=True)]
    return []


def gitlab_meta(request: HttpRequest, body: bytes, payload: Any) -> DeliveryMeta:
    data = payload if isinstance(payload, dict) else {}
    attrs = data.get("object_attributes") or {}
    delivery = (
        request.headers.get("X-Gitlab-Event-UUID") or request.headers.get("Idempotency-Key") or body_delivery_id(body)
    )
    return DeliveryMeta(
        delivery_id=delivery[:80],
        event=(request.headers.get("X-Gitlab-Event") or "")[:40],
        action=str(attrs.get("action") or "")[:40],
        account_id=str((data.get("project") or {}).get("id") or data.get("project_id") or ""),
    )


class GitLabProvider:
    key = "gitlab"

    def available(self) -> bool:
        return True  # token mode needs no server setup

    def methods(self) -> list[str]:
        return ["oauth", "token"] if settings.GITLAB_CLIENT_ID and settings.GITLAB_CLIENT_SECRET else ["token"]

    # ── HTTP ──

    def _request(
        self, base_url: str, method: str, path: str, headers: dict[str, str], *, json_body: Any = None, form: Any = None
    ) -> http.Response:
        target = http.SafeTarget(base_url)
        url = target.origin + path
        try:
            res = http.request(method, url, headers=headers, json_body=json_body, form=form, target=target)
        except http.TransportError as exc:
            raise ProviderError(str(exc)) from exc
        self._last = res
        return res

    def _check(self, res: http.Response) -> Any:
        if res.status == 429 or (res.status == 403 and res.header("retry-after")):
            wait = int(res.header("retry-after") or 60)
            raise RateLimited(timezone.now() + dt.timedelta(seconds=wait))
        if res.status == 401:
            raise AuthError("token_revoked")
        if res.status == 404:
            raise NotFoundError("not found", 404)
        if res.status in (400, 409, 422):
            body = res.json() if res.body else {}
            message = body.get("message") if isinstance(body, dict) else None
            raise Rejected(str(message or "rejected"), res.status)
        if res.status >= 400:
            raise ProviderError(f"GitLab answered {res.status}", res.status)
        return res.json() if res.body else None

    def _auth_headers(self, integration: Any) -> dict[str, str]:
        if integration.auth_kind == "gitlab_token":
            return {"PRIVATE-TOKEN": integration.get_credentials().get("token", "")}
        return {"Authorization": f"Bearer {self._oauth_token(integration)}"}

    def _oauth_token(self, integration: Any) -> str:
        creds = integration.get_credentials()
        expires = parse_time(creds.get("expiresAt"))
        if expires and expires > timezone.now() + dt.timedelta(minutes=5):
            return creds["accessToken"]
        with transaction.atomic():  # §7.5: the refresh token rotates; never use it twice
            locked = type(integration).objects.select_for_update().get(pk=integration.pk)
            creds = locked.get_credentials()
            expires = parse_time(creds.get("expiresAt"))
            if expires and expires > timezone.now() + dt.timedelta(minutes=5):
                integration.credentials = locked.credentials
                return creds["accessToken"]
            res = self._request(
                integration.base_url,
                "POST",
                "/oauth/token",
                {},
                form={
                    "grant_type": "refresh_token",
                    "refresh_token": creds.get("refreshToken", ""),
                    "client_id": settings.GITLAB_CLIENT_ID,
                    "client_secret": settings.GITLAB_CLIENT_SECRET,
                    "redirect_uri": self.redirect_uri(),
                },
            )
            if res.status in (400, 401):
                raise AuthError("token_expired")
            data = self._check(res)
            fresh = self._token_creds(data)
            locked.set_credentials(fresh)
            locked.version += 1
            locked.save(update_fields=["credentials", "version", "updated_at"])
            integration.credentials = locked.credentials
            return fresh["accessToken"]

    @staticmethod
    def _token_creds(data: Mapping[str, Any]) -> dict[str, Any]:
        expires = timezone.now() + dt.timedelta(seconds=int(data.get("expires_in") or 7200))
        return {
            "accessToken": data["access_token"],
            "refreshToken": data.get("refresh_token", ""),
            "expiresAt": expires.isoformat(),
        }

    def _api(self, repo_or_integration: Any, method: str, path: str, *, json_body: Any = None) -> Any:
        integration = getattr(repo_or_integration, "integration", repo_or_integration)
        res = self._request(
            integration.base_url, method, "/api/v4" + path, self._auth_headers(integration), json_body=json_body
        )
        return self._check(res)

    def low_budget(self, integration: Any) -> bool:
        last = getattr(self, "_last", None)
        return bool(last is not None and last.rate_remaining is not None and last.rate_remaining < LOW_BUDGET)

    # ── connect ──

    def redirect_uri(self) -> str:
        return f"{settings.API_PUBLIC_URL}/api/v1/integrations/gitlab/callback"

    def authorize_url(self, attempt: Any, state: str) -> str:
        verifier = secrets.token_urlsafe(48)
        attempt.set_secret("pkce_verifier", verifier)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        params = {
            "client_id": settings.GITLAB_CLIENT_ID,
            "redirect_uri": self.redirect_uri(),
            "response_type": "code",
            "scope": "api",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        return f"{settings.GITLAB_BASE_URL}/oauth/authorize?" + urllib.parse.urlencode(params)

    def complete(self, attempt: Any, params: Mapping[str, str]) -> ConnectResult:
        base = settings.GITLAB_BASE_URL
        try:
            res = self._request(
                base,
                "POST",
                "/oauth/token",
                {},
                form={
                    "grant_type": "authorization_code",
                    "code": params.get("code", ""),
                    "client_id": settings.GITLAB_CLIENT_ID,
                    "client_secret": settings.GITLAB_CLIENT_SECRET,
                    "redirect_uri": self.redirect_uri(),
                    "code_verifier": attempt.get_secret("pkce_verifier"),
                },
            )
            data = self._check(res)
            if "api" not in str(data.get("scope", "api")).split():
                raise ConnectError("insufficient_scope")
            creds = self._token_creds(data)
            user = self._check(
                self._request(base, "GET", "/api/v4/user", {"Authorization": f"Bearer {creds['accessToken']}"})
            )
        except (ProviderError, http.UnsafeUrl, KeyError, ValueError) as exc:
            raise ConnectError("provider_failed") from exc
        return ConnectResult(
            account_external_id=str(user["id"]),
            account_login=user.get("username") or "",
            account_kind="bot" if user.get("bot") else "user",
            account_url=user.get("web_url") or f"{base}/{user.get('username')}",
            base_url=http.normalize_base_url(base),
            credentials=creds,
            scopes=["api"],
        )

    def connect_with_token(self, base_url: str, token: str) -> ConnectResult:
        try:
            target = http.SafeTarget(base_url)
            target.resolve()
        except http.UnsafeUrl as exc:
            raise TokenError("baseUrl", exc.message) from exc
        headers = {"PRIVATE-TOKEN": token}
        try:
            res = self._request(target.origin, "GET", "/api/v4/personal_access_tokens/self", headers)
            if res.status == 401:
                raise TokenError("token", "GitLab didn't accept this token.")
            info = self._check(res) or {}
            if not info.get("active", True) or info.get("revoked"):
                raise TokenError("token", "This token has expired.")
            expires = parse_time(f"{info['expires_at']}T00:00:00Z") if info.get("expires_at") else None
            if expires and expires <= timezone.now():
                raise TokenError("token", "This token has expired.")
            if "api" not in (info.get("scopes") or []):
                raise TokenError("token", "The token needs the api scope.")
            user = self._check(self._request(target.origin, "GET", "/api/v4/user", headers))
        except (ProviderError, http.UnsafeUrl) as exc:
            raise TokenError("baseUrl", "Couldn't reach GitLab at this address.") from exc
        return ConnectResult(
            account_external_id=str(user["id"]),
            account_login=user.get("username") or "",
            account_kind="bot" if user.get("bot") else "user",
            account_url=user.get("web_url") or f"{target.origin}/{user.get('username')}",
            base_url=target.origin,
            credentials={"token": token, "bot": bool(user.get("bot"))},
            scopes=list(info.get("scopes") or []),
            token_expires_at=expires,
        )

    def revoke(self, integration: Any) -> bool:
        ok = True
        for repo in integration.repositories.all():
            try:
                self.disable_repository(integration, repo)
            except ProviderError:
                ok = False
        try:
            if integration.auth_kind == "gitlab_oauth":
                creds = integration.get_credentials()
                for token in (creds.get("accessToken"), creds.get("refreshToken")):
                    if token:
                        self._request(
                            integration.base_url,
                            "POST",
                            "/oauth/revoke",
                            {},
                            form={
                                "token": token,
                                "client_id": settings.GITLAB_CLIENT_ID,
                                "client_secret": settings.GITLAB_CLIENT_SECRET,
                            },
                        )
            elif integration.get_credentials().get("bot"):
                self._api(integration, "DELETE", "/personal_access_tokens/self")
        except (ProviderError, http.UnsafeUrl):
            ok = False
        return ok

    def manage_url(self, integration: Any) -> str | None:
        return None

    # ── repositories ──

    def list_repositories(self, integration: Any) -> list[RepoInfo]:
        out: list[RepoInfo] = []
        for page in range(1, 11):
            rows = (
                self._api(
                    integration,
                    "GET",
                    f"/projects?membership=true&min_access_level=40&simple=true&per_page=100&page={page}",
                )
                or []
            )
            for p in rows:
                namespace = (p.get("namespace") or {}).get("full_path") or p["path_with_namespace"].rsplit("/", 1)[0]
                out.append(
                    RepoInfo(
                        external_id=str(p["id"]),
                        full_path=p["path_with_namespace"],
                        owner=namespace,
                        name=p.get("path") or p.get("name") or "",
                        visibility=p.get("visibility") or "private",
                        default_branch=p.get("default_branch") or "main",
                        web_url=p.get("web_url") or "",
                        updated_at=parse_time(p.get("last_activity_at")),
                        archived=bool(p.get("archived")),
                    )
                )
            if len(rows) < 100:
                break
        return out[:1000]

    def enable_repository(self, integration: Any, repo: Any) -> None:
        hook = self._api(
            integration,
            "POST",
            f"/projects/{repo.external_id}/hooks",
            json_body={
                "url": f"{settings.API_PUBLIC_URL}/api/v1/webhooks/gitlab/{integration.pk}",
                "token": integration.get_secret("webhook_secret"),
                "push_events": True,
                "merge_requests_events": True,
                "pipeline_events": True,
                "issues_events": False,
                "tag_push_events": False,
                "note_events": False,
                "job_events": False,
                "wiki_page_events": False,
                "enable_ssl_verification": True,
            },
        )
        repo.hook_id = str(hook["id"])

    def disable_repository(self, integration: Any, repo: Any) -> None:
        if repo.hook_id:
            with contextlib.suppress(NotFoundError):
                self._api(integration, "DELETE", f"/projects/{repo.external_id}/hooks/{repo.hook_id}")

    # ── webhooks ──

    def verify(self, request: HttpRequest, body: bytes, integration: Any) -> bool:
        return integration is not None and verify_gitlab_token(integration, request)

    def delivery_meta(self, request: HttpRequest, body: bytes, payload: Any) -> DeliveryMeta:
        return gitlab_meta(request, body, payload)

    def normalize(self, delivery: Any) -> list[DevEvent]:
        return normalize(delivery.event, delivery.payload or {})

    # ── reads ──

    def _p(self, repo: Any) -> str:
        return f"/projects/{repo.external_id}"

    def _mr(self, mr: Mapping[str, Any]) -> PullRequestInfo:
        author = mr.get("author") or {}
        return _mr_info(mr, Author(login=author.get("username") or "", name=author.get("name") or ""))

    def pull_requests(self, repo: Any, *, updated_since: dt.datetime | None, limit: int) -> Iterator[PullRequestInfo]:
        seen: set[int] = set()
        queries = ["state=opened"]
        if updated_since:
            queries.append("updated_after=" + urllib.parse.quote(updated_since.isoformat()))
        for query in queries:
            rows = (
                self._api(repo, "GET", f"{self._p(repo)}/merge_requests?{query}&order_by=updated_at&per_page=100") or []
            )
            for mr in rows:
                if mr["iid"] in seen:
                    continue
                seen.add(mr["iid"])
                yield self._mr(mr)
                if len(seen) >= limit:
                    return

    def branches(self, repo: Any, *, limit: int) -> Iterator[BranchInfo]:
        count = 0
        for page in range(1, 11):
            rows = self._api(repo, "GET", f"{self._p(repo)}/repository/branches?per_page=100&page={page}") or []
            for b in rows:
                commit = b.get("commit") or {}
                yield BranchInfo(
                    name=b["name"],
                    sha=commit.get("id") or "",
                    url=b.get("web_url") or "",
                    updated_at=parse_time(commit.get("committed_date")),
                )
                count += 1
                if count >= limit:
                    return
            if len(rows) < 100:
                return

    def commits(self, repo: Any, *, ref: str | None, since: dt.datetime, limit: int) -> Iterator[CommitInfo]:
        query = urllib.parse.urlencode(
            {"ref_name": ref or repo.default_branch, "since": since.isoformat(), "per_page": 100}
        )
        for c in (self._api(repo, "GET", f"{self._p(repo)}/repository/commits?{query}") or [])[:limit]:
            yield _commit(c)

    def compare_commits(self, repo: Any, before: str, after: str, *, limit: int) -> list[CommitInfo]:
        query = urllib.parse.urlencode({"from": before, "to": after})
        data = self._api(repo, "GET", f"{self._p(repo)}/repository/compare?{query}") or {}
        return [_commit(c) for c in (data.get("commits") or [])[-limit:]]

    def pull_request_commits(self, repo: Any, number: int, *, limit: int) -> Iterator[CommitInfo]:
        for c in (self._api(repo, "GET", f"{self._p(repo)}/merge_requests/{number}/commits?per_page=100") or [])[
            :limit
        ]:
            yield _commit(c)

    def checks(self, repo: Any, sha: str) -> list[CheckInfo]:
        pipelines = self._api(repo, "GET", f"{self._p(repo)}/pipelines?sha={sha}&per_page=1") or []
        if not pipelines:
            return []
        jobs = self._api(repo, "GET", f"{self._p(repo)}/pipelines/{pipelines[0]['id']}/jobs?per_page=100") or []
        return [
            CheckInfo(
                name=j.get("name") or "job",
                state=job_state(j.get("status") or "", bool(j.get("allow_failure"))),
                duration_sec=int(j["duration"]) if isinstance(j.get("duration"), int | float) else None,
                url=j.get("web_url"),
            )
            for j in jobs
            if j.get("status") not in ("skipped", "manual")
        ]

    def approvals(self, repo: Any, number: int) -> int:
        data = self._api(repo, "GET", f"{self._p(repo)}/merge_requests/{number}/approvals") or {}
        return len(data.get("approved_by") or [])

    def ahead_by(self, repo: Any, branch: str) -> int | None:
        query = urllib.parse.urlencode({"from": repo.default_branch, "to": branch})
        data = self._api(repo, "GET", f"{self._p(repo)}/repository/compare?{query}") or {}
        commits = data.get("commits")
        return len(commits) if isinstance(commits, list) else None

    def resolve_url(self, integration: Any, repo: Any, kind: str, ref: str) -> ResolvedObject | None:
        try:
            if kind == "pull_request":
                return ResolvedObject(
                    kind, pr=self._mr(self._api(repo, "GET", f"{self._p(repo)}/merge_requests/{int(ref)}"))
                )
            if kind == "commit":
                return ResolvedObject(
                    kind, commit=_commit(self._api(repo, "GET", f"{self._p(repo)}/repository/commits/{ref}"))
                )
            data = self._api(repo, "GET", f"{self._p(repo)}/repository/branches/{urllib.parse.quote(ref, safe='')}")
            return ResolvedObject(
                kind,
                branch=BranchInfo(
                    name=ref, sha=(data.get("commit") or {}).get("id") or "", url=data.get("web_url") or ""
                ),
            )
        except NotFoundError:
            return None

    def create_branch(self, repo: Any, name: str, from_ref: str) -> BranchInfo:
        query = urllib.parse.urlencode({"branch": name, "ref": from_ref})
        try:
            data = self._api(repo, "POST", f"{self._p(repo)}/repository/branches?{query}")
        except Rejected as exc:
            if "already exists" in str(exc).lower():
                raise BranchExists(str(exc), 400) from exc
            raise
        return BranchInfo(
            name=name,
            sha=(data.get("commit") or {}).get("id") or "",
            url=data.get("web_url") or f"{repo.web_url}/-/tree/{name}",
            updated_at=timezone.now(),
        )

    def recover(self, integration: Any, known_delivery_ids: set[str]) -> None:
        """§7.6: re-enable project hooks that GitLab disabled after failures."""
        for repo in integration.repositories.exclude(hook_id=""):
            try:
                hook = self._api(integration, "GET", f"{self._p(repo)}/hooks/{repo.hook_id}") or {}
                disabled = hook.get("disabled_until") or hook.get("alert_status") not in (None, "executable")
                if disabled:
                    self._api(
                        integration,
                        "PUT",
                        f"{self._p(repo)}/hooks/{repo.hook_id}",
                        json_body={"enable_ssl_verification": True},
                    )
            except ProviderError:
                continue
