from django.apps import AppConfig


class AccountsConfig(AppConfig):
    name = "core.accounts"
    label = "accounts"

    def ready(self) -> None:
        from . import schema  # noqa: F401 - registers the OpenAPI bearer scheme
