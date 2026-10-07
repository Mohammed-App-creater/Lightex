"""Transactional email built from the designed templates in templates/emails/*.html.

Templates use Django's autoescaping, so every merge value is escaped. Plain-text alternatives are
derived from the rendered HTML. Sending goes through a Celery task (inline when no broker).
"""

from __future__ import annotations

import html
import re
from typing import Any

from django.conf import settings
from django.db import transaction
from django.template.loader import render_to_string
from django.utils.html import strip_tags

TEMPLATES = {
    "invitation",
    "password_reset",
    "task_assigned",
    "mentioned",
    "due_soon",
    "sprint_started",
    "sprint_completed",
}

_ANCHOR = re.compile(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S | re.I)

PRIORITY_LABEL = {0: "No priority", 1: "Low", 2: "Medium", 3: "High", 4: "Urgent"}
PRIORITY_COLOR = {0: "#8794B6", 1: "#8794B6", 2: "#3B7BFF", 3: "#E58A00", 4: "#E5484D"}


def base_context(workspace_slug: str | None = None) -> dict[str, Any]:
    prefs = (
        f"{settings.FRONTEND_URL}/{workspace_slug}/settings/notifications" if workspace_slug else settings.FRONTEND_URL
    )
    return {"company_address": settings.COMPANY_ADDRESS, "preferences_url": prefs, "unsubscribe_url": prefs}


def render_email(template: str, context: dict[str, Any]) -> tuple[str, str, str]:
    if template not in TEMPLATES:
        raise ValueError(f"Unknown email template {template}")
    body = render_to_string(f"emails/{template}.html", context)
    match = re.search(r"<title>(.*?)</title>", body, re.S)
    subject = html.unescape(match.group(1).strip()) if match else "Lightex"
    text_part = re.sub(r"<(style|head)[^>]*>.*?</\1>", "", body, flags=re.S | re.I)
    text_part = re.sub(r"<!--.*?-->", "", text_part, flags=re.S)
    text_part = _ANCHOR.sub(lambda m: f"{strip_tags(m.group(2)).strip()} ({m.group(1)})", text_part)
    text = html.unescape(strip_tags(text_part))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return subject, body, text


def queue_email(to: str, template: str, context: dict[str, Any]) -> None:
    """Sends after the current transaction commits (never for rolled-back work)."""
    from .tasks import send_email_task

    transaction.on_commit(lambda: send_email_task.delay(to, template, context))
