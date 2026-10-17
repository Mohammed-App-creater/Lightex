"""gunicorn settings for the Lightex API (board 33: gthread workers for the realtime stream).

The Dockerfile CMD passes the worker flags (`--workers ${WEB_CONCURRENCY:-2} --worker-class gthread
--threads ${GUNICORN_THREADS:-24} …`); this file holds the shutdown hooks. On SIGTERM (a deploy) every open stream
ends with `reconnect` (`shutdown`) within `--graceful-timeout`, so clients reconnect with Last-Event-ID instead of
seeing a cut connection. docs/v2/33-dashboards-presence.md §2.7, §2.9.
"""

import signal


def _close_streams() -> None:
    try:
        from core.realtime.hub import hub

        hub.shutdown()
    except Exception:  # noqa: S110 - best effort while the worker exits
        pass


def post_worker_init(worker):
    """gunicorn registers its SIGTERM handler before this hook; chain ours in front of it."""
    previous = signal.getsignal(signal.SIGTERM)

    def on_term(signum, frame):
        _close_streams()
        if callable(previous):
            previous(signum, frame)

    signal.signal(signal.SIGTERM, on_term)
    _start_channel_sweeper()


def _start_channel_sweeper() -> None:
    """Board 38 §6.7: one event-driven sweeper per worker when channels send from a thread pool (no broker)."""
    try:
        from core.channels.runner import start_sweeper

        start_sweeper()
    except Exception:  # noqa: S110 - never stop a worker from booting over notifications
        pass


def worker_int(worker):
    _close_streams()


def worker_exit(server, worker):
    _close_streams()
