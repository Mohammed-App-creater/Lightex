"""Board 37 §7.3: drain webhook deliveries and sync runs, enqueue catch-ups, check token expiry, purge.

Run every 5 minutes where cron exists (compose `worker` profile, a paid Render cron). Without cron, webhooks and
page loads keep the queue moving (§7.6).
"""

from django.core.management.base import BaseCommand

from apps.integrations import runner, services


class Command(BaseCommand):
    help = "Process pending integration work (deliveries, sync runs, catch-ups) and purge old rows."

    def add_arguments(self, parser):
        parser.add_argument("--check-tokens", action="store_true", help="Also mark expired GitLab tokens")

    def handle(self, *args, **options):
        expired = services.check_tokens() if options["check_tokens"] else 0
        queued = services.enqueue_catchups()
        handled = runner.drain()
        purged = services.purge()
        self.stdout.write(
            self.style.SUCCESS(
                f"Integrations: {handled} items processed, {queued} catch-ups queued, {expired} tokens expired, "
                f"{purged['deliveries']} deliveries and {purged['attempts']} attempts purged"
            )
        )
