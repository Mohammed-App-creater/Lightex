"""Twilio Programmable Messaging backend (docs/v2/38-telegram-sms-push.md §2.3, §6.8): one form POST, no SDK."""

from __future__ import annotations

import base64
import urllib.parse

from django.conf import settings

from .base import HttpResponse, SendResult, http_request, retry_after_header

PERMANENT = {
    "21610": "opted_out",
    "21211": "invalid_number",
    "21614": "invalid_number",
    "21408": "config_error",
    "20003": "config_error",
}


class TwilioSms:
    def send(self, to_e164: str, body: str, *, status_callback: str | None) -> SendResult:
        sid = settings.TWILIO_ACCOUNT_SID
        form = {"To": to_e164, "Body": body}
        if settings.TWILIO_MESSAGING_SERVICE_SID:
            form["MessagingServiceSid"] = settings.TWILIO_MESSAGING_SERVICE_SID
        else:
            form["From"] = settings.TWILIO_FROM_NUMBER
        if status_callback:
            form["StatusCallback"] = status_callback
        auth = base64.b64encode(f"{sid}:{settings.TWILIO_AUTH_TOKEN}".encode()).decode()
        res = http_request(
            "POST",
            f"{settings.TWILIO_API_BASE}/2010-04-01/Accounts/{sid}/Messages.json",
            headers={"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"},
            body=urllib.parse.urlencode(form).encode(),
        )
        return map_response(res)


def map_response(res: HttpResponse) -> SendResult:
    data = res.json() or {}
    if res.status in (200, 201):
        return SendResult(True, provider_id=str(data.get("sid", ""))[:64])
    if res.status == 0:
        return SendResult(False, reason="timeout", code="timeout")
    code = str(data.get("code") or res.status)
    if code in PERMANENT:
        return SendResult(False, permanent=True, reason=PERMANENT[code], code=code)
    if res.status == 429 or code == "20429":
        return SendResult(False, reason="rate_limited", code=code, retry_after=retry_after_header(res.headers))
    if res.status == 401:
        return SendResult(False, permanent=True, reason="config_error", code=code)
    if res.status >= 500:
        return SendResult(False, reason="provider_error", code=code)
    return SendResult(False, permanent=True, reason="provider_error", code=code)
