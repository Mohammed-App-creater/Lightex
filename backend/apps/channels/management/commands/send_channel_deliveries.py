from django.core.management.base import BaseCommand

from apps.channels.runner import sweep_and_send


class Command(BaseCommand):
    help = "One sweep of due channel deliveries (retries, quiet-hours releases), sent inline. Cron: every 5 min."

    def handle(self, *args, **options):
        self.stdout.write(f"Sent {sweep_and_send()} deliveries.")
