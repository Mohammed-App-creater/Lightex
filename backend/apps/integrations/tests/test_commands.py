"""Management commands: fake_webhook end to end through the real verifier, process_integrations, purge (§7.8, §12.1)."""

import datetime as dt
import io

import pytest
from django.core.management import CommandError, call_command
from django.utils import timezone

from apps.integrations.models import Integration, WebhookDelivery
from apps.tasks.models import ExternalLink
from apps.tasks.services import create_task

from .conftest import make_integration, track

pytestmark = pytest.mark.django_db


def test_fake_webhook_end_to_end(ws, owner, project, github, web):
    task = create_task(owner, project, {"title": "x"})
    out = io.StringIO()
    call_command("fake_webhook", "--provider", "github", "--event", "pr_opened", "--key", task.key, stdout=out)
    assert "pull_request → 202" in out.getvalue()
    assert ExternalLink.objects.get(task=task).state == "open"
    gl = make_integration(ws, "gitlab")
    track(gl)
    call_command("fake_webhook", "--provider", "gitlab", "--event", "push", "--key", task.key, stdout=out)
    assert ExternalLink.objects.filter(task=task, provider="gitlab", type="commit").exists()
    with pytest.raises(CommandError):
        call_command("fake_webhook", "--event", "push", "--key", "PRJ-1", "--workspace", "nope")


def test_process_and_purge(ws, github):
    old = WebhookDelivery.objects.create(provider="github", delivery_id="old", event="push", status="processed")
    WebhookDelivery.objects.filter(pk=old.pk).update(received_at=timezone.now() - dt.timedelta(days=8))
    WebhookDelivery.objects.create(provider="github", delivery_id="new", event="push", status="processed")
    gl = make_integration(ws, "gitlab", token_expires_at=timezone.now() - dt.timedelta(days=1))
    out = io.StringIO()
    call_command("process_integrations", "--check-tokens", stdout=out)
    assert "1 deliveries" in out.getvalue() and "1 tokens expired" in out.getvalue()
    assert list(WebhookDelivery.objects.values_list("delivery_id", flat=True)) == ["new"]
    assert Integration.objects.get(pk=gl.pk).error_code == "token_expired"
    call_command("purge_integrations", stdout=out)
