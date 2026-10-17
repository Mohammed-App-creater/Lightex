"""Platform Stage 4 follow-ups to Stage 3: the expired-trash purge skips the kinds of a disabled module (disabling
never deletes data), and switching a module publishes `core.module.changed` to the workspace."""

import datetime as dt

import pytest
from django.utils import timezone

from core.audit.trash import disabled_workspaces, kind_for, purge_expired
from core.common.testing import UserFactory, add_member, make_workspace
from core.modules import services
from core.realtime import protocol
from core.realtime.models import RealtimeEvent
from core.tests.fake_module import module as fake
from core.tests.fake_module.models import Widget

pytestmark = pytest.mark.django_db


@pytest.fixture
def fake_module():
    fake.register()
    yield fake.DEFINITION
    fake.unregister()


def _old_widget(ws, title):
    long_ago = timezone.now() - dt.timedelta(days=60)
    return Widget.all_objects.create(workspace=ws, title=title, deleted_at=long_ago)


def test_purge_skips_kinds_of_a_disabled_module(fake_module, owner, ws):
    on = make_workspace(owner, name="On", slug="on", modules=["fake"])
    off = ws  # fake was never enabled here
    was_on = make_workspace(owner, name="Was on", slug="was-on", modules=["fake"])
    services.set_module_enabled(owner, was_on, "fake", False)
    for w in (on, off, was_on):
        _old_widget(w, w.slug)
    Widget.all_objects.create(workspace=on, title="recent", deleted_at=timezone.now())
    counts = purge_expired()
    assert counts["widgets"] == 1
    assert sorted(Widget.all_objects.values_list("title", flat=True)) == ["platform", "recent", "was-on"]
    # Re-enabled, the module's expired trash is purged again.
    services.set_module_enabled(owner, was_on, "fake", True)
    assert purge_expired()["widgets"] == 1
    assert sorted(Widget.all_objects.values_list("title", flat=True)) == ["platform", "recent"]


def test_always_on_kinds_skip_nothing(fake_module):
    assert disabled_workspaces(kind_for("core.comment")) == ()
    assert disabled_workspaces(kind_for("tracking.task")) == ()


def test_unregistered_module_kinds_are_purged_everywhere(owner, ws):
    """Without a definition the fake module is not gated, so nothing is skipped."""
    _old_widget(ws, "gone")
    assert purge_expired()["widgets"] == 1
    assert not Widget.all_objects.exists()


def test_switching_a_module_publishes_module_changed(owner, ws):
    member = add_member(ws, UserFactory())
    assert "core.module.changed" in protocol.DURABLE_TYPES
    assert "core.module.changed" in protocol.WORKSPACE_TYPES
    RealtimeEvent.objects.all().delete()
    services.set_module_enabled(owner, ws, "sales", True)
    services.set_module_enabled(owner, ws, "sales", True)  # no change, no event
    services.set_module_enabled(owner, ws, "sales", False)
    events = list(RealtimeEvent.objects.filter(type="core.module.changed").order_by("id"))
    assert [e.payload["data"] for e in events] == [
        {"module": "sales", "enabled": True},
        {"module": "sales", "enabled": False},
    ]
    event = events[0].payload
    assert (event["ws"], event["projectId"], event["actorId"]) == (str(ws.pk), None, str(owner.pk))
    assert events[0].user_id is None
    # Workspace-wide: every member's stream receives it.
    assert protocol.matches(event, str(ws.pk), set(), str(member.pk))
    assert not protocol.matches(event, "another-workspace", set(), str(member.pk))


def test_module_toggle_via_api_publishes(owner, ws, as_user):
    RealtimeEvent.objects.all().delete()
    res = as_user(owner).put("/api/v1/workspaces/platform/modules/sales", {"enabled": True}, format="json")
    assert res.status_code == 200, res.json()
    assert RealtimeEvent.objects.filter(type="core.module.changed").count() == 1
