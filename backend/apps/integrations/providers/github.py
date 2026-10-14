"""GitHub App provider (docs/v2/37-integrations-github-gitlab.md §2.1, §2.4, §7).

Installation tokens only (minted from the app's private key with an RS256 JWT, cached encrypted until 5 min before
they expire). The user token from the OAuth leg exists only to prove the installer can see the installation, and is
revoked immediately.
"""

from __future__ import annotations

import base64
import contextlib
import datetime as dt
import time
import urllib.parse
from collections.abc import Iterator, Mapping
from typing import Any

import jwt
from django.conf import settings
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
    github_secrets,
    parse_time,
    verify_github_signature,
)

API = "https://api.github.com"
WEB = "https://github.com"
LOW_BUDGET = 200
ZERO_SHA = "0" * 40

PASSING = {"success", "neutral", "skipped"}
FAILING = {"failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error"}


def check_state(status: str | None, conclusion: str | None) -> str:
    if status and status != "completed":
        return "running"
    value = (conclusion or "").lower()
    if value in PASSING:
        return "passing"
    if value in FAILING:
        return "failing"
    return "running"


def status_state(state: str) -> str:
    return {"success": "passing", "failure": "failing", "error": "failing"}.get(state, "running")


def pr_state(pr: Mapping[str, Any]) -> str:
    if pr.get("merged") or pr.get("merged_at"):
        return "merged"
    if pr.get("state") == "closed":
        return "closed"
    return "draft" if pr.get("draft") else "open"


def _author(user: Mapping[str, Any] | None, email: str = "") -> Author:
    user = user or {}
    return Author(login=user.get("login") or "", name=user.get("name") or "", email=email or user.get("email") or "")


def pr_info(pr: Mapping[str, Any]) -> PullRequestInfo:
    return PullRequestInfo(
        number=int(pr["number"]),
        title=(pr.get("title") or "")[:300],
        state=pr_state(pr),
        head_branch=(pr.get("head") or {}).get("ref") or "",
        base_branch=(pr.get("base") or {}).get("ref") or "",
        sha=(pr.get("head") or {}).get("sha") or "",
        url=pr.get("html_url") or "",
        author=_author(pr.get("user")),
        created_at=parse_time(pr.get("created_at")),
        updated_at=parse_time(pr.get("updated_at")),
        merged_at=parse_time(pr.get("merged_at")),
        closed_at=parse_time(pr.get("closed_at")),
    )


def _push_commit(c: Mapping[str, Any]) -> CommitInfo:
    author = c.get("author") or {}
    return CommitInfo(
        sha=c.get("id") or "",
        message=c.get("message") or "",
        url=c.get("url") or "",
        author=Author(
            login=author.get("username") or "", name=author.get("name") or "", email=author.get("email") or ""
        ),
        committed_at=parse_time(c.get("timestamp")),
    )


def _api_commit(c: Mapping[str, Any]) -> CommitInfo:
    commit = c.get("commit") or {}
    author = commit.get("author") or {}
    return CommitInfo(
        sha=c.get("sha") or "",
        message=commit.get("message") or "",
        url=c.get("html_url") or "",
        author=Author(
            login=(c.get("author") or {}).get("login") or "",
            name=author.get("name") or "",
            email=author.get("email") or "",
        ),
        committed_at=parse_time(author.get("date")),
    )


