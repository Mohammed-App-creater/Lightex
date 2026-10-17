from django.core.management.base import BaseCommand
from django.db import transaction

from apps.channels import crypto
from apps.channels.models import SmsConnection, SmsVerification


class Command(BaseCommand):
    help = "Re-encrypt and re-hash every stored phone number with the first CHANNELS_ENCRYPTION_KEY (board 38 §7.1)."

    def handle(self, *args, **options):
        count = 0
        with transaction.atomic():
            for model in (SmsConnection, SmsVerification):
                for row in model.objects.select_for_update().iterator():
                    e164 = crypto.decrypt_phone(row.phone_enc)
                    if not e164:
                        continue
                    row.phone_enc = crypto.rotate_phone(row.phone_enc)
                    row.phone_hash = crypto.phone_hash(e164)
                    row.save(update_fields=["phone_enc", "phone_hash", "updated_at"])
                    count += 1
        self.stdout.write(self.style.SUCCESS(f"Rotated {count} phone numbers."))
