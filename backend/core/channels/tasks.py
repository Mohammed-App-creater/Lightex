from celery import shared_task


@shared_task
def send_delivery_task(delivery_id: str) -> None:
    """CHANNEL_DISPATCH=celery: one task per delivery row (docs/v2/38-telegram-sms-push.md §6.7)."""
    from .runner import send_delivery

    send_delivery(delivery_id)
