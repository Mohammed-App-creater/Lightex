from django.apps import AppConfig


class Config(AppConfig):
    name = "modules.sales"
    label = "sales"
    verbose_name = "Sales"

    def ready(self) -> None:
        from core.modules.registry import register_module

        from .module import DEFINITION

        register_module(DEFINITION)
