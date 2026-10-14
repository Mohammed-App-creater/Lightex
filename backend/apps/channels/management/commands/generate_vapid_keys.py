from django.core.management.base import BaseCommand

from apps.channels.providers.webpush import generate_vapid_keys


class Command(BaseCommand):
    help = "Print a new VAPID key pair for Web Push (board 38 §2.4). Rotating it drops every browser subscription."

    def handle(self, *args, **options):
        public, private = generate_vapid_keys()
        self.stdout.write(f"VAPID_PUBLIC_KEY={public}")
        self.stdout.write(f"VAPID_PRIVATE_KEY={private}")
