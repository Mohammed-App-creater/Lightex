import logging
import re

from django.apps import AppConfig

_PHONE = re.compile(r"\+\d{8,15}")


class NoPhoneNumbers(logging.Filter):
    """Board 38 §7.1, defence in depth: drop any channels log record that contains an E.164 number."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            return not _PHONE.search(record.getMessage())
        except Exception:
            return True


class ChannelsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.channels"
    label = "channels"

    def ready(self) -> None:
        for name in ("lightex.channels", "lightex.channels.console", "lightex.channels.webhooks"):
            logger = logging.getLogger(name)
            if not any(isinstance(f, NoPhoneNumbers) for f in logger.filters):
                logger.addFilter(NoPhoneNumbers())
