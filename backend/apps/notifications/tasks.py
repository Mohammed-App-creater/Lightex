import logging

from celery import shared_task
from django.conf import settings
from django.core.mail import EmailMultiAlternatives

from .emails import render_email

logger = logging.getLogger("lightex.email")


@shared_task(bind=True, max_retries=3, default_retry_delay=60)
def send_email_task(self, to: str, template: str, context: dict) -> None:
    subject, html_body, text = render_email(template, context)
    message = EmailMultiAlternatives(subject=subject, body=text, from_email=settings.DEFAULT_FROM_EMAIL, to=[to])
    message.attach_alternative(html_body, "text/html")
    try:
        message.send()
    except Exception as exc:
        logger.warning("Email to %s failed: %s", to, exc)
        if not settings.CELERY_TASK_ALWAYS_EAGER:
            raise self.retry(exc=exc) from exc
