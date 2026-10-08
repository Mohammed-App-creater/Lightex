import re

import pytest
from django.core import mail
from freezegun import freeze_time

from apps.accounts.models import PasswordResetToken, User
from apps.common.testing import PASSWORD, UserFactory, client_for

pytestmark = pytest.mark.django_db
ORIGIN = "http://localhost:3000"


def login(api, email, password=PASSWORD):
    return api.post("/api/v1/auth/login", {"email": email, "password": password}, format="json")


def test_register_returns_session_and_sets_cookie(api):
    res = api.post(
        "/api/v1/auth/register", {"name": "Jo Doe", "email": "Jo@Team.dev", "password": PASSWORD}, format="json"
    )
    assert res.status_code == 201
    body = res.json()
    assert body["accessToken"]
    assert body["user"]["email"] == "jo@team.dev"
    assert set(body["user"]) == {"id", "name", "email", "hue", "avatarUrl", "createdAt", "hasPassword"}
    assert body["user"]["hasPassword"] is True
    cookie = res.cookies["lx_refresh"]
    assert cookie["httponly"]
    assert cookie["secure"]
    assert cookie["path"] == "/api/v1/auth/"
    assert cookie["samesite"] == "Lax"


def test_register_validation(api):
    res = api.post("/api/v1/auth/register", {"name": "J", "email": "nope", "password": "short"}, format="json")
    assert res.status_code == 422
    assert set(res.json()["details"]["fields"]) == {"name", "email", "password"}


def test_register_rejects_weak_and_common_passwords(api):
    for pw in ["alllowercase", "12345678", "password1"]:
        res = api.post("/api/v1/auth/register", {"name": "Jo", "email": "a@b.dev", "password": pw}, format="json")
        assert res.status_code == 422, pw
        assert "password" in res.json()["details"]["fields"]


def test_register_existing_email_is_vague(api):
    UserFactory(email="taken@team.dev")
    res = api.post(
        "/api/v1/auth/register", {"name": "Jo", "email": "TAKEN@team.dev", "password": PASSWORD}, format="json"
    )
    assert res.status_code == 422
    assert "already exists" not in res.json()["details"]["fields"]["email"]


def test_login_success_and_failure_are_indistinguishable(api):
    user = UserFactory(email="sam@team.dev")
    assert login(api, "SAM@team.dev").status_code == 200
    wrong = login(api, "sam@team.dev", "Wrong!pass1")
    missing = login(api, "ghost@team.dev")
    assert wrong.status_code == missing.status_code == 401
    assert wrong.json() == missing.json()
    user.is_active = False
    user.save()
    assert login(api, "sam@team.dev").status_code == 401


def test_me_requires_bearer(api):
    assert api.get("/api/v1/auth/me").status_code == 401
    user = UserFactory()
    res = client_for(user).get("/api/v1/auth/me")
    assert res.status_code == 200
    assert res.json()["id"] == str(user.id)
    bad = api.get("/api/v1/auth/me", HTTP_AUTHORIZATION="Bearer nonsense")
    assert bad.status_code == 401
    assert bad.json()["code"] == "unauthorized"


def test_refresh_flow_and_logout_revokes(api):
    UserFactory(email="r@team.dev")
    assert login(api, "r@team.dev").status_code == 200
    res = api.post("/api/v1/auth/refresh", HTTP_ORIGIN=ORIGIN)
    assert res.status_code == 200
    token = res.json()["accessToken"]
    assert api.get("/api/v1/auth/me", HTTP_AUTHORIZATION=f"Bearer {token}").status_code == 200
    old_cookie = api.cookies["lx_refresh"].value
    out = api.post("/api/v1/auth/logout", HTTP_ORIGIN=ORIGIN)
    assert out.status_code == 204
    api.cookies["lx_refresh"] = old_cookie  # replaying the old cookie fails: it was blacklisted
    assert api.post("/api/v1/auth/refresh").status_code == 401


def test_refresh_without_cookie_or_garbage(api):
    assert api.post("/api/v1/auth/refresh").status_code == 401
    api.cookies["lx_refresh"] = "garbage"
    assert api.post("/api/v1/auth/refresh").status_code == 401


def test_refresh_rejects_foreign_origin(api):
    UserFactory(email="o@team.dev")
    login(api, "o@team.dev")
    res = api.post("/api/v1/auth/refresh", HTTP_ORIGIN="https://evil.example")
    assert res.status_code == 403
    assert res.json()["code"] == "csrf_failed"
    assert api.post("/api/v1/auth/logout", HTTP_ORIGIN="https://evil.example").status_code == 403


def test_refresh_for_deactivated_user_fails(api):
    user = UserFactory(email="d@team.dev")
    login(api, "d@team.dev")
    user.is_active = False
    user.save()
    assert api.post("/api/v1/auth/refresh").status_code == 401


def _reset_token_from_mail() -> str:
    assert mail.outbox, "no email sent"
    match = re.search(r"reset-password\?token=([A-Za-z0-9_\-]+)", mail.outbox[-1].body)
    assert match
    return match.group(1)


def test_forgot_password_never_enumerates(api):
    UserFactory(email="known@team.dev")
    a = api.post("/api/v1/auth/forgot-password", {"email": "known@team.dev"}, format="json")
    b = api.post("/api/v1/auth/forgot-password", {"email": "ghost@team.dev"}, format="json")
    assert a.status_code == b.status_code == 204
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == ["known@team.dev"]
    assert "Reset" in mail.outbox[0].subject or "reset" in mail.outbox[0].subject.lower()
    # Only the hash is stored.
    token = _reset_token_from_mail()
    assert not PasswordResetToken.objects.filter(token_hash=token).exists()


