"""How tracking plugs into the platform core: every registry entry tracking contributes is made in `register()`,
called once from the projects AppConfig `ready()`. Core never imports tracking; it only calls what is registered here.
"""

from __future__ import annotations

_registered = False


def register() -> None:
    global _registered
    if _registered:
        return
    _registered = True
    from . import access, events, realtime, search, seed, targets, trash, workspaces

    access.register()
    targets.register()
    events.register()
    search.register()
    trash.register()
    realtime.register()
    workspaces.register()
    seed.register()
