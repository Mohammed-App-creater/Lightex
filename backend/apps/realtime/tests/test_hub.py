"""Hub, brokers and protocol units (no streams)."""

import json

import pytest
from django.test import override_settings

from apps.realtime import brokers, protocol
from apps.realtime.hub import WAKE, Hub, Subscription
from apps.realtime.models import RealtimeEvent

pytestmark = pytest.mark.django_db


def test_slots_release_once():
    hub = Hub()
    with override_settings(SSE_MAX_STREAMS_PER_PROCESS=2):
        a, b = hub.admit(), hub.admit()
        assert a and b and hub.admit() is None and hub.active_streams == 2
        a.release()
        a.release()
        assert hub.active_streams == 1
        assert hub.admit() is not None


def test_subscription_overflow_and_wake():
    sub = Subscription("ws", frozenset({"p"}), "u", 1)
    sub.offer({"n": 1})
    sub.offer({"n": 2})
    assert sub.overflowed and sub.queue.qsize() == 1
    sub.offer({"n": 3})  # ignored once overflowed
    sub.signal({"type": "reset"})  # never blocks, even on a full queue
    assert list(sub.controls) == [{"type": "reset"}]
    fresh = Subscription("ws", frozenset(), "u", 2)
    fresh.signal()
    assert fresh.queue.get_nowait() is WAKE


@pytest.mark.parametrize(
    ("event", "delivered"),
    [
        ({"ws": "w1", "projectId": "p1", "userId": None}, True),
        ({"ws": "w1", "projectId": "p2", "userId": None}, False),
        ({"ws": "w2", "projectId": "p1", "userId": None}, False),
        ({"ws": "w1", "projectId": None, "userId": "u1"}, True),
        ({"ws": "w1", "projectId": "p1", "userId": "u2"}, False),  # a target wins over the project
        ({"ws": "w1", "projectId": None, "userId": None}, False),
    ],
)
def test_matching(event, delivered):
    assert protocol.matches(event, "w1", frozenset({"p1"}), "u1") is delivered


def test_dispatch_payload(world):
    hub = Hub()
    sub = Subscription(str(world.ws.pk), frozenset({str(world.project.pk)}), str(world.sam.pk), 10)
    hub._subs.add(sub)
    hub.dispatch_payload("{not json")
    hub.dispatch_payload(json.dumps({"id": "999999999", "ref": True}))  # a purged row
    assert sub.queue.empty()
    event = protocol.envelope("task.changed", workspace=world.ws, project=world.project, data={"taskId": "t"})
    with override_settings(REALTIME_BROKER="local"):
        brokers._wire(event, True)
    row = RealtimeEvent.objects.latest("id")
    hub.dispatch_payload(json.dumps({"id": str(row.pk), "ref": True}))
    got = sub.queue.get_nowait()
    assert got["id"] == str(row.pk) and got["data"] == {"taskId": "t"} and got["userId"] is None


def test_frames():
    event = {"v": 1, "type": "task.changed", "id": 7, "data": {"a": "é"}, "userId": "secret"}
    text = protocol.frame(event).decode()
    assert text.startswith("id: 7\nevent: task.changed\ndata: {") and text.endswith("}\n\n")
    assert "secret" not in text and "é" in text
    assert (
        protocol.frame(protocol.control("hello", {})).decode()
        == 'event: hello\ndata: {"v":1,"type":"hello","data":{}}\n\n'
    )
    assert protocol.retry() == b"retry: 3000\n\n"


def test_listen_conninfo():
    with override_settings(REALTIME_LISTEN_DATABASE_URL="postgres://u:p@direct.example/db?sslmode=require"):
        assert brokers.listen_conninfo() == "postgres://u:p@direct.example/db?sslmode=require"
    info = brokers.listen_conninfo()
    assert isinstance(info, dict) and info["dbname"].startswith("test_")


def test_unknown_broker():
    with override_settings(REALTIME_BROKER="carrier-pigeon"), pytest.raises(ValueError):
        brokers.broker()


class FakeRedis:
    published: list = []

    @classmethod
    def from_url(cls, url):
        return cls()

    def publish(self, channel, message):
        self.published.append((channel, message))

    def pubsub(self, **kwargs):
        return FakePubSub()

    def close(self):
        pass


class FakePubSub:
    def __init__(self):
        self.messages = [{"data": b'{"a":1}'}, {"data": 1}, {"data": "plain"}]

    def subscribe(self, channel):
        self.channel = channel

    def get_message(self, timeout=None):
        return self.messages.pop(0) if self.messages else None

    def close(self):
        pass


def test_redis_broker_stores_and_publishes(world, monkeypatch):
    import redis

    monkeypatch.setattr(redis, "Redis", FakeRedis)
    FakeRedis.published.clear()
    broker = brokers.RedisBroker()
    event = protocol.envelope("project.changed", workspace=world.ws, project=world.project, data={"areas": []})
    broker.send(event, durable=True)
    ((channel, message),) = FakeRedis.published
    assert channel == protocol.CHANNEL and json.loads(message)["id"] == str(RealtimeEvent.objects.latest("id").pk)
    with broker.listen() as source:
        assert list(source.poll(0.1)) == ['{"a":1}', "plain"]


def test_local_broker_dispatches_volatile_events_without_storing(world):
    from apps.realtime.hub import hub

    sub = hub.subscribe(str(world.ws.pk), frozenset({str(world.project.pk)}), str(world.sam.pk))
    event = protocol.envelope("presence.updated", workspace=world.ws, project=world.project, data={})
    brokers.LocalBroker().send(event, durable=False)
    assert sub.queue.get_nowait()["type"] == "presence.updated"
    assert not RealtimeEvent.objects.exists()
