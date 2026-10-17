"""Domain events (contract §3, architecture §12): written in the caller's transaction, dispatched on commit to
registered handlers, idempotent, and retried safely after a failure."""

import pytest
from django.core.management import call_command
from django.db import transaction

from core.events.models import DomainEvent
from core.events.registry import (
    event_type,
    handlers_for,
    preference_types,
    register_event_type,
    register_handler,
    unregister_event_type,
    unregister_handler,
)
from core.events.services import emit, pending, process_event

pytestmark = pytest.mark.django_db


class Recorder:
    """An idempotent handler: remembers each event id once, however often it is called."""

    def __init__(self, fail_times: int = 0):
        self.seen: list[str] = []
        self.calls = 0
        self.fail_times = fail_times

    def __call__(self, event):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("smtp down")
        if str(event.pk) not in self.seen:
            self.seen.append(str(event.pk))


@pytest.fixture
def recorder():
    handler = Recorder()
    register_handler("test.thing.*", handler, module="test")
    yield handler
    unregister_handler(handler)


def test_emit_writes_the_row_with_target_and_dispatches_on_commit(ws, owner, recorder):
    event = emit(
        "test.thing.happened",
        workspace=ws,
        target_type="test.thing",
        target_id="6f1c2a8e-8a48-4cf3-9f3c-1d1f0f3e6a11",
        actor=owner,
        payload={"x": 1},
    )
    event.refresh_from_db()
    assert event.target_type == "test.thing"
    assert str(event.target_id) == "6f1c2a8e-8a48-4cf3-9f3c-1d1f0f3e6a11"
    assert event.processed_at is not None  # the test settings run on_commit work inline
    assert event.attempts == 1
    assert recorder.seen == [str(event.pk)]


def test_emit_inside_a_rolled_back_transaction_leaves_nothing(ws, recorder, monkeypatch):
    queued = []
    monkeypatch.setattr(transaction, "on_commit", lambda func, using=None, robust=False: queued.append(func))
    with pytest.raises(RuntimeError), transaction.atomic():
        emit("test.thing.happened", workspace=ws)
        assert DomainEvent.objects.filter(type="test.thing.happened").count() == 1
        raise RuntimeError("the business write failed")
    assert not DomainEvent.objects.filter(type="test.thing.happened").exists()
    assert recorder.calls == 0  # dispatch only runs on commit


def test_events_are_processed_once(ws, recorder, monkeypatch):
    monkeypatch.setattr(transaction, "on_commit", lambda func, using=None, robust=False: None)
    event = emit("test.thing.happened", workspace=ws)
    assert process_event(event.pk) is True
    assert process_event(event.pk) is False  # already processed: the handler doesn't run again
    assert recorder.calls == 1


def test_a_failure_records_attempts_and_error_and_retries_safely(ws, monkeypatch):
    monkeypatch.setattr(transaction, "on_commit", lambda func, using=None, robust=False: None)
    flaky = Recorder(fail_times=1)
    steady = Recorder()
    register_handler("test.thing.*", steady, module="test")
    register_handler("test.thing.happened", flaky, module="test")
    try:
        event = emit("test.thing.happened", workspace=ws)
        assert process_event(event.pk) is False
        event.refresh_from_db()
        assert event.processed_at is None
        assert event.attempts == 1
        assert "smtp down" in event.error
        assert event.pk in pending()
        call_command("process_outbox")  # the retry runs every handler again; they are idempotent
        event.refresh_from_db()
        assert event.processed_at is not None
        assert event.attempts == 2
        assert event.error == ""
        assert steady.seen == [str(event.pk)] and steady.calls == 2
        assert flaky.seen == [str(event.pk)]
    finally:
        unregister_handler(flaky)
        unregister_handler(steady)


def test_retries_stop_after_max_attempts(ws, monkeypatch):
    monkeypatch.setattr(transaction, "on_commit", lambda func, using=None, robust=False: None)
    event = emit("test.thing.happened", workspace=ws)
    DomainEvent.objects.filter(pk=event.pk).update(attempts=5)
    assert event.pk not in pending(max_attempts=5)


def test_unknown_event_types_are_marked_processed(ws):
    event = emit("something.new.happened", workspace=ws)
    event.refresh_from_db()
    assert event.processed_at is not None


def test_handlers_match_patterns_and_keep_their_module(recorder):
    entries = handlers_for("test.thing.happened")
    assert [(e.pattern, e.module) for e in entries if e.handler is recorder] == [("test.thing.*", "test")]
    assert not [e for e in handlers_for("other.thing.happened") if e.handler is recorder]


def test_event_type_registry_builds_the_preference_matrix():
    register_event_type("test.thing.happened", "Thing happened", {"in_app": True, "email": False}, "test", position=999)
    try:
        assert event_type("test.thing.happened").module == "test"
        rows = [t.key for t in preference_types()]
        assert rows[-1] == "test.thing.happened"
        assert "core.comment.mentioned" in rows and "core.comment.created" in rows
        from core.notifications.models import default_events

        assert default_events()["test.thing.happened"] == {
            "in_app": True,
            "email": False,
            "telegram": False,
            "sms": False,
            "push": False,
        }
    finally:
        unregister_event_type("test.thing.happened")
