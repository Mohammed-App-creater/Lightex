"""The per-process realtime hub (docs/v2/33-dashboards-presence.md §2.7).

One `Hub` per process (module singleton, thread-safe):

- **Admission.** At most `SSE_MAX_STREAMS_PER_PROCESS` streams hold a `Slot` at a time; the rest get 503.
- **Subscriptions.** Each stream owns a `Subscription` with a bounded queue. Fan-out is `put_nowait`; a full queue
  marks the subscription `overflowed` (its stream sends `reset` and `reconnect`). Nothing ever blocks the fan-out.
- **Listener thread.** For the `postgres` and `redis` brokers, a daemon thread holds the broker subscription (one
  direct LISTEN connection) while the process has streams, and closes it `REALTIME_LISTENER_IDLE_SECONDS` after the
  last one ends. It reconnects with backoff (1 to 30 s) and then sends `reset` (`broker_restart`) to every stream.
  While it runs it also does housekeeping: expired presence rows every 15 s, old events every 60 s.
- **Shutdown.** `shutdown()` (gunicorn hooks, atexit) wakes every stream so it ends with `reconnect` (`shutdown`).
"""

from __future__ import annotations

import atexit
import contextlib
import json
import logging
import queue
import threading
import time
import weakref
from collections import deque
from typing import Any

from django.conf import settings

from .protocol import TARGET, control, matches

logger = logging.getLogger("lightex.realtime")

#: Put on a queue to wake its stream (a control event or shutdown is pending).
WAKE = object()


class Slot:
    """One admitted stream. `release()` is idempotent; it also runs if the response is dropped unread."""

    def __init__(self, hub: Hub):
        self._released = [False]
        self._finalizer = weakref.finalize(self, Hub._release_slot, hub, self._released)

    def release(self) -> None:
        self._finalizer()


class Subscription:
    def __init__(self, workspace_id: str, project_ids: frozenset[str], user_id: str, maxsize: int):
        self.workspace_id = workspace_id
        self.project_ids = project_ids
        self.user_id = user_id
        self.queue: queue.Queue[Any] = queue.Queue(maxsize=maxsize)
        self.controls: deque[dict[str, Any]] = deque()
        self.overflowed = False
        self.degraded = False

    def wants(self, event: dict[str, Any]) -> bool:
        return matches(event, self.workspace_id, self.project_ids, self.user_id)

    def offer(self, event: Any) -> None:
        if self.overflowed:
            return
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            self.overflowed = True

    def signal(self, event: dict[str, Any] | None = None) -> None:
        """A control event (or just a wake-up) for this stream; never blocks."""
        if event is not None:
            self.controls.append(event)
        with contextlib.suppress(queue.Full):  # a full queue wakes its stream anyway
            self.queue.put_nowait(WAKE)


class Hub:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subs: set[Subscription] = set()
        self._active = 0
        self._idle_since = time.monotonic()
        self.listener: Listener | None = None
        self.closing = False

    # ── admission ──

    def admit(self) -> Slot | None:
        with self._lock:
            if self.closing or self._active >= settings.SSE_MAX_STREAMS_PER_PROCESS:
                return None
            self._active += 1
        return Slot(self)

    @staticmethod
    def _release_slot(hub: Hub, flag: list[bool]) -> None:
        with hub._lock:
            if not flag[0]:
                flag[0] = True
                hub._active = max(0, hub._active - 1)

    @property
    def active_streams(self) -> int:
        return self._active

    # ── subscriptions ──

    def subscribe(self, workspace_id: str, project_ids: frozenset[str], user_id: str) -> Subscription:
        from .brokers import broker

        sub = Subscription(workspace_id, project_ids, user_id, settings.SSE_QUEUE_SIZE)
        current = broker()
        with self._lock:
            self._subs.add(sub)
            listener = self.listener
            if current.needs_listener and (listener is None or not listener.is_alive()):
                listener = self.listener = Listener(self, current)
                listener.start()
        if listener is not None:
            listener.ready.wait(settings.REALTIME_LISTEN_WAIT_SECONDS)  # LISTEN before the replay query
            sub.degraded = not listener.up
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            self._subs.discard(sub)
            if not self._subs:
                self._idle_since = time.monotonic()

    def subscriptions(self) -> list[Subscription]:
        with self._lock:
            return list(self._subs)

    def release_listener_if_idle(self, listener: Listener) -> bool:
        """Called by the listener: stop when no stream has existed for the idle period."""
        with self._lock:
            idle = not self._subs and time.monotonic() - self._idle_since >= settings.REALTIME_LISTENER_IDLE_SECONDS
            if idle or self.closing:
                if self.listener is listener:
                    self.listener = None
                return True
        return False

    # ── fan-out ──

    def dispatch(self, event: dict[str, Any]) -> int:
        delivered = 0
        for sub in self.subscriptions():
            if sub.wants(event):
                sub.offer(event)
                delivered += 1
        return delivered

    def dispatch_payload(self, payload: str) -> None:
        """A broker message: the event (with `id` and `userId`), or `{"id", "ref": true}` for one too big to notify."""
        try:
            event = json.loads(payload)
        except ValueError:
            logger.warning("Ignoring a malformed realtime payload")
            return
        if isinstance(event, dict) and event.get("ref"):
            from .models import RealtimeEvent

            row = RealtimeEvent.objects.filter(pk=int(event.get("id") or 0)).first()
            if row is None:
                return
            event = {**row.payload, TARGET: str(row.user_id) if row.user_id else None}
            if row.type not in _volatile_types():
                event["id"] = str(row.pk)
        if isinstance(event, dict):
            self.dispatch(event)

    def broadcast_control(self, event: dict[str, Any]) -> None:
        for sub in self.subscriptions():
            sub.signal(event)

    # ── lifecycle ──

    def shutdown(self) -> None:
        """Every stream ends with `reconnect` (`shutdown`); new streams are refused."""
        self.closing = True
        for sub in self.subscriptions():
            sub.signal()
        listener = self.listener
        if listener is not None:
            listener.stop()

    def stop_listener(self, timeout: float = 10.0) -> None:
        listener = self.listener
        if listener is not None:
            listener.stop()
            listener.join(timeout)
        with self._lock:
            if self.listener is listener:
                self.listener = None

    def reset(self) -> None:
        """Tests: forget every stream, slot and listener."""
        self.stop_listener()
        with self._lock:
            self._subs.clear()
            self._active = 0
            self.closing = False
            self._idle_since = time.monotonic()


