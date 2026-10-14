"""Telegram linking: H1 + C2–C5 (docs/v2/38-telegram-sms-push.md §5.3–§5.5, §5.12)."""

import datetime as dt
import json

import pytest
from django.utils import timezone

from apps.channels.models import ChannelDelivery, TelegramConnection, TelegramLinkRequest
from apps.channels.providers.fake import FakeTelegram
from apps.common.testing import client_for

from .conftest import connect_telegram

pytestmark = pytest.mark.django_db
HOOK = "/api/v1/webhooks/telegram"
SECRET = {"HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN": "test-telegram-secret"}


def post_update(api, update, headers=SECRET):
    return api.post(HOOK, json.dumps(update), content_type="application/json", **headers)


def say(api, text, chat_id=555, **kw):
    res = post_update(api, FakeTelegram.fake_update(text, chat_id, **kw))
    assert res.status_code == 200
    return res.json()


def start_link(client):
    res = client.post("/api/v1/me/notification-channels/telegram/link", {"timezone": "America/New_York"}, format="json")
    assert res.status_code == 201, res.content
    return res.json()


def test_wrong_or_missing_secret_is_401_without_db_writes(api, sam_client):
    link = start_link(sam_client)
    update = FakeTelegram.fake_update(f"/start {link['code']}", 555)
    assert post_update(api, update, headers={}).status_code == 401
    assert post_update(api, update, headers={"HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN": "nope"}).status_code == 401
    assert not TelegramConnection.objects.exists()
    assert TelegramLinkRequest.objects.get().status == "pending"


@pytest.mark.parametrize("how", ["token", "code", "bare"])
def test_linking_by_token_code_or_bare_code(api, sam, sam_client, how):
    link = start_link(sam_client)
    assert len(link["code"]) == 6 and link["deepLink"].startswith("https://t.me/lightex_bot?start=lx_")
    token = link["deepLink"].split("start=")[1]
    code = link["code"]
    text = {"token": f"/start {token}", "code": f"/start {code}", "bare": f"{code[:3].lower()}-{code[3:].lower()}"}[how]
    reply = say(api, text, username="alexkim", first_name="Alex")
    assert reply == {"method": "sendMessage", "chat_id": 555, "text": reply["text"]}
    assert reply["text"].startswith("Connected to Lightex.")
    polled = sam_client.get(f"/api/v1/me/notification-channels/telegram/link/{link['id']}").json()
    assert polled["status"] == "linked" and "code" not in polled and "deepLink" not in polled
    assert polled["connection"]["username"] == "alexkim" and polled["connection"]["firstName"] == "Alex"
    # A second use of the same code doesn't work.
    assert "didn't work" in say(api, f"/start {code}", chat_id=556)["text"]


def test_expired_code_group_chat_and_silence_after_five_failures(api, sam_client):
    link = start_link(sam_client)
    TelegramLinkRequest.objects.update(expires_at=timezone.now() - dt.timedelta(seconds=1))
    assert "didn't work" in say(api, f"/start {link['code']}")["text"]
    assert sam_client.get(f"/api/v1/me/notification-channels/telegram/link/{link['id']}").json()["status"] == "expired"
    assert "private chat" in say(api, "/start ABCDEF", chat_type="group")["text"]
    for _ in range(4):
        assert "didn't work" in say(api, "/start ZZZZZZ")["text"]
    fresh = start_link(sam_client)
    assert say(api, f"/start {fresh['code']}") == {}  # silenced for an hour, even with a good code
    assert not TelegramConnection.objects.exists()


def test_commands_stop_status_and_chat_member(api, sam, owner):
    connect_telegram(sam, chat_id=555)
    connect_telegram(owner, chat_id=555)
    assert say(api, "/status")["text"] == "This chat is connected to Lightex."
    assert "/stop" in say(api, "/help")["text"]
    assert "Replies aren't supported yet" in say(api, "Looks good to me!")["text"]
    say(api, "/status", username="renamed")
    assert set(TelegramConnection.objects.values_list("username", flat=True)) == {"renamed"}
    kicked = {"update_id": 9001, "my_chat_member": {"chat": {"id": 555}, "new_chat_member": {"status": "kicked"}}}
    assert post_update(api, kicked).json() == {}
    assert set(TelegramConnection.objects.values_list("status", flat=True)) == {"blocked"}
    assert TelegramConnection.objects.first().last_error == "You blocked the bot in Telegram."
    back = {"update_id": 9002, "my_chat_member": {"chat": {"id": 555}, "new_chat_member": {"status": "member"}}}
    post_update(api, back)
    assert set(TelegramConnection.objects.values_list("status", flat=True)) == {"active"}
    assert say(api, "/stop")["text"].startswith("Disconnected.")
    assert not TelegramConnection.objects.exists()
    assert say(api, "/start")["text"].startswith("Not connected.")


def test_c2_conflict_cancel_previous_c4_and_c5(sam, sam_client, tg):
    first = start_link(sam_client)
    second = start_link(sam_client)
    assert TelegramLinkRequest.objects.get(pk=first["id"]).status == "canceled"
    assert sam_client.delete(f"/api/v1/me/notification-channels/telegram/link/{second['id']}").status_code == 204
    assert TelegramLinkRequest.objects.get(pk=second["id"]).status == "canceled"
    conn = connect_telegram(sam)
    res = sam_client.post("/api/v1/me/notification-channels/telegram/link", {}, format="json")
    assert (res.status_code, res.json()["code"]) == (409, "already_connected")
    TelegramConnection.objects.filter(pk=conn.pk).update(status="blocked")
    assert sam_client.post("/api/v1/me/notification-channels/telegram/link", {}, format="json").status_code == 201
    queued = ChannelDelivery.objects.create(
        user=sam, channel="telegram", event="assigned", template="assigned", telegram=conn, status="deferred",
        next_attempt_at=timezone.now() + dt.timedelta(hours=3),
    )  # fmt: skip
    assert sam_client.delete("/api/v1/me/notification-channels/telegram").status_code == 204
    assert sam_client.delete("/api/v1/me/notification-channels/telegram").status_code == 204
    queued.refresh_from_db()
    assert (queued.status, queued.skip_reason) == ("skipped", "not_connected")
    assert tg.outbox[-1]["text"].startswith("Disconnected from Lightex.")
    assert client_for(sam).get("/api/v1/me/notification-channels").json()["telegram"]["connection"] is None


def test_unavailable_telegram_is_503(sam_client, settings):
    settings.TELEGRAM_BACKEND = "disabled"
    res = sam_client.post("/api/v1/me/notification-channels/telegram/link", {}, format="json")
    assert (res.status_code, res.json()["code"], res.json()["details"]) == (
        503, "channel_unavailable", {"channel": "telegram"},
    )  # fmt: skip
    channels = sam_client.get("/api/v1/me/notification-channels").json()
    assert channels["telegram"] == {"available": False, "botUsername": None, "connection": None}
