"""W1/W2 receivers (§5.5, §10.1): verify, store, answer; no provider call and no task write in the request."""

import json

import pytest
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from apps.integrations import fake_payloads, runner
from apps.integrations.models import WebhookDelivery
from apps.integrations.providers.base import sign_github
from apps.integrations.providers.fake import FAKE
from apps.tasks.models import ExternalLink
from apps.tasks.services import create_task

from .conftest import make_integration, track

pytestmark = pytest.mark.django_db
SECRET = "test-webhook-secret"


def raw(client, body: bytes, **headers):
    return client.generic("POST", "/api/v1/webhooks/github", body, content_type="application/json", **headers)


def gh_headers(body, event="pull_request", delivery="d-1", signature=None):
    return {
        "HTTP_X_GITHUB_EVENT": event,
        "HTTP_X_GITHUB_DELIVERY": delivery,
        "HTTP_X_HUB_SIGNATURE_256": signature if signature is not None else sign_github(body, SECRET),
    }


@pytest.fixture
def no_dispatch(monkeypatch):
    monkeypatch.setattr(runner, "dispatch_on_commit", lambda: None)


def pr_body(web, github, key="PRJ-1"):
    _, payload = fake_payloads.github_payload(web, github, "pr_opened", key)
    return json.dumps(payload).encode()


def test_signatures(github, web, no_dispatch):
    client = APIClient()
    body = pr_body(web, github)
    for bad in ("", "sha1=" + "0" * 40, "sha256=abc", sign_github(body, "wrong")):
        res = raw(client, body, **gh_headers(body, signature=bad))
        assert res.status_code == 401 and res.json()["code"] == "invalid_signature"
    assert not WebhookDelivery.objects.exists()
    with override_settings(GITHUB_WEBHOOK_SECRET=f"new-secret,{SECRET}"):  # rotation: both accepted
        assert raw(client, body, **gh_headers(body)).status_code == 202
    assert WebhookDelivery.objects.get().status == "received"
    dup = raw(client, body, **gh_headers(body))
    assert dup.status_code == 200 and dup.json() == {"received": True, "duplicate": True}
    ping = raw(client, b"{}", **gh_headers(b"{}", event="ping", delivery="p"))
    assert ping.status_code == 200 and WebhookDelivery.objects.count() == 1


def test_size_cap_unknown_installation_and_foreign_app(ws, github, web, no_dispatch):
    client = APIClient()
    with override_settings(WEBHOOK_MAX_BODY_BYTES=10):
        body = pr_body(web, github)
        assert raw(client, body, **gh_headers(body)).status_code == 413
    payload = json.loads(pr_body(web, github))
    payload["installation"]["id"] = 1
    body = json.dumps(payload).encode()
    assert raw(client, body, **gh_headers(body, delivery="u")).status_code == 202
    assert WebhookDelivery.objects.get(delivery_id="u").status == "ignored"
    with override_settings(GITHUB_APP_ID="42"):
        body = pr_body(web, github)
        raw(client, body, HTTP_X_GITHUB_HOOK_INSTALLATION_TARGET_ID="7", **gh_headers(body, delivery="f"))
    assert WebhookDelivery.objects.get(delivery_id="f").status == "ignored"
    assert raw(client, b"not json", **gh_headers(b"not json", delivery="j")).status_code == 400


def test_receiver_makes_no_outbound_call_and_no_task_write(ws, owner, project, github, web, no_dispatch):
    create_task(owner, project, {"title": "x"})
    body = pr_body(web, github)
    with CaptureQueriesContext(connection) as ctx:
        res = raw(APIClient(), body, **gh_headers(body))
    assert res.status_code == 202
    assert FAKE.calls == []
    assert len(ctx.captured_queries) <= 15
    assert not any("tasks_" in q["sql"] and q["sql"].startswith(("INSERT", "UPDATE")) for q in ctx.captured_queries)
    assert not ExternalLink.objects.exists()
    runner.drain()  # the processor links PRJ-1 after the response
    assert ExternalLink.objects.count() == 1 and WebhookDelivery.objects.get().status == "processed"


def test_gitlab_receiver(ws, owner, project, no_dispatch):
    gl = make_integration(ws, "gitlab")
    repo = track(gl)
    client = APIClient()
    event, payload = fake_payloads.gitlab_payload(repo, "pr_opened", "PRJ-1")
    assert fake_payloads.post(client, gl, event, payload).status_code == 202
    res = fake_payloads.post(client, gl, event, payload, HTTP_X_GITLAB_TOKEN="wrong")
    assert res.status_code == 401
    res = fake_payloads.post(client, gl, event, payload, HTTP_X_GITLAB_INSTANCE="https://evil.example.com")
    assert res.status_code == 401
    assert (
        fake_payloads.post(client, gl, event, payload, HTTP_X_GITLAB_INSTANCE="https://gitlab.com").status_code == 202
    )
    assert fake_payloads.post(client, gl, "Note Hook", payload, delivery="n").status_code == 202
    assert WebhookDelivery.objects.get(delivery_id="n").status == "ignored"
    payload["project"]["id"] = 1
    fake_payloads.post(client, gl, event, payload, delivery="untracked")
    assert WebhookDelivery.objects.get(delivery_id="untracked").status == "ignored"
    import uuid

    missing = client.generic("POST", f"/api/v1/webhooks/gitlab/{uuid.uuid4()}", b"{}", content_type="application/json")
    assert missing.status_code == 404
    gl.status = "error"
    gl.save()
    assert fake_payloads.post(client, gl, event, payload, delivery="err").status_code == 202
