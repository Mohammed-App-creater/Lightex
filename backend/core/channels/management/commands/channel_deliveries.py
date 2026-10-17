import datetime as dt
import re

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.channels.models import ChannelDelivery


def _since(value: str) -> dt.datetime:
    match = re.fullmatch(r"(\d+)([dh])", value or "")
    if not match:
        raise CommandError("--since takes a duration like 7d or 12h")
    n, unit = int(match[1]), match[2]
    return timezone.now() - (dt.timedelta(days=n) if unit == "d" else dt.timedelta(hours=n))


class Command(BaseCommand):
    help = "Dead-letter operations (board 38 §6.8). Never prints message text or phone numbers."

    def add_arguments(self, parser):
        parser.add_argument("--dead", action="store_true", help="List dead deliveries")
        parser.add_argument("--since", default="7d")
        parser.add_argument("--retry", metavar="ID", help="Queue one delivery again")
        parser.add_argument("--retry-dead", action="store_true", help="Queue every dead delivery since --since")

    def handle(self, *args, **options):
        since = _since(options["since"])
        if options["retry"] or options["retry_dead"]:
            qs = (
                ChannelDelivery.objects.filter(pk=options["retry"])
                if options["retry"]
                else ChannelDelivery.objects.filter(status="dead", updated_at__gte=since)
            )
            n = qs.update(status="queued", attempts=0, next_attempt_at=timezone.now(), lease_until=None)
            self.stdout.write(f"Queued {n} deliveries again.")
            return
        rows = ChannelDelivery.objects.filter(status="dead", updated_at__gte=since).order_by("-updated_at")
        for row in rows.values("id", "user_id", "channel", "template", "error_code"):
            self.stdout.write(
                f"{row['id']} user={row['user_id']} {row['channel']} {row['template']} {row['error_code']}"
            )
        self.stdout.write(f"{rows.count()} dead deliveries.")
