import importlib
import os

import pytest

pytestmark = pytest.mark.django_db


def test_cors_allows_the_client_with_credentials(client):
    res = client.options(
        "/api/v1/auth/refresh",
        HTTP_ORIGIN="http://localhost:3000",
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
    )
    assert res["Access-Control-Allow-Origin"] == "http://localhost:3000"
    assert res["Access-Control-Allow-Credentials"] == "true"


def test_cors_ignores_other_origins(client):
    res = client.options(
        "/api/v1/auth/refresh",
        HTTP_ORIGIN="https://evil.example",
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
    )
    assert "Access-Control-Allow-Origin" not in res


def test_request_id_header_is_exposed(client):
    res = client.get("/health", HTTP_ORIGIN="http://localhost:3000")
    assert "X-Request-ID" in res["Access-Control-Expose-Headers"]


def test_errors_never_leak_html(client):
    res = client.get("/api/v1/projects/not-a-uuid")
    assert res.status_code == 404
    assert res["Content-Type"].startswith("application/json")


def test_prod_settings_are_strict(monkeypatch):
    monkeypatch.setenv("DJANGO_SECRET_KEY", "x" * 50)
    monkeypatch.setenv("DJANGO_ALLOWED_HOSTS", "api.example.com")
    prod = importlib.import_module("config.settings.prod")
    importlib.reload(prod)
    assert prod.DEBUG is False
    assert prod.SECURE_SSL_REDIRECT is True
    assert prod.REFRESH_COOKIE_SECURE is True
    assert prod.SESSION_COOKIE_SECURE and prod.CSRF_COOKIE_SECURE
    assert prod.ADMIN_ENABLED is False
    assert prod.ALLOWED_HOSTS == ["api.example.com"]
    assert os.environ["DJANGO_ALLOWED_HOSTS"] == "api.example.com"
