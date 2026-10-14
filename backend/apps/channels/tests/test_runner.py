"""Runner: claim, retries, dead letter, sweeper, re-checks (docs/v2/38-telegram-sms-push.md §6.7, §6.8, §6.10)."""

import datetime as dt
import threading
import time

import pytest
from django.core.management import call_command
from django.db import connection
from django.utils import timezone

from apps.audit.trash import purge_expired
from apps.channels import runner
from apps.channels.models import (
    ChannelDelivery,
    OtpSend,
    PushSubscription,
    SmsConnection,
    SmsVerification,
    TelegramConnection,
    TelegramLinkRequest,
)
from apps.common.testing import UserFactory
from apps.projects.models import ProjectMember
from apps.tasks.services import create_task

from .conftest import connect_push, connect_sms, connect_telegram

pytestmark = pytest.mark.django_db


def queued(user, channel="telegram", **target):
    return ChannelDelivery.objects.create(
        user=user, channel=channel, kind="test", event="test", template="test", status="queued",
        next_attempt_at=timezone.now(), **target,
    )  # fmt: skip


def due(row):
    ChannelDelivery.objects.filter(pk=row.pk).update(next_attempt_at=timezone.now() - dt.timedelta(seconds=1))


@pytest.mark.django_db(transaction=True)
def test_claim_is_exclusive():
    row = queued(UserFactory())
    wins = []
    barrier = threading.Barrier(2)

    def claim():
        barrier.wait()
        wins.append(runner.claim(row.pk))
        connection.close()

    threads = [threading.Thread(target=claim) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(wins) == [False, True]


def test_backoff_retry_after_and_dead_letter(sam, tg, settings):
    assert dt.timedelta(seconds=24) <= runner.backoff(1) <= dt.timedelta(seconds=36)
    assert dt.timedelta(hours=4.8) <= runner.backoff(5) <= dt.timedelta(hours=7.2)
    assert runner.backoff(1, retry_after=600) == dt.timedelta(seconds=600)
    row = queued(sam, telegram=connect_telegram(sam))
    for _ in range(5):
        tg.fail_next(retry_after=1)
    for attempt in range(1, 6):
        runner.send_delivery(row.pk)
        row.refresh_from_db()
        assert row.attempts == attempt
        due(row)
    assert (row.status, row.error_code) == ("dead", "rate_limited")
    call_command("channel_deliveries", "--dead")
    call_command("channel_deliveries", "--retry", str(row.pk))
    row.refresh_from_db()
    assert (row.status, row.attempts) == ("queued", 0)
    ChannelDelivery.objects.filter(pk=row.pk).update(status="dead")
    call_command("channel_deliveries", "--retry-dead", "--since", "1d")
    runner.send_delivery(row.pk)
    row.refresh_from_db()
    assert row.status == "sent"


def test_lease_expiry_and_orphans_are_recovered_by_the_cron_command(sam, tg):
    conn = connect_telegram(sam)
    stuck = queued(sam, telegram=conn)
    ChannelDelivery.objects.filter(pk=stuck.pk).update(
        status="sending", attempts=1, lease_until=timezone.now() - dt.timedelta(seconds=5)
    )
    orphan = queued(sam, telegram=conn)
    call_command("send_channel_deliveries")
    assert set(ChannelDelivery.objects.filter(pk__in=[stuck.pk, orphan.pk]).values_list("status", flat=True)) == {
        "sent"
    }
    assert len(tg.outbox) == 2


def test_sweeper_is_idle_without_work(monkeypatch):
    calls = []

    def fake_sweep():
        calls.append(time.monotonic())
        return [], None

    monkeypatch.setattr(runner, "sweep", fake_sweep)
    sweeper = runner.Sweeper()
    sweeper.start()  # one sweep at start picks up rows left by a previous process
    try:
        time.sleep(0.3)
        assert len(calls) == 1
        sweeper.notify(timezone.now() + dt.timedelta(milliseconds=100))
        time.sleep(0.4)
        assert len(calls) == 2
        time.sleep(0.2)
        assert len(calls) == 2  # nothing scheduled: no further sweeps, so no queries
    finally:
        sweeper.stop()


def test_send_time_rechecks_mark_rows_stale(owner, project, sam, tg):
    from apps.tasks.models import Task

    connect_telegram(sam)
    task = create_task(owner, project, {"title": "Gone", "assigneeId": str(sam.pk)})
    row = ChannelDelivery.objects.get(user=sam)
    assert row.status == "sent"

    def resend():
        ChannelDelivery.objects.filter(pk=row.pk).update(status="retry", next_attempt_at=timezone.now())
        runner.send_delivery(row.pk)
        row.refresh_from_db()
        return row.status, row.skip_reason

    member = ProjectMember.objects.get(project=project, user=sam)
    role = member.role
    member.delete()
    assert resend() == ("skipped", "stale")  # member removed
    ProjectMember.objects.create(project=project, user=sam, role=role)
    Task.objects.filter(pk=task.pk).update(deleted_at=timezone.now())
    assert resend() == ("skipped", "stale")  # task deleted


def test_permanent_failures_update_connections(sam, tg, sms, push, caplog):
    cases = [
        (tg, "telegram", {"telegram": connect_telegram(sam)}, "blocked"),
        (sms, "sms", {"sms": connect_sms(sam)}, "opted_out"),
        (push, "push", {"push": connect_push(sam)}, "expired_subscription"),
    ]
    for fake, channel, target, reason in cases:
        fake.fail_next(reason=reason, permanent=True)
        row = queued(sam, channel, **target)
        runner.send_delivery(row.pk)
        row.refresh_from_db()
        assert (row.status, row.error_code) == ("failed", reason)
    assert TelegramConnection.objects.get().status == "blocked"
    assert SmsConnection.objects.get().status == "opted_out"
    assert PushSubscription.objects.get().status == "expired"
    SmsConnection.objects.update(status="active")
    sms.fail_next(reason="invalid_number", permanent=True)
    runner.send_delivery(queued(sam, "sms", sms=SmsConnection.objects.get()).pk)
    assert SmsConnection.objects.get().status == "invalid"
    runner._config_logged.clear()
    caplog.set_level("ERROR", logger="lightex.channels")
    TelegramConnection.objects.update(status="active")
    for _ in range(2):
        tg.fail_next(reason="config_error", permanent=True)
        runner.send_delivery(queued(sam, "telegram", telegram=TelegramConnection.objects.get()).pk)
    assert caplog.text.count("configuration error") == 1


def test_push_transient_failures_expire_after_ten(sam, push):
    sub = connect_push(sam)
    PushSubscription.objects.filter(pk=sub.pk).update(failure_count=9)
    push.fail_next(reason="provider_error")
    runner.send_delivery(queued(sam, "push", push=sub).pk)
    sub.refresh_from_db()
    assert (sub.failure_count, sub.status) == (10, "expired")


def test_purge_retention(sam):
    old = timezone.now() - dt.timedelta(days=40)
    row = queued(sam)
    ChannelDelivery.objects.filter(pk=row.pk).update(status="sent", updated_at=old)
    link = TelegramLinkRequest.objects.create(user=sam, code_hash="x", start_hash="y", status="linked",
                                              expires_at=old)  # fmt: skip
    TelegramLinkRequest.objects.filter(pk=link.pk).update(updated_at=old)
    v = SmsVerification.objects.create(user=sam, phone_enc="x", phone_hash="h", country="US", code_hash="c",
                                       status="verified", expires_at=old, resend_at=old)  # fmt: skip
    SmsVerification.objects.filter(pk=v.pk).update(updated_at=old)
    otp = OtpSend.objects.create(user=sam, phone_hash="h")
    OtpSend.objects.filter(pk=otp.pk).update(created_at=old)
    sub = connect_push(sam, status="expired")
    PushSubscription.objects.filter(pk=sub.pk).update(updated_at=old)
    keep = connect_push(sam, n=2, status="expired")
    counts = purge_expired()
    assert counts["channel_deliveries"] == counts["telegram_links"] == counts["sms_verifications"] == 1
    assert counts["otp_sends"] == counts["push_subscriptions"] == 1
    assert list(PushSubscription.objects.values_list("pk", flat=True)) == [keep.pk]
