"""Sales plugs into the platform (called from `Config.ready()`): collab target types, the search provider, trash kinds
and audit filter groups.

Target types registered in S1: `sales.company`, `sales.contact`. Later stages register `sales.lead`,
`sales.opportunity` (S2) and `sales.quotation` (S2) the same way, with a `_ScopedTarget` subclass each.

Every check goes through data scope: a target the user can't see under the type's view code is a 404, exactly like
the record's own routes. Commenting and attaching need only view scope; deleting someone else's comment or attachment
needs the type's edit code with a scope that reaches the record.
"""

from __future__ import annotations

from typing import Any, ClassVar

from django.conf import settings

from core.access import services as access
from core.audit import trash
from core.audit.registry import register_audit_group
from core.common.targets import TargetResolver, parse_id, register_target_type
from core.search.services import SearchProvider, register_search_provider

from . import module as perms
from . import scope

KEY = perms.KEY


def link(workspace_slug: str, path: str) -> str:
    return f"{settings.FRONTEND_URL}/{workspace_slug}/sales/{path}"


# ───────────────────────── collab targets ─────────────────────────


class _ScopedTarget(TargetResolver):
    """A resolver for an owned, soft-deleted sales record read through data scope."""

    model_label: ClassVar[str] = ""
    view_code: ClassVar[str] = ""
    edit_code: ClassVar[str] = ""

    @property
    def model(self) -> Any:
        from django.apps import apps

        return apps.get_model(self.model_label)

    def _live_filter(self, qs: Any) -> Any:
        return qs

    def _obj(self, target_id: Any) -> Any:
        pk = parse_id(target_id)
        if pk is None:
            return None
        qs = self.model.objects.unscoped().select_related("workspace").filter(pk=pk, workspace__deleted_at__isnull=True)
        return self._live_filter(qs).first()

    def _reach(self, user: Any, target_id: Any, code: str) -> bool:
        obj = self._obj(target_id)
        return obj is not None and scope.in_scope(user, obj, code)

    def record_exists(self, target_id: Any) -> bool:
        return self.model.all_objects.unscoped().filter(pk=parse_id(target_id)).exists()

    def exists(self, workspace: Any, target_id: Any) -> bool:
        obj = self._obj(target_id)
        return obj is not None and str(obj.workspace_id) == str(getattr(workspace, "pk", workspace))

    def workspace_of(self, target_id: Any) -> Any:
        obj = self._obj(target_id)
        return obj.workspace_id if obj is not None else None

    def can_view(self, user: Any, target_id: Any) -> bool:
        return self._reach(user, target_id, self.view_code)

    def can_comment(self, user: Any, target_id: Any) -> bool:
        return self.can_view(user, target_id)

    def can_attach(self, user: Any, target_id: Any) -> bool:
        return self.can_view(user, target_id)

    def can_delete_any_comment(self, user: Any, target_id: Any) -> bool:
        return self.can_view(user, target_id) and self._reach(user, target_id, self.edit_code)

    def can_delete_any_attachment(self, user: Any, target_id: Any) -> bool:
        return self.can_delete_any_comment(user, target_id)

    def subscribers(self, target_id: Any) -> list[Any]:
        obj = self._obj(target_id)
        return [obj.owner_id] if obj is not None and obj.owner_id else []

    def visible_ids(self, user: Any, workspace: Any = None) -> Any:
        if workspace is None:
            return None
        qs = self._live_filter(self.model.objects.for_workspace(workspace))
        return scope.visible(qs, user, self.view_code, workspace).values_list("pk", flat=True)

    def comment_trash_access(self, user: Any, workspace: Any) -> str:
        from core.collab.models import Comment

        mine = Comment.all_objects.filter(
            workspace=workspace, target_type=self.key, deleted_by=user, deleted_at__isnull=False
        )
        return trash.OWN if mine.exists() else trash.NONE


