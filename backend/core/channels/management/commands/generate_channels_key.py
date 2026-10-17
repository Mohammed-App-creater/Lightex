from django.core.management.base import BaseCommand

from core.channels.crypto import generate_key


class Command(BaseCommand):
    help = "Print a new Fernet key for CHANNELS_ENCRYPTION_KEY (board 38 §7.1). Put it first to rotate."

    def handle(self, *args, **options):
        self.stdout.write(f"CHANNELS_ENCRYPTION_KEY={generate_key()}")
