"""The provider interface (docs/v2/37-integrations-github-gitlab.md §2.4) and its value types.

`get_provider(key)` returns the GitHub or GitLab adapter, or `FakeProvider(key)` for both when
`INTEGRATIONS_PROVIDER_BACKEND=fake`. Nothing outside `providers/` imports a concrete provider.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from django.conf import settings
from django.http import HttpRequest

# ───────────────────────── errors ─────────────────────────


class ProviderError(Exception):
    """The provider timed out or failed (→ 502 provider_failed)."""

    def __init__(self, message: str = "provider failed", status: int | None = None):
        super().__init__(message)
        self.status = status


class NotFoundError(ProviderError):
    """The object doesn't exist (or the credential can't see it)."""


class AuthError(ProviderError):
    """The credential stopped working: `code` is an IntegrationErrorCode (token_expired, token_revoked, …)."""

    def __init__(self, code: str, message: str = "credential rejected"):
        super().__init__(message, 401)
        self.code = code


class RateLimited(ProviderError):
    def __init__(self, reset_at: dt.datetime):
        super().__init__("rate limited", 429)
        self.reset_at = reset_at


class ConnectError(Exception):
    """A connect/callback failure with a §5.3 code (state_invalid, insufficient_scope, provider_failed, …)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class TokenError(Exception):
    """G3/G12 token mode: a 422 on `field` with `message`."""

    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field
        self.message = message


class BranchExists(ProviderError):
    pass


class Rejected(ProviderError):
    """The provider refused a write (protected branch pattern, permissions); `message` is shown cut to 200."""


# ───────────────────────── value types ─────────────────────────


@dataclass
class ConnectResult:
    account_external_id: str
    account_login: str
    account_kind: str
    account_url: str
    base_url: str
    credentials: dict[str, Any] = field(default_factory=dict)
    scopes: list[str] = field(default_factory=list)
    token_expires_at: dt.datetime | None = None


@dataclass
class RepoInfo:
    external_id: str
    full_path: str
    owner: str
    name: str
    visibility: str
    default_branch: str
    web_url: str
    updated_at: dt.datetime | None = None
    archived: bool = False


@dataclass
class Author:
    login: str = ""
    name: str = ""
    email: str = ""


@dataclass
class PullRequestInfo:
    number: int
    title: str
    state: str  # open | draft | merged | closed
    head_branch: str
    base_branch: str
    sha: str
    url: str
    author: Author
    created_at: dt.datetime | None
    updated_at: dt.datetime | None
    merged_at: dt.datetime | None = None
    closed_at: dt.datetime | None = None


@dataclass
class BranchInfo:
    name: str
    sha: str
    url: str
    updated_at: dt.datetime | None = None


@dataclass
class CommitInfo:
    sha: str
    message: str
    url: str
    author: Author
    committed_at: dt.datetime | None


@dataclass
class CheckInfo:
    name: str
    state: str  # passing | failing | running
    duration_sec: int | None = None
    url: str | None = None
    started_at: dt.datetime | None = None


@dataclass
class ResolvedObject:
    kind: str  # pull_request | branch | commit
    pr: PullRequestInfo | None = None
    branch: BranchInfo | None = None
    commit: CommitInfo | None = None


@dataclass
class DeliveryMeta:
    delivery_id: str
    event: str
    action: str
    account_id: str  # GitHub installation id; GitLab project id


@dataclass
class DevEvent:
    """A normalised webhook event (§7.2)."""

    kind: str  # pr_upsert | review_update | push | branch_upsert | branch_deleted | checks_update | repo_update |
    # repo_removed | integration_state
    repo_external_id: str = ""
    pr: PullRequestInfo | None = None
    number: int | None = None
    branch: BranchInfo | None = None
    branch_name: str = ""
    commits: list[CommitInfo] = field(default_factory=list)
    compare: tuple[str, str] | None = None  # GitLab push over 20 commits: (before, after)
    sha: str = ""
    checks: list[CheckInfo] = field(default_factory=list)
    replace_checks: bool = False
    full_path: str | None = None
    archived: bool | None = None
    deleted: bool = False
    repo_ids: list[str] = field(default_factory=list)
    error_code: str | None = None  # integration_state: "" clears


