"""Providers (docs/v2/38-telegram-sms-push.md §9.1 "Providers"): real backends against a stub HTTP server."""

import base64
import importlib
import json
import time
import urllib.parse

import http_ece
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from django.core.exceptions import ImproperlyConfigured

from apps.channels.providers import PushTarget, base, get_sms
from apps.channels.providers.telegram import BotTelegram
from apps.channels.providers.twilio import TwilioSms
from apps.channels.providers.webpush import WebPush, b64d, b64e, encrypt, generate_vapid_keys, public_bytes

# RFC 8291 Appendix A.
RFC = {
    "plaintext": b"When I grow up, I want to be a watermelon",
    "as_private": "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    "ua_private": "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
    "ua_public": "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    "auth": "BTBZMqHH6r4Tts7J_aSIgg",
    "salt": "DGv6ra1nlYgDCS1FRnbzlw",
    "body": "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6"
    "PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
}


def _key(raw):
    return ec.derive_private_key(int.from_bytes(b64d(raw), "big"), ec.SECP256R1())


# ───────────────────────── Telegram ─────────────────────────


def test_telegram_send_message_body_and_mapping(stub, settings):
    settings.TELEGRAM_API_BASE = stub.url
    settings.TELEGRAM_BOT_TOKEN = "123:abc"
    bot = BotTelegram()
    stub.reply(200, {"ok": True, "result": {"message_id": 77}})
    result = bot.send_message(42, "<b>PRJ-1</b>", button=("Open PRJ-1", "https://app.lightex.dev/x"))
    assert (result.ok, result.provider_id) == (True, "77")
    req = stub.requests[0]
    assert req["path"] == "/bot123:abc/sendMessage"
    sent = json.loads(req["body"])
    assert sent["parse_mode"] == "HTML" and sent["link_preview_options"] == {"is_disabled": True}
    assert sent["reply_markup"]["inline_keyboard"][0][0] == {"text": "Open PRJ-1", "url": "https://app.lightex.dev/x"}
    bot.send_message(42, "x", button=None)
    assert "reply_markup" not in json.loads(stub.requests[1]["body"])
    cases = [
        (403, {"ok": False, "description": "Forbidden: bot was blocked by the user"}, ("blocked", True)),
        (400, {"ok": False, "description": "Bad Request: chat not found"}, ("blocked", True)),
        (429, {"ok": False, "parameters": {"retry_after": 7}}, ("rate_limited", False)),
        (401, {"ok": False}, ("config_error", True)),
        (502, {"ok": False}, ("provider_error", False)),
    ]
    for status, body, (reason, permanent) in cases:
        stub.reply(status, body)
        r = bot.send_message(42, "x", button=None)
        assert (r.ok, r.reason, r.permanent) == (False, reason, permanent), status
        if status == 429:
            assert r.retry_after == 7


def test_telegram_button_left_out_for_non_https_frontend(settings):
    from apps.channels import render

    ctx = {"task_key": "PRJ-1", "task_title": "T", "cta_url": "http://localhost:3000/platform/tasks/PRJ-1"}
    settings.FRONTEND_URL = "http://localhost:3000"
    text, button = render.telegram("assigned", ctx)
    assert button is None and text.endswith("http://localhost:3000/platform/tasks/PRJ-1")
    settings.FRONTEND_URL = "https://app.lightex.dev"
    ctx["cta_url"] = "https://app.lightex.dev/platform/tasks/PRJ-1"
    assert render.telegram("assigned", ctx)[1] == ("Open PRJ-1", ctx["cta_url"])


# ───────────────────────── Twilio ─────────────────────────


def test_twilio_form_auth_and_error_codes(stub, settings):
    settings.TWILIO_API_BASE = stub.url
    twilio = TwilioSms()
    stub.reply(201, {"sid": "SM123"})
    r = twilio.send("+14155550132", "hello", status_callback="https://api.lightex.dev/api/v1/webhooks/twilio/status")
    assert (r.ok, r.provider_id) == (True, "SM123")
    req = stub.requests[0]
    assert req["path"] == "/2010-04-01/Accounts/ACtest/Messages.json"
    assert req["headers"]["Authorization"] == "Basic " + base64.b64encode(b"ACtest:test-twilio-token").decode()
    form = dict(urllib.parse.parse_qsl(req["body"].decode()))
    assert form["MessagingServiceSid"] == "MGtest" and "From" not in form
    assert form["StatusCallback"].endswith("/webhooks/twilio/status")
    settings.TWILIO_MESSAGING_SERVICE_SID = ""
    settings.TWILIO_FROM_NUMBER = "+15005550006"
    stub.reply(201, {"sid": "SM124"})
    twilio.send("+14155550132", "hello", status_callback=None)
    form = dict(urllib.parse.parse_qsl(stub.requests[1]["body"].decode()))
    assert form["From"] == "+15005550006" and "MessagingServiceSid" not in form and "StatusCallback" not in form
    cases = [
        (400, {"code": 21610}, "opted_out", True),
        (400, {"code": 21211}, "invalid_number", True),
        (400, {"code": 21408}, "config_error", True),
        (401, {"code": 20003}, "config_error", True),
        (429, {"code": 20429}, "rate_limited", False),
        (500, {}, "provider_error", False),
    ]
    for status, body, reason, permanent in cases:
        stub.reply(status, body, headers={"Retry-After": "3"} if status == 429 else None)
        r = twilio.send("+14155550132", "x", status_callback=None)
        assert (r.reason, r.permanent, r.code) == (reason, permanent, str(body.get("code", status))), body
        if status == 429:
            assert r.retry_after == 3