def normalize(event: str, payload: Mapping[str, Any]) -> list[DevEvent]:
    """Provider-shaped GitHub payload → DevEvents (§7.2). Pure; used by the real and the fake provider."""
    repo = str((payload.get("repository") or {}).get("id") or "")
    action = payload.get("action") or ""
    if event == "pull_request" and payload.get("pull_request"):
        return [DevEvent("pr_upsert", repo, pr=pr_info(payload["pull_request"]))]
    if event == "pull_request_review" and payload.get("pull_request"):
        return [DevEvent("review_update", repo, number=int(payload["pull_request"]["number"]))]
    if event == "push":
        ref = payload.get("ref") or ""
        if not ref.startswith("refs/heads/"):
            return []
        name = ref[len("refs/heads/") :]
        if payload.get("deleted") or payload.get("after") == ZERO_SHA:
            return [DevEvent("branch_deleted", repo, branch_name=name)]
        head = payload.get("head_commit") or {}
        base = (payload.get("repository") or {}).get("html_url") or ""
        branch = BranchInfo(
            name=name,
            sha=payload.get("after") or "",
            url=f"{base}/tree/{name}",
            updated_at=parse_time(head.get("timestamp")),
        )
        commits = [_push_commit(c) for c in (payload.get("commits") or [])[-100:]]
        return [DevEvent("push", repo, branch=branch, commits=commits)]
    if event in ("create", "delete") and payload.get("ref_type") == "branch":
        name = payload.get("ref") or ""
        if event == "delete":
            return [DevEvent("branch_deleted", repo, branch_name=name)]
        base = (payload.get("repository") or {}).get("html_url") or ""
        return [DevEvent("branch_upsert", repo, branch=BranchInfo(name=name, sha="", url=f"{base}/tree/{name}"))]
    if event == "check_run" and payload.get("check_run"):
        run = payload["check_run"]
        started, finished = parse_time(run.get("started_at")), parse_time(run.get("completed_at"))
        check = CheckInfo(
            name=run.get("name") or "check",
            state=check_state(run.get("status"), run.get("conclusion")),
            duration_sec=int((finished - started).total_seconds()) if started and finished else None,
            url=run.get("html_url"),
            started_at=started,
        )
        return [DevEvent("checks_update", repo, sha=run.get("head_sha") or "", checks=[check])]
    if event == "status":
        check = CheckInfo(
            name=payload.get("context") or "status",
            state=status_state(payload.get("state") or ""),
            url=payload.get("target_url"),
        )
        return [DevEvent("checks_update", repo, sha=payload.get("sha") or "", checks=[check])]
    if event == "repository":
        info = payload.get("repository") or {}
        return [
            DevEvent(
                "repo_update",
                repo,
                full_path=info.get("full_name"),
                archived=bool(info.get("archived")),
                deleted=action == "deleted",
            )
        ]
    if event == "installation_repositories" and action == "removed":
        ids = [str(r.get("id")) for r in payload.get("repositories_removed") or []]
        return [DevEvent("repo_removed", repo_ids=ids)]
    if event == "installation":
        code = {"suspend": "installation_suspended", "deleted": "installation_removed"}.get(action)
        if code:
            return [DevEvent("integration_state", error_code=code)]
        if action in ("unsuspend", "new_permissions_accepted"):
            return [DevEvent("integration_state", error_code="")]
    return []


def github_meta(request: HttpRequest, payload: Any) -> DeliveryMeta:
    installation = (payload or {}).get("installation") or {} if isinstance(payload, dict) else {}
    return DeliveryMeta(
        delivery_id=(request.headers.get("X-GitHub-Delivery") or "")[:80],
        event=(request.headers.get("X-GitHub-Event") or "")[:40],
        action=str((payload or {}).get("action") or "")[:40] if isinstance(payload, dict) else "",
        account_id=str(installation.get("id") or ""),
    )


def private_key() -> str:
    raw = settings.GITHUB_APP_PRIVATE_KEY.strip()
    if "BEGIN" not in raw:
        try:
            raw = base64.b64decode(raw).decode()
        except ValueError:
            return raw
    return raw.replace("\\n", "\n")


