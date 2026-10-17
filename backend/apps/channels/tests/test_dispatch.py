"""Dispatch: fan-out, quiet hours, release and templates (docs/v2/38-telegram-sms-push.md §6.1–§6.6, §9.1)."""

import datetime as dt
import json
from pathlib import Path

import pytest
from django.db import transaction
from django.db.transaction import on_commit as REAL_ON_COMMIT
from django.utils import timezone

from apps.channels import dispatch, quiet, render, runner
from apps.channels.models import ChannelDelivery
from apps.notifications.handlers import on_task_assigned, preferences_for
from apps.notifications.models import DomainEvent, Notification
from apps.tasks.services import create_task

from .conftest import connect_push, connect_sms, connect_telegram

pytestmark = pytest.mark.django_db
QUIET = json.loads((Path(__file__).parent / "data" / "quiet_vectors.json").read_text(encoding="utf-8"))["cases"]


def _utc(text):
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00")) if text else None


@pytest.mark.parametrize("case", QUIET, ids=lambda c: c["name"])
def test_quiet_vectors(case):
    q = quiet.Quiet(True, dt.time.fromisoformat(case["from"]), dt.time.fromisoformat(case["to"]),
                    tuple(bool(d) for d in case["days"]), case["tz"])  # fmt: skip
    at = _utc(case["at"])
    assert quiet.is_quiet(q, at) is (case["end"] is not None)
    if case["end"]:
        assert quiet.window_end(q, at) == _utc(case["end"])
        released = quiet.release_at(q, at, "user-1")
        assert dt.timedelta(0) <= released - _utc(case["end"]) <= dt.timedelta(seconds=120)


def enable(user, *channels, event="assigned"):
    prefs = preferences_for(user)
    for c in channels:
        prefs.events[event][c] = True
    prefs.save()
    return prefs


def assign(owner, project, user, priority=3, title="Fix flaky board reflow"):
    return create_task(owner, project, {"title": title, "assigneeId": str(user.pk), "priority": priority})


def rows(user, channel):
    return list(ChannelDelivery.objects.filter(user=user, channel=channel).values_list("status", "skip_reason"))


MATRIX = [
    ("telegram", None, True, []),
    ("telegram", "active", True, [("sent", "")]),
    ("telegram", "active", False, []),
    ("telegram", "blocked", True, [("skipped", "blocked")]),
    ("sms", "active", True, [("sent", "")]),
    ("sms", "opted_out", True, [("skipped", "opted_out")]),
    ("sms", "policy_off", True, [("skipped", "policy")]),
    ("sms", "disabled", True, [("skipped", "unavailable")]),
    ("push", "active", True, [("sent", "")]),
    ("push", "expired", True, [("skipped", "expired")]),
    ("push", None, True, []),
]


@pytest.mark.parametrize(("channel", "state", "pref", "expected"), MATRIX)
def test_fan_out_matrix(owner, project, sam, ws, settings, channel, state, pref, expected):
    prefs = preferences_for(sam)
    prefs.events["assigned"][channel] = pref
    prefs.save()
    connect = {"telegram": connect_telegram, "sms": connect_sms, "push": connect_push}[channel]
    if state == "policy_off":
        ws.sms_enabled = False
        ws.save()
    if state == "disabled":
        settings.SMS_BACKEND = "disabled"
        connect(sam)
    elif state is not None:
        connect(sam, status="active" if state == "policy_off" else state)
    assign(owner, project, sam)
    assert rows(sam, channel) == expected
    assign(owner, project, owner)  # the actor never receives their own event
    assert not ChannelDelivery.objects.filter(user=owner).exists()


def test_only_the_six_matrix_events_fan_out(sam):
    prefs = preferences_for(sam)
    assert dispatch.wanted(sam, prefs, "assigned") == ["telegram", "push"]
    for pref in (None, "import", "access", "sprint_completed"):
        assert dispatch.wanted(sam, prefs, pref) == []


def test_rolled_back_event_sends_nothing_and_rows_are_unique(owner, project, sam, tg, monkeypatch):
    connect_telegram(sam)
    monkeypatch.setattr(transaction, "on_commit", REAL_ON_COMMIT)
    assign(owner, project, sam)  # the event waits for a commit that never comes in this test
    event = DomainEvent.objects.get(type="task_assigned")
    with pytest.raises(RuntimeError), transaction.atomic():
        on_task_assigned(event)
        assert ChannelDelivery.objects.count() == 1
        raise RuntimeError
    assert not ChannelDelivery.objects.exists() and tg.outbox == []
    on_task_assigned(event)
    n = Notification.objects.get(recipient=sam)
    dispatch.enqueue(n, sam, preferences_for(sam), ["telegram"], template="assigned", context={}, urgent=False)
    assert ChannelDelivery.objects.count() == 1


def quiet_now(user, **extra):
    prefs = preferences_for(user)
    now = timezone.now()
    prefs.timezone = "UTC"
    prefs.quiet_from = (now - dt.timedelta(hours=1)).time().replace(second=0, microsecond=0)
    prefs.quiet_to = (now + dt.timedelta(hours=2)).time().replace(second=0, microsecond=0)
    for k, v in extra.items():
        setattr(prefs, k, v)
    prefs.save()
    return prefs


