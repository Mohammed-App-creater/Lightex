from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.channels.providers.fake import FakeTelegram
from apps.channels.webhooks import handle_update


class Command(BaseCommand):
    help = "Dev only: simulate `/start <code>` from chat 999000 (@devbot_user) without a bot (board 38 §2.2)."

    def add_arguments(self, parser):
        parser.add_argument("code")

    def handle(self, *args, **options):
        if settings.TELEGRAM_BACKEND not in ("console", "fake"):
            raise CommandError("telegram_fake_start is for TELEGRAM_BACKEND=console or fake.")
        reply = handle_update(FakeTelegram.fake_update(f"/start {options['code']}"))
        self.stdout.write(reply.get("text", ""))
