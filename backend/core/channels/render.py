"""Message rendering (docs/v2/38-telegram-sms-push.md §6.3–§6.5), always at send time from `template` + `context`.

Templates live in `templates/channels/<template>.<channel>.txt`. Telegram renders with autoescape on (the markup is
`<b>`/`<i>` written in the template); SMS and push render with autoescape off. Every context value passes through
`plain()` first. SMS never contains a task title, comment text or project name: its templates don't use those tags.
A push template renders two lines: the title, then the body.
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any
from urllib.parse import urlsplit

from django.conf import settings
from django.template.loader import render_to_string

TEMPLATES = ("assigned", "mentioned", "status_change", "comment", "due_soon", "sprint_started", "summary", "test")
BUTTON = {"sprint_started": "Open board", "summary": "Open inbox"}

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f​-‏ -‮⁦-⁩]")
_SPACE = re.compile(r"\s+")

# GSM 03.38 basic set (1 septet) and extension table (2 septets).
GSM_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿"
    "abcdefghijklmnopqrstuvwxyzäöñüà"
)
GSM_EXT = set("^{}\\[~]|€\f")


def plain(value: Any) -> Any:
    """Strips control characters and collapses whitespace (strings only)."""
    if not isinstance(value, str):
        return value
    return _SPACE.sub(" ", _CONTROL.sub("", value)).strip()


def truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def septets(text: str) -> int | None:
    """GSM-7 length, or None when the text needs UCS-2."""
    total = 0
    for ch in text:
        if ch in GSM_BASIC:
            total += 1
        elif ch in GSM_EXT:
            total += 2
        else:
            return None
    return total


def gsm_fold(value: str) -> str:
    """ASCII-folds with NFKD; returns "" when characters outside GSM-7 remain."""
    folded = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return folded if folded and septets(folded) is not None else ""


def first_word(name: str) -> str:
    return (name or "").split(" ")[0]


def prepare(context: dict[str, Any]) -> dict[str, Any]:
    ctx = {k: plain(v) for k, v in (context or {}).items()}
    ctx["task_title"] = truncate(str(ctx.get("task_title") or ""), 200)
    ctx["comment_excerpt"] = truncate(str(ctx.get("comment_excerpt") or ""), 140)
    ctx["priority_shown"] = ctx.get("priority") if ctx.get("priority") in ("High", "Urgent") else ""
    ctx.setdefault("actor_name", ctx.get("assigner_name") or ctx.get("author_name") or "")
    ctx["actor_first"] = gsm_fold(first_word(str(ctx.get("actor_name") or "")))
    items = ctx.get("items") or []
    ctx["items"] = items[:3]
    ctx["more"] = max(0, int(ctx.get("count") or 0) - len(ctx["items"]))
    return ctx


def _lines(text: str) -> str:
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def https_front() -> bool:
    return settings.FRONTEND_URL.startswith("https://")


def telegram(template: str, context: dict[str, Any]) -> tuple[str, tuple[str, str] | None]:
    ctx = prepare(context)
    text = _lines(render_to_string(f"channels/{template}.telegram.txt", ctx))[:4000]
    url = str(ctx.get("cta_url") or "")
    if not url or template == "test":
        return text, None
    label = BUTTON.get(template) or f"Open {ctx.get('task_key') or 'Lightex'}"
    if https_front() and url.startswith("https://"):
        return text, (label, url)
    return f"{text}\n{url}", None


def sms(template: str, context: dict[str, Any]) -> str:
    """≤ 160 GSM-7 septets: drop the actor's name when over; never more than 2 segments (306 septets)."""
    ctx = prepare(context)
    for k in ("sprint_name", "to_status", "project_key", "due_relative"):
        if isinstance(ctx.get(k), str):
            ctx[k] = gsm_fold(ctx[k]) or ctx[k]
    text = render_to_string(f"channels/{template}.sms.txt", ctx).strip()
    if (septets(text) or 999) > 160 and ctx.get("actor_first"):
        ctx["actor_first"] = ""
        text = render_to_string(f"channels/{template}.sms.txt", ctx).strip()
    return text[:306]


def otp_sms(code: str) -> str:
    host = urlsplit(settings.FRONTEND_URL).netloc
    return render_to_string("channels/otp.sms.txt", {"code": code, "host": host}).strip()


def push(template: str, context: dict[str, Any]) -> tuple[str, str]:
    ctx = prepare(context)
    rendered = render_to_string(f"channels/{template}.push.txt", ctx).strip()
    title, _, body = rendered.partition("\n")
    return truncate(title.strip(), 60), truncate(plain(body), 160)


def push_payload(template: str, context: dict[str, Any], *, sent_at: str) -> bytes:
    title, body = push(template, context)
    ctx = context or {}
    if ctx.get("task_id"):
        tag = f"task:{ctx['task_id']}"
    elif ctx.get("sprint_id"):
        tag = f"sprint:{ctx['sprint_id']}"
    else:
        tag = template
    data = {
        "v": 1,
        "title": title,
        "body": body,
        "url": ctx.get("cta_url") or settings.FRONTEND_URL,
        "tag": tag,
        "kind": template,
        "ts": sent_at,
    }
    raw = json.dumps(data, ensure_ascii=False).encode()
    return raw[:3000]


def summary_line(template: str, ctx: dict[str, Any]) -> str:
    key = ctx.get("task_key") or ""
    actor = first_word(str(ctx.get("actor_name") or ctx.get("author_name") or ctx.get("assigner_name") or ""))
    return {
        "assigned": f"{key} assigned to you",
        "mentioned": f"{key} · {actor} mentioned you",
        "status_change": f"{key} moved to {ctx.get('to_status', '')}",
        "comment": f"{key} · {actor} commented",
        "due_soon": f"{key} is due {ctx.get('due_relative', 'soon')}",
        "sprint_started": f"{ctx.get('sprint_name', 'Sprint')} started",
    }.get(template, key)