def test_quiet_hours_defer_and_urgent_bypass(owner, project, sam, tg):
    connect_telegram(sam)
    quiet_now(sam)
    assign(owner, project, sam, priority=3)
    assign(owner, project, sam, priority=4)
    statuses = sorted(ChannelDelivery.objects.values_list("status", "urgent"))
    assert statuses == [("deferred", False), ("sent", True)]
    deferred = ChannelDelivery.objects.get(status="deferred")
    assert deferred.next_attempt_at > timezone.now() + dt.timedelta(hours=1)
    prefs = quiet_now(sam, quiet_urgent_bypass=False)
    assert prefs.quiet_urgent_bypass is False
    assign(owner, project, sam, priority=4)
    assert ChannelDelivery.objects.filter(status="deferred").count() == 2


def test_release_one_row_and_summary_for_several(owner, project, sam, tg, sms):
    connect_telegram(sam)
    connect_sms(sam)
    enable(sam, "sms")
    quiet_now(sam)
    assign(owner, project, sam)
    later = timezone.now() + dt.timedelta(hours=3)
    runner.sweep_and_send(later)
    assert [m["text"].split("\n")[0] for m in tg.outbox] == ["<b>PRJ-1</b> assigned to you by Alex Kim"]
    for i in range(3):
        assign(owner, project, sam, title=f"Task {i}")
    assert ChannelDelivery.objects.filter(status="deferred").count() == 6
    runner.sweep_and_send(timezone.now() + dt.timedelta(hours=3))
    summary = ChannelDelivery.objects.get(kind="summary", channel="telegram")
    assert summary.status == "sent" and summary.context["count"] == 3
    assert ChannelDelivery.objects.filter(status="coalesced", summary=summary).count() == 3
    assert tg.outbox[-1]["text"].startswith("<b>While quiet hours were on</b> · 3 updates")
    assert tg.outbox[-1]["button"] == ("Open inbox", "https://app.lightex.dev/platform/inbox")
    assert sms.outbox[-1]["body"].startswith("Lightex: 3 updates while quiet hours were on.")
    assert runner.sms_sent_today(sam.pk) == 2  # one event SMS + the summary counted once


def test_quiet_hours_change_retimes_deferred_rows(owner, project, sam, sam_client):
    connect_telegram(sam)
    quiet_now(sam)
    assign(owner, project, sam)
    prefs = sam_client.get("/api/v1/notification-preferences").json()
    prefs["quietHours"]["enabled"] = False
    assert sam_client.put("/api/v1/notification-preferences", prefs, format="json").status_code == 200
    row = ChannelDelivery.objects.get()
    assert row.status == "deferred" and row.next_attempt_at <= timezone.now()
    ChannelDelivery.objects.update(created_at=timezone.now() - dt.timedelta(hours=25))
    runner.sweep_and_send()
    assert ChannelDelivery.objects.get().skip_reason == "stale"


# ───────────────────────── templates (§6.3–§6.5) ─────────────────────────

TITLE = "Zebra-Quokka secret title"
EXCERPT = "Narwhal private comment"
CTX = {
    "task_key": "PRJ-42", "task_title": TITLE, "project_name": "Platform Rebuild", "project_key": "PRJ",
    "priority": "Urgent", "due_date": "Oct 14", "due_relative": "tomorrow", "actor_name": "Alex Kim",
    "assigner_name": "Alex Kim", "author_name": "Alex Kim", "comment_excerpt": EXCERPT, "to_status": "In review",
    "sprint_name": "Sprint 14", "sprint_start": "Oct 9", "sprint_end": "Oct 23", "task_count": 12,
    "points_total": 34, "your_task_count": 3, "cta_url": "https://app.lightex.dev/platform/tasks/PRJ-42",
    "inbox_url": "https://app.lightex.dev/platform/inbox", "count": 5, "task_id": "t1",
    "items": [{"task_key": "PRJ-42", "line": "PRJ-42 assigned to you"}],
}  # fmt: skip


@pytest.mark.parametrize("template", render.TEMPLATES)
def test_every_template_renders_and_sms_never_has_titles_or_comments(template):
    text, _ = render.telegram(template, CTX)
    title, body = render.push(template, CTX)
    sms = render.sms(template, CTX)
    assert text and title and body and sms
    assert TITLE not in sms and EXCERPT not in sms and "Platform Rebuild" not in sms
    assert render.septets(sms) is not None and render.septets(sms) <= 160
    assert len(title) <= 60 and len(body) <= 160


def test_copy_escaping_folding_and_limits():
    assert render.sms("assigned", CTX) == (
        "Lightex: PRJ-42 assigned to you by Alex. https://app.lightex.dev/platform/tasks/PRJ-42 Reply STOP to opt out"
    )
    assert render.push("assigned", CTX) == ("PRJ-42 assigned to you", f"{TITLE} · from Alex Kim")
    text, _ = render.telegram("assigned", {**CTX, "task_title": "<script>alert(1)</script>"})
    assert "&lt;script&gt;" in text and "<script>" not in text
    assert "<i>Platform Rebuild · Urgent · due Oct 14</i>" in text
    assert "by Zoe" in render.sms("assigned", {**CTX, "actor_name": "Zoë Brontë"})
    assert " by " not in render.sms("assigned", {**CTX, "actor_name": "李雷"})
    long_url = "https://app.lightex.dev/" + "x" * 90
    assert " by " not in render.sms("assigned", {**CTX, "cta_url": long_url})
    payload = json.loads(render.push_payload("assigned", {**CTX, "task_title": "T" * 200}, sent_at="now"))
    assert len(json.dumps(payload, ensure_ascii=False).encode()) <= 3000
    assert payload["tag"] == "task:t1" and payload["kind"] == "assigned"
    assert render.otp_sms("482913") == (
        "Lightex code: 482913. It expires in 10 minutes. Don't share it.\n\n@app.lightex.dev #482913"
    )