class CompanyTarget(_ScopedTarget):
    model_label = "sales.Company"
    view_code = perms.COMPANY_VIEW
    edit_code = perms.COMPANY_EDIT
    not_found_message = "Company not found. It may have been deleted, or you may not have access."
    permission_codes = {
        "view": perms.COMPANY_VIEW,
        "comment": perms.COMPANY_VIEW,
        "attach": perms.COMPANY_VIEW,
        "delete_any_comment": perms.COMPANY_EDIT,
        "delete_any_attachment": perms.COMPANY_EDIT,
    }

    def describe(self, target_id: Any) -> dict[str, Any]:
        c = self._obj(target_id)
        if c is None:
            return {}
        return {"title": c.name, "link": link(c.workspace.slug, f"companies/{c.pk}")}


class ContactTarget(_ScopedTarget):
    model_label = "sales.Contact"
    view_code = perms.CONTACT_VIEW
    edit_code = perms.CONTACT_EDIT
    not_found_message = "Contact not found. It may have been deleted, or you may not have access."
    permission_codes = {
        "view": perms.CONTACT_VIEW,
        "comment": perms.CONTACT_VIEW,
        "attach": perms.CONTACT_VIEW,
        "delete_any_comment": perms.CONTACT_EDIT,
        "delete_any_attachment": perms.CONTACT_EDIT,
    }

    def _live_filter(self, qs: Any) -> Any:
        return qs.filter(company__deleted_at__isnull=True)

    def describe(self, target_id: Any) -> dict[str, Any]:
        c = self._obj(target_id)
        if c is None:
            return {}
        return {"title": c.name, "link": link(c.workspace.slug, f"contacts/{c.pk}")}


# ───────────────────────── search ─────────────────────────


def company_result(c: Any) -> dict[str, Any]:
    return {
        "type": "company",
        "company": {"id": str(c.pk), "name": c.name, "status": c.status, "city": c.city},
        "targetType": "sales.company",
        "targetId": str(c.pk),
        "title": c.name,
        "link": link(c.workspace.slug, f"companies/{c.pk}"),
    }


def contact_result(c: Any) -> dict[str, Any]:
    return {
        "type": "contact",
        "contact": {"id": str(c.pk), "name": c.name, "companyId": str(c.company_id), "companyName": c.company.name},
        "targetType": "sales.contact",
        "targetId": str(c.pk),
        "title": c.name,
        "link": link(c.workspace.slug, f"contacts/{c.pk}"),
    }


class SalesSearch(SearchProvider):
    """Companies and contacts the user can see under their view scope (`visible_to()`)."""

    types = ("company", "contact")
    global_types = ("company", "contact")

    def search(self, user: Any, workspace: Any, query: str, limit: int, types: set[str]) -> list[dict[str, Any]]:
        from django.db.models import Q

        from .selectors import companies_for, contacts_for

        q = query.strip()
        out: list[dict[str, Any]] = []
        if "company" in types and access.can(user, perms.COMPANY_VIEW, workspace):
            rows = companies_for(user, workspace).select_related("workspace")
            if q:
                rows = rows.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(email__icontains=q))
            out.extend(company_result(c) for c in rows.order_by("name", "id")[:limit])
        if "contact" in types and access.can(user, perms.CONTACT_VIEW, workspace):
            contacts = contacts_for(user, workspace).select_related("workspace", "company")
            if q:
                contacts = contacts.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(email__icontains=q))
            out.extend(contact_result(c) for c in contacts.order_by("name", "id")[:limit])
        return out

    def search_all(self, user: Any, query: str, limit: int, types: set[str]) -> list[dict[str, Any]]:
        from core.modules.services import is_enabled
        from core.workspaces.selectors import workspaces_for

        out: list[dict[str, Any]] = []
        for ws in workspaces_for(user):
            if is_enabled(ws, KEY):
                out.extend(self.search(user, ws, query, limit, types))
        return out[:limit]


# ───────────────────────── trash ─────────────────────────


