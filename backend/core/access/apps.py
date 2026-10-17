from django.apps import AppConfig
from django.db.models.signals import post_migrate


def _sync(sender, **kwargs):
    """The permission catalogue is synced after every migrate (fresh databases included); not a data migration."""
    from core.common.scoping import unscoped

    from .services import sync_permission_catalogue

    with unscoped():
        sync_permission_catalogue()


class Config(AppConfig):
    name = "core.access"
    label = "access"

    def ready(self) -> None:
        post_migrate.connect(_sync, sender=self, dispatch_uid="access-sync-permissions")
