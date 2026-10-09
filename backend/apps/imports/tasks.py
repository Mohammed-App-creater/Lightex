"""Celery entry point for the import runner (used when a broker is configured; see services.dispatch)."""

from celery import shared_task
from django.db import InterfaceError, OperationalError


@shared_task(bind=True, acks_late=True, max_retries=3, ignore_result=True)
def run_import(self, job_id: str) -> None:
    from . import runner

    try:
        runner.run(job_id, retries=0, raise_db_errors=True)
    except (OperationalError, InterfaceError) as exc:
        if self.request.retries >= self.max_retries:
            runner.fail_after_error(job_id)
            return
        raise self.retry(exc=exc, countdown=2**self.request.retries) from exc
