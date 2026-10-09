"""Realtime brokers (docs/v2/33-dashboards-presence.md §2.7): how an event leaves the process that published it.

- `PostgresBroker` (default): durable events are inserted under a global advisory lock and `pg_notify`-ed in the
  same short transaction, so ids follow commit order; volatile events are only notified. Both run on the normal
  (pooled) connection. Each process LISTENs on one **direct** connection (`REALTIME_LISTEN_DATABASE_URL`).
- `RedisBroker` (`REALTIME_BROKER=redis`): durable rows are still inserted in Postgres (replay), then `PUBLISH`.
- `LocalBroker` (tests, one process): rows are still inserted (replay), then dispatched in memory.

A payload too big for NOTIFY (over 7,500 bytes) is sent as `{"id", "ref": true}` and the listener reads the row.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

from django.conf import settings
from django.db import connection, connections, transaction

from .protocol import CHANNEL, LOCK_KEY, MAX_NOTIFY_BYTES, TARGET, dumps

#: Django OPTIONS keys that are not libpq connection parameters.
_NOT_LIBPQ = {"pool", "server_side_binding", "isolation_level", "assume_role", "cursor_factory", "context"}


def listen_conninfo() -> str | dict[str, Any]:
    """`REALTIME_LISTEN_DATABASE_URL`, or the default database's own settings (which follow `DATABASE_URL`)."""
    if settings.REALTIME_LISTEN_DATABASE_URL:
        return settings.REALTIME_LISTEN_DATABASE_URL
    db = connections["default"].settings_dict
    params: dict[str, Any] = {
        "dbname": db["NAME"],
        "user": db.get("USER") or None,
        "password": db.get("PASSWORD") or None,
        "host": db.get("HOST") or None,
        "port": db.get("PORT") or None,
    }
    params.update({k: v for k, v in (db.get("OPTIONS") or {}).items() if k not in _NOT_LIBPQ})
    return {k: v for k, v in params.items() if v not in (None, "")}


def _store(event: dict[str, Any]) -> int:
    """Inserts the event row under the advisory lock (call inside an atomic block). Returns its id."""
    from .models import RealtimeEvent

    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [LOCK_KEY])
    row = RealtimeEvent.objects.create(
        workspace_id=event["ws"],
        project_id=event.get("projectId"),
        user_id=event.get(TARGET),
        type=event["type"],
        payload={k: v for k, v in event.items() if k not in ("id", TARGET)},
    )
    return row.pk


def _notify(payload: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_notify(%s, %s)", [CHANNEL, payload])


def _wire(event: dict[str, Any], durable: bool) -> tuple[dict[str, Any], str]:
    """Stores durable events; returns the event (with its id) and the message to send (maybe a row reference)."""
    with transaction.atomic():
        if durable:
            event = {**event, "id": str(_store(event))}
        message = dumps(event)
        if len(message.encode()) > MAX_NOTIFY_BYTES:
            row_id = event["id"] if durable else str(_store(event))
            message = dumps({"id": row_id, "ref": True})
        return event, message


class Broker:
    needs_listener = False

    def send(self, event: dict[str, Any], *, durable: bool) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def listen(self) -> contextlib.AbstractContextManager[Any]:  # pragma: no cover - interface
        raise NotImplementedError


class LocalBroker(Broker):
    """One process: rows are stored for replay, then dispatched in memory (synchronously, after commit)."""

    def send(self, event: dict[str, Any], *, durable: bool) -> None:
        from .hub import hub

        if durable:
            with transaction.atomic():
                event = {**event, "id": str(_store(event))}
        hub.dispatch(event)


class PostgresBroker(Broker):
    needs_listener = True

    def send(self, event: dict[str, Any], *, durable: bool) -> None:
        with transaction.atomic():
            _, message = _wire(event, durable)
            _notify(message)  # delivered when this short transaction commits, in commit order

    @contextlib.contextmanager
    def listen(self) -> Iterator[_PgSource]:
        import psycopg

        info = listen_conninfo()
        conn = (
            psycopg.connect(info, autocommit=True)
            if isinstance(info, str)
            else psycopg.connect(autocommit=True, **info)
        )
        try:
            conn.execute(f"LISTEN {CHANNEL}")
            yield _PgSource(conn)
        finally:
            conn.close()


class _PgSource:
    def __init__(self, conn: Any):
        self.conn = conn
        self.pid = conn.info.backend_pid

    def poll(self, timeout: float) -> Iterator[str]:
        for notify in self.conn.notifies(timeout=timeout):
            yield notify.payload


class RedisBroker(Broker):
    needs_listener = True

    def _client(self) -> Any:
        import redis

        return redis.Redis.from_url(settings.REDIS_URL)

    def send(self, event: dict[str, Any], *, durable: bool) -> None:
        _, message = _wire(event, durable)
        self._client().publish(CHANNEL, message)

    @contextlib.contextmanager
    def listen(self) -> Iterator[_RedisSource]:
        client = self._client()
        pubsub = client.pubsub(ignore_subscribe_messages=True)
        try:
            pubsub.subscribe(CHANNEL)
            yield _RedisSource(pubsub)
        finally:
            pubsub.close()
            client.close()


class _RedisSource:
    pid = None

    def __init__(self, pubsub: Any):
        self.pubsub = pubsub

    def poll(self, timeout: float) -> Iterator[str]:
        message = self.pubsub.get_message(timeout=timeout)
        while message is not None:
            data = message.get("data")
            if isinstance(data, bytes):
                data = data.decode()
            if isinstance(data, str):
                yield data
            message = self.pubsub.get_message(timeout=0)


BROKERS: dict[str, type[Broker]] = {"local": LocalBroker, "postgres": PostgresBroker, "redis": RedisBroker}
_instances: dict[str, Broker] = {}


def broker() -> Broker:
    name = settings.REALTIME_BROKER
    if name not in _instances:
        if name not in BROKERS:
            raise ValueError(f"Unknown REALTIME_BROKER {name!r}; use postgres, redis or local")
        _instances[name] = BROKERS[name]()
    return _instances[name]
