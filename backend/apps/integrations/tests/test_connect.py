"""G2–G6 and G12: the two-secret connect round-trip (§5.3, §10.3) through the fake provider."""

import datetime as dt
import hashlib
import urllib.parse

import pytest
from django.test import override_settings
from django.utils import timezone

from apps.audit.models import AuditLog
from apps.common.testing import UserFactory, add_member, client_for, make_workspace
from apps.integrations.models import ConnectAttempt, Integration
from apps.integrations.providers.fake import FAKE
from apps.integrations.services import purge

from .conftest import make_integration, track

pytestmark = pytest.mark.django_db
FRONT = "http://localhost:3000"


def _query(url):
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


def start(client, slug="platform", provider="github", body=None):
    res = client.post(f"/api/v1/workspaces/{slug}/integrations/{provider}/connect", body or {}, format="json")
    assert res.status_code == 200, res.content
    return _query(res.json()["authorizeUrl"])["state"]


def callback(client, state, provider="github", **params):
    return client.get(f"/api/v1/integrations/{provider}/callback", {"state": state, "code": "fake-ok", **params})


def fragment(res):
    assert res.status_code == 302
    return urllib.parse.urlsplit(res["Location"]).fragment


def connect(client, provider="github"):
    state = start(client, provider=provider, body={"method": "oauth"} if provider == "gitlab" else {})
    attempt, token = fragment(callback(client, state, provider)).split("=", 1)[1].split(".", 1)
    return client.post(
        "/api/v1/workspaces/platform/integrations/confirm", {"attempt": attempt, "token": token}, format="json"
    )


def test_github_connect_round_trip(ws, owner):
    client = client_for(owner)
    state = start(client)
    attempt = ConnectAttempt.objects.get()
    assert attempt.state_hash == hashlib.sha256(state.encode()).hexdigest() and state not in str(attempt.__dict__)
    assert abs((attempt.expires_at - attempt.created_at) - dt.timedelta(minutes=10)) < dt.timedelta(seconds=5)
    # G4: the Setup URL leg forwards to the OAuth leg with the same state.
    setup = client.get(
        "/api/v1/integrations/github/setup", {"installation_id": "51234567", "setup_action": "install", "state": state}
    )
    assert setup.status_code == 302 and _query(setup["Location"])["state"] == state
    assert setup["Referrer-Policy"] == "no-referrer" and setup["Cache-Control"] == "no-store"
    res = callback(client, state)
    assert res["Location"].startswith(f"{FRONT}/platform/settings/integrations#connect=")
    integration = Integration.objects.get()
    assert integration.status == "pending"
    assert ("github", "revoke_user_token") in FAKE.calls  # the user token is revoked at once
    assert client.get("/api/v1/workspaces/platform/integrations").json()["integrations"] == []
    # Single use: the same state can't be replayed.
    assert fragment(callback(client, state)) == "connect_error=state_invalid"
    attempt_id, token = fragment(res).split("=", 1)[1].split(".", 1)
    ok = client.post(
        "/api/v1/workspaces/platform/integrations/confirm", {"attempt": attempt_id, "token": token}, format="json"
    )
    assert ok.status_code == 200, ok.content
    body = ok.json()
    assert body["status"] == "active" and body["account"]["login"] == "platform-team" and body["repositories"] == []
    assert AuditLog.objects.filter(action="integration.connected").count() == 1
    again = client.post(
        "/api/v1/workspaces/platform/integrations/confirm", {"attempt": attempt_id, "token": token}, format="json"
    )
    assert again.status_code == 404


def test_confirm_checks_user_token_expiry_and_permission(ws, owner):
    client = client_for(owner)
    state = start(client)
    attempt_id, token = fragment(callback(client, state)).split("=", 1)[1].split(".", 1)
    url = "/api/v1/workspaces/platform/integrations/confirm"
    admin = add_member(ws, UserFactory(), "admin")
    assert client_for(admin).post(url, {"attempt": attempt_id, "token": token}, format="json").status_code == 404
    assert client.post(url, {"attempt": attempt_id, "token": token + "x"}, format="json").status_code == 404
    ConnectAttempt.objects.filter(pk=attempt_id).update(expires_at=timezone.now() - dt.timedelta(seconds=1))
    assert client.post(url, {"attempt": attempt_id, "token": token}, format="json").status_code == 404
    ConnectAttempt.objects.filter(pk=attempt_id).update(expires_at=timezone.now() + dt.timedelta(minutes=5))
    member_role = ws.roles.get(system_key="admin")
    member_role.permissions.remove(member_role.permissions.get(code="integration.manage"))
    owner.workspace_memberships.filter(workspace=ws).update(role=member_role)
    assert client_for(owner).post(url, {"attempt": attempt_id, "token": token}, format="json").status_code == 404


def test_callback_failures_redirect_with_codes(ws, owner):
    client = client_for(owner)
    state = start(client)
    res = client.get("/api/v1/integrations/github/setup", {"setup_action": "request", "state": state})
    assert urllib.parse.urlsplit(res["Location"]).fragment == "connect_error=github_requested"
    state = start(client)
    assert fragment(client.get("/api/v1/integrations/github/callback", {"state": state, "error": "access_denied"})) == (
        "connect_error=github_cancelled"
    )
    # An installation id the installer can't see: state_invalid, nothing created.
    state = start(client)
    client.get("/api/v1/integrations/github/setup", {"installation_id": "999", "state": state})
    assert fragment(callback(client, state)) == "connect_error=state_invalid"
    assert not Integration.objects.exists()
    assert fragment(callback(client, "unknown-state")) == "connect_error=state_invalid"
    assert client.get("/api/v1/integrations/github/callback", {"state": "nope"})["Location"] == (
        f"{FRONT}/#connect_error=state_invalid"
    )