class _OwnedTrash(trash.TrashKind):
    """Deleted records the user's delete scope reaches: `all` for scope all, `own` (a narrower view) otherwise."""

    module = KEY
    model_label: ClassVar[str] = ""
    delete_code: ClassVar[str] = ""

    @property
    def model(self) -> Any:
        from django.apps import apps

        return apps.get_model(self.model_label)

    def access(self, user: Any, workspace: Any) -> str:
        level = scope.scope_of(user, workspace, self.delete_code)
        if level is None:
            return trash.NONE
        return trash.ALL if level == "all" else trash.OWN

    def _deleted(self, user: Any, workspace: Any) -> Any:
        qs = self.model.all_objects.for_workspace(workspace).filter(deleted_at__isnull=False)
        return scope.visible(qs, user, self.delete_code, workspace)

    def _get(self, item_id: Any) -> Any:
        pk = parse_id(item_id)
        return self.model.all_objects.unscoped().filter(pk=pk).first() if pk else None

    def workspace_of(self, item_id: Any) -> Any:
        obj = self._get(item_id)
        return obj.workspace_id if obj is not None else None

    def purge_expired(self, cutoff: Any, now: Any, *, skip_workspaces: Any = ()) -> dict[str, int]:
        from core.collab.services import delete_target_records

        rows = self.model.all_objects.unscoped().filter(deleted_at__lt=cutoff).exclude(workspace_id__in=skip_workspaces)
        delete_target_records(self.kind, list(rows.values_list("pk", flat=True)))
        return {self.kind.split(".")[1] + "s": rows.delete()[0]}

    def purge_workspace(self, workspace: Any) -> None:
        self.model.all_objects.for_workspace(workspace).delete()


class CompanyTrash(_OwnedTrash):
    kind = "sales.company"
    model_label = "sales.Company"
    delete_code = perms.COMPANY_DELETE
    permission = perms.COMPANY_DELETE
    position = 60

    def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
        rows = self._deleted(user, workspace).select_related("deleted_by")
        return [trash.item(self, c, c.name) for c in rows]

    def restore(self, user: Any, item_id: Any) -> None:
        from .services import restore_company

        restore_company(user, self._get(item_id))

    def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
        from .services import purge_company

        purge_company(user, self._get(item_id))

    def purge_expired(self, cutoff: Any, now: Any, *, skip_workspaces: Any = ()) -> dict[str, int]:
        from core.collab.services import delete_target_records

        from .models import Contact

        rows = self.model.all_objects.unscoped().filter(deleted_at__lt=cutoff).exclude(workspace_id__in=skip_workspaces)
        contacts = Contact.all_objects.unscoped().filter(company__in=rows)
        delete_target_records("sales.contact", list(contacts.values_list("pk", flat=True)))
        delete_target_records(self.kind, list(rows.values_list("pk", flat=True)))
        return {"companies": rows.delete()[0]}

    def purge_workspace(self, workspace: Any) -> None:
        from .models import Contact

        Contact.all_objects.for_workspace(workspace).delete()
        super().purge_workspace(workspace)


class ContactTrash(_OwnedTrash):
    """Contacts deleted on their own; those deleted with their company come back with the company."""

    kind = "sales.contact"
    model_label = "sales.Contact"
    delete_code = perms.CONTACT_DELETE
    permission = perms.CONTACT_DELETE
    position = 61

    def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
        rows = (
            self._deleted(user, workspace)
            .filter(company__deleted_at__isnull=True)
            .select_related("deleted_by", "company")
        )
        return [trash.item(self, c, c.name, parent_key=c.company.name) for c in rows]

    def restore(self, user: Any, item_id: Any) -> None:
        from .services import restore_contact

        restore_contact(user, self._get(item_id))

    def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
        from .services import purge_contact

        purge_contact(user, self._get(item_id))


def register() -> None:
    register_target_type("sales.company", CompanyTarget())
    register_target_type("sales.contact", ContactTarget())
    register_search_provider(KEY, SalesSearch())
    trash.register_trash_kind(CompanyTrash())
    trash.register_trash_kind(ContactTrash())
    register_audit_group("company", ["sales.company"])
    register_audit_group("contact", ["sales.contact"])
    register_audit_group(
        "sales_settings",
        ["sales.settings", "sales.stage", "sales.product", "sales.lostreason", "sales.calendar", "sales.holiday"],
    )
