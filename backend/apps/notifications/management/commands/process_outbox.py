"""Processes outbox events that weren't handled yet (worker down, transient failure)."""

from django.core.management.base import BaseCommand

from apps.notifications.handlers import process_event
from apps.notifications.models import DomainEvent


class Command(BaseCommand):
    help = "Process unhandled domain events (retries failed ones up to --max-attempts)."

    def add_arguments(self, parser):
        parser.add_argument("--max-attempts", type=int, default=5)
        parser.add_argument("--limit", type=int, default=1000)

    def handle(self, *args, **options):
        ids = list(
            DomainEvent.objects.filter(processed_at__isnull=True, attempts__lt=options["max_attempts"])
            .order_by("created_at")
            .values_list("pk", flat=True)[: options["limit"]]
        )
        done = sum(1 for pk in ids if process_event(pk))
        self.stdout.write(self.style.SUCCESS(f"Processed {done} of {len(ids)} pending events"))
