"""The fake provider (docs/v2/37-integrations-github-gitlab.md §7.8): dev, tests and parity with the web client's mock.

Fixtures are the design's eight repositories and the PRs, branches and commits of §9.8 (`seed_demo` backfills them).
Webhooks use the **real** verification and payload shapes (`github.normalize` / `gitlab.normalize`); only the API
calls are faked. Every call is recorded in `FAKE.calls`, and tests steer failures through `FAKE`.
"""

from __future__ import annotations

import datetime as dt
import secrets
import urllib.parse
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Any

from django.conf import settings
from django.http import HttpRequest
from django.utils import timezone

from .. import http
from . import github, gitlab
from .base import (
    Author,
    BranchExists,
    BranchInfo,
    CheckInfo,
    CommitInfo,
    ConnectError,
    ConnectResult,
    DeliveryMeta,
    DevEvent,
    ProviderError,
    PullRequestInfo,
    Rejected,
    RepoInfo,
    ResolvedObject,
    TokenError,
    github_secrets,
    verify_github_signature,
    verify_gitlab_token,
)

GH = "https://github.com"
GL = "https://gitlab.com"
FAKE_WEBHOOK_SECRET = "lightex-fake-webhook-secret"  # noqa: S105 (dev only, when GITHUB_WEBHOOK_SECRET is unset)

# (id, owner, name, visibility, minutes since update, open PRs)
REPOS = [
    ("712004001", "platform-team", "web", "private", 2, 12),
    ("712004002", "platform-team", "api", "private", 9, 7),
    ("712004003", "platform-team", "board-engine", "private", 60, 4),
    ("712004004", "platform-team", "mobile-app", "private", 180, 5),
    ("712004188", "platform-team", "infra-terraform", "private", 1440, 2),
    ("712004190", "platform-team", "design-tokens", "public", 5760, 1),
    ("712009001", "alexkim", "reflow-bench", "public", 2880, 0),
    ("712009002", "alexkim", "dotfiles", "public", 30240, 0),
]
GH_ACCOUNTS = [("51234567", "platform-team", "organization"), ("51239999", "alexkim", "user")]
PEOPLE = {
    "akim": ("Alex Kim", "alex@team.dev"),
    "jlee": ("Jordan Lee", "jordan@team.dev"),
    "sam-p": ("Sam Patel", "sam@team.dev"),
    "rchen": ("Riley Chen", "riley@team.dev"),
    "tng": ("Taylor Ng", "taylor@team.dev"),
}
# repo name → PRs: (number, title, state, head branch, author, minutes since update, checks, approvals)
PRS: dict[str, list[tuple[int, str, str, str, str, int, list[tuple[str, str, int]], int]]] = {
    "web": [
        (214, "PRJ-42 Fix flaky board reflow", "open", "prj-42-fix-reflow", "akim", 20,
         [("e2e / board-drag", "failing", 134), ("unit / reflow", "failing", 48), ("lint", "passing", 12)], 0),
        (209, "PRJ-42 Add reflow regression test", "draft", "prj-42-reflow-tests", "sam-p", 50,
         [("e2e / board-drag", "running", 60), ("unit / reflow", "passing", 41), ("lint", "passing", 11)], 0),
        (198, "PRJ-42 Debounce sidebar toggle", "merged", "prj-42-debounce-sidebar", "jlee", 60 * 30,
         [("e2e / board-drag", "passing", 122), ("unit / reflow", "passing", 45), ("lint", "passing", 10)], 2),
        (190, "PRJ-42 Drop will-change hack", "closed", "prj-42-will-change", "akim", 60 * 24 * 5, [], 0),
        (221, "PRJ-41 Virtualize board column lists", "open", "prj-41-virtualize-columns", "rchen", 90,
         [("e2e / board-drag", "passing", 118), ("unit / virtual", "passing", 39), ("lint", "passing", 11)], 1),
    ],
    "board-engine": [
        (187, "PRJ-29 Board drag preview", "merged", "prj-29-drag-preview", "tng", 60 * 24 * 3,
         [("unit / drag", "passing", 52), ("lint", "passing", 9)], 1),
    ],
}  # fmt: skip
# repo name → branches: (name, minutes since update, ahead by)
BRANCHES = {"web": [("main", 2, 0), ("prj-42-fix-reflow", 60, 3), ("prj-42-reflow-tests", 180, 1)]}
# repo name → commits: (short sha, message, author, minutes ago)
COMMITS = {
    "web": [
        ("a3f9c21", "fix(board): debounce reflow (PRJ-42)", "akim", 60),
        ("7be04d8", "test(board): drag while resizing (PRJ-42)", "sam-p", 180),
        ("e51c7aa", "refactor(board): extract measure() (PRJ-42)", "akim", 300),
        ("0c2d9f3", "fix(board): guard null column (PRJ-42)", "jlee", 60 * 24),
    ]
}


