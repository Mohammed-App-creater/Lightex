"""Permanently deletes items that have been in the trash for more than TRASH_RETENTION_DAYS (30).

Schedule daily: `python manage.py purge_trash`. Also clears abandoned uploads (older than a day)
and processed outbox events past the retention window.
"""

from django.core.management.base import BaseCommand

from apps.audit.trash import purge_expired


class Command(BaseCommand):
    help = "Purge soft-deleted items older than the retention window."

    def handle(self, *args, **options):
        counts = purge_expired()
        summary = ", ".join(f"{v} {k}" for k, v in counts.items())
        self.stdout.write(self.style.SUCCESS(f"Purged: {summary}"))
