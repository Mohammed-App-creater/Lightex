"""Web Push with VAPID (docs/v2/38-telegram-sms-push.md §2.4): RFC 8291 encryption through `http-ece`, an ES256 VAPID
JWT (RFC 8292) through PyJWT, and a standard-library POST. No `pywebpush`."""

from __future__ import annotations

import base64
import os
import threading
import time
import urllib.parse

import http_ece
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.conf import settings

from .base import HttpResponse, PushTarget, SendResult, http_request, retry_after_header


def b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def private_key_from(raw_b64: str) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(int.from_bytes(b64d(raw_b64), "big"), ec.SECP256R1())


def public_bytes(key: ec.EllipticCurvePrivateKey | ec.EllipticCurvePublicKey) -> bytes:
    pub = key.public_key() if isinstance(key, ec.EllipticCurvePrivateKey) else key
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def generate_vapid_keys() -> tuple[str, str]:
    """(public: base64url 65-byte point, private: base64url 32-byte scalar)."""
    key = ec.generate_private_key(ec.SECP256R1())
    scalar = key.private_numbers().private_value.to_bytes(32, "big")
    return b64e(public_bytes(key)), b64e(scalar)


def encrypt(
    payload: bytes,
    p256dh: str,
    auth: str,
    *,
    server_key: ec.EllipticCurvePrivateKey | None = None,
    salt: bytes | None = None,
) -> bytes:
    """RFC 8291 `aes128gcm` body. `server_key`/`salt` are only fixed by the RFC vector test."""
    return http_ece.encrypt(
        payload,
        salt=salt or os.urandom(16),
        private_key=server_key or ec.generate_private_key(ec.SECP256R1()),
        dh=b64d(p256dh),
        auth_secret=b64d(auth),
        version="aes128gcm",
    )


def origin(endpoint: str) -> str:
    parts = urllib.parse.urlsplit(endpoint)
    return f"{parts.scheme}://{parts.netloc}"


class WebPush:
    def __init__(self) -> None:
        self._tokens: dict[str, tuple[str, float]] = {}
        self._lock = threading.Lock()

    def vapid_token(self, aud: str) -> str:
        """Cached per audience for an hour; each token is valid for 12 h."""
        now = time.time()
        with self._lock:
            cached = self._tokens.get(aud)
            if cached and cached[1] > now:
                return cached[0]
            claims = {"aud": aud, "exp": int(now) + 12 * 3600, "sub": settings.VAPID_SUBJECT}
            token = jwt.encode(claims, private_key_from(settings.VAPID_PRIVATE_KEY), algorithm="ES256")
            self._tokens[aud] = (token, now + 3600)
            return token

    def send(self, sub: PushTarget, payload: bytes, *, ttl: int, urgency: str, topic: str | None) -> SendResult:
        body = encrypt(payload, sub.p256dh, sub.auth)
        headers = {
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(ttl),
            "Urgency": urgency,
            "Authorization": f"vapid t={self.vapid_token(origin(sub.endpoint))}, k={settings.VAPID_PUBLIC_KEY}",
        }
        if topic:
            headers["Topic"] = topic[:32]
        return map_response(http_request("POST", sub.endpoint, headers=headers, body=body))


def map_response(res: HttpResponse) -> SendResult:
    code = str(res.status)
    if res.status in (200, 201, 202):
        return SendResult(True, provider_id=res.headers.get("location", "")[:64])
    if res.status == 0:
        return SendResult(False, reason="timeout", code="timeout")
    if res.status in (400, 403, 404, 410):
        return SendResult(False, permanent=True, reason="expired_subscription", code=code)
    if res.status == 401:
        return SendResult(False, permanent=True, reason="config_error", code=code)
    if res.status == 413:
        return SendResult(False, permanent=True, reason="provider_error", code=code)
    if res.status == 429:
        return SendResult(False, reason="rate_limited", code=code, retry_after=retry_after_header(res.headers))
    if res.status >= 500:
        return SendResult(False, reason="provider_error", code=code)
    return SendResult(False, permanent=True, reason="provider_error", code=code)
