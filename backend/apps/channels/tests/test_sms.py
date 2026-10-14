"""SMS: C6–C9, H2, H3 (docs/v2/38-telegram-sms-push.md §5.6–§5.9, §5.12, §7.1, §7.5)."""

import datetime as dt
import json
import re
import threading
from pathlib import Path

import pytest
from django.core.management import call_command
from django.db import connection
from django.utils import timezone

from apps.channels import crypto, phones
from apps.channels.models import ChannelDelivery, OtpSend, SmsConnection, SmsVerification
from apps.channels.webhooks import twilio_signature
from apps.common.testing import UserFactory, client_for

from .conftest import connect_sms

pytestmark = pytest.mark.django_db
VECTORS = json.loads((Path(__file__).parent / "data" / "phone_vectors.json").read_text(encoding="utf-8"))
BASE = "/api/v1/me/notification-channels/sms"


@pytest.fixture(autouse=True)
def _no_phone_in_logs(caplog):
    """§9.1: no E.164 number appears in any captured log line of the SMS suite."""
    caplog.set_level("DEBUG")
    yield
    assert not re.search(r"\+\d{8,15}", caplog.text), caplog.text


@pytest.mark.parametrize("case", VECTORS["format"], ids=lambda c: c["digits"] or "empty")
def test_format_vectors(case):
    assert phones.format_pattern(case["digits"], case["pattern"]) == case["out"]


@pytest.mark.parametrize("case", VECTORS["validate"], ids=lambda c: f"{c['country']}-{c['input']}")
def test_validate_vectors(case):
    result = phones.validate(case["country"], case["input"], case.get("allowed", ["US", "GB", "DE"]))
    assert result.ok is case["ok"]
    if case["ok"]:
        assert (result.e164, result.display) == (case["e164"], case["display"])
    else:
        assert (result.field, result.error) == (case["field"], case["error"])


def start(client, national="4155550132", country="US"):
    return client.post(BASE + "/verifications", {"country": country, "nationalNumber": national}, format="json")


def last_code(sms):
    return re.search(r"code: (\d{6})", sms.outbox[-1]["body"])[1]


def verify(client, vid, code):
    return client.post(f"{BASE}/verifications/{vid}/verify", {"code": code}, format="json")


def test_verify_flow_hash_encryption_and_errors(sam, sam_client, sms):
    res = start(sam_client)
    assert res.status_code == 201, res.content
    body = res.json()
    assert (body["phoneNumber"], body["display"], body["attemptsLeft"]) == ("+14155550132", "+1 (415) 555-0132", 3)
    code = last_code(sms)
    assert sms.outbox[-1]["body"].endswith(f"@app.lightex.dev #{code}")
    v = SmsVerification.objects.get()
    assert code not in v.code_hash and len(v.code_hash) == 64
    assert crypto.decrypt_phone(v.phone_enc) == "+14155550132" and "4155550132" not in v.phone_enc
    bad = verify(sam_client, v.pk, "12")
    assert (bad.status_code, bad.json()["details"]["fields"]) == (422, {"code": "Enter the 6-digit code"})
    wrong = "000000" if code != "000000" else "111111"
    res = verify(sam_client, v.pk, wrong)
    assert (res.status_code, res.json()["code"], res.json()["details"]) == (422, "invalid_code", {"attemptsLeft": 2})
    res = verify(sam_client, v.pk, code)
    assert res.status_code == 200
    conn = res.json()["connection"]
    assert (conn["phoneNumber"], conn["country"], conn["status"]) == ("+14155550132", "US", "active")
    assert SmsConnection.objects.get().last4 == "0132"
    assert verify(sam_client, v.pk, code).status_code == 410
    assert start(sam_client).json()["code"] == "already_connected"
    assert sam_client.delete(BASE).status_code == 204 and sam_client.delete(BASE).status_code == 204
    assert not SmsConnection.objects.exists()


def test_three_wrong_codes_kill_the_code_and_expiry(sam_client, sms):
    vid = start(sam_client).json()["id"]
    code = last_code(sms)
    wrong = "000000" if code != "000000" else "111111"
    codes = [verify(sam_client, vid, wrong).json()["code"] for _ in range(3)]
    assert codes == ["invalid_code", "invalid_code", "too_many_attempts"]
    res = verify(sam_client, vid, code)
    assert (res.json()["code"], res.json()["details"]) == ("too_many_attempts", {"attemptsLeft": 0})
    SmsVerification.objects.update(resend_at=timezone.now() - dt.timedelta(seconds=1))
    sam_client.post(f"{BASE}/verifications/{vid}/resend")
    SmsVerification.objects.update(expires_at=timezone.now() - dt.timedelta(seconds=1))
    res = verify(sam_client, vid, last_code(sms))
    assert (res.status_code, res.json()["code"]) == (410, "code_expired")


