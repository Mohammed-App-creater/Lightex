import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.channels.providers import get_telegram
from apps.channels.webhooks import handle_update


class Command(BaseCommand):
    help = "Dev only: delete the webhook and long-poll getUpdates into the webhook handler (board 38 §2.2)."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="One poll, then exit")

    def handle(self, *args, **options):
        if settings.TELEGRAM_BACKEND != "bot":
            raise CommandError("telegram_poll needs TELEGRAM_BACKEND=bot (a dev bot token).")
        bot = get_telegram()
        bot.delete_webhook()
        self.stdout.write("Polling Telegram; run telegram_setup again before going back to the webhook.")
        offset = None
        while True:
            for update in bot.get_updates(offset, timeout=0 if options["once"] else 30):
                offset = int(update["update_id"]) + 1
                reply = handle_update(update)
                if reply.get("method") == "sendMessage":
                    bot.send_message(reply["chat_id"], reply["text"], button=None)
                self.stdout.write(json.dumps({"update": update.get("update_id"), "replied": bool(reply)}))
            if options["once"]:
                return
