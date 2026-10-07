"""Due-soon reminders. Run daily (cron / platform scheduler): `python manage.py send_due_soon`.

Creates one `due_soon` event per open, assigned task due tomorrow (or today with --today). Re-running
on the same day is safe: a task already reminded for its current due date is skipped.
"""

import datetime as dt

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.notifications.events import emit
from apps.notifications.models import DomainEvent
from apps.tasks.models import Task


class Command(BaseCommand):
    help = "Emit due-soon reminders for open tasks due tomorrow."

    def add_arguments(self, parser):
        parser.add_argument("--today", action="store_true", help="Remind about tasks due today instead of tomorrow")

    def handle(self, *args, **options):
        today = timezone.now().date()
        target = today if options["today"] else today + dt.timedelta(days=1)
        relative = "today" if options["today"] else "tomorrow"
        tasks = (
            Task.objects.filter(
                due_date=target,
                assignee__isnull=False,
                project__deleted_at__isnull=True,
                project__status="active",
                project__workspace__deleted_at__isnull=True,
            )
            .exclude(status__category="done")
            .select_related("project")
        )
        sent = 0
        for task in tasks:
            already = DomainEvent.objects.filter(
                type="due_soon", payload__taskId=str(task.pk), payload__dueDate=target.isoformat()
            ).exists()
            if already:
                continue
            with transaction.atomic():
                emit(
                    "due_soon",
                    workspace=task.project.workspace_id,
                    project=task.project_id,
                    payload={"taskId": str(task.pk), "dueDate": target.isoformat(), "relative": relative},
                )
            sent += 1
        self.stdout.write(self.style.SUCCESS(f"Due-soon reminders queued: {sent}"))