# ───────────────────────── Web Push ─────────────────────────


def test_rfc8291_vector_and_round_trip():
    body = encrypt(RFC["plaintext"], RFC["ua_public"], RFC["auth"], server_key=_key(RFC["as_private"]),
                   salt=b64d(RFC["salt"]))  # fmt: skip
    assert b64e(body) == RFC["body"]
    plain = http_ece.decrypt(body, private_key=_key(RFC["ua_private"]), auth_secret=b64d(RFC["auth"]),
                             version="aes128gcm")  # fmt: skip
    assert plain == RFC["plaintext"]


def test_webpush_request_jwt_headers_and_mapping(stub, settings):
    public, private = generate_vapid_keys()
    settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY = public, private
    ua = ec.generate_private_key(ec.SECP256R1())
    auth = b"0123456789abcdef"
    target = PushTarget(f"{stub.url}/push/abc", b64e(public_bytes(ua)), b64e(auth))
    pusher = WebPush()
    stub.reply(201, b"", headers={"Location": "https://push.example/m/1"})
    r = pusher.send(target, b'{"v":1}', ttl=86400, urgency="high", topic="t" * 40)
    assert (r.ok, r.provider_id) == (True, "https://push.example/m/1")
    req = stub.requests[0]
    h = {k.lower(): v for k, v in req["headers"].items()}  # header names are case-insensitive
    assert (h["content-encoding"], h["ttl"], h["urgency"], len(h["topic"])) == ("aes128gcm", "86400", "high", 32)
    token = h["authorization"].split("t=")[1].split(",")[0]
    assert h["authorization"].endswith(f"k={public}")
    pub_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64d(public))
    claims = jwt.decode(token, pub_key, algorithms=["ES256"], audience=stub.url)
    assert claims["aud"] == stub.url and claims["sub"] == "mailto:ops@lightex.test"
    assert claims["exp"] - time.time() <= 24 * 3600
    assert http_ece.decrypt(req["body"], private_key=ua, auth_secret=auth, version="aes128gcm") == b'{"v":1}'
    for status, reason, permanent in [
        (404, "expired_subscription", True),
        (410, "expired_subscription", True),
        (413, "provider_error", True),
        (429, "rate_limited", False),
        (503, "provider_error", False),
    ]:
        stub.reply(status, b"", headers={"Retry-After": "9"} if status == 429 else None)
        r = pusher.send(target, b"x", ttl=60, urgency="normal", topic=None)
        assert (r.ok, r.reason, r.permanent) == (False, reason, permanent), status
    assert "topic" not in {k.lower() for k in stub.requests[-1]["headers"]}


# ───────────────────────── console / fake ─────────────────────────


def test_prod_settings_refuse_console_sms_and_missing_key(monkeypatch):
    import sys

    def load():
        sys.modules.pop("config.settings.prod", None)
        importlib.import_module("config.settings.prod")

    monkeypatch.setenv("DJANGO_ALLOWED_HOSTS", "api.lightex.dev")
    monkeypatch.setenv("SMS_BACKEND", "console")
    with pytest.raises(ImproperlyConfigured, match="console"):
        load()
    monkeypatch.setenv("SMS_BACKEND", "twilio")
    monkeypatch.delenv("CHANNELS_ENCRYPTION_KEY", raising=False)
    with pytest.raises(ImproperlyConfigured, match="CHANNELS_ENCRYPTION_KEY"):
        load()
    sys.modules.pop("config.settings.prod", None)


def test_console_logs_masked_and_fake_scripting(settings, caplog):
    from apps.channels.providers.console import ConsoleSms

    caplog.set_level("INFO", logger="lightex.channels.console")
    assert ConsoleSms().send("+14155550132", "Lightex code: 123456", status_callback=None).ok
    assert "+1•••••0132" in caplog.text and "123456" in caplog.text and "+14155550132" not in caplog.text
    fake = get_sms()
    fake.fail_next(reason="blocked", permanent=True)
    fake.fail_next(retry_after=5)
    first, second, third = (fake.send("+1", "x", status_callback=None) for _ in range(3))
    assert (first.reason, first.permanent) == ("blocked", True)
    assert (second.reason, second.retry_after) == ("rate_limited", 5)
    assert third.ok and len(fake.outbox) == 3
    settings.SMS_BACKEND = "disabled"
    assert not base.available("sms")
    with pytest.raises(RuntimeError):
        get_sms()