def test_resend_cooldown_resets_attempts_and_invalidates_old_code(sam_client, sms):
    vid = start(sam_client).json()["id"]
    old = last_code(sms)
    res = sam_client.post(f"{BASE}/verifications/{vid}/resend")
    assert (res.status_code, res.json()["details"]["reason"]) == (429, "resend_cooldown")
    assert res.json()["details"]["retryAt"] and res["Retry-After"]
    verify(sam_client, vid, "999999" if old != "999999" else "888888")
    SmsVerification.objects.update(resend_at=timezone.now() - dt.timedelta(seconds=1))
    res = sam_client.post(f"{BASE}/verifications/{vid}/resend")
    assert res.status_code == 200 and res.json()["attemptsLeft"] == 3
    new = last_code(sms)
    if new != old:
        assert verify(sam_client, vid, old).json()["code"] == "invalid_code"
    assert verify(sam_client, vid, new).status_code == 200
    assert sam_client.post(f"{BASE}/verifications/{vid}/resend").json()["code"] == "verification_closed"
    other = client_for(UserFactory())
    assert other.post(f"{BASE}/verifications/{vid}/resend").status_code == 404
    assert verify(other, vid, new).status_code == 404


def test_validation_unavailable_and_send_failure(sam_client, sms, settings):
    res = start(sam_client, "415555013")
    assert (res.status_code, res.json()["details"]["fields"]) == (422, {"nationalNumber": "Enter 10 digits"})
    assert start(sam_client, "9876543210", "IN").json()["details"]["fields"]["country"]
    sms.fail_next(reason="invalid_number", permanent=True)
    res = start(sam_client)
    assert (res.status_code, res.json()["details"]) == (502, {"channel": "sms", "reason": "invalid_number"})
    assert SmsVerification.objects.get().status == "canceled"
    settings.SMS_BACKEND = "disabled"
    assert start(sam_client).status_code == 503


def _otp_rows(user, phone, n, ago=dt.timedelta(minutes=1)):
    for _ in range(n):
        row = OtpSend.objects.create(user=user, phone_hash=crypto.phone_hash(phone))
        OtpSend.objects.filter(pk=row.pk).update(created_at=timezone.now() - ago)


def test_otp_limits_are_counted_in_the_database(sam, sam_client, settings):
    """CACHES is locmem; clearing the cache between calls simulates a second process."""
    from django.core.cache import cache

    _otp_rows(sam, "+14155550132", 5)
    cache.clear()
    assert start(sam_client).json()["details"]["reason"] == "hourly_limit"
    OtpSend.objects.all().delete()
    _otp_rows(sam, "+14155550199", 10, ago=dt.timedelta(hours=3))
    cache.clear()
    assert start(sam_client).json()["details"]["reason"] == "daily_limit"
    OtpSend.objects.all().delete()
    for _ in range(5):
        _otp_rows(UserFactory(), "+14155550132", 1)
    cache.clear()
    assert start(sam_client).json()["details"]["reason"] == "phone_limit"
    OtpSend.objects.all().delete()
    settings.SMS_OTP_GLOBAL_DAILY_CAP = 2
    _otp_rows(UserFactory(), "+14155550111", 2, ago=dt.timedelta(seconds=5))
    cache.clear()
    res = start(sam_client)
    assert (res.status_code, res.json()["code"], res.json()["details"]["reason"]) == (429, "throttled", "global_limit")


