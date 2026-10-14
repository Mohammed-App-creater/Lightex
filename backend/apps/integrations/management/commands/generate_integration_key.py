"""Board 37 §10.2: print a new `kid:base64url(32 bytes)` entry for INTEGRATIONS_ENCRYPTION_KEYS.

Put it first in the list to encrypt with it, keep the old entries until `rotate_integration_secrets` has run.
"""

from django.core.management.base import BaseCommand

from apps.integrations.crypto import generate_key


class Command(BaseCommand):
    help = "Generate an AES-256-GCM key for INTEGRATIONS_ENCRYPTION_KEYS."

    def add_arguments(self, parser):
        parser.add_argument("--kid", help="Key id (letters/digits); random when omitted")

    def handle(self, *args, **options):
        self.stdout.write(generate_key(options.get("kid")))
