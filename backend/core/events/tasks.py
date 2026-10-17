from celery import shared_task


@shared_task
def process_event_task(event_id: str) -> None:
    from .services import process_event

    process_event(event_id)
