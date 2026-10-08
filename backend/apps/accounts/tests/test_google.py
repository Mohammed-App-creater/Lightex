from urllib.parse import parse_qs, urlsplit

import pytest

from apps.accounts import google
from apps.accounts.models import User
from apps.common.testing import UserFactory

pytestmark = pytest.mark.django_db
START = "/api/v1/auth/google/start"
CALLBACK = "/api/v1/auth/google/callback"


@pytest.fixture(autouse=True)
def _configured(settings):
    settings.GOOGLE_CLIENT_ID = "client-id"
    settings.GOOGLE_CLIENT_SECRET = "client-secret"
    settings.FRONTEND_URL = "https://app.test"
    settings.API_PUBLIC_URL = "https://api.test"


def fake_google(monkeypatch, profile):
    calls = []

    def fetch(code):
        calls.append(code)
        return profile

    monkeypatch.setattr(google, "fetch_profile", fetch)
    return calls


def begin(api, next_path="/platform/inbox"):
    res = api.get(START, {"next": next_path})
    assert res.status_code == 302
    return parse_qs(urlsplit(res["Location"]).query)["state"][0]


def test_start_redirects_to_google_with_state_cookie(api):
    res = api.get(START, {"next": "/platform"})
    assert res.status_code == 302
    url = urlsplit(res["Location"])
    params = parse_qs(url.query)
    assert f"{url.scheme}://{url.netloc}{url.path}" == google.AUTH_URL
    assert params["redirect_uri"] == ["https://api.test/api/v1/auth/google/callback"]
    assert params["scope"] == ["openid email profile"]
    cookie = res.cookies[google.STATE_COOKIE]
    assert cookie["httponly"]
    assert cookie["path"] == google.STATE_COOKIE_PATH


def test_start_without_credentials_returns_to_login(api, settings):
    settings.GOOGLE_CLIENT_SECRET = ""
    res = api.get(START)
    assert res.status_code == 302
    assert res["Location"] == "https://app.test/login?error=google_unavailable"


def test_callback_creates_user_and_sets_refresh_cookie(api, monkeypatch):
    fake_google(monkeypatch, {"email": "New@Team.dev", "email_verified": True, "name": "New Person"})
    state = begin(api)
    res = api.get(CALLBACK, {"state": state, "code": "abc"})
    assert res.status_code == 302
    assert res["Location"] == "https://app.test/platform/inbox"
    assert res.cookies["lx_refresh"].value
    user = User.objects.get(email="new@team.dev")
    assert user.name == "New Person"
    assert not user.has_usable_password()
    # The client restores the session from the cookie.
    refreshed = api.post("/api/v1/auth/refresh")
    assert refreshed.status_code == 200
    assert refreshed.json()["accessToken"]


def test_callback_signs_in_existing_account_by_email(api, monkeypatch):
    existing = UserFactory(email="alex@team.dev")
    fake_google(monkeypatch, {"email": "ALEX@team.dev", "email_verified": True, "name": "Other Name"})
    res = api.get(CALLBACK, {"state": begin(api), "code": "abc"})
    assert res.status_code == 302
    assert User.objects.filter(email__iexact="alex@team.dev").count() == 1
    existing.refresh_from_db()
    assert existing.has_usable_password()
    assert existing.last_login is not None


@pytest.mark.parametrize(
    "profile",
    [{"email": "x@team.dev", "email_verified": False}, {"email": "x@team.dev"}, {"email_verified": True}],
)
def test_callback_rejects_unverified_email(api, monkeypatch, profile):
    fake_google(monkeypatch, profile)
    res = api.get(CALLBACK, {"state": begin(api, "/"), "code": "abc"})
    assert res["Location"] == "https://app.test/login?error=google"
    assert "lx_refresh" not in res.cookies
    assert not User.objects.filter(email="x@team.dev").exists()


def test_callback_rejects_inactive_account(api, monkeypatch):
    UserFactory(email="gone@team.dev", is_active=False)
    fake_google(monkeypatch, {"email": "gone@team.dev", "email_verified": True})
    res = api.get(CALLBACK, {"state": begin(api, "/"), "code": "abc"})
    assert res["Location"] == "https://app.test/login?error=google"
    assert "lx_refresh" not in res.cookies


def test_callback_rejects_wrong_or_missing_state(api, monkeypatch):
    calls = fake_google(monkeypatch, {"email": "x@team.dev", "email_verified": True})
    begin(api)
    assert api.get(CALLBACK, {"state": "forged", "code": "abc"})["Location"] == "https://app.test/login?error=google"
    api.cookies.clear()
    assert api.get(CALLBACK, {"state": "forged", "code": "abc"})["Location"] == "https://app.test/login?error=google"
    assert calls == []


def test_callback_when_person_cancels(api, monkeypatch):
    fake_google(monkeypatch, {})
    state = begin(api)
    res = api.get(CALLBACK, {"state": state, "error": "access_denied"})
    assert res["Location"] == "https://app.test/login?error=google_cancelled&next=%2Fplatform%2Finbox"


@pytest.mark.parametrize("bad", ["https://evil.test", "//evil.test", "/\\evil.test", "platform"])
def test_next_is_kept_on_this_site(api, monkeypatch, bad):
    fake_google(monkeypatch, {"email": "n@team.dev", "email_verified": True})
    res = api.get(CALLBACK, {"state": begin(api, bad), "code": "abc"})
    assert res["Location"] == "https://app.test/"
