from django.apps import AppConfig


class Config(AppConfig):
    name = "core.notifications"
    label = "notifications"

    def ready(self) -> None:
        from .handlers import register

        register()
