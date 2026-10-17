"""Workspace scoping for `WorkspaceScopedModel` managers (platform architecture §8).

A scoped manager answers queries only when it knows the workspace:

- `Model.objects.for_workspace(ws)` names it explicitly;
- inside a request, `WorkspaceScopeMiddleware` puts the request in *strict* mode and the scoped view sets the
  workspace once it has resolved (and checked) its scope, so `Model.objects.filter(...)` is filtered to it;
- `Model.objects.unscoped()` is the explicit escape hatch (scope resolution, management commands, Celery tasks
  given ids, background threads, migrations and tests).

Anything else raises `UnscopedQueryError`. Outside a request the mode is `settings.WORKSPACE_SCOPE_DEFAULT`
(`strict`; the test settings choose `unscoped`), and the entry points that are not requests — `manage.py`, Celery
tasks, the background threads — enter `unscoped()` themselves.
"""

from __future__ import annotations

import contextlib
import contextvars
from collections.abc import Iterator
from typing import Any

STRICT = "strict"
UNSCOPED = "unscoped"

_workspace: contextvars.ContextVar[str | None] = contextvars.ContextVar("scope_workspace", default=None)
_mode: contextvars.ContextVar[str | None] = contextvars.ContextVar("scope_mode", default=None)


class UnscopedQueryError(RuntimeError):
    """A workspace-scoped model was queried without a workspace and outside `unscoped()`."""


def _id(workspace: Any) -> str | None:
    if workspace is None:
        return None
    return str(getattr(workspace, "pk", workspace))


def workspace_id_of(scope: Any) -> str | None:
    """The workspace id of a resolved scope object: a workspace itself, or anything with a `workspace_id`."""
    if scope is None:
        return None
    if scope._meta.label_lower == "workspaces.workspace":
        return str(scope.pk)
    ws = getattr(scope, "workspace_id", None)
    return str(ws) if ws is not None else None


def current_workspace_id() -> str | None:
    return _workspace.get()


def mode() -> str:
    explicit = _mode.get()
    if explicit is not None:
        return explicit
    from django.conf import settings

    return getattr(settings, "WORKSPACE_SCOPE_DEFAULT", STRICT)


def is_unscoped() -> bool:
    return _workspace.get() is None and mode() == UNSCOPED


def enter_strict() -> None:
    """Strict mode with no workspace (the start of a request). Bounded by the caller's copied context."""
    _mode.set(STRICT)
    _workspace.set(None)


def enter_unscoped() -> None:
    _mode.set(UNSCOPED)
    _workspace.set(None)


def enter_workspace(workspace: Any) -> None:
    """Scopes the rest of the current context (a request) to `workspace`."""
    _mode.set(STRICT)
    _workspace.set(_id(workspace))


@contextlib.contextmanager
def unscoped() -> Iterator[None]:
    """The escape hatch: scoped managers answer every workspace inside this block."""
    mode_token = _mode.set(UNSCOPED)
    ws_token = _workspace.set(None)
    try:
        yield
    finally:
        _workspace.reset(ws_token)
        _mode.reset(mode_token)


@contextlib.contextmanager
def workspace_context(workspace: Any) -> Iterator[None]:
    """Scopes the block to `workspace` (strict mode)."""
    mode_token = _mode.set(STRICT)
    ws_token = _workspace.set(_id(workspace))
    try:
        yield
    finally:
        _workspace.reset(ws_token)
        _mode.reset(mode_token)


@contextlib.contextmanager
def strict() -> Iterator[None]:
    """Strict mode with no workspace: every scoped query must say `for_workspace()` or `unscoped()`."""
    mode_token = _mode.set(STRICT)
    ws_token = _workspace.set(None)
    try:
        yield
    finally:
        _workspace.reset(ws_token)
        _mode.reset(mode_token)


def push_unscoped() -> tuple[Any, Any]:
    """Enters unscoped mode until `pop(tokens)` (paired signal handlers, such as Celery's prerun/postrun)."""
    return _mode.set(UNSCOPED), _workspace.set(None)


def pop(tokens: tuple[Any, Any]) -> None:
    mode_token, ws_token = tokens
    try:
        _workspace.reset(ws_token)
        _mode.reset(mode_token)
    except ValueError:  # a token from another context (should not happen); leave the current state alone
        pass


def run_unscoped(fn: Any, *args: Any, **kwargs: Any) -> Any:
    """Runs `fn` in a fresh copy of the context, unscoped (thread targets, task bodies)."""

    def body() -> Any:
        enter_unscoped()
        return fn(*args, **kwargs)

    return contextvars.copy_context().run(body)


def unscoped_target(fn: Any) -> Any:
    """Decorator for background-thread entry points (a new thread starts with an empty context)."""
    import functools

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        return run_unscoped(fn, *args, **kwargs)

    return wrapper


def iterate_in_workspace(iterable: Any, workspace: Any) -> Iterator[Any]:
    """Iterates `iterable` scoped to `workspace`: a streaming body runs after the request's context is gone."""
    ctx = contextvars.copy_context()
    ctx.run(enter_workspace, workspace)
    it = iter(iterable)
    try:
        while True:
            try:
                item = ctx.run(next, it)
            except StopIteration:
                return
            yield item
    finally:
        close = getattr(it, "close", None)
        if close is not None:
            ctx.run(close)


class WorkspaceScopeMiddleware:
    """Runs each request in its own context in strict mode. Scoped views (`core.access.permissions.ScopedView`)
    set the workspace once their scope is resolved; views that are not about one workspace declare
    `cross_workspace = True` and run unscoped (they filter by the user's memberships themselves)."""

    def __init__(self, get_response: Any):
        self.get_response = get_response

    def __call__(self, request: Any) -> Any:
        return contextvars.copy_context().run(self._handle, request)

    def _handle(self, request: Any) -> Any:
        enter_strict()
        return self.get_response(request)

    def process_view(self, request: Any, view_func: Any, view_args: Any, view_kwargs: Any) -> None:
        cls = getattr(view_func, "cls", None) or getattr(view_func, "view_class", None)
        if getattr(cls, "cross_workspace", False):
            enter_unscoped()
        return None
