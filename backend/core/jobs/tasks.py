from typing import Any

from celery import shared_task


@shared_task(name="core.jobs.run_job")
def run_job_task(name: str, workspace_id: str | None = None) -> dict[str, Any]:
    """The Celery entry point (beat may schedule it): the same runner as `manage.py run_job`."""
    from .services import run_job

    return run_job(name, workspace_id=workspace_id).as_dict()
