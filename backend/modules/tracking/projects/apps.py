from django.apps import AppConfig


class Config(AppConfig):
    name = "modules.tracking.projects"
    label = "projects"

    def ready(self) -> None:
        from modules.tracking.hooks import register

        register()
