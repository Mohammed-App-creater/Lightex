"""Sales plugs into the platform (called from `Config.ready()`): collab target types, the search provider, trash kinds,
audit filter groups and scheduled jobs.

Target types: `sales.company`, `sales.contact` (S1), `sales.lead`, `sales.opportunity`, `sales.quotation` (S2), each a
`_ScopedTarget` subclass. Jobs: `sales_expire_quotations` (S2, nightly).

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
from core.jobs.registry import register_job
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


class LeadTarget(_ScopedTarget):
    model_label = "sales.Lead"
    view_code = perms.LEAD_VIEW
    edit_code = perms.LEAD_EDIT
    not_found_message = "Lead not found. It may have been deleted, or you may not have access."
    permission_codes = {
        "view": perms.LEAD_VIEW,
        "comment": perms.LEAD_VIEW,
        "attach": perms.LEAD_VIEW,
        "delete_any_comment": perms.LEAD_EDIT,
        "delete_any_attachment": perms.LEAD_EDIT,
    }

    def describe(self, target_id: Any) -> dict[str, Any]:
        lead = self._obj(target_id)
        if lead is None:
            return {}
        return {"title": lead.display_name, "link": link(lead.workspace.slug, f"leads/{lead.pk}")}


class OpportunityTarget(_ScopedTarget):
    model_label = "sales.Opportunity"
    view_code = perms.OPPORTUNITY_VIEW
    edit_code = perms.OPPORTUNITY_EDIT
    not_found_message = "Opportunity not found. It may have been deleted, or you may not have access."
    permission_codes = {
        "view": perms.OPPORTUNITY_VIEW,
        "comment": perms.OPPORTUNITY_VIEW,
        "attach": perms.OPPORTUNITY_VIEW,
        "delete_any_comment": perms.OPPORTUNITY_EDIT,
        "delete_any_attachment": perms.OPPORTUNITY_EDIT,
    }

    def describe(self, target_id: Any) -> dict[str, Any]:
        o = self._obj(target_id)
        if o is None:
            return {}
        return {"title": o.title, "link": link(o.workspace.slug, f"opportunities/{o.pk}")}


class QuotationTarget(_ScopedTarget):
    """Quotations of a deleted opportunity are not targets until it is restored."""

    model_label = "sales.Quotation"
    view_code = perms.QUOTATION_VIEW
    edit_code = perms.QUOTATION_EDIT
    not_found_message = "Quotation not found. It may have been deleted, or you may not have access."
    permission_codes = {
        "view": perms.QUOTATION_VIEW,
        "comment": perms.QUOTATION_VIEW,
        "attach": perms.QUOTATION_VIEW,
        "delete_any_comment": perms.QUOTATION_EDIT,
        "delete_any_attachment": perms.QUOTATION_EDIT,
    }

    def _live_filter(self, qs: Any) -> Any:
        return qs.filter(opportunity__deleted_at__isnull=True)

    def describe(self, target_id: Any) -> dict[str, Any]:
        q = self._obj(target_id)
        if q is None:
            return {}
        return {"title": f"{q.number} {q.title}", "link": link(q.workspace.slug, f"quotations/{q.pk}")}


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


def lead_result(lead: Any) -> dict[str, Any]:
    return {
        "type": "lead",
        "lead": {
            "id": str(lead.pk),
            "name": lead.display_name,
            "status": lead.status,
            "contactName": lead.contact_name,
        },
        "targetType": "sales.lead",
        "targetId": str(lead.pk),
        "title": lead.display_name,
        "link": link(lead.workspace.slug, f"leads/{lead.pk}"),
    }


def opportunity_result(o: Any) -> dict[str, Any]:
    return {
        "type": "opportunity",
        "opportunity": {
            "id": str(o.pk),
            "title": o.title,
            "status": o.stage.category,
            "stageName": o.stage.name,
            "companyId": str(o.company_id),
            "companyName": o.company.name,
        },
        "targetType": "sales.opportunity",
        "targetId": str(o.pk),
        "title": o.title,
        "link": link(o.workspace.slug, f"opportunities/{o.pk}"),
    }


def quotation_result(q: Any) -> dict[str, Any]:
    return {
        "type": "quotation",
        "quotation": {
            "id": str(q.pk),
            "number": q.number,
            "title": q.title,
            "status": q.status,
            "opportunityId": str(q.opportunity_id),
        },
        "targetType": "sales.quotation",
        "targetId": str(q.pk),
        "title": f"{q.number} {q.title}",
        "link": link(q.workspace.slug, f"quotations/{q.pk}"),
    }


class SalesSearch(SearchProvider):
    """Companies, contacts, leads, opportunities and quotations the user can see under their view scope
    (`visible_to()`)."""

    types = ("company", "contact", "lead", "opportunity", "quotation")
    global_types = ("company", "contact", "lead", "opportunity", "quotation")

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
        out.extend(self._deals(user, workspace, q, limit, types))
        return out

    def _deals(self, user: Any, workspace: Any, q: str, limit: int, types: set[str]) -> list[dict[str, Any]]:
        from django.db.models import Q

        from .pipeline_selectors import leads_for, opportunities_for, quotations_for

        out: list[dict[str, Any]] = []
        if "lead" in types and access.can(user, perms.LEAD_VIEW, workspace):
            leads = leads_for(user, workspace).select_related("workspace", "company")
            if q:
                leads = leads.filter(
                    Q(company_name_text__icontains=q)
                    | Q(company__name__icontains=q)
                    | Q(contact_name__icontains=q)
                    | Q(phone__icontains=q)
                    | Q(email__icontains=q)
                )
            out.extend(lead_result(lead) for lead in leads.order_by("-created_at", "id")[:limit])
        if "opportunity" in types and access.can(user, perms.OPPORTUNITY_VIEW, workspace):
            opps = opportunities_for(user, workspace).select_related("workspace", "company", "stage")
            if q:
                opps = opps.filter(Q(title__icontains=q) | Q(company__name__icontains=q))
            out.extend(opportunity_result(o) for o in opps.order_by("title", "id")[:limit])
        if "quotation" in types and access.can(user, perms.QUOTATION_VIEW, workspace):
            quotes = quotations_for(user, workspace).select_related("workspace")
            if q:
                quotes = quotes.filter(Q(number__icontains=q) | Q(title__icontains=q))
            out.extend(quotation_result(x) for x in quotes.order_by("-created_at", "id")[:limit])
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
        from .models import Contact, Opportunity

        # Opportunities restrict deleting their company, so they go first (OpportunityTrash sorts after this kind).
        Opportunity.all_objects.for_workspace(workspace).delete()
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


class LeadTrash(_OwnedTrash):
    kind = "sales.lead"
    model_label = "sales.Lead"
    delete_code = perms.LEAD_DELETE
    permission = perms.LEAD_DELETE
    position = 62

    def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
        rows = self._deleted(user, workspace).select_related("deleted_by", "company")
        return [trash.item(self, lead, lead.display_name) for lead in rows]

    def restore(self, user: Any, item_id: Any) -> None:
        from .pipeline_services import restore_lead

        restore_lead(user, self._get(item_id))

    def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
        from .pipeline_services import purge_lead

        purge_lead(user, self._get(item_id))


class OpportunityTrash(_OwnedTrash):
    """Deleting an opportunity takes its live quotations along; restoring it brings exactly those back."""

    kind = "sales.opportunity"
    model_label = "sales.Opportunity"
    delete_code = perms.OPPORTUNITY_DELETE
    permission = perms.OPPORTUNITY_DELETE
    position = 63

    def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
        rows = self._deleted(user, workspace).select_related("deleted_by", "company")
        return [trash.item(self, o, o.title, parent_key=o.company.name) for o in rows]

    def restore(self, user: Any, item_id: Any) -> None:
        from .pipeline_services import restore_opportunity

        restore_opportunity(user, self._get(item_id))

    def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
        from .pipeline_services import purge_opportunity

        purge_opportunity(user, self._get(item_id))

    def purge_expired(self, cutoff: Any, now: Any, *, skip_workspaces: Any = ()) -> dict[str, int]:
        from core.collab.services import delete_target_records

        from .models import Quotation

        rows = self.model.all_objects.unscoped().filter(deleted_at__lt=cutoff).exclude(workspace_id__in=skip_workspaces)
        quotes = Quotation.all_objects.unscoped().filter(opportunity__in=rows)
        delete_target_records("sales.quotation", list(quotes.values_list("pk", flat=True)))
        delete_target_records(self.kind, list(rows.values_list("pk", flat=True)))
        return {"opportunities": rows.delete()[0]}


class QuotationTrash(_OwnedTrash):
    """Quotations deleted on their own; those deleted with their opportunity come back with it."""

    kind = "sales.quotation"
    model_label = "sales.Quotation"
    delete_code = perms.QUOTATION_DELETE
    permission = perms.QUOTATION_DELETE
    position = 64

    def items(self, user: Any, workspace: Any) -> list[dict[str, Any]]:
        rows = (
            self._deleted(user, workspace)
            .filter(opportunity__deleted_at__isnull=True)
            .select_related("deleted_by", "opportunity")
        )
        return [trash.item(self, q, f"{q.number} {q.title}", parent_key=q.opportunity.title) for q in rows]

    def restore(self, user: Any, item_id: Any) -> None:
        from .pipeline_services import restore_quotation

        restore_quotation(user, self._get(item_id))

    def purge(self, user: Any, workspace: Any, item_id: Any) -> None:
        from .pipeline_services import purge_quotation

        purge_quotation(user, self._get(item_id))


# ───────────────────────── jobs ─────────────────────────


def expire_quotations_job(workspace: Any, *, now: Any) -> None:
    from .pipeline_services import expire_quotations, notify_expiring_quotations

    expire_quotations(workspace, now=now)
    notify_expiring_quotations(workspace, now=now)


def followup_digest_job(workspace: Any, *, now: Any) -> None:
    from .activity_services import followup_digest

    followup_digest(workspace, now=now)


def register() -> None:
    register_target_type("sales.company", CompanyTarget())
    register_target_type("sales.contact", ContactTarget())
    register_target_type("sales.lead", LeadTarget())
    register_target_type("sales.opportunity", OpportunityTarget())
    register_target_type("sales.quotation", QuotationTarget())
    register_search_provider(KEY, SalesSearch())
    for kind in (CompanyTrash(), ContactTrash(), LeadTrash(), OpportunityTrash(), QuotationTrash()):
        trash.register_trash_kind(kind)
    register_audit_group("company", ["sales.company"])
    register_audit_group("contact", ["sales.contact"])
    register_audit_group("lead", ["sales.lead"])
    register_audit_group("opportunity", ["sales.opportunity"])
    register_audit_group("quotation", ["sales.quotation"])
    register_job(
        "sales_expire_quotations",
        expire_quotations_job,
        module=KEY,
        schedule="daily 00:15",
        description="Expire sent quotations whose valid-until date has passed and notify owners of quotations "
        "expiring within 3 days (workspace time)",
    )
    register_job(
        "sales_followup_digest",
        followup_digest_job,
        module=KEY,
        schedule="daily 07:30",
        description="Morning digest: follow-ups due today and overdue, one notification per owner (workspace time)",
    )
    register_audit_group("activity", ["sales.activity"])
    register_audit_group("followup", ["sales.followup"])
    from . import activity_selectors, notifications

    activity_selectors.register_timeline_sources()
    notifications.register()
    register_audit_group("target", ["sales.target"])
    from . import target_notifications

    target_notifications.register()
    register_audit_group(
        "sales_settings",
        ["sales.settings", "sales.stage", "sales.product", "sales.lostreason", "sales.calendar", "sales.holiday"],
    )
