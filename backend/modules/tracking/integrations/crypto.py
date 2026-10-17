"""AES-256-GCM encryption at rest for integration credentials (docs/v2/37-integrations-github-gitlab.md §10.2).

Format `lx1.<kid>.<b64url(nonce)>.<b64url(ciphertext‖tag)>`. The associated data binds a ciphertext to its row and
column (`"<app_label>.<model>:<row id>:<field>"`), so a value copied elsewhere fails to decrypt. Keys come from
`INTEGRATIONS_ENCRYPTION_KEYS` (`kid:base64url(32 bytes)`, comma-separated; the first encrypts). Without keys, a dev
key (`kid=dev`) is derived from `DJANGO_SECRET_KEY` with HKDF-SHA256.
"""

from __future__ import annotations

import base64
import os
import secrets
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

PREFIX = "lx1"


class DecryptionError(Exception):
    """Tampered, foreign or undecryptable ciphertext."""


def b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def generate_key(kid: str | None = None) -> str:
    """A new `kid:base64url(32 bytes)` entry for INTEGRATIONS_ENCRYPTION_KEYS."""
    return f"{kid or 'k' + secrets.token_hex(3)}:{b64e(os.urandom(32))}"


def keys() -> list[tuple[str, bytes]]:
    raw = (settings.INTEGRATIONS_ENCRYPTION_KEYS or "").strip()
    if not raw:
        derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"lightex-integrations").derive(
            settings.SECRET_KEY.encode()
        )
        return [("dev", derived)]
    out = []
    for entry in raw.split(","):
        kid, _, value = entry.strip().partition(":")
        try:
            key = b64d(value) if value else b""
        except ValueError:
            key = b""
        if not kid or len(key) != 32 or "." in kid:
            raise ImproperlyConfigured("INTEGRATIONS_ENCRYPTION_KEYS entries are kid:base64url(32 bytes).")
        out.append((kid, key))
    return out


def encrypt(plain: str, aad: str) -> str:
    if plain == "":
        return ""
    kid, key = keys()[0]
    nonce = os.urandom(12)
    sealed = AESGCM(key).encrypt(nonce, plain.encode(), aad.encode())
    return f"{PREFIX}.{kid}.{b64e(nonce)}.{b64e(sealed)}"


def decrypt(token: str, aad: str) -> str:
    if token == "":
        return ""
    parts = token.split(".")
    if len(parts) != 4 or parts[0] != PREFIX:
        raise DecryptionError("bad format")
    by_kid = dict(keys())
    key = by_kid.get(parts[1])
    if key is None:
        raise DecryptionError("unknown key id")
    try:
        return AESGCM(key).decrypt(b64d(parts[2]), b64d(parts[3]), aad.encode()).decode()
    except (InvalidTag, ValueError) as exc:
        raise DecryptionError("authentication failed") from exc


def kid_of(token: str) -> str | None:
    parts = token.split(".")
    return parts[1] if len(parts) == 4 else None


def aad_for(instance: Any, field: str) -> str:
    meta = instance._meta
    return f"{meta.app_label}.{meta.model_name}:{instance.pk}:{field}"
