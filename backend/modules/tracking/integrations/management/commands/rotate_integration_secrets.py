"""Board 37 §10.1, §10.2: re-encrypt every secret with the first INTEGRATIONS_ENCRYPTION_KEYS key; with
`--webhooks`, also give every GitLab integration a new webhook secret and update its project hooks."""

import secrets

from django.core.management.base import BaseCommand
from django.db import transaction

from modules.tracking.integrations.crypto import DecryptionError, keys, kid_of
from modules.tracking.integrations.models import ConnectAttempt, Integration
from modules.tracking.integrations.providers.base import ProviderError, get_provider


class Command(BaseCommand):
    help = "Re-encrypt integration credentials with the current key (and optionally rotate GitLab hook secrets)."

    def add_arguments(self, parser):
        parser.add_argument("--webhooks", action="store_true", help="Rotate GitLab webhook secrets too")

    def handle(self, *args, **options):
        current = keys()[0][0]
        count = 0
        with transaction.atomic():
            for model, fields in (
                (Integration, ("credentials", "webhook_secret")),
                (ConnectAttempt, ("pkce_verifier",)),
            ):
                for row in model.objects.select_for_update():
                    changed = []
                    for field in fields:
                        value = getattr(row, field)
                        if value and kid_of(value) != current:
                            try:
                                row.set_secret(field, row.get_secret(field))
                            except DecryptionError:
                                self.stderr.write(f"{model.__name__} {row.pk}: {field} can't be decrypted; skipped")
                                continue
                            changed.append(field)
                    if changed:
                        row.save(update_fields=[*changed, "updated_at"])
                        count += 1
        rotated = 0
        if options["webhooks"]:
            for integration in Integration.objects.filter(provider="gitlab", status__in=("active", "error")):
                integration.set_secret("webhook_secret", secrets.token_urlsafe(32))
                provider = get_provider("gitlab")
                for repo in integration.repositories.exclude(hook_id=""):
                    try:
                        provider.disable_repository(integration, repo)
                        provider.enable_repository(integration, repo)
                        repo.save(update_fields=["hook_id", "updated_at"])
                    except ProviderError:
                        self.stderr.write(f"Could not update the hook of {repo.full_path}")
                integration.save(update_fields=["webhook_secret", "updated_at"])
                rotated += 1
        self.stdout.write(self.style.SUCCESS(f"Re-encrypted {count} rows; rotated {rotated} webhook secrets"))
