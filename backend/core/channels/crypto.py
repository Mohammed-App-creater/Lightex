"""Phone numbers at rest and code hashing (docs/v2/38-telegram-sms-push.md §7.1, §7.2).

- `phone_enc` = MultiFernet(CHANNELS_ENCRYPTION_KEY…).encrypt(E.164). Keys are comma-separated, newest first. Without
  a key (dev, tests) one is derived from DJANGO_SECRET_KEY; prod refuses that with SMS_BACKEND=twilio.
- `phone_hash` = HMAC-SHA256(HKDF(primary key, "lightex.phone"), E.164): lookups for STOP, status callbacks and the
  per-phone OTP limit, without decrypting.
- OTPs and Telegram link codes: HMAC-SHA256 with keys derived from SECRET_KEY.
"""

from __future__ import annotations

import base64
import hashlib
import hmac

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings


def _hkdf(material: bytes, info: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info.encode()).derive(material)


def fernet_keys() -> list[bytes]:
    raw = (settings.CHANNELS_ENCRYPTION_KEY or "").strip()
    if raw:
        return [k.strip().encode() for k in raw.split(",") if k.strip()]
    return [base64.urlsafe_b64encode(_hkdf(settings.SECRET_KEY.encode(), "lightex.channels.dev"))]


def generate_key() -> str:
    return Fernet.generate_key().decode()


def _fernet() -> MultiFernet:
    return MultiFernet([Fernet(k) for k in fernet_keys()])


def encrypt_phone(e164: str) -> str:
    return _fernet().encrypt(e164.encode()).decode()


def decrypt_phone(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        return ""


def rotate_phone(token: str) -> str:
    return _fernet().rotate(token.encode()).decode()


def phone_hash(e164: str) -> str:
    key = _hkdf(base64.urlsafe_b64decode(fernet_keys()[0]), "lightex.phone")
    return hmac.new(key, e164.encode(), hashlib.sha256).hexdigest()


def secret_hash(purpose: str, value: str) -> str:
    """HMAC-SHA256(HKDF(SECRET_KEY, purpose), value): `lightex.otp` and `lightex.tglink`."""
    key = _hkdf(settings.SECRET_KEY.encode(), purpose)
    return hmac.new(key, value.encode(), hashlib.sha256).hexdigest()


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def mask(e164: str) -> str:
    """`+1•••••0132` for logs and errors."""
    if len(e164) < 6:
        return "•••"
    return f"{e164[:2]}•••••{e164[-4:]}"
