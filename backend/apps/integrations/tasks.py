"""Celery entry point (used when a broker is configured; see runner.dispatch)."""

from celery import shared_task
from django.db import InterfaceError, OperationalError


@shared_task(acks_late=True, autoretry_for=(OperationalError, InterfaceError), max_retries=3, ignore_result=True)
def drain() -> None:
    from . import runner

    runner.drain()
