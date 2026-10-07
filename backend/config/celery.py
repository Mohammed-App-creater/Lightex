"""Celery app. With no broker configured, tasks run eagerly in-process (CELERY_TASK_ALWAYS_EAGER)."""

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

app = Celery("lightex")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
