from django.apps import AppConfig
from django.db.models.signals import post_migrate


def _sync(sender, **kwargs):
    from .services import sync_permission_catalogue

    sync_permission_catalogue()


class Config(AppConfig):
    name = "apps.access"
    label = "access"

    def ready(self) -> None:
        post_migrate.connect(_sync, sender=self, dispatch_uid="access-sync-permissions")
