"""Board 40 recovery (§5.1), optional cron every minute: `python manage.py resume_imports`.

Re-dispatches queued/running imports whose runner stopped sending heartbeats (a restarted web process or worker).
The runner's lease makes a duplicate dispatch harmless. The I3 poll does the same for jobs someone is watching.
"""

from django.core.management.base import BaseCommand

from apps.imports.services import resume_stale


class Command(BaseCommand):
    help = "Resume import jobs whose runner died."

    def handle(self, *args, **options):
        count = resume_stale()
        self.stdout.write(self.style.SUCCESS(f"Resumed {count} import(s)."))
