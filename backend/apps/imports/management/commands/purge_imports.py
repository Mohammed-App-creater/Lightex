"""Board 40 retention (§2.5). Schedule daily, next to purge_trash: `python manage.py purge_imports`.

Untouched drafts (24 h) are canceled; jobs whose `expires_at` passed (30 days after they finished) lose their
storage objects (source file, parsed rows, error report) and then their row. Imported tasks, labels and epics stay.
"""

from django.core.management.base import BaseCommand

from apps.imports.services import purge_expired


class Command(BaseCommand):
    help = "Delete expired import jobs and their files."

    def handle(self, *args, **options):
        counts = purge_expired()
        summary = ", ".join(f"{v} {k}" for k, v in counts.items())
        self.stdout.write(self.style.SUCCESS(f"Purged imports: {summary}"))