@pytest.mark.django_db(transaction=True)
def test_parallel_wrong_verifies_never_exceed_three_attempts(sms):
    from apps.channels import services

    user = UserFactory()
    data = services.start_verification(user, {"country": "US", "nationalNumber": "4155550132"})
    code = last_code(sms)
    wrong = "000000" if code != "000000" else "111111"
    outcomes = []

    def guess():
        try:
            services.verify(user, data["id"], wrong)
        except Exception as exc:
            outcomes.append(getattr(exc, "details", {}).get("attemptsLeft"))
        finally:
            connection.close()

    threads = [threading.Thread(target=guess) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(outcomes) == [0, 0, 0, 1, 2]
    assert SmsVerification.objects.get().attempts_left == 0


def test_rotation_reencrypts_and_rehashes(sam, settings):
    from cryptography.fernet import Fernet

    old_key = Fernet.generate_key().decode()
    settings.CHANNELS_ENCRYPTION_KEY = old_key
    conn = connect_sms(sam)
    old_hash = conn.phone_hash
    settings.CHANNELS_ENCRYPTION_KEY = f"{Fernet.generate_key().decode()},{old_key}"
    call_command("rotate_channels_key")
    conn.refresh_from_db()
    assert conn.phone_hash != old_hash and conn.phone_hash == crypto.phone_hash("+14155550132")
    settings.CHANNELS_ENCRYPTION_KEY = settings.CHANNELS_ENCRYPTION_KEY.split(",")[0]
    assert crypto.decrypt_phone(conn.phone_enc) == "+14155550132"


def twilio_post(api, path, params, signature=None):
    sig = signature if signature is not None else twilio_signature(path, params)
    from urllib.parse import urlencode

    form = urlencode(params)
    return api.post(path, form, content_type="application/x-www-form-urlencoded", HTTP_X_TWILIO_SIGNATURE=sig)


def test_inbound_stop_and_start(api, sam, owner):
    path = "/api/v1/webhooks/twilio/sms"
    a, b = connect_sms(sam), connect_sms(owner)
    pending = ChannelDelivery.objects.create(
        user=sam, channel="sms", event="assigned", template="assigned", sms=a, status="queued",
        next_attempt_at=timezone.now(),
    )  # fmt: skip
    assert twilio_post(api, path, {"From": "+14155550132", "Body": "STOP"}, signature="bad").status_code == 403
    res = twilio_post(api, path, {"From": "+14155550132", "Body": " stop "})
    assert res.status_code == 200 and res["Content-Type"].startswith("text/xml") and b"<Response/>" in res.content
    assert {SmsConnection.objects.get(pk=x.pk).status for x in (a, b)} == {"opted_out"}
    pending.refresh_from_db()
    assert (pending.status, pending.skip_reason) == ("skipped", "opted_out")
    twilio_post(api, path, {"From": "+14155550132", "OptOutType": "START", "Body": "start"})
    assert {SmsConnection.objects.get(pk=x.pk).status for x in (a, b)} == {"active"}
    twilio_post(api, path, {"From": "+14155550132", "OptOutType": "STOP", "Body": "please no"})
    assert SmsConnection.objects.get(pk=a.pk).status == "opted_out"
    twilio_post(api, path, {"From": "+14155550132", "Body": "HELP"})
    assert SmsConnection.objects.get(pk=a.pk).status == "opted_out"


def test_status_callbacks(api, sam):
    path = "/api/v1/webhooks/twilio/status"
    conn = connect_sms(sam)
    rows = [
        ChannelDelivery.objects.create(
            user=sam,
            channel="sms",
            event="assigned",
            template="assigned",
            sms=conn,
            status="sent",
            provider_id=f"SM{i}",
            next_attempt_at=timezone.now(),
        )  # fmt: skip
        for i in range(4)
    ]
    assert twilio_post(api, path, {"MessageSid": "SM0", "MessageStatus": "failed"}, signature="x").status_code == 403
    assert twilio_post(api, path, {"MessageSid": "SM0", "MessageStatus": "delivered"}).status_code == 204
    twilio_post(api, path, {"MessageSid": "SM3", "MessageStatus": "undelivered", "ErrorCode": "30007"})
    rows[3].refresh_from_db()
    assert rows[3].error_code == "30007" and rows[3].status == "sent"
    for sid in ("SM0", "SM1"):
        twilio_post(api, path, {"MessageSid": sid, "MessageStatus": "undelivered", "ErrorCode": "30003"})
    assert SmsConnection.objects.get().status == "active"  # one or two could be transient
    twilio_post(api, path, {"MessageSid": "SM2", "MessageStatus": "failed", "ErrorCode": "30005"})
    assert SmsConnection.objects.get().status == "invalid"
    twilio_post(api, path, {"MessageSid": "SM3", "MessageStatus": "failed", "ErrorCode": "21610"})
    assert SmsConnection.objects.get().status == "opted_out"
