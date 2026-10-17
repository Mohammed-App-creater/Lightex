"""Board 37 §3.4, §3.5 retention: webhook deliveries older than WEBHOOK_RETENTION_DAYS; expired connect attempts
(an attempt that expires after its callback revokes and deletes its pending integration)."""

from django.core.management.base import BaseCommand

from modules.tracking.integrations.services import purge


class Command(BaseCommand):
    help = "Delete old webhook deliveries and expired connect attempts."

    def handle(self, *args, **options):
        counts = purge()
        self.stdout.write(
            self.style.SUCCESS(f"Purged {counts['deliveries']} deliveries, expired {counts['attempts']} attempts")
        )
