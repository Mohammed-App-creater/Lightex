"""Notification rules shared by the inbox and the external channels."""

from __future__ import annotations

from typing import Any

from core.access import scopes
from core.access.catalogue import PROJECT
from core.common.targets import get_resolver


def still_visible(notification: Any, user: Any) -> bool:
    """Send-time re-check: the workspace, the scope (project membership) and the target still exist for `user`."""
    from core.workspaces.models import Workspace

    if not Workspace.objects.filter(pk=notification.workspace_id).exists():
        return False
    if notification.project_id:
        provider = scopes.provider(PROJECT)
        if provider is None or provider.workspace_of(notification.project_id) is None:
            return False
        if not provider.is_member(user, notification.project_id):
            return False
    if notification.target_type and notification.target_id:
        resolver = get_resolver(notification.target_type)
        if resolver is None or resolver.workspace_of(notification.target_id) is None:
            return False
    return True