def _volatile_types() -> tuple[str, ...]:
    from .protocol import VOLATILE_TYPES

    return VOLATILE_TYPES


class Listener(threading.Thread):
    """Holds the broker subscription while the process has streams; also runs housekeeping."""

    def __init__(self, hub: Hub, broker: Any):
        super().__init__(name="lightex-realtime-listener", daemon=True)
        self.hub = hub
        self.broker = broker
        self.ready = threading.Event()  # set after the first connection attempt, success or not
        self.up = False
        self.backend_pid: int | None = None
        self._stop_event = threading.Event()

    def stop(self) -> None:
        self._stop_event.set()

    @property
    def stopping(self) -> bool:
        return self._stop_event.is_set()

    def run(self) -> None:
        backoff = settings.REALTIME_LISTENER_BACKOFF_SECONDS
        connected_before = False
        next_sweep = time.monotonic() + settings.REALTIME_SWEEP_SECONDS
        next_purge = time.monotonic() + settings.REALTIME_PURGE_SECONDS
        try:
            while not self.stopping:
                try:
                    with self.broker.listen() as source:
                        self.backend_pid = getattr(source, "pid", None)
                        self.up = True
                        self.ready.set()
                        if connected_before:
                            # Events may have been missed while the connection was down.
                            self.hub.broadcast_control(control("reset", {"reason": "broker_restart"}))
                        connected_before = True
                        backoff = settings.REALTIME_LISTENER_BACKOFF_SECONDS
                        while not self.stopping:
                            for payload in source.poll(settings.REALTIME_LISTEN_POLL_SECONDS):
                                self.hub.dispatch_payload(payload)
                            now = time.monotonic()
                            if now >= next_sweep:
                                next_sweep = now + settings.REALTIME_SWEEP_SECONDS
                                _housekeeping("sweep_presence")
                            if now >= next_purge:
                                next_purge = now + settings.REALTIME_PURGE_SECONDS
                                _housekeeping("purge_events")
                            if self.hub.release_listener_if_idle(self):
                                return
                except Exception:
                    self.up = False
                    self.ready.set()
                    if self.stopping:
                        return
                    logger.warning("Realtime listener lost its connection; retrying in %ss", backoff, exc_info=True)
                    self._stop_event.wait(backoff)
                    backoff = min(settings.REALTIME_LISTENER_BACKOFF_MAX_SECONDS, backoff * 2)
        finally:
            self.up = False
            _close_db()


def _housekeeping(name: str) -> None:
    from . import presence, services

    try:
        if name == "sweep_presence":
            presence.sweep_presence()
        else:
            services.purge_events()
    except Exception:
        logger.exception("Realtime housekeeping (%s) failed", name)
    finally:
        _close_db()


def _close_db() -> None:
    from django.db import connection

    try:
        connection.close()
    except Exception:  # pragma: no cover - best effort
        logger.debug("Closing the listener's database connection failed", exc_info=True)


hub = Hub()
atexit.register(hub.shutdown)