def full_sha(short: str) -> str:
    return (short + "6e1b0c4d9a7f2e5b8c3d1a0f9e8d7c6b5a4f3e2d")[:40]


def pr_sha(number: int) -> str:
    return full_sha(f"{number:07d}")


@dataclass
class FakeState:
    calls: list[tuple[Any, ...]] = field(default_factory=list)
    fail: set[str] = field(default_factory=set)  # operation names that raise ProviderError
    low_budget: bool = False
    created_branches: set[tuple[str, str]] = field(default_factory=set)
    deliveries: list[dict[str, Any]] = field(default_factory=list)  # GitHub /app/hook/deliveries
    disabled_hooks: set[str] = field(default_factory=set)
    approvals: dict[int, int] = field(default_factory=dict)
    next_hook: int = 1000

    def reset(self) -> None:
        self.__init__()  # type: ignore[misc]


FAKE = FakeState()


def _ago(minutes: int) -> dt.datetime:
    return timezone.now() - dt.timedelta(minutes=minutes)


class FakeProvider:
    def __init__(self, key: str):
        self.key = key
        self.base = GH if key == "github" else GL

    def _record(self, op: str, *args: Any) -> None:
        FAKE.calls.append((self.key, op, *args))
        if op in FAKE.fail:
            raise ProviderError(f"fake {op} failed", 502)

    def _repo_id(self, raw: str) -> str:
        return raw if self.key == "github" else "44" + raw[2:]

    def _fixture(self, repo: Any) -> str:
        return repo.name

    def available(self) -> bool:
        return True

    def methods(self) -> list[str]:
        return ["app"] if self.key == "github" else ["oauth", "token"]

    def low_budget(self, integration: Any) -> bool:
        return FAKE.low_budget

    # ── connect ──

    def authorize_url(self, attempt: Any, state: str) -> str:
        if self.key == "gitlab" and attempt is not None:
            attempt.set_secret("pkce_verifier", secrets.token_urlsafe(48))  # as the real PKCE flow does
        query = urllib.parse.urlencode({"state": state, "provider": self.key})
        return f"{settings.API_PUBLIC_URL}/api/v1/integrations/fake/authorize?{query}"

    def oauth_url(self, state: str) -> str:
        return self.authorize_url(None, state)

    def complete(self, attempt: Any, params: Mapping[str, str]) -> ConnectResult:
        self._record("complete", params.get("code"))
        code = params.get("code")
        if code not in ("fake-ok", "fake-other"):
            raise ConnectError("provider_failed")
        if self.key == "gitlab":
            login, ext = ("someone-else", "9002") if code == "fake-other" else ("alexkim", "9001")
            return ConnectResult(
                ext, login, "user", f"{GL}/{login}", GL,
                credentials={"accessToken": "fake-access", "refreshToken": "fake-refresh",
                             "expiresAt": (timezone.now() + dt.timedelta(hours=2)).isoformat()},
                scopes=["api"],
            )  # fmt: skip
        from ..models import Integration

        if attempt.installation_id and attempt.installation_id not in {a[0] for a in GH_ACCOUNTS}:
            raise ConnectError("state_invalid")  # not in the installer's /user/installations
        self._record("revoke_user_token")
        if attempt.mode == "reconnect" and attempt.integration_id and code == "fake-ok":
            target = Integration.objects.get(pk=attempt.integration_id)
            account = next(a for a in GH_ACCOUNTS if a[0] == target.account_external_id)
        elif code == "fake-other":
            account = GH_ACCOUNTS[1]
        else:
            taken = set(
                Integration.objects.filter(workspace_id=attempt.workspace_id, provider="github")
                .exclude(status="pending")
                .values_list("account_external_id", flat=True)
            )
            wanted = attempt.installation_id or next(
                (a[0] for a in GH_ACCOUNTS if a[0] not in taken), GH_ACCOUNTS[0][0]
            )
            account = next(a for a in GH_ACCOUNTS if a[0] == wanted)
        ext, login, kind = account
        return ConnectResult(ext, login, kind, f"{GH}/{login}", GH, scopes=["checks", "contents", "metadata"])

    def connect_with_token(self, base_url: str, token: str) -> ConnectResult:
        self._record("connect_with_token", base_url)
        try:
            origin = http.normalize_base_url(base_url)
        except http.UnsafeUrl as exc:
            raise TokenError("baseUrl", exc.message) from exc
        if token == "fake-noscope":  # noqa: S105 (fake fixtures)
            raise TokenError("token", "The token needs the api scope.")
        if token == "fake-expired":  # noqa: S105 (fake fixtures)
            raise TokenError("token", "This token has expired.")
        accounts = {
            "fake-token": ("9001", "alexkim", "user"),
            "fake-other": ("9002", "someone-else", "user"),
            "fake-bot-token": ("9100", "group_42_bot", "bot"),
        }
        if token not in accounts:
            raise TokenError("token", "GitLab didn't accept this token.")
        ext, login, kind = accounts[token]
        return ConnectResult(
            ext, login, kind, f"{origin}/{login}", origin,
            credentials={"token": token, "bot": kind == "bot"}, scopes=["api"],
            token_expires_at=timezone.now() + dt.timedelta(days=90),
        )  # fmt: skip

    def revoke(self, integration: Any) -> bool:
        if self.key == "gitlab":
            for repo in integration.repositories.exclude(hook_id=""):
                self._record("delete_hook", repo.external_id, repo.hook_id)
            if integration.auth_kind == "gitlab_oauth":
                self._record("oauth_revoke")
            elif integration.get_credentials().get("bot"):
                self._record("token_self_revoke")
            return "revoke" not in FAKE.fail
        try:
            self._record("revoke", integration.account_external_id)
        except ProviderError:
            return False
        return True

    def manage_url(self, integration: Any) -> str | None:
        if self.key != "github":
            return None
        return (
            f"{GH}/organizations/{integration.account_login}/settings/installations/{integration.account_external_id}"
        )

    # ── repositories ──

    def list_repositories(self, integration: Any) -> list[RepoInfo]:
        self._record("list_repositories")
        return [
            RepoInfo(
                external_id=self._repo_id(rid),
                full_path=f"{owner}/{name}",
                owner=owner,
                name=name,
                visibility=vis,
                default_branch="main",
                web_url=f"{integration.base_url}/{owner}/{name}",
                updated_at=_ago(minutes),
            )
            for rid, owner, name, vis, minutes, _ in REPOS
        ]

    def open_pr_count(self, name: str) -> int:
        return next((r[5] for r in REPOS if r[2] == name), 0)

    def enable_repository(self, integration: Any, repo: Any) -> None:
        if self.key != "gitlab":
            return
        FAKE.next_hook += 1
        self._record(
            "create_hook",
            repo.external_id,
            {
                "url": f"{settings.API_PUBLIC_URL}/api/v1/webhooks/gitlab/{integration.pk}",
                "token": integration.get_secret("webhook_secret"),
                "push_events": True,
                "merge_requests_events": True,
                "pipeline_events": True,
                "enable_ssl_verification": True,
            },
        )
        repo.hook_id = str(FAKE.next_hook)

    def disable_repository(self, integration: Any, repo: Any) -> None:
        if self.key == "gitlab" and repo.hook_id:
            self._record("delete_hook", repo.external_id, repo.hook_id)

    # ── webhooks ──

    def verify(self, request: HttpRequest, body: bytes, integration: Any) -> bool:
        if self.key == "github":
            return verify_github_signature(
                body, request.headers.get("X-Hub-Signature-256"), github_secrets() or [FAKE_WEBHOOK_SECRET]
            )
        return integration is not None and verify_gitlab_token(integration, request)

    def delivery_meta(self, request: HttpRequest, body: bytes, payload: Any) -> DeliveryMeta:
        if self.key == "github":
            return github.github_meta(request, payload)
        return gitlab.gitlab_meta(request, body, payload)

    def normalize(self, delivery: Any) -> list[DevEvent]:
        module = github if self.key == "github" else gitlab
        return module.normalize(delivery.event, delivery.payload or {})

    # ── reads ──

    def _pr(self, repo: Any, row: tuple) -> PullRequestInfo:
        number, title, state, head, login, minutes, _, _ = row
        name, email = PEOPLE.get(login, ("", ""))
        updated = _ago(minutes)
        ref = f"/pull/{number}" if self.key == "github" else f"/-/merge_requests/{number}"
        return PullRequestInfo(
            number=number,
            title=title,
            state=state,
            head_branch=head,
            base_branch="main",
            sha=pr_sha(number),
            url=f"{repo.web_url}{ref}",
            author=Author(login, name, email),
            created_at=updated - dt.timedelta(hours=20),
            updated_at=updated,
            merged_at=updated if state == "merged" else None,
            closed_at=updated if state == "closed" else None,
        )

    def pull_requests(self, repo: Any, *, updated_since: dt.datetime | None, limit: int) -> Iterator[PullRequestInfo]:
        self._record("pull_requests", repo.external_id)
        rows = sorted(PRS.get(self._fixture(repo), []), key=lambda r: r[5])
        count = 0
        for row in rows:
            pr = self._pr(repo, row)
            if updated_since and pr.updated_at and pr.updated_at < updated_since and pr.state not in ("open", "draft"):
                continue
            yield pr
            count += 1
            if count >= limit:
                return

    def branches(self, repo: Any, *, limit: int) -> Iterator[BranchInfo]:
        self._record("branches", repo.external_id)
        heads = {row[3]: pr_sha(row[0]) for row in PRS.get(self._fixture(repo), [])}
        for name, minutes, _ in BRANCHES.get(self._fixture(repo), [])[:limit]:
            yield BranchInfo(name, heads.get(name, full_sha(name[:7])), self._tree(repo, name), _ago(minutes))

    def _tree(self, repo: Any, name: str) -> str:
        return f"{repo.web_url}/tree/{name}" if self.key == "github" else f"{repo.web_url}/-/tree/{name}"

    def _commit(self, repo: Any, row: tuple) -> CommitInfo:
        short, message, login, minutes = row
        name, email = PEOPLE.get(login, ("", ""))
        sha = full_sha(short)
        path = "commit" if self.key == "github" else "-/commit"
        return CommitInfo(sha, message, f"{repo.web_url}/{path}/{sha}", Author(login, name, email), _ago(minutes))

    def commits(self, repo: Any, *, ref: str | None, since: dt.datetime, limit: int) -> Iterator[CommitInfo]:
        self._record("commits", repo.external_id)
        for row in COMMITS.get(self._fixture(repo), [])[:limit]:
            commit = self._commit(repo, row)
            if commit.committed_at and commit.committed_at >= since:
                yield commit

    def compare_commits(self, repo: Any, before: str, after: str, *, limit: int) -> list[CommitInfo]:
        self._record("compare", repo.external_id, before, after)
        return [self._commit(repo, row) for row in COMMITS.get(self._fixture(repo), [])][:limit]

    def pull_request_commits(self, repo: Any, number: int, *, limit: int) -> Iterator[CommitInfo]:
        self._record("pull_request_commits", repo.external_id, number)
        return iter([])

    def checks(self, repo: Any, sha: str) -> list[CheckInfo]:
        self._record("checks", repo.external_id, sha)
        for row in PRS.get(self._fixture(repo), []):
            if pr_sha(row[0]) == sha:
                return [CheckInfo(name, state, seconds) for name, state, seconds in row[6]]
        return []

    def approvals(self, repo: Any, number: int) -> int:
        self._record("approvals", repo.external_id, number)
        if number in FAKE.approvals:
            return FAKE.approvals[number]
        return next((row[7] for row in PRS.get(self._fixture(repo), []) if row[0] == number), 0)

    def ahead_by(self, repo: Any, branch: str) -> int | None:
        self._record("ahead_by", repo.external_id, branch)
        return next((ahead for name, _, ahead in BRANCHES.get(self._fixture(repo), []) if name == branch), 0)

    def resolve_url(self, integration: Any, repo: Any, kind: str, ref: str) -> ResolvedObject | None:
        self._record("resolve_url", kind, ref)
        if kind == "pull_request":
            row = next((r for r in PRS.get(self._fixture(repo), []) if str(r[0]) == ref), None)
            return ResolvedObject(kind, pr=self._pr(repo, row)) if row else None
        if kind == "commit":
            crow = next(
                (r for r in COMMITS.get(self._fixture(repo), []) if full_sha(r[0]).startswith(ref.lower())), None
            )
            return ResolvedObject(kind, commit=self._commit(repo, crow)) if crow else None
        names = {b[0]: b for b in BRANCHES.get(self._fixture(repo), [])}
        if ref in names or (repo.external_id, ref) in FAKE.created_branches:
            return ResolvedObject(kind, branch=BranchInfo(ref, full_sha(ref[:7]), self._tree(repo, ref), _ago(5)))
        return None

    # ── writes ──

    def create_branch(self, repo: Any, name: str, from_ref: str) -> BranchInfo:
        self._record("create_branch", repo.external_id, name, from_ref)
        existing = {b[0] for b in BRANCHES.get(self._fixture(repo), [])}
        if name in existing or (repo.external_id, name) in FAKE.created_branches:
            raise BranchExists("Reference already exists", 422)
        if name.startswith("protected/"):
            raise Rejected("Branch name matches a protected pattern", 422)
        FAKE.created_branches.add((repo.external_id, name))
        return BranchInfo(name, full_sha("c0ffee0"), self._tree(repo, name), timezone.now())

    def recover(self, integration: Any, known_delivery_ids: set[str]) -> None:
        self._record("recover", str(integration.pk))
        if self.key == "github":
            for d in FAKE.deliveries:
                if (
                    str(d.get("installation_id")) == integration.account_external_id
                    and d.get("status") != "OK"
                    and d.get("guid") not in known_delivery_ids
                ):
                    self._record("redeliver", d["guid"])
        else:
            for repo in integration.repositories.exclude(hook_id=""):
                if repo.hook_id in FAKE.disabled_hooks:
                    self._record("enable_hook", repo.hook_id)
                    FAKE.disabled_hooks.discard(repo.hook_id)
