"""The SMS country table and phone validation (docs/v2/38-telegram-sms-push.md §5.6). Vectors shared with the mock:
`tests/data/phone_vectors.json`."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from django.conf import settings


@dataclass(frozen=True)
class Country:
    code: str
    dial: str
    label: str
    digits: int
    pattern: str
    mobile: Callable[[str], bool]

    def public(self) -> dict:
        return {
            "code": self.code,
            "dial": self.dial,
            "label": self.label,
            "digits": self.digits,
            "pattern": self.pattern,
        }


TABLE: dict[str, Country] = {
    c.code: c
    for c in (
        Country("US", "+1", "US +1", 10, "(XXX) XXX-XXXX", lambda n: n[0] in "23456789" and n[3] in "23456789"),
        Country("GB", "+44", "UK +44", 10, "XXXX XXXXXX", lambda n: n.startswith("7")),
        Country("DE", "+49", "DE +49", 11, "XXX XXXXXXXX", lambda n: n[:2] in ("15", "16", "17")),
        Country("IN", "+91", "IN +91", 10, "XXXXX XXXXX", lambda n: n[0] in "6789"),
    )
}
UNAVAILABLE = "SMS isn’t available for this country"


def allowed_countries() -> list[Country]:
    return [TABLE[c] for c in settings.SMS_COUNTRIES if c in TABLE]


def format_pattern(digits: str, pattern: str) -> str:
    out = []
    i = 0
    for ch in pattern:
        if i >= len(digits):
            break
        if ch == "X":
            out.append(digits[i])
            i += 1
        else:
            out.append(ch)
    return "".join(out)


@dataclass
class Checked:
    ok: bool
    e164: str = ""
    national: str = ""
    display: str = ""
    field: str = ""
    error: str = ""
    country: Country | None = None


def validate(country: str, national: str, allowed: Iterable[str] | None = None) -> Checked:
    codes = set(allowed if allowed is not None else settings.SMS_COUNTRIES)
    rule = TABLE.get(str(country or "").upper())
    if rule is None or rule.code not in codes:
        return Checked(False, field="country", error=UNAVAILABLE)
    digits = re.sub(r"\D", "", str(national or ""))
    if digits.startswith("0"):
        digits = digits[1:]
    if len(digits) != rule.digits:
        return Checked(False, field="nationalNumber", error=f"Enter {rule.digits} digits")
    if not rule.mobile(digits):
        return Checked(False, field="nationalNumber", error="Enter a mobile number")
    return Checked(
        True,
        e164=rule.dial + digits,
        national=digits,
        display=display(rule, digits),
        country=rule,
    )


def display(rule: Country, national: str) -> str:
    return f"{rule.dial} {format_pattern(national, rule.pattern)}"


def display_e164(country: str, e164: str) -> str:
    rule = TABLE.get(country)
    if rule is None or not e164.startswith(rule.dial):
        return e164
    return display(rule, e164[len(rule.dial) :])
