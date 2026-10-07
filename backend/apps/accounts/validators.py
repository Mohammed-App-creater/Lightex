import re

from django.core.exceptions import ValidationError


class CharacterClassValidator:
    """Mirrors the client's strength meter: 8+ characters and two of mixed case, digits, symbols."""

    message = "Choose a stronger password: mix upper and lower case, numbers or symbols."

    def validate(self, password: str, user=None) -> None:
        classes = [
            bool(re.search(r"[a-z]", password) and re.search(r"[A-Z]", password)),
            bool(re.search(r"\d", password)),
            bool(re.search(r"[^A-Za-z0-9]", password)),
        ]
        if sum(classes) < 2:
            raise ValidationError(self.message, code="password_too_weak")

    def get_help_text(self) -> str:
        return self.message
