"""Push subscriptions: C10–C13 (docs/v2/38-telegram-sms-push.md §2.4, §5.9–§5.11)."""

import pytest

from core.channels.models import PushSubscription
from core.common.testing import UserFactory, client_for

from .conftest import AUTH, FCM, P256DH

pytestmark = pytest.mark.django_db
URL = "/api/v1/me/push-subscriptions"
CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36"


def body(endpoint=FCM + "abc", mode="subscribe", p256dh=P256DH, auth=AUTH):
    return {"mode": mode, "subscription": {"endpoint": endpoint, "expirationTime": None,
                                           "keys": {"p256dh": p256dh, "auth": auth}}}  # fmt: skip


def put(client, data):
    return client.put(URL, data, format="json", HTTP_USER_AGENT=CHROME_MAC)


def test_vapid_key_is_public_and_cached(api, settings):
    res = api.get("/api/v1/push/vapid-public-key")
    assert res.status_code == 200 and res.json() == {"publicKey": settings.VAPID_PUBLIC_KEY}
    assert res["Cache-Control"] == "public, max-age=3600"
    settings.WEB_PUSH_BACKEND = "disabled"
    assert api.get("/api/v1/push/vapid-public-key").status_code == 503


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/x",
        "https://localhost/push",
        "https://169.254.169.254/latest",
        "https://evil.example.com/push",
        "https://fcm.googleapis.com:8443/x",
    ],
)
def test_allow_list_rejects(sam_client, endpoint):
    res = put(sam_client, body(endpoint))
    assert res.status_code == 422
    assert res.json()["details"]["fields"] == {"subscription.endpoint": "Unsupported push service"}


def test_key_validation_and_allowed_wildcards(sam_client):
    res = put(sam_client, body(p256dh="AAAA", auth="short"))
    assert set(res.json()["details"]["fields"]) == {"subscription.keys.p256dh", "subscription.keys.auth"}
    assert put(sam_client, body("https://wns2-par02p.notify.windows.com/w/?token=x")).status_code == 201


def test_subscribe_moves_refresh_and_device_cap(sam, sam_client):
    res = put(sam_client, body())
    assert res.status_code == 201
    device = res.json()
    assert device["label"] == "Chrome on macOS" and len(device["endpointHash"]) == 16
    assert put(sam_client, body()).status_code == 200
    other_user = UserFactory()
    other = client_for(other_user)
    assert put(other, body(mode="refresh")).status_code == 404  # another user's endpoint
    assert put(other, body()).status_code == 200  # subscribe takes the browser over
    assert PushSubscription.objects.get().user_id == other_user.pk
    assert put(sam_client, body(mode="refresh")).status_code == 404
    PushSubscription.objects.update(status="expired")
    assert put(other, body(mode="refresh")).status_code == 404  # expired
    for n in range(11):
        assert put(sam_client, body(f"{FCM}dev-{n}")).status_code == 201
    active = PushSubscription.objects.filter(user=sam, status="active")
    assert active.count() == 10
    assert PushSubscription.objects.get(endpoint=f"{FCM}dev-0").status == "expired"


def test_remove_by_endpoint_is_idempotent_and_device_delete_is_scoped(sam, sam_client):
    put(sam_client, body())
    remove = {"endpoint": FCM + "abc"}
    assert sam_client.post(URL + "/remove", remove, format="json").status_code == 204
    assert sam_client.post(URL + "/remove", remove, format="json").status_code == 204
    assert not PushSubscription.objects.exists()
    device_id = put(sam_client, body()).json()["id"]
    assert client_for(UserFactory()).delete(f"{URL}/{device_id}").status_code == 404
    assert sam_client.delete(f"{URL}/{device_id}").status_code == 204
    assert sam_client.delete(f"{URL}/{device_id}").status_code == 404
