"""Normalization for the duplicate check (`GET .../companies/check-duplicate`)."""

from __future__ import annotations

import re
import unicodedata

#: Legal-form words dropped from the end of a company name ("Abay Trading PLC" matches "abay trading").
LEGAL_SUFFIXES = frozenset(
    {
        "plc",
        "ltd",
        "limited",
        "llc",
        "inc",
        "incorporated",
        "co",
        "corp",
        "corporation",
        "company",
        "sc",
        "share",
        "pvt",
    }
)
PHONE_DIGITS = 9


def normalize_name(name: str | None) -> str:
    """Lower case, accents and punctuation removed, spaces collapsed, trailing legal-form words dropped. Never empties
    a name made only of legal words ("Company" stays "company")."""
    text = unicodedata.normalize("NFKD", name or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).casefold()
    text = text.replace("&", " and ").replace(".", "")  # "P.L.C." → "plc"
    words = re.sub(r"[^\w]+", " ", text).replace("_", " ").split()
    while len(words) > 1 and words[-1] in LEGAL_SUFFIXES:
        words.pop()
    return " ".join(words)[:200]


def normalize_phone(phone: str | None) -> str:
    """The last nine digits ("+251 911 22 33 44", "0911223344" and "911223344" all match); "" with fewer than seven
    digits (too short to compare)."""
    digits = re.sub(r"\D", "", phone or "")
    if len(digits) < 7:
        return ""
    return digits[-PHONE_DIGITS:]
