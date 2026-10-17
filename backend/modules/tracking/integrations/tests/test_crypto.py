"""§10.2 encryption at rest: AES-256-GCM, row/column binding, key rotation, prod key requirement."""

import importlib
import io
import sys

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.core.management import call_command
from django.test import override_settings

from modules.tracking.integrations import crypto
from modules.tracking.integrations.models import Integration

from .conftest import make_integration

K1 = "k1:" + crypto.b64e(b"\x01" * 32)
K2 = "k2:" + crypto.b64e(b"\x02" * 32)


def test_round_trip_and_tamper_detection():
    token = crypto.encrypt("glpat-secret", "integrations.integration:1:credentials")
    assert token.startswith("lx1.dev.") and "glpat" not in token
    assert crypto.decrypt(token, "integrations.integration:1:credentials") == "glpat-secret"
    prefix, kid, nonce, sealed = token.split(".")
    flipped = sealed[:-2] + ("A" if sealed[-2] != "A" else "B") + sealed[-1]
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt(".".join([prefix, kid, nonce, flipped]), "integrations.integration:1:credentials")
    with pytest.raises(crypto.DecryptionError):  # copied into another row
        crypto.decrypt(token, "integrations.integration:2:credentials")
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt("garbage", "x")
    assert crypto.encrypt("", "x") == "" and crypto.decrypt("", "x") == ""


def test_old_kid_still_decrypts_after_rotation_and_bad_keys_are_refused():
    with override_settings(INTEGRATIONS_ENCRYPTION_KEYS=K1):
        old = crypto.encrypt("v", "a")
    with override_settings(INTEGRATIONS_ENCRYPTION_KEYS=f"{K2},{K1}"):
        assert crypto.decrypt(old, "a") == "v"
        assert crypto.kid_of(crypto.encrypt("v", "a")) == "k2"
    with override_settings(INTEGRATIONS_ENCRYPTION_KEYS=K2), pytest.raises(crypto.DecryptionError):
        crypto.decrypt(old, "a")
    with override_settings(INTEGRATIONS_ENCRYPTION_KEYS="bad:short"), pytest.raises(ImproperlyConfigured):
        crypto.keys()


@pytest.mark.django_db
def test_rows_are_bound_and_rotate_command_reencrypts(ws):
    with override_settings(INTEGRATIONS_ENCRYPTION_KEYS=K1):
        a = make_integration(ws, "gitlab")
        b = make_integration(ws, "gitlab", account_external_id="9002")
        Integration.objects.filter(pk=b.pk).update(credentials=a.credentials)  # copied between rows
        b.refresh_from_db()
        with pytest.raises(crypto.DecryptionError):
            b.get_credentials()
    with override_settings(INTEGRATIONS_ENCRYPTION_KEYS=f"{K2},{K1}"):
        call_command("rotate_integration_secrets", stdout=io.StringIO(), stderr=io.StringIO())
        a.refresh_from_db()
        assert crypto.kid_of(a.credentials) == crypto.kid_of(a.webhook_secret) == "k2"
        assert a.get_credentials() == {"token": "fake-token"}
    with override_settings(INTEGRATIONS_ENCRYPTION_KEYS=K2):
        assert a.get_secret("webhook_secret") == "gl-secret"


def test_generate_key_command():
    out = io.StringIO()
    call_command("generate_integration_key", "--kid", "k9", stdout=out)
    kid, _, value = out.getvalue().strip().partition(":")
    assert kid == "k9" and len(crypto.b64d(value)) == 32


def test_prod_settings_refuse_a_provider_without_keys(monkeypatch):
    monkeypatch.setenv("DJANGO_ALLOWED_HOSTS", "api.example.com")
    monkeypatch.setenv("GITHUB_APP_ID", "12345")
    monkeypatch.delenv("INTEGRATIONS_ENCRYPTION_KEYS", raising=False)
    sys.modules.pop("config.settings.prod", None)
    with pytest.raises(ImproperlyConfigured):
        importlib.import_module("config.settings.prod")
    monkeypatch.setenv("INTEGRATIONS_ENCRYPTION_KEYS", K1)
    sys.modules.pop("config.settings.prod", None)
    assert importlib.import_module("config.settings.prod").DEBUG is False
    sys.modules.pop("config.settings.prod", None)
