"""The real GitHub and GitLab adapters against recorded-shape JSON through an injected HTTP stub, and the SSRF guard
(§2.4, §10.4). No network."""

import json
import socket
import urllib.parse

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from django.test import override_settings
from django.utils import timezone

from modules.tracking.integrations import http
from modules.tracking.integrations.models import ConnectAttempt
from modules.tracking.integrations.providers.base import (
    BranchExists,
    ConnectError,
    NotFoundError,
    RateLimited,
    TokenError,
)
from modules.tracking.integrations.providers.github import GitHubProvider
from modules.tracking.integrations.providers.gitlab import GitLabProvider

from .conftest import make_integration, track

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
).decode()
GH_SETTINGS = {
    "GITHUB_APP_ID": "42", "GITHUB_APP_SLUG": "lightex", "GITHUB_APP_CLIENT_ID": "Iv1.abc",
    "GITHUB_APP_CLIENT_SECRET": "cs", "GITHUB_APP_PRIVATE_KEY": PEM.replace("\n", "\\n"),
    "GITHUB_WEBHOOK_SECRET": "s",
}  # fmt: skip


class Stub:
    """Routes (METHOD, path) → (status, json body, headers); records every request."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, url, headers, body, ip):
        parts = urllib.parse.urlsplit(url)
        self.calls.append((method, parts.path, headers, body, ip))
        for (m, prefix), reply in self.routes.items():
            if m == method and parts.path.startswith(prefix):
                status, data, *extra = reply
                return http.Response(status, extra[0] if extra else {}, json.dumps(data).encode())
        return http.Response(404, {}, b'{"message":"Not Found"}')


@pytest.fixture
def stub():
    def install(routes):
        s = Stub(routes)
        http.set_transport(s)
        return s

    return install


def _public_dns(monkeypatch, *answers):
    seq = list(answers)

    def fake(host, port, *a, **k):
        ips = seq.pop(0) if len(seq) > 1 else seq[0]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in ips]

    monkeypatch.setattr(socket, "getaddrinfo", fake)


# ───────────────────────── GitHub ─────────────────────────


@pytest.mark.django_db
@override_settings(**GH_SETTINGS)
def test_github_connect_verifies_installation_and_revokes_user_token(ws, owner, stub):
    s = stub(
        {
            ("POST", "/login/oauth/access_token"): (200, {"access_token": "ghu_user"}),
            ("GET", "/user/installations"): (200, {"installations": [{"id": 51234567}]}),
            ("DELETE", "/applications/Iv1.abc/token"): (204, {}),
            ("GET", "/app/installations/51234567"): (
                200,
                {"account": {"login": "platform-team", "type": "Organization", "html_url": "https://github.com/platform-team"},
                 "permissions": {"contents": "write", "metadata": "read"}},
            ),
        }
    )  # fmt: skip
    provider = GitHubProvider()
    assert provider.available()
    attempt = ConnectAttempt(
        workspace=ws, user=owner, provider="github", installation_id="51234567", expires_at=timezone.now()
    )
    assert "installations/new?state=abc" in provider.authorize_url(attempt, "abc")
    result = provider.complete(attempt, {"code": "c"})
    assert (result.account_login, result.account_kind, result.account_external_id) == (
        "platform-team",
        "organization",
        "51234567",
    )
    assert any(c[0] == "DELETE" and c[1] == "/applications/Iv1.abc/token" for c in s.calls)
    app_jwt = next(c[2]["Authorization"] for c in s.calls if c[1] == "/app/installations/51234567").split()[1]
    claims = jwt.decode(app_jwt, KEY.public_key(), algorithms=["RS256"])
    assert claims["iss"] == "Iv1.abc" and claims["exp"] - claims["iat"] == 600
    attempt.installation_id = "999"
    with pytest.raises(ConnectError) as err:
        provider.complete(attempt, {"code": "c"})
    assert err.value.code == "state_invalid"


@pytest.mark.django_db
@override_settings(**GH_SETTINGS)
def test_github_reads_writes_and_token_cache(ws, stub):
    integration = make_integration(ws, "github")
    repo = track(integration)
    expires = (timezone.now() + timezone.timedelta(hours=1)).isoformat()
    s = stub(
        {
            ("POST", "/app/installations/51234567/access_tokens"): (201, {"token": "ghs_inst", "expires_at": expires}),
            ("GET", "/installation/repositories"): (200, {"repositories": [
                {"id": 1, "full_name": "platform-team/web", "name": "web", "owner": {"login": "platform-team"},
                 "private": True, "default_branch": "main", "html_url": "https://github.com/platform-team/web",
                 "pushed_at": "2026-10-09T08:57:00Z"}]}),
            ("GET", "/repos/platform-team/web/pulls/214/reviews"): (200, [
                {"user": {"login": "a"}, "state": "CHANGES_REQUESTED"}, {"user": {"login": "a"}, "state": "APPROVED"},
                {"user": {"login": "b"}, "state": "COMMENTED"}]),
            ("GET", "/repos/platform-team/web/commits/abc/check-runs"): (200, {"check_runs": [
                {"name": "unit", "status": "completed", "conclusion": "timed_out"},
                {"name": "e2e", "status": "in_progress"}]}),
            ("GET", "/repos/platform-team/web/commits/abc/status"): (
                200, {"statuses": [{"context": "ci", "state": "success"}]}),
            ("GET", "/repos/platform-team/web/git/ref/heads/main"): (200, {"object": {"sha": "f" * 40}}),
            ("POST", "/repos/platform-team/web/git/refs"): (422, {"message": "Reference already exists"}),
            ("GET", "/repos/platform-team/web/compare/"): (200, {"ahead_by": 3}),
            ("DELETE", "/app/installations/51234567"): (404, {}),
            ("GET", "/repos/platform-team/web/pulls/5"): (
                403, {}, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999"}),
        }
    )  # fmt: skip
    provider = GitHubProvider()
    assert [r.full_path for r in provider.list_repositories(integration)] == ["platform-team/web"]
    assert provider.approvals(repo, 214) == 1
    assert [c.state for c in provider.checks(repo, "abc")] == ["failing", "running", "passing"]
    assert provider.ahead_by(repo, "prj-1-x") == 3
    with pytest.raises(BranchExists):
        provider.create_branch(repo, "prj-1-x", "main")
    assert sum(1 for c in s.calls if c[1].endswith("/access_tokens")) == 1  # cached, encrypted
    integration.refresh_from_db()
    assert (
        integration.get_credentials()["installationToken"] == "ghs_inst" and "ghs_inst" not in integration.credentials
    )
    assert provider.revoke(integration) is True  # 404 counts as done
    with pytest.raises(RateLimited):
        provider.resolve_url(integration, repo, "pull_request", "5")
    assert provider.resolve_url(integration, repo, "commit", "deadbee") is None


# ───────────────────────── GitLab ─────────────────────────


@pytest.mark.django_db
def test_gitlab_token_mode_hooks_and_ssrf_pinning(ws, stub, monkeypatch):
    _public_dns(monkeypatch, ["140.82.112.3"])
    s = stub(
        {
            ("GET", "/api/v4/personal_access_tokens/self"): (
                200, {"active": True, "scopes": ["api"], "expires_at": "2099-01-01"}),
            ("GET", "/api/v4/user"): (200, {"id": 77, "username": "group_1_bot", "bot": True, "web_url": "https://gitlab.example.com/g"}),
            ("POST", "/api/v4/projects/5/hooks"): (201, {"id": 900}),
            ("DELETE", "/api/v4/projects/5/hooks/900"): (204, {}),
            ("DELETE", "/api/v4/personal_access_tokens/self"): (204, {}),
        }
    )  # fmt: skip
    provider = GitLabProvider()
    result = provider.connect_with_token("https://gitlab.example.com/", "glpat-x")
    assert (result.base_url, result.account_kind, result.credentials["bot"]) == (
        "https://gitlab.example.com",
        "bot",
        True,
    )
    assert all(c[4] == "140.82.112.3" for c in s.calls)  # connected to the vetted IP
    integration = make_integration(ws, "gitlab", base_url="https://gitlab.example.com", account_external_id="77")
    integration.set_credentials(result.credentials)
    integration.save()
    repo = track(integration, external_id="5")
    provider.enable_repository(integration, repo)
    hook = json.loads(next(c[3] for c in s.calls if c[0] == "POST"))
    assert repo.hook_id == "900" and hook["token"] == "gl-secret" and hook["enable_ssl_verification"] is True
    repo.save()
    assert provider.revoke(integration) is True
    assert {(c[0], c[1]) for c in s.calls} >= {
        ("DELETE", "/api/v4/projects/5/hooks/900"),
        ("DELETE", "/api/v4/personal_access_tokens/self"),
    }


@pytest.mark.django_db
def test_gitlab_token_errors(stub, monkeypatch):
    _public_dns(monkeypatch, ["140.82.112.3"])
    provider = GitLabProvider()
    stub({("GET", "/api/v4/personal_access_tokens/self"): (200, {"active": True, "scopes": ["read_api"]})})
    with pytest.raises(TokenError, match="api scope"):
        provider.connect_with_token("https://gitlab.example.com", "t")
    stub({("GET", "/api/v4/personal_access_tokens/self"): (401, {})})
    with pytest.raises(TokenError, match="didn't accept"):
        provider.connect_with_token("https://gitlab.example.com", "t")
    stub(
        {
            ("GET", "/api/v4/personal_access_tokens/self"): (
                200,
                {"active": True, "scopes": ["api"], "expires_at": "2001-01-01"},
            )
        }
    )
    with pytest.raises(TokenError, match="expired"):
        provider.connect_with_token("https://gitlab.example.com", "t")


@pytest.mark.django_db
@override_settings(GITLAB_CLIENT_ID="app", GITLAB_CLIENT_SECRET="sec")
def test_gitlab_oauth_refresh_rotates_and_invalid_grant_expires(ws, stub, monkeypatch):
    _public_dns(monkeypatch, ["140.82.112.3"])
    integration = make_integration(ws, "gitlab", auth_kind="gitlab_oauth")
    integration.set_credentials({"accessToken": "old", "refreshToken": "r1", "expiresAt": timezone.now().isoformat()})
    integration.save()
    repo = track(integration, external_id="5")
    s = stub(
        {
            ("POST", "/oauth/token"): (200, {"access_token": "new", "refresh_token": "r2", "expires_in": 7200}),
            ("GET", "/api/v4/projects/5/merge_requests/3/approvals"): (200, {"approved_by": [{"user": {}}]}),
        }
    )
    assert GitLabProvider().approvals(repo, 3) == 1
    integration.refresh_from_db()
    assert integration.get_credentials()["refreshToken"] == "r2"
    assert next(c[2]["Authorization"] for c in s.calls if "approvals" in c[1]) == "Bearer new"
    assert GitLabProvider().methods() == ["oauth", "token"]
    integration.set_credentials({"accessToken": "x", "refreshToken": "r2", "expiresAt": timezone.now().isoformat()})
    integration.save()
    stub({("POST", "/oauth/token"): (400, {"error": "invalid_grant"})})
    from modules.tracking.integrations.providers.base import AuthError

    with pytest.raises(AuthError) as err:
        GitLabProvider().approvals(repo, 3)
    assert err.value.code == "token_expired"


# ───────────────────────── SSRF guard (§10.4) ─────────────────────────


@pytest.mark.parametrize(
    "url,message",
    [
        ("http://gitlab.example.com", "Use an https:// address."),
        ("https://user:pw@gitlab.example.com", "This address isn't allowed."),
        ("https://gitlab.example.com:22", "This address isn't allowed."),
    ],
)
def test_ssrf_url_rules(url, message):
    with pytest.raises(http.UnsafeUrl) as err:
        http.SafeTarget(url)
    assert err.value.message == message


@pytest.mark.parametrize(
    "ip", ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "fd00::1", "100.64.0.1", "::ffff:10.0.0.1"]
)
def test_ssrf_private_answers_rejected(ip, monkeypatch):
    _public_dns(monkeypatch, [ip])
    with pytest.raises(http.UnsafeUrl):
        http.SafeTarget("https://gitlab.example.com").resolve()


def test_ssrf_mixed_answers_rebinding_allow_list_redirects_and_size(monkeypatch, stub):
    _public_dns(monkeypatch, ["140.82.112.3", "10.0.0.1"])
    with pytest.raises(http.UnsafeUrl):
        http.SafeTarget("https://gitlab.example.com").resolve()
    _public_dns(monkeypatch, ["140.82.112.3"], ["127.0.0.1"])  # rebinding: the second answer would be private
    target = http.SafeTarget("https://gitlab.example.com")
    s = stub({("GET", "/a"): (200, {}), ("GET", "/r"): (302, {}, {"location": "http://169.254.169.254/"})})
    http.request("GET", "https://gitlab.example.com/a", target=target)
    http.request("GET", "https://gitlab.example.com/a", target=target)
    assert [c[4] for c in s.calls] == ["140.82.112.3", "140.82.112.3"]
    with pytest.raises(http.TransportError):
        http.request("GET", "https://gitlab.example.com/r", target=target)
    http.set_transport(lambda *a: http.Response(200, {}, b"x" * (http.MAX_RESPONSE_BYTES + 1)))
    with pytest.raises(http.TransportError):
        http.request("GET", "https://gitlab.example.com/big", target=target)
    with override_settings(GITLAB_ALLOWED_HOSTS=["*.corp.example"]):
        with pytest.raises(http.UnsafeUrl):
            http.SafeTarget("https://gitlab.example.com")
        assert http.SafeTarget("https://git.corp.example").origin == "https://git.corp.example"


def test_pinned_connection_uses_the_vetted_ip(monkeypatch):
    seen = []

    def fake_connect(address, timeout=None):
        seen.append(address)
        raise OSError("stop")

    monkeypatch.setattr(socket, "create_connection", fake_connect)
    with pytest.raises(http.TransportError):
        http._stdlib_transport("GET", "https://gitlab.example.com/x", {}, None, "140.82.112.3")
    assert seen == [("140.82.112.3", 443)]


def test_not_found_maps(stub):
    stub({})
    with pytest.raises(NotFoundError):
        GitHubProvider()._call("GET", "/nope", "t")
