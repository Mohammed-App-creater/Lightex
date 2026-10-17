from typing import Any

from django.apps import AppConfig
from django.conf import settings

MODULE = "fake"


def _widget(target_id: Any, *, deleted: bool = False) -> Any:
    from core.common.targets import parse_id

    from .models import Widget

    pk = parse_id(target_id)
    manager = Widget.all_objects if deleted else Widget.objects
    return manager.select_related("workspace").filter(pk=pk).first() if pk else None


def _member(user: Any, workspace_id: Any) -> bool:
    from core.access import services as access

    return access.is_workspace_member(user, workspace_id)


def make_resolver() -> Any:
    from core.common.targets import TargetResolver

    class WidgetTarget(TargetResolver):
        not_found_message = "Widget not found."

        def exists(self, workspace: Any, target_id: Any) -> bool:
            w = _widget(target_id)
            return w is not None and w.workspace_id == getattr(workspace, "pk", workspace)

        def workspace_of(self, target_id: Any) -> Any:
            w = _widget(target_id)
            return w.workspace_id if w is not None else None

        def can_view(self, user: Any, target_id: Any) -> bool:
            w = _widget(target_id)
            return w is not None and _member(user, w.workspace_id)

        def can_comment(self, user: Any, target_id: Any) -> bool:
            return self.can_view(user, target_id)

        def can_attach(self, user: Any, target_id: Any) -> bool:
            return self.can_view(user, target_id)

        def can_delete_any_comment(self, user: Any, target_id: Any) -> bool:
            w = _widget(target_id)
            return w is not None and w.owner_id == user.pk

        def describe(self, target_id: Any) -> dict[str, Any]:
            w = _widget(target_id)
            if w is None:
                return {}
            return {"title": w.title, "link": f"{settings.FRONTEND_URL}/{w.workspace.slug}/widgets/{w.pk}"}

        def subscribers(self, target_id: Any) -> list[Any]:
            w = _widget(target_id)
            return [w.owner_id] if w is not None and w.owner_id else []

        def comment_trash_access(self, user: Any, workspace: Any) -> str:
            from core.collab.models import Comment

            mine = Comment.all_objects.filter(
                workspace=workspace, target_type="fake.widget", deleted_by=user, deleted_at__isnull=False
            )
            return "own" if mine.exists() else "none"

    return WidgetTarget()


def make_search() -> Any:
    from core.search.services import SearchProvider

    from .models import Widget

    def result(w: Any) -> dict[str, Any]:
        return {
            "type": "widget",
            "widget": {"id": str(w.pk), "title": w.title},
            "targetType": "fake.widget",
            "targetId": str(w.pk),
            "title": w.title,
            "link": f"{settings.FRONTEND_URL}/{w.workspace.slug}/widgets/{w.pk}",
        }

    class WidgetSearch(SearchProvider):
        types = ("widget",)
        global_types = ("widget",)

        def search(self, user: Any, workspace: Any, query: str, limit: int, types: set[str]) -> list[dict[str, Any]]:
            if not _member(user, workspace):
                return []
            rows = Widget.objects.filter(workspace=workspace, title__icontains=query).select_related("workspace")
            return [result(w) for w in rows[:limit]]

        def search_all(self, user: Any, query: str, limit: int, types: set[str]) -> list[dict[str, Any]]:
            rows = Widget.objects.filter(
                workspace__members__user=user, workspace__members__status="active", title__icontains=query
            ).select_related("workspace")
            return [result(w) for w in rows[:limit]]

    return WidgetSearch()


def make_trash() -> Any:
    from core.audit import trash
    from core.audit.services import record

    from .models import Widget

    class WidgetTrash(trash.TrashKind):
        kind = "fake.widget"
        module = MODULE
        aliases = ("widget",)
        position = 90

        def access(self, user: Any, workspace: Any) -> str:
            mine = Widget.all_objects.filter(workspace=workspace, deleted_at__isnull=False, deleted_by=user)
            return trash.OWN if mine.exists() else trash.NONE

        def offered(self, user: Any, workspace: Any) -> bool:
            return self.access(user, workspace) != trash.NONE

        def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
            rows = Widget.all_objects.filter(workspace=workspace, deleted_at__isnull=False, deleted_by=user)
            return [trash.item(self, w, w.title) for w in rows.select_related("deleted_by")]

        def restore(self, user: Any, item_id: Any) -> None:
            w = _widget(item_id, deleted=True)
            Widget.all_objects.filter(pk=w.pk).update(deleted_at=None, deleted_by=None)
            record(workspace=w.workspace_id, actor=user, action="fake.widget.restored", target=w.title, entity_id=w.pk)

        def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
            from core.collab.services import delete_target_records

            w = _widget(item_id, deleted=True)
            delete_target_records("fake.widget", [w.pk])
            w.delete()

        def workspace_of(self, item_id: Any) -> Any:
            w = _widget(item_id, deleted=True)
            return w.workspace_id if w is not None else None

        def purge_expired(self, cutoff: Any, now: Any, *, skip_workspaces: Any = ()) -> dict[str, int]:
            rows = Widget.all_objects.filter(deleted_at__lt=cutoff).exclude(workspace_id__in=skip_workspaces)
            return {"widgets": rows.delete()[0]}

    return WidgetTrash()


def on_pinged(event: Any) -> None:
    from core.notifications.handlers import deliver, recipients

    for user in recipients(event, event.payload.get("userIds", [])):
        deliver(event, user, kind="comment", pref=None, payload={"note": event.payload.get("note")})


class Config(AppConfig):
    name = "core.tests.fake_module"
    label = "fake_module"

    def ready(self) -> None:
        from core.audit import trash
        from core.audit.registry import register_audit_group
        from core.common.targets import register_target_type
        from core.events.registry import register_event_type, register_handler
        from core.search.services import register_search_provider

        register_target_type("fake.widget", make_resolver())
        # Not a preference row: the real modules' preference matrix stays as it is in every other test.
        register_event_type("fake.widget.pinged", "Widget pinged", {"in_app": True}, MODULE, preference=False)
        register_handler("fake.widget.pinged", on_pinged, module=MODULE)
        register_search_provider(MODULE, make_search())
        trash.register_trash_kind(make_trash())
        register_audit_group("widget", ["fake.widget"])