class GitHubProvider:
    key = "github"

    # ── configuration ──

    def available(self) -> bool:
        return all(
            (
                settings.GITHUB_APP_ID,
                settings.GITHUB_APP_SLUG,
                settings.GITHUB_APP_CLIENT_ID,
                settings.GITHUB_APP_CLIENT_SECRET,
                settings.GITHUB_APP_PRIVATE_KEY,
                settings.GITHUB_WEBHOOK_SECRET,
            )
        )

    def methods(self) -> list[str]:
        return ["app"]

    # ── HTTP ──

    def app_jwt(self) -> str:
        now = int(time.time())
        return jwt.encode(
            {"iat": now - 60, "exp": now + 540, "iss": settings.GITHUB_APP_CLIENT_ID}, private_key(), algorithm="RS256"
        )

    def _call(self, method: str, url: str, token: str, *, json_body: Any = None, scheme: str = "Bearer") -> Any:
        try:
            res = http.request(
                method,
                url if url.startswith("http") else API + url,
                headers={
                    "Authorization": f"{scheme} {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json_body=json_body,
            )
        except http.TransportError as exc:
            raise ProviderError(str(exc)) from exc
        self._last = res
        if res.status in (403, 429) and (res.header("retry-after") or res.rate_remaining == 0):
            wait = int(res.header("retry-after") or 0) or max(
                0, (res.rate_reset or int(time.time()) + 60) - int(time.time())
            )
            raise RateLimited(timezone.now() + dt.timedelta(seconds=wait))
        if res.status == 401:
            raise AuthError("installation_removed")
        if res.status == 404:
            raise NotFoundError("not found", 404)
        if res.status == 422:
            raise Rejected(str((res.json() or {}).get("message") or "rejected"), 422)
        if res.status >= 400:
            raise ProviderError(f"GitHub answered {res.status}", res.status)
        return res.json() if res.body else None

    def _installation_id(self, integration: Any) -> str:
        return integration.account_external_id

    def token(self, integration: Any) -> str:
        creds = integration.get_credentials()
        expires = parse_time(creds.get("expiresAt"))
        if creds.get("installationToken") and expires and expires > timezone.now() + dt.timedelta(minutes=5):
            return creds["installationToken"]
        data = self._call(
            "POST", f"/app/installations/{self._installation_id(integration)}/access_tokens", self.app_jwt()
        )
        integration.set_credentials({"installationToken": data["token"], "expiresAt": data["expires_at"]})
        type(integration).objects.filter(pk=integration.pk).update(credentials=integration.credentials)
        return data["token"]

    def _api(self, repo_or_integration: Any, method: str, path: str, **kwargs: Any) -> Any:
        integration = getattr(repo_or_integration, "integration", repo_or_integration)
        return self._call(method, path, self.token(integration), **kwargs)

    def low_budget(self, integration: Any) -> bool:
        last = getattr(self, "_last", None)
        return bool(last is not None and last.rate_remaining is not None and last.rate_remaining < LOW_BUDGET)

    # ── connect ──

    def authorize_url(self, attempt: Any, state: str) -> str:
        return f"{WEB}/apps/{settings.GITHUB_APP_SLUG}/installations/new?" + urllib.parse.urlencode({"state": state})

    def oauth_url(self, state: str) -> str:
        params = {
            "client_id": settings.GITHUB_APP_CLIENT_ID,
            "redirect_uri": f"{settings.API_PUBLIC_URL}/api/v1/integrations/github/callback",
            "state": state,
        }
        return f"{WEB}/login/oauth/authorize?" + urllib.parse.urlencode(params)

    def complete(self, attempt: Any, params: Mapping[str, str]) -> ConnectResult:
        installation_id = attempt.installation_id
        if not installation_id:
            raise ConnectError("state_invalid")
        try:
            res = http.request(
                "POST",
                f"{WEB}/login/oauth/access_token",
                form={
                    "client_id": settings.GITHUB_APP_CLIENT_ID,
                    "client_secret": settings.GITHUB_APP_CLIENT_SECRET,
                    "code": params.get("code", ""),
                },
            )
            user_token = (res.json() or {}).get("access_token") if res.status == 200 else None
            if not user_token:
                raise ConnectError("provider_failed")
            try:
                installs = self._call("GET", "/user/installations?per_page=100", user_token) or {}
            finally:
                self._revoke_user_token(user_token)
            ids = {str(i.get("id")) for i in installs.get("installations") or []}
            if installation_id not in ids:
                raise ConnectError("state_invalid")
            info = self._call("GET", f"/app/installations/{installation_id}", self.app_jwt())
        except (ProviderError, http.TransportError, ValueError) as exc:
            raise ConnectError("provider_failed") from exc
        account = info.get("account") or {}
        login = account.get("login") or ""
        kind = "organization" if account.get("type") == "Organization" else "user"
        return ConnectResult(
            account_external_id=installation_id,
            account_login=login,
            account_kind=kind,
            account_url=account.get("html_url") or f"{WEB}/{login}",
            base_url=WEB,
            scopes=sorted((info.get("permissions") or {}).keys()),
        )

    def _revoke_user_token(self, user_token: str) -> None:
        basic = base64.b64encode(
            f"{settings.GITHUB_APP_CLIENT_ID}:{settings.GITHUB_APP_CLIENT_SECRET}".encode()
        ).decode()
        with contextlib.suppress(ProviderError):
            self._call(
                "DELETE",
                f"/applications/{settings.GITHUB_APP_CLIENT_ID}/token",
                basic,
                scheme="Basic",
                json_body={"access_token": user_token},
            )

    def connect_with_token(self, base_url: str, token: str) -> ConnectResult:
        raise TokenError("token", "GitHub connects through the GitHub App.")

    def revoke(self, integration: Any) -> bool:
        try:
            self._call("DELETE", f"/app/installations/{self._installation_id(integration)}", self.app_jwt())
        except NotFoundError:
            return True
        except ProviderError:
            return False
        return True

    def manage_url(self, integration: Any) -> str:
        if integration.account_kind == "organization":
            org = integration.account_login
            return f"{WEB}/organizations/{org}/settings/installations/{integration.account_external_id}"
        return f"{WEB}/settings/installations/{integration.account_external_id}"

    # ── repositories ──

    def list_repositories(self, integration: Any) -> list[RepoInfo]:
        out: list[RepoInfo] = []
        for page in range(1, 11):
            data = self._api(integration, "GET", f"/installation/repositories?per_page=100&page={page}") or {}
            rows = data.get("repositories") or []
            for r in rows:
                out.append(
                    RepoInfo(
                        external_id=str(r["id"]),
                        full_path=r["full_name"],
                        owner=(r.get("owner") or {}).get("login") or r["full_name"].split("/")[0],
                        name=r["name"],
                        visibility=r.get("visibility") or ("private" if r.get("private") else "public"),
                        default_branch=r.get("default_branch") or "main",
                        web_url=r.get("html_url") or f"{WEB}/{r['full_name']}",
                        updated_at=parse_time(r.get("pushed_at") or r.get("updated_at")),
                        archived=bool(r.get("archived")),
                    )
                )
            if len(rows) < 100 or len(out) >= 1000:
                break
        return out[:1000]

    def enable_repository(self, integration: Any, repo: Any) -> None:
        return None  # the app-level webhook covers every repository

    def disable_repository(self, integration: Any, repo: Any) -> None:
        return None

    # ── webhooks ──

    def verify(self, request: HttpRequest, body: bytes, integration: Any) -> bool:
        return verify_github_signature(body, request.headers.get("X-Hub-Signature-256"), github_secrets())

    def delivery_meta(self, request: HttpRequest, body: bytes, payload: Any) -> DeliveryMeta:
        return github_meta(request, payload)

    def normalize(self, delivery: Any) -> list[DevEvent]:
        return normalize(delivery.event, delivery.payload or {})

    # ── reads ──

    def _repo_path(self, repo: Any) -> str:
        return f"/repos/{repo.full_path}"

    def pull_requests(self, repo: Any, *, updated_since: dt.datetime | None, limit: int) -> Iterator[PullRequestInfo]:
        count = 0
        for page in range(1, 6):
            rows = (
                self._api(
                    repo,
                    "GET",
                    f"{self._repo_path(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=100&page={page}",
                )
                or []
            )
            for pr in rows:
                info = pr_info(pr)
                if (
                    updated_since
                    and info.updated_at
                    and info.updated_at < updated_since
                    and info.state not in ("open", "draft")
                ):
                    continue
                yield info
                count += 1
                if count >= limit:
                    return
            if len(rows) < 100:
                return

    def branches(self, repo: Any, *, limit: int) -> Iterator[BranchInfo]:
        count = 0
        for page in range(1, 11):
            rows = self._api(repo, "GET", f"{self._repo_path(repo)}/branches?per_page=100&page={page}") or []
            for b in rows:
                yield BranchInfo(
                    name=b["name"], sha=(b.get("commit") or {}).get("sha") or "", url=f"{repo.web_url}/tree/{b['name']}"
                )
                count += 1
                if count >= limit:
                    return
            if len(rows) < 100:
                return

    def commits(self, repo: Any, *, ref: str | None, since: dt.datetime, limit: int) -> Iterator[CommitInfo]:
        query = urllib.parse.urlencode({"sha": ref or repo.default_branch, "since": since.isoformat(), "per_page": 100})
        rows = self._api(repo, "GET", f"{self._repo_path(repo)}/commits?{query}") or []
        for c in rows[:limit]:
            yield _api_commit(c)

    def compare_commits(self, repo: Any, before: str, after: str, *, limit: int) -> list[CommitInfo]:
        data = self._api(repo, "GET", f"{self._repo_path(repo)}/compare/{before}...{after}") or {}
        return [_api_commit(c) for c in (data.get("commits") or [])[-limit:]]

    def pull_request_commits(self, repo: Any, number: int, *, limit: int) -> Iterator[CommitInfo]:
        rows = self._api(repo, "GET", f"{self._repo_path(repo)}/pulls/{number}/commits?per_page=100") or []
        for c in rows[:limit]:
            yield _api_commit(c)

    def checks(self, repo: Any, sha: str) -> list[CheckInfo]:
        runs = self._api(repo, "GET", f"{self._repo_path(repo)}/commits/{sha}/check-runs?per_page=100") or {}
        out = []
        for run in runs.get("check_runs") or []:
            started, finished = parse_time(run.get("started_at")), parse_time(run.get("completed_at"))
            out.append(
                CheckInfo(
                    name=run.get("name") or "check",
                    state=check_state(run.get("status"), run.get("conclusion")),
                    duration_sec=int((finished - started).total_seconds()) if started and finished else None,
                    url=run.get("html_url"),
                    started_at=started,
                )
            )
        status = self._api(repo, "GET", f"{self._repo_path(repo)}/commits/{sha}/status") or {}
        for s in status.get("statuses") or []:
            out.append(
                CheckInfo(
                    name=s.get("context") or "status", state=status_state(s.get("state") or ""), url=s.get("target_url")
                )
            )
        return out

    def approvals(self, repo: Any, number: int) -> int:
        reviews = self._api(repo, "GET", f"{self._repo_path(repo)}/pulls/{number}/reviews?per_page=100") or []
        latest: dict[str, str] = {}
        for r in reviews:
            login = (r.get("user") or {}).get("login") or ""
            if r.get("state") in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
                latest[login] = r["state"]
        return sum(1 for state in latest.values() if state == "APPROVED")

    def ahead_by(self, repo: Any, branch: str) -> int | None:
        base, head = urllib.parse.quote(repo.default_branch, safe=""), urllib.parse.quote(branch, safe="")
        data = self._api(repo, "GET", f"{self._repo_path(repo)}/compare/{base}...{head}") or {}
        value = data.get("ahead_by")
        return int(value) if isinstance(value, int) else None

    def resolve_url(self, integration: Any, repo: Any, kind: str, ref: str) -> ResolvedObject | None:
        try:
            if kind == "pull_request":
                return ResolvedObject(
                    kind, pr=pr_info(self._api(repo, "GET", f"{self._repo_path(repo)}/pulls/{int(ref)}"))
                )
            if kind == "commit":
                return ResolvedObject(
                    kind, commit=_api_commit(self._api(repo, "GET", f"{self._repo_path(repo)}/commits/{ref}"))
                )
            data = self._api(repo, "GET", f"{self._repo_path(repo)}/branches/{urllib.parse.quote(ref, safe='')}")
            return ResolvedObject(
                kind,
                branch=BranchInfo(
                    name=ref, sha=(data.get("commit") or {}).get("sha") or "", url=f"{repo.web_url}/tree/{ref}"
                ),
            )
        except NotFoundError:
            return None

    # ── writes ──

    def create_branch(self, repo: Any, name: str, from_ref: str) -> BranchInfo:
        base = self._api(repo, "GET", f"{self._repo_path(repo)}/git/ref/heads/{urllib.parse.quote(from_ref, safe='')}")
        sha = (base.get("object") or {}).get("sha") or ""
        try:
            self._api(
                repo, "POST", f"{self._repo_path(repo)}/git/refs", json_body={"ref": f"refs/heads/{name}", "sha": sha}
            )
        except Rejected as exc:
            if "already exists" in str(exc).lower():
                raise BranchExists(str(exc), 422) from exc
            raise
        return BranchInfo(name=name, sha=sha, url=f"{repo.web_url}/tree/{name}", updated_at=timezone.now())

    # ── recovery (§7.6) ──

    def recover(self, integration: Any, known_delivery_ids: set[str]) -> None:
        cutoff = timezone.now() - dt.timedelta(days=3)
        rows = self._call("GET", "/app/hook/deliveries?per_page=100", self.app_jwt()) or []
        for d in rows[:300]:
            delivered = parse_time(d.get("delivered_at"))
            if delivered and delivered < cutoff:
                break
            if str(d.get("installation_id")) != integration.account_external_id or d.get("status") == "OK":
                continue
            if d.get("guid") in known_delivery_ids:
                continue
            try:
                self._call("POST", f"/app/hook/deliveries/{d['id']}/attempts", self.app_jwt())
            except ProviderError:
                continue
