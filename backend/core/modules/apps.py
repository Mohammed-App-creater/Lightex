from django.apps import AppConfig


class Config(AppConfig):
    name = "core.modules"
    label = "platform_modules"
    verbose_name = "Modules"

    def ready(self) -> None:
        from .core_module import DEFINITION
        from .registry import register_module

        register_module(DEFINITION)
