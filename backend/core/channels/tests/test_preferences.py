"""Preferences P1 and the workspace SMS policy W1 (docs/v2/38-telegram-sms-push.md §3.8, §4.2, §5.13)."""

import importlib

import pytest
from django.apps import apps as django_apps

from core.audit.models import AuditLog
from core.common.testing import add_member, client_for
from core.notifications.models import NotificationPreference, default_events

from .conftest import AUTH, FCM, P256DH

pytestmark = pytest.mark.django_db
URL = "/api/v1/notification-preferences"
migration = importlib.import_module("core.notifications.migrations.0004_board38_channel_preferences")
namespace = importlib.import_module("core.notifications.migrations.0005_namespace_event_types")
QUIET = {"enabled": True, "from": "22:00", "to": "08:00", "timezone": "Europe/Berlin",
         "days": [True] * 5 + [False] * 2, "urgentBypass": False}  # fmt: skip


def test_defaults_and_v1_shaped_put_keeps_new_keys(sam_client):
    prefs = sam_client.get(URL).json()
    assert prefs["events"]["tracking.task.due_soon"] == {
        "in_app": True,
        "email": True,
        "telegram": True,
        "sms": True,
        "push": True,
    }
    assert prefs["events"]["tracking.task.status_changed"]["telegram"] is False
    assert prefs["quietHours"] == {"enabled": True, "from": "22:00", "to": "08:00", "timezone": None,
                                   "days": [True] * 7, "urgentBypass": True}  # fmt: skip
    v1 = {"events": {"tracking.task.due_soon": {"in_app": False, "email": False}}, "emailDelivery": "daily"}
    saved = sam_client.put(URL, v1, format="json").json()
    assert saved["events"]["tracking.task.due_soon"] == {
        "in_app": False,
        "email": False,
        "telegram": True,
        "sms": True,
        "push": True,
    }
    saved = sam_client.put(URL, {**v1, "events": {"tracking.task.due_soon": {"sms": False}}}, format="json").json()
    assert (
        saved["events"]["tracking.task.due_soon"]["sms"] is False
        and saved["events"]["tracking.task.due_soon"]["in_app"] is False
    )
    assert sam_client.put(URL, {**v1, "quietHours": QUIET}, format="json").json()["quietHours"] == QUIET


def test_data_migration_merges_channel_keys(sam):
    old = {"assigned": {"in_app": False, "email": True}, "comment": {"in_app": True, "email": True, "push": False}}
    NotificationPreference.objects.create(user=sam, events=old)
    migration.add_channel_keys(django_apps, None)
    namespace.forwards(django_apps, None)  # platform Stage 1 renames the keys
    namespace.forwards(django_apps, None)  # idempotent
    events = NotificationPreference.objects.get(user=sam).events
    assert events["tracking.task.assigned"] == {
        "in_app": False,
        "email": True,
        "telegram": True,
        "sms": False,
        "push": True,
    }
    assert events["tracking.comment.created"]["push"] is False and events["tracking.comment.created"]["email"] is True
    assert set(events) == set(default_events())


@pytest.mark.parametrize(
    ("change", "field", "message"),
    [
        ({"from": "24:00"}, "quietHours.from", "Use HH:MM"),
        ({"to": "8:00"}, "quietHours.to", "Use HH:MM"),
        ({"to": "22:00"}, "quietHours.to", "End must differ from start"),
        ({"timezone": "Mars/Olympus"}, "quietHours.timezone", "Unknown time zone"),
        ({"days": [True] * 6}, "quietHours.days", "Send 7 booleans, Monday first"),
    ],
)
def test_quiet_hours_validation(sam_client, change, field, message):
    res = sam_client.put(URL, {"events": {}, "emailDelivery": "instant", "quietHours": {**QUIET, **change}},
                         format="json")  # fmt: skip
    assert res.status_code == 422 and res.json()["details"]["fields"][field] == message


@pytest.mark.parametrize("route", ["telegram", "sms", "push"])
def test_timezone_filled_once_by_connect_calls(sam, sam_client, route):
    def connect(tz):
        if route == "telegram":
            from core.channels.models import TelegramLinkRequest

            TelegramLinkRequest.objects.all().delete()
            return sam_client.post("/api/v1/me/notification-channels/telegram/link", {"timezone": tz}, format="json")
        if route == "sms":
            from core.channels.models import OtpSend

            OtpSend.objects.all().delete()
            data = {"country": "US", "nationalNumber": "4155550132", "timezone": tz}
            return sam_client.post("/api/v1/me/notification-channels/sms/verifications", data, format="json")
        sub = {"endpoint": FCM + "tz", "expirationTime": None, "keys": {"p256dh": P256DH, "auth": AUTH}}
        return sam_client.put("/api/v1/me/push-subscriptions", {"mode": "subscribe", "subscription": sub,
                                                                 "timezone": tz}, format="json")  # fmt: skip

    assert connect("America/New_York").status_code in (200, 201)
    assert connect("Asia/Tokyo").status_code in (200, 201)
    assert NotificationPreference.objects.get(user=sam).timezone == "America/New_York"


def test_workspace_sms_policy_needs_workspace_update(ws, owner):
    member = add_member(ws)
    url = f"/api/v1/workspaces/{ws.slug}"
    assert client_for(member).get(url).json()["notificationPolicy"] == {"sms": True}
    res = client_for(member).patch(url, {"notificationPolicy": {"sms": False}}, format="json")
    assert res.status_code == 403 and res.json()["code"] == "forbidden"
    res = client_for(owner).patch(url, {"notificationPolicy": {"sms": False}}, format="json")
    assert res.status_code == 200 and res.json()["notificationPolicy"] == {"sms": False}
    entry = AuditLog.objects.filter(action="core.workspace.updated").latest("created_at")
    assert entry.changes[0]["field"] == "smsNotifications"
    assert (entry.changes[0]["before"], entry.changes[0]["after"]) == (True, False)
    res = client_for(owner).patch(url, {"notificationPolicy": {"sms": "no"}}, format="json")
    assert res.status_code == 422
