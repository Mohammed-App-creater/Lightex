from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.channels.providers import get_telegram


class Command(BaseCommand):
    help = "Register the Telegram webhook and bot commands (board 38 §2.2). Idempotent; run once per deploy."

    def add_arguments(self, parser):
        parser.add_argument("--delete", action="store_true", help="Remove the webhook")
        parser.add_argument("--info", action="store_true", help="Print getWebhookInfo")

    def handle(self, *args, **options):
        if settings.TELEGRAM_BACKEND == "disabled":
            raise CommandError("Telegram is disabled (set TELEGRAM_BOT_TOKEN or TELEGRAM_BACKEND).")
        bot = get_telegram()
        if options["info"]:
            info = bot.webhook_info()
            self.stdout.write(
                f"url={info.get('url', '')} pending={info.get('pending_update_count', 0)} "
                f"last_error={info.get('last_error_message', '')}"
            )
            return
        if options["delete"]:
            bot.delete_webhook()
            self.stdout.write("Webhook removed.")
            return
        me = bot.get_me()
        if settings.TELEGRAM_BOT_USERNAME and me.get("username") != settings.TELEGRAM_BOT_USERNAME:
            raise CommandError(f"The token belongs to @{me.get('username')}, not @{settings.TELEGRAM_BOT_USERNAME}.")
        secret = settings.TELEGRAM_WEBHOOK_SECRET
        if not secret:
            raise CommandError("TELEGRAM_WEBHOOK_SECRET is required.")
        url = f"{settings.API_PUBLIC_URL}/api/v1/webhooks/telegram"
        bot.set_webhook(url, secret)
        self.stdout.write(self.style.SUCCESS(f"Webhook set to {url}."))
