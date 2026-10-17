"""Celery app. With no broker configured, tasks run eagerly in-process (CELERY_TASK_ALWAYS_EAGER)."""

import os

from celery import Celery, signals

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

app = Celery("lightex")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()

_scope_tokens: dict = {}


@signals.task_prerun.connect
def _task_unscoped(task_id=None, **kwargs):
    """Celery tasks are given ids and run unscoped (core/common/scoping.py); restored after the task."""
    from core.common import scoping

    _scope_tokens[task_id] = scoping.push_unscoped()


@signals.task_postrun.connect
def _task_restore(task_id=None, **kwargs):
    from core.common import scoping

    tokens = _scope_tokens.pop(task_id, None)
    if tokens is not None:
        scoping.pop(tokens)