def test_installation_in_use_across_workspaces(ws, owner):
    other = make_workspace(UserFactory(), slug="other")
    make_integration(other, "github")
    client = client_for(owner)
    assert fragment(callback(client, start(client))) == "connect_error=installation_in_use"


def test_expired_called_back_attempt_is_revoked_and_deleted_by_purge(ws, owner):
    client = client_for(owner)
    callback(client, start(client))
    assert Integration.objects.filter(status="pending").count() == 1
    ConnectAttempt.objects.update(expires_at=timezone.now() - dt.timedelta(minutes=1))
    assert purge()["attempts"] == 1
    assert not Integration.objects.exists()
    assert ("github", "revoke", "51234567") in FAKE.calls


def test_gitlab_oauth_with_pkce(ws, owner):
    client = client_for(owner)
    state = start(client, provider="gitlab", body={"method": "oauth"})
    attempt = ConnectAttempt.objects.get(provider="gitlab")
    verifier = attempt.get_secret("pkce_verifier")
    assert len(verifier) > 40 and verifier not in attempt.pkce_verifier
    attempt_id, token = fragment(callback(client, state, "gitlab")).split("=", 1)[1].split(".", 1)
    res = client.post(
        "/api/v1/workspaces/platform/integrations/confirm", {"attempt": attempt_id, "token": token}, format="json"
    )
    assert res.status_code == 200 and res.json()["authKind"] == "gitlab_oauth"
    integration = Integration.objects.get(provider="gitlab")
    assert integration.get_secret("webhook_secret") and integration.get_credentials()["refreshToken"] == "fake-refresh"


def test_gitlab_token_mode_validation(ws, owner):
    client = client_for(owner)
    url = "/api/v1/workspaces/platform/integrations/gitlab/connect"

    def post(base, token):
        return client.post(url, {"method": "token", "baseUrl": base, "token": token}, format="json")

    assert post("http://gitlab.example.com", "fake-token").json()["details"]["fields"] == {
        "baseUrl": "Use an https:// address."
    }
    assert post("https://gitlab.example.com", "fake-noscope").json()["details"]["fields"] == {
        "token": "The token needs the api scope."
    }
    assert (
        post("https://gitlab.example.com", "fake-expired").json()["details"]["fields"]["token"]
        == "This token has expired."
    )
    created = post("https://GitLab.Example.com/", "fake-token")
    assert created.status_code == 201 and created.json()["baseUrl"] == "https://gitlab.example.com"
    dup = post("https://gitlab.example.com", "fake-token")
    assert dup.status_code == 409 and dup.json()["details"]["integrationId"] == created.json()["id"]


def test_reconnect(ws, owner):
    client = client_for(owner)
    gl = make_integration(ws, "gitlab", status="error", error_code="token_expired")
    track(gl)
    res = client.post(f"/api/v1/integrations/{gl.id}/reconnect", {"token": "fake-other"}, format="json")
    assert res.json()["details"]["fields"]["token"] == "This token belongs to a different GitLab user."
    res = client.post(f"/api/v1/integrations/{gl.id}/reconnect", {"token": "fake-token"}, format="json")
    assert res.status_code == 200 and res.json()["status"] == "active" and res.json()["error"] is None
    # GitHub: a reconnect with another account fails with account_mismatch.
    gh = make_integration(ws, "github", status="error", error_code="installation_suspended")
    state = _query(client.post(f"/api/v1/integrations/{gh.id}/reconnect", {}, format="json").json()["authorizeUrl"])[
        "state"
    ]
    assert fragment(callback(client, state, code="fake-other")) == "connect_error=account_mismatch"
    state = _query(client.post(f"/api/v1/integrations/{gh.id}/reconnect", {}, format="json").json()["authorizeUrl"])[
        "state"
    ]
    attempt_id, token = fragment(callback(client, state)).split("=", 1)[1].split(".", 1)
    body = client.post(
        "/api/v1/workspaces/platform/integrations/confirm", {"attempt": attempt_id, "token": token}, format="json"
    ).json()
    assert body["status"] == "active" and AuditLog.objects.filter(action="integration.reconnected").count() == 2


def test_fake_authorize_and_kill_switch(ws, owner):
    client = client_for(owner)
    state = start(client)
    res = client.get("/api/v1/integrations/fake/authorize", {"state": state, "provider": "github", "deny": "1"})
    assert "error=access_denied" in res["Location"]
    with override_settings(INTEGRATIONS_PROVIDER_BACKEND="real"):
        assert client.get("/api/v1/integrations/fake/authorize", {"state": state}).status_code == 404
        providers = client.get("/api/v1/workspaces/platform/integrations").json()["providers"]
        assert [p["available"] for p in providers] == [False, True]
        assert providers[1]["methods"] == ["token"]
        res = client.post("/api/v1/workspaces/platform/integrations/github/connect", {}, format="json")
        assert res.status_code == 503 and res.json()["code"] == "integrations_unavailable"
    with override_settings(INTEGRATIONS_ENABLED=False):
        res = client.post("/api/v1/workspaces/platform/integrations/github/connect", {}, format="json")
        assert res.status_code == 503
        assert client.post("/api/v1/webhooks/github", b"{}", content_type="application/json").status_code == 503