class Provider(Protocol):
    key: str

    def available(self) -> bool: ...
    def methods(self) -> list[str]: ...
    def authorize_url(self, attempt: Any, state: str) -> str: ...
    def complete(self, attempt: Any, params: Mapping[str, str]) -> ConnectResult: ...
    def connect_with_token(self, base_url: str, token: str) -> ConnectResult: ...
    def revoke(self, integration: Any) -> bool: ...
    def list_repositories(self, integration: Any) -> list[RepoInfo]: ...
    def enable_repository(self, integration: Any, repo: Any) -> None: ...
    def disable_repository(self, integration: Any, repo: Any) -> None: ...
    def verify(self, request: HttpRequest, body: bytes, integration: Any) -> bool: ...
    def delivery_meta(self, request: HttpRequest, body: bytes, payload: Any) -> DeliveryMeta: ...
    def normalize(self, delivery: Any) -> list[DevEvent]: ...
    def pull_requests(
        self, repo: Any, *, updated_since: dt.datetime | None, limit: int
    ) -> Iterator[PullRequestInfo]: ...
    def branches(self, repo: Any, *, limit: int) -> Iterator[BranchInfo]: ...
    def commits(self, repo: Any, *, ref: str | None, since: dt.datetime, limit: int) -> Iterator[CommitInfo]: ...
    def compare_commits(self, repo: Any, before: str, after: str, *, limit: int) -> list[CommitInfo]: ...
    def pull_request_commits(self, repo: Any, number: int, *, limit: int) -> Iterator[CommitInfo]: ...
    def checks(self, repo: Any, sha: str) -> list[CheckInfo]: ...
    def approvals(self, repo: Any, number: int) -> int: ...
    def ahead_by(self, repo: Any, branch: str) -> int | None: ...
    def resolve_url(self, integration: Any, repo: Any, kind: str, ref: str) -> ResolvedObject | None: ...
    def create_branch(self, repo: Any, name: str, from_ref: str) -> BranchInfo: ...
    def recover(self, integration: Any, known_delivery_ids: set[str]) -> None: ...
    def low_budget(self, integration: Any) -> bool: ...


def get_provider(key: str) -> Provider:
    if settings.INTEGRATIONS_PROVIDER_BACKEND == "fake":
        from .fake import FakeProvider

        return FakeProvider(key)
    if key == "github":
        from .github import GitHubProvider

        return GitHubProvider()
    from .gitlab import GitLabProvider

    return GitLabProvider()


# ───────────────────────── shared helpers ─────────────────────────


def parse_time(value: Any) -> dt.datetime | None:
    """ISO-8601 (`2026-10-09T08:40:00Z`) or GitLab's hook format (`2026-10-09 08:40:00 UTC`)."""
    if not value or not isinstance(value, str):
        return None
    text = value.strip().replace(" UTC", "+00:00").replace("Z", "+00:00")
    if " " in text and "T" not in text:
        text = text.replace(" ", "T", 1)
    text = text.replace(" ", "")
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.UTC)


def github_secrets() -> list[str]:
    secrets_ = [s.strip() for s in (settings.GITHUB_WEBHOOK_SECRET or "").split(",") if s.strip()]
    return secrets_


def verify_github_signature(body: bytes, header: str | None, secrets_: list[str]) -> bool:
    """§10.1: `sha256=<hex>` HMAC of the raw body, compared in constant time with every configured secret."""
    if not header or not header.startswith("sha256=") or not secrets_:
        return False
    ok = False
    for secret in secrets_:
        expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        if len(expected) == len(header) and hmac.compare_digest(expected.encode(), header.encode()):
            ok = True
    return ok


def sign_github(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def verify_gitlab_token(integration: Any, request: HttpRequest) -> bool:
    """§10.1: `X-Gitlab-Token` against the integration's decrypted secret, plus `X-Gitlab-Instance` = its host."""
    from urllib.parse import urlsplit

    header = request.headers.get("X-Gitlab-Token") or ""
    try:
        secret = integration.get_secret("webhook_secret")
    except Exception:
        return False
    if not secret or not hmac.compare_digest(secret.encode(), header.encode()):
        return False
    instance = request.headers.get("X-Gitlab-Instance")
    if instance:
        expected = (urlsplit(integration.base_url).hostname or "").lower()
        given = (urlsplit(instance).hostname or instance).lower()
        if given != expected:
            return False
    return True


def body_delivery_id(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def first_line(message: str, limit: int = 300) -> str:
    return (message or "").split("\n", 1)[0][:limit]
