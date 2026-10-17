"""The module guard, applied once per module URLconf.

    path("sales/", include(module_urls("sales", [path("", include("modules.sales.urls"))])))

`module_urls` tags every view under the prefix with its module key. `ScopedPermission` (core/access/permissions.py)
then resolves the view's scope (the workspace, or the project behind a task, view, dashboard, …; non-members still
get 404) and answers 403 `module_disabled` when that module is off in the scope's workspace, before checking the
view's permission. A toggleable module's routes must therefore be `ScopedView`s; `module_urls` refuses anything else.
"""

from __future__ import annotations

import functools
from typing import Any

from django.core.exceptions import ImproperlyConfigured
from django.urls import URLPattern, URLResolver

from .registry import get_module

ATTR = "lx_module"


def _guarded(key: str, view: Any) -> Any:
    @functools.wraps(view)  # keeps `cls`, `view_class`, `initkwargs`, `csrf_exempt` (DRF and drf-spectacular)
    def wrapped(request: Any, *args: Any, **kwargs: Any) -> Any:
        setattr(request, ATTR, key)
        return view(request, *args, **kwargs)

    setattr(wrapped, ATTR, key)
    return wrapped


def _check(key: str, pattern: URLPattern) -> None:
    from core.access.permissions import ScopedView

    defn = get_module(key)
    cls = getattr(pattern.callback, "cls", None) or getattr(pattern.callback, "view_class", None)
    if defn is not None and defn.toggleable and not (isinstance(cls, type) and issubclass(cls, ScopedView)):
        raise ImproperlyConfigured(
            f"Route {pattern.pattern} of toggleable module {key!r} must be a ScopedView so the module guard can "
            "resolve its workspace."
        )


def module_urls(key: str, patterns: list[Any]) -> list[Any]:
    out: list[Any] = []
    for p in patterns:
        if isinstance(p, URLResolver):
            out.append(
                URLResolver(p.pattern, module_urls(key, p.url_patterns), p.default_kwargs, p.app_name, p.namespace)
            )
        else:
            _check(key, p)
            out.append(URLPattern(p.pattern, _guarded(key, p.callback), p.default_args, p.name))
    return out


def module_of_request(request: Any) -> str | None:
    """The module key of the route being served (set by `module_urls`), or None for core routes."""
    raw = getattr(request, "_request", request)
    return getattr(raw, ATTR, None)
