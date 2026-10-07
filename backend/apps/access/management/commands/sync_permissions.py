from django.core.management.base import BaseCommand

from apps.access.services import sync_permission_catalogue


class Command(BaseCommand):
    help = "Sync the permission catalogue (defined in apps/access/catalogue.py) into the database."

    def handle(self, *args, **options):
        created, updated, removed = sync_permission_catalogue()
        self.stdout.write(
            self.style.SUCCESS(f"Permissions synced: {created} created, {updated} updated, {removed} removed")
        )
