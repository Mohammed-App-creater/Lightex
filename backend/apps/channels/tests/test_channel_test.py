"""C14 test sends (docs/v2/38-telegram-sms-push.md §5.11) and the setup commands (§2.2, §2.4, §7.1)."""

import io

import pytest
from django.core import mail
from django.core.management import call_command
from django.utils import timezone

from apps.channels.models import ChannelDelivery, PushSubscription, TelegramConnection, TelegramLinkRequest
from apps.notifications.handlers import preferences_for

from .conftest import connect_push, connect_sms, connect_telegram

pytestmark = pytest.mark.django_db


def route(channel):
    return f"/api/v1/me/notification-channels/{channel}/test"


def send(client, channel, data=None, query=""):
    return client.post(route(channel) + query, data or {}, format="json")


def test_sends_synchronously_ignoring_quiet_hours(sam, sam_client, tg, push, ws):
    prefs = preferences_for(sam)
    prefs.timezone, prefs.quiet_from, prefs.quiet_to = "UTC", timezone.now().time().replace(hour=0), \
        timezone.now().time().replace(hour=23, minute=59)  # fmt: skip
    prefs.save()
    connect_telegram(sam)
    res = send(sam_client, "telegram", query=f"?workspace={ws.slug}")
    assert res.status_code == 200, res.content
    body = res.json()
    assert (body["channel"], body["status"]) == ("telegram", "sent") and body["sentAt"]
    assert ChannelDelivery.objects.get(pk=body["deliveryId"]).kind == "test"
    assert tg.outbox[-1]["text"] == "<b>Test notification</b>\nLightex notifications will arrive in this chat."
    connect_push(sam, 1)
    connect_push(sam, 2)
    assert send(sam_client, "push").status_code == 200 and len(push.outbox) == 2
    assert push.outbox[0]["ttl"] == 3600
    assert send(sam_client, "email").status_code == 200
    assert mail.outbox[-1].subject == "Lightex test notification" and mail.outbox[-1].to == [sam.email]


def test_not_connected_failures_and_unknown_channel(sam, sam_client, tg, sms, push, settings):
    for channel in ("telegram", "sms", "push"):
        res = send(sam_client, channel)
        assert (res.status_code, res.json()["code"], res.json()["details"]) == (
            409, "channel_not_connected", {"channel": channel},
        )  # fmt: skip
    assert send(sam_client, "in_app").status_code == 404
    connect_telegram(sam, status="blocked")
    assert send(sam_client, "telegram").json()["details"] == {"channel": "telegram", "reason": "blocked"}
    conn = connect_sms(sam, status="opted_out")
    assert send(sam_client, "sms").json()["details"] == {"channel": "sms", "reason": "opted_out"}
    conn.status = "active"
    conn.save()
    sms.fail_next(reason="invalid_number", permanent=True)
    res = send(sam_client, "sms")
    assert (res.status_code, res.json()["details"]["reason"]) == (502, "invalid_number")
    sub = connect_push(sam)
    push.fail_next(reason="expired_subscription", permanent=True)
    assert send(sam_client, "push", {"deviceId": str(sub.pk)}).json()["details"]["reason"] == "expired_subscription"
    assert PushSubscription.objects.get().status == "expired"
    assert send(sam_client, "push").json()["details"]["reason"] == "expired_subscription"
    TelegramConnection.objects.update(status="active")
    tg.fail_next(reason="provider_error")  # transient: a test is one attempt, no retry
    assert send(sam_client, "telegram").status_code == 502
    assert not ChannelDelivery.objects.filter(status="retry").exists()
    settings.WEB_PUSH_BACKEND = "disabled"
    assert send(sam_client, "push").status_code == 503


def test_sms_tests_count_toward_the_daily_cap_and_throttle(sam, sam_client, settings):
    settings.SMS_USER_DAILY_CAP = 2
    connect_sms(sam)
    assert [send(sam_client, "sms").status_code for _ in range(2)] == [200, 200]
    res = send(sam_client, "sms")
    assert (res.status_code, res.json()["code"], res.json()["details"]["reason"]) == (429, "throttled", "daily_cap")
    assert sam_client.get("/api/v1/me/notification-channels").json()["sms"]["sentToday"] == 2
    settings.REST_FRAMEWORK = {
        **settings.REST_FRAMEWORK,
        "DEFAULT_THROTTLE_RATES": {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "channel_test": "1/hour"},
    }
    from rest_framework.throttling import SimpleRateThrottle

    SimpleRateThrottle.THROTTLE_RATES = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
    try:
        send(sam_client, "email")
        res = send(sam_client, "email")
        assert (res.status_code, res.json()["details"]["reason"]) == (429, "test_limit")
        assert res["Retry-After"]
    finally:
        from rest_framework.settings import api_settings

        SimpleRateThrottle.THROTTLE_RATES = api_settings.DEFAULT_THROTTLE_RATES


def test_overview_shape(sam, sam_client):
    connect_sms(sam)
    body = sam_client.get("/api/v1/me/notification-channels").json()
    assert body["email"] == {"address": sam.email}
    assert body["telegram"] == {"available": True, "botUsername": "lightex_bot", "connection": None}
    assert [c["code"] for c in body["sms"]["countries"]] == ["US", "GB", "DE"]
    assert body["sms"]["connection"]["display"] == "+1 (415) 555-0132"
    assert body["push"]["vapidPublicKey"] and body["push"]["devices"] == []


def test_setup_commands(settings, tg):
    out = io.StringIO()
    call_command("generate_vapid_keys", stdout=out)
    assert "VAPID_PUBLIC_KEY=B" in out.getvalue() and "VAPID_PRIVATE_KEY=" in out.getvalue()
    call_command("generate_channels_key", stdout=out)
    assert "CHANNELS_ENCRYPTION_KEY=" in out.getvalue()
    call_command("telegram_setup")
    assert tg.webhook == {"url": "https://api.lightex.dev/api/v1/webhooks/telegram", "secret": "test-telegram-secret"}
    call_command("telegram_setup", "--info", stdout=out)
    call_command("telegram_setup", "--delete")
    assert tg.webhook is None


def test_telegram_fake_start_links_the_dev_chat(sam, sam_client):
    link = sam_client.post("/api/v1/me/notification-channels/telegram/link", {}, format="json").json()
    out = io.StringIO()
    call_command("telegram_fake_start", link["code"], stdout=out)
    assert out.getvalue().startswith("Connected to Lightex.")
    assert TelegramLinkRequest.objects.get().status == "linked"
    assert TelegramConnection.objects.get(user=sam).chat_id == 999000
