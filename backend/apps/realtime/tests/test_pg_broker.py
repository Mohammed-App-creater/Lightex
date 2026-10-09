"""Postgres broker integration (docs/v2/33-dashboards-presence.md §8.1): a real LISTEN connection on the test database,
real commits, the listener thread. Every wait has a timeout, and the listener is stopped after each test."""

import json
import queue
import time

import psycopg
import pytest
from django.db import connection
from django.test import override_settings

from apps.common.testing import UserFactory, add_project_member, make_project, make_workspace
from apps.realtime.brokers import listen_conninfo
from apps.realtime.hub import WAKE, hub
from apps.realtime.models import RealtimeEvent
from apps.realtime.protocol import CHANNEL
from apps.realtime.services import publish

from .conftest import Stream, open_stream

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.realtime_pg]
TIMEOUT = 10


@pytest.fixture
def pg():
    with override_settings(REALTIME_BROKER="postgres"):
        owner = UserFactory()
        ws = make_workspace(owner, slug="platform")
        project = make_project(ws, owner, key="PRJ")
        sam = add_project_member(project, key="project_member")
        yield ws, project, sam
        hub.reset()


def _get(sub, timeout=TIMEOUT):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            item = sub.queue.get(timeout=0.2)
        except queue.Empty:
            continue
        if item is not WAKE:
            return item
        if sub.controls:
            return sub.controls.popleft()
    raise AssertionError("nothing arrived")


def _connect():
    info = listen_conninfo()
    return psycopg.connect(info, autocommit=True) if isinstance(info, str) else psycopg.connect(autocommit=True, **info)


def test_listener_receives_a_notify_from_another_connection(pg):
    ws, project, sam = pg
    sub = hub.subscribe(str(ws.pk), frozenset({str(project.pk)}), str(sam.pk))
    assert hub.listener is not None and hub.listener.up and not sub.degraded
    event = {"v": 1, "type": "project.changed", "ws": str(ws.pk), "projectId": str(project.pk), "data": {"areas": []}}
    with _connect() as other:
        other.execute("SELECT pg_notify(%s, %s)", [CHANNEL, json.dumps(event)])
    assert _get(sub) == event


def test_published_events_round_trip_through_listen(pg):
    ws, project, sam = pg
    sub = hub.subscribe(str(ws.pk), frozenset({str(project.pk)}), str(sam.pk))
    data = {"taskId": "t1", "key": "PRJ-1", "op": "updated", "version": 2, "fields": ["dueDate"]}
    publish("task.changed", workspace=ws, project=project, actor=sam, data=data)
    got = _get(sub)
    row = RealtimeEvent.objects.latest("id")
    assert got["id"] == str(row.pk) and got["type"] == "task.changed" and got["data"] == data
    assert got["actorId"] == str(sam.pk) and got["userId"] is None
    assert row.payload["data"] == data and "id" not in row.payload


def test_an_oversize_payload_is_sent_by_reference(pg):
    ws, project, sam = pg
    sub = hub.subscribe(str(ws.pk), frozenset({str(project.pk)}), str(sam.pk))
    big = {"taskId": "t1", "key": "PRJ-1", "op": "updated", "version": 2, "fields": ["x" * 40] * 300}
    publish("task.changed", workspace=ws, project=project, data=big)
    got = _get(sub)
    assert got["data"] == big and got["id"] == str(RealtimeEvent.objects.latest("id").pk)
    people = [{"user": {"id": str(i), "name": "n" * 60}} for i in range(150)]
    location = {"kind": "board", "id": str(project.pk)}
    publish(
        "presence.updated",
        workspace=ws,
        project=project,
        durable=False,
        data={"location": location, "people": people, "at": "x"},
    )
    volatile = _get(sub)
    assert volatile["type"] == "presence.updated" and "id" not in volatile and len(volatile["data"]["people"]) == 150


def test_user_targeted_events_reach_only_that_user(pg):
    ws, project, sam = pg
    mine = hub.subscribe(str(ws.pk), frozenset({str(project.pk)}), str(sam.pk))
    other = hub.subscribe(str(ws.pk), frozenset({str(project.pk)}), str(ws.pk))
    publish("inbox.changed", workspace=ws, user=sam, data={"unread": 4})
    assert _get(mine)["data"] == {"unread": 4}
    with pytest.raises(AssertionError):
        _get(other, timeout=0.5)


def test_reconnects_after_the_connection_is_killed_and_resets_streams(pg):
    ws, project, sam = pg
    sub = hub.subscribe(str(ws.pk), frozenset({str(project.pk)}), str(sam.pk))
    listener = hub.listener
    old_pid = listener.backend_pid
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_terminate_backend(%s)", [old_pid])
    reset = _get(sub)
    assert reset == {"v": 1, "type": "reset", "data": {"reason": "broker_restart"}}
    assert listener.up and listener.backend_pid != old_pid
    publish("project.changed", workspace=ws, project=project, data={"areas": ["labels"]})
    assert _get(sub)["type"] == "project.changed"  # listening again


def test_the_listener_closes_when_idle(pg):
    ws, project, sam = pg
    with override_settings(REALTIME_LISTENER_IDLE_SECONDS=0.1):
        sub = hub.subscribe(str(ws.pk), frozenset({str(project.pk)}), str(sam.pk))
        listener = hub.listener
        hub.unsubscribe(sub)
        listener.join(TIMEOUT)
        assert not listener.is_alive() and hub.listener is None
        # a new stream starts a new one
        hub.subscribe(str(ws.pk), frozenset({str(project.pk)}), str(sam.pk))
        assert hub.listener is not None and hub.listener is not listener and hub.listener.up


def test_a_stream_fans_out_through_listen_notify(pg):
    ws, project, sam = pg
    with override_settings(SSE_MAX_LIFETIME_SECONDS=10):
        stream = Stream(open_stream(sam))
        hello = stream.next()[1]["data"]["data"]
        assert "degraded" not in hello
        publish("project.changed", workspace=ws, project=project, data={"areas": ["sprints"]})
        (msg,) = stream.next_event()
        assert msg["event"] == "project.changed" and msg["data"]["data"] == {"areas": ["sprints"]}
        stream.close()


def test_a_listener_that_cannot_connect_marks_streams_degraded(pg):
    ws, project, sam = pg
    with override_settings(
        REALTIME_LISTEN_DATABASE_URL="postgres://nobody@127.0.0.1:1/none?connect_timeout=1",
        REALTIME_LISTEN_WAIT_SECONDS=5,
    ):
        sub = hub.subscribe(str(ws.pk), frozenset({str(project.pk)}), str(sam.pk))
        assert sub.degraded and not hub.listener.up
