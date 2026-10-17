"""Webhook receivers W1/W2 (docs/v2/37-integrations-github-gitlab.md §5.5, §7.1, §10.1).

Verify, store one row, answer: no provider API call and no task write inside the request. Processing is dispatched
after commit (runner). Failures are logged with the delivery id and source IP only, never the body.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from . import runner
from .models import Integration, Repository, WebhookDelivery
from .providers.base import get_provider
from .providers.gitlab import EVENTS as GITLAB_EVENTS

logger = logging.getLogger("lightex.integrations.webhooks")

Reply = tuple[int, dict[str, Any]]
RECEIVED: Reply = (202, {"received": True})


def _error(status: int, code: str, message: str) -> Reply:
    return status, {"code": code, "message": message, "details": {}}


def _read_body(request: Any) -> bytes | Reply:
    """Exactly Content-Length bytes from the raw stream (not `request.body`, so the upload cap doesn't interfere)."""
    raw = request.META.get("CONTENT_LENGTH") or ""
    if not raw.isdigit() or int(raw) > settings.WEBHOOK_MAX_BODY_BYTES:
        return _error(413, "payload_too_large", "Payload too large.")
    return request.read(int(raw))


def _ip(request: Any) -> str:
    return request.META.get("REMOTE_ADDR", "")


def _store(provider: str, meta: Any, integration: Integration | None, payload: Any, status: str) -> Reply:
    try:
        with transaction.atomic():
            WebhookDelivery.objects.create(
                provider=provider,
                delivery_id=meta.delivery_id,
                integration=integration,
                event=meta.event,
                action=meta.action,
                payload=payload,
                status=status,
                processed_at=timezone.now() if status == "ignored" else None,
            )
    except IntegrityError:
        return 200, {"received": True, "duplicate": True}
    if integration is not None:
        Integration.objects.filter(pk=integration.pk).update(last_delivery_at=timezone.now())
    if status == "received":
        runner.dispatch_on_commit()
    return RECEIVED


def receive_github(request: Any) -> Reply:
    if not settings.INTEGRATIONS_ENABLED:
        return _error(503, "integrations_unavailable", "Integrations aren’t available on this server.")
    body = _read_body(request)
    if isinstance(body, tuple):
        return body
    provider = get_provider("github")
    if not provider.verify(request, body, None):
        logger.warning(
            "github webhook signature failed delivery=%s ip=%s", request.headers.get("X-GitHub-Delivery"), _ip(request)
        )
        return _error(401, "invalid_signature", "Invalid signature.")
    if request.headers.get("X-GitHub-Event") == "ping":
        return 200, {"received": True}
    try:
        payload = json.loads(body)
    except ValueError:
        return _error(400, "bad_request", "The request body could not be parsed.")
    meta = provider.delivery_meta(request, body, payload)
    if not meta.delivery_id:
        return _error(400, "bad_request", "Missing X-GitHub-Delivery.")
    target = request.headers.get("X-GitHub-Hook-Installation-Target-ID")
    integration = (
        Integration.objects.filter(
            provider="github", account_external_id=meta.account_id, status__in=("active", "error")
        )
        .order_by("created_at")
        .first()
        if meta.account_id
        else None
    )
    foreign_app = bool(settings.GITHUB_APP_ID and target and target != str(settings.GITHUB_APP_ID))
    status = "ignored" if integration is None or foreign_app else "received"
    return _store("github", meta, integration, payload, status)


def receive_gitlab(request: Any, integration_id: Any) -> Reply:
    if not settings.INTEGRATIONS_ENABLED:
        return _error(503, "integrations_unavailable", "Integrations aren’t available on this server.")
    integration = Integration.objects.filter(
        pk=integration_id, provider="gitlab", status__in=("active", "error")
    ).first()
    if integration is None:
        return _error(404, "not_found", "Not found.")
    body = _read_body(request)
    if isinstance(body, tuple):
        return body
    provider = get_provider("gitlab")
    if not provider.verify(request, body, integration):
        logger.warning("gitlab webhook token failed integration=%s ip=%s", integration_id, _ip(request))
        return _error(401, "invalid_signature", "Invalid signature.")
    try:
        payload = json.loads(body)
    except ValueError:
        return _error(400, "bad_request", "The request body could not be parsed.")
    meta = provider.delivery_meta(request, body, payload)
    tracked = Repository.objects.filter(integration=integration, external_id=meta.account_id).exists()
    status = "received" if meta.event in GITLAB_EVENTS and tracked else "ignored"
    return _store("gitlab", meta, integration, payload, status)