def test_reset_password_flow_revokes_sessions(api):
    UserFactory(email="k@team.dev")
    login(api, "k@team.dev")
    old_cookie = api.cookies["lx_refresh"].value
    api.post("/api/v1/auth/forgot-password", {"email": "k@team.dev"}, format="json")
    token = _reset_token_from_mail()
    weak = api.post("/api/v1/auth/reset-password", {"token": token, "password": "weak"}, format="json")
    assert weak.status_code == 422
    ok = api.post("/api/v1/auth/reset-password", {"token": token, "password": "N3w!password"}, format="json")
    assert ok.status_code == 204
    again = api.post("/api/v1/auth/reset-password", {"token": token, "password": "N3w!password2"}, format="json")
    assert again.status_code == 400
    assert again.json()["code"] == "invalid_token"
    assert login(api, "k@team.dev", "N3w!password").status_code == 200
    fresh = api.cookies["lx_refresh"].value
    api.cookies["lx_refresh"] = old_cookie
    assert api.post("/api/v1/auth/refresh").status_code == 401
    api.cookies["lx_refresh"] = fresh
    assert api.post("/api/v1/auth/refresh").status_code == 200


def test_reset_token_expires(api):
    UserFactory(email="e@team.dev")
    with freeze_time("2026-10-07 10:00:00"):
        api.post("/api/v1/auth/forgot-password", {"email": "e@team.dev"}, format="json")
    token = _reset_token_from_mail()
    with freeze_time("2026-10-07 11:30:00"):
        res = api.post("/api/v1/auth/reset-password", {"token": token, "password": "N3w!password"}, format="json")
    assert res.status_code == 400
    assert (
        api.post(
            "/api/v1/auth/reset-password", {"token": "nope", "password": "N3w!password"}, format="json"
        ).status_code
        == 400
    )


def test_change_password(api):
    user = UserFactory(email="c@team.dev")
    client = client_for(user)
    bad = client.put(
        "/api/v1/auth/me/password", {"currentPassword": "nope", "newPassword": "N3w!password"}, format="json"
    )
    assert bad.status_code == 422
    assert "currentPassword" in bad.json()["details"]["fields"]
    weak = client.put("/api/v1/auth/me/password", {"currentPassword": PASSWORD, "newPassword": "abc"}, format="json")
    assert "newPassword" in weak.json()["details"]["fields"]
    ok = client.put(
        "/api/v1/auth/me/password", {"currentPassword": PASSWORD, "newPassword": "N3w!password"}, format="json"
    )
    assert ok.status_code == 204
    assert "lx_refresh" in ok.cookies
    user.refresh_from_db()
    assert user.check_password("N3w!password")


def test_google_account_without_password_can_set_one(api):
    user = UserFactory(email="g@team.dev")
    user.set_unusable_password()
    user.save()
    client = client_for(user)
    assert client.get("/api/v1/auth/me").json()["hasPassword"] is False
    ok = client.put("/api/v1/auth/me/password", {"newPassword": "N3w!password"}, format="json")
    assert ok.status_code == 204
    user.refresh_from_db()
    assert user.check_password("N3w!password")
    assert client.get("/api/v1/auth/me").json()["hasPassword"] is True
    # Once set, changing it needs the current password again.
    again = client.put("/api/v1/auth/me/password", {"newPassword": "An0ther!pass"}, format="json")
    assert again.status_code == 422


def test_update_profile_and_avatar_rules(api):
    user = UserFactory()
    client = client_for(user)
    assert client.patch("/api/v1/auth/me", {"name": "A"}, format="json").status_code == 422
    res = client.patch("/api/v1/auth/me", {"name": "  New Name  "}, format="json")
    assert res.json()["name"] == "New Name"
    png = (
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhf"
        "DwAChwGA60e6kgAAAABJRU5ErkJggg=="
    )
    assert client.patch("/api/v1/auth/me", {"avatarUrl": png}, format="json").json()["avatarUrl"] == png
    fake = "data:image/png;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+"  # <svg onload=...> labelled as png
    assert client.patch("/api/v1/auth/me", {"avatarUrl": fake}, format="json").status_code == 422
    assert client.patch("/api/v1/auth/me", {"avatarUrl": "javascript:alert(1)"}, format="json").status_code == 422
    assert (
        client.patch("/api/v1/auth/me", {"avatarUrl": "data:image/svg+xml;base64,AAAA"}, format="json").status_code
        == 422
    )
    assert client.patch("/api/v1/auth/me", {"avatarUrl": 5}, format="json").status_code == 422
    assert client.patch("/api/v1/auth/me", {"avatarUrl": "https://cdn.example/a.png"}, format="json").status_code == 200
    assert client.patch("/api/v1/auth/me", {"avatarUrl": None}, format="json").json()["avatarUrl"] is None


def test_user_manager():
    su = User.objects.create_superuser("Root@Team.dev", PASSWORD)
    assert su.is_staff and su.is_superuser and su.email == "root@team.dev"
    assert str(su) == "root@team.dev"
    with pytest.raises(ValueError):
        User.objects.create_user("", PASSWORD)


def test_login_is_throttled(api, monkeypatch):
    from apps.common.throttles import AuthThrottle, LoginEmailThrottle

    for cls in (AuthThrottle, LoginEmailThrottle):
        monkeypatch.setattr(cls, "THROTTLE_RATES", {"auth": "3/min"})
    codes = [login(api, "x@team.dev", "Wrong!pass1").status_code for _ in range(5)]
    assert codes[:3] == [401, 401, 401]
    assert codes[-1] == 429
    last = login(api, "x@team.dev", "Wrong!pass1")
    assert last.json()["code"] == "rate_limited"
    assert last["Retry-After"]
