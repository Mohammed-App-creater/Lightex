"""Sends queued notification emails for people on hourly or daily delivery.

Schedule `--delivery hourly` every hour and `--delivery daily` once a day. v1 has no digest template,
so each queued notification is sent as its own designed email (see the final report).
"""

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.notifications.emails import queue_email
from apps.notifications.models import Notification


class Command(BaseCommand):
    help = "Send pending notification emails for users on hourly or daily delivery."

    def add_arguments(self, parser):
        parser.add_argument("--delivery", choices=["hourly", "daily"], required=True)

    def handle(self, *args, **options):
        pending = (
            Notification.objects.filter(
                email_pending=True, recipient__notification_preference__email_delivery=options["delivery"]
            )
            .select_related("recipient")
            .order_by("created_at")
        )
        sent = 0
        for n in pending:
            with transaction.atomic():
                queue_email(n.recipient.email, n.email_template, n.email_context)
                n.email_pending = False
                n.emailed_at = timezone.now()
                n.save(update_fields=["email_pending", "emailed_at", "updated_at"])
            sent += 1
        self.stdout.write(self.style.SUCCESS(f"Sent {sent} queued emails"))
