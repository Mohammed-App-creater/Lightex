"""Sales writes for leads, opportunities and quotations (S2, docs/sales/api.md §9–§11). Same rules as `services.py`:
every mutation writes one audit row per record inside its transaction; the views have checked the method's
permission code and the record's view scope (404); the services check the action's scope on the record (403).

Owner changes on leads and opportunities use their `assign` codes (create with someone else as owner, edit,
bulk-assign). An opportunity's quotations always belong to the opportunity's owner. Domain events (spec §9) are
emitted inside the transaction (`core.events.services.emit`, dispatched after commit).
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from core.access.catalogue import ALL, TEAM
from core.audit.services import change
from core.common.exceptions import ApiError, conflict, forbidden, invalid
from core.events.services import emit
from core.workspaces.timezone import local_date, workspace_today, workspace_zone

from . import module as perms
from . import scope
from .activity_services import sync_company
from .defaults import ensure_defaults
from .models import (
    Company,
    Contact,
    Lead,
    LostReason,
    Opportunity,
    OpportunityStageHistory,
    PipelineStage,
    Product,
    Quotation,
    SalesSequence,
)
from .normalize import normalize_name, normalize_phone
from .periods import CLOSING_PERIOD, current_period
from .selectors import first_open_stage
from .services import _apply, _audit, _owner_change, _visible_company, create_company, create_contact

# ───────────────────────── shared ─────────────────────────


def _workspace(obj: Any) -> Any:
    from core.workspaces.models import Workspace

    return Workspace.objects.get(pk=obj.workspace_id)


def _product(workspace: Any, product_id: Any, current_id: Any = None) -> Product | None:
    """A product of the workspace; a newly picked one must be active (keeping an inactive one is fine)."""
    if product_id is None:
        return None
    product = Product.objects.for_workspace(workspace).filter(pk=product_id).first()
    if product is None or (not product.is_active and str(product_id) != str(current_id)):
        raise invalid({"productId": "Pick an active product"})
    return product


def _contact(actor: Any, workspace: Any, contact_id: Any, company: Company | None) -> Contact | None:
    """A live contact the caller can see, of `company` when one is given."""
    if contact_id is None:
        return None
    qs = Contact.objects.for_workspace(workspace).filter(pk=contact_id, company__deleted_at__isnull=True)
    contact = scope.visible(qs, actor, perms.CONTACT_VIEW, workspace).select_related("company").first()
    if contact is None or (company is not None and contact.company_id != company.pk):
        raise invalid({"contactId": "Pick a contact of this company"})
    return contact


def _name(obj: Any) -> str | None:
    return None if obj is None else obj.name


def _event(event_type: str, obj: Any, actor: Any, target_type: str, payload: dict[str, Any]) -> None:
    emit(
        event_type, workspace=obj.workspace_id, target_type=target_type, target_id=obj.pk, actor=actor, payload=payload
    )


def _soft_delete(actor: Any, obj: Any, now: Any = None) -> None:
    obj.deleted_at, obj.deleted_by = now or timezone.now(), actor
    obj.save(update_fields=["deleted_at", "deleted_by", "updated_at"])


def _bulk_records(
    actor: Any, workspace: Any, model: Any, ids: list[Any], view_code: str, assign_code: str, field: str, noun: str
) -> list[Any]:
    """All-or-nothing: every id must be a record the caller can see (else 422 `field`) and reach with `assign_code`
    (else 403). Returns the rows locked for update."""
    unique = list(dict.fromkeys(str(i) for i in ids))
    base = model.objects.for_workspace(workspace).filter(pk__in=unique)
    if scope.visible(base, actor, view_code, workspace).count() != len(unique):
        raise invalid({field: f"Some of these {noun} don't exist or you can't see them"})
    if scope.visible(base, actor, assign_code, workspace).count() != len(unique):
        raise forbidden(details={"permission": assign_code})
    return list(model.objects.for_workspace(workspace).filter(pk__in=unique).select_for_update().order_by("pk"))


# ───────────────────────── leads ─────────────────────────

LEAD_LABELS = {
    "source": "Source",
    "company_name_text": "Company name",
    "contact_name": "Contact name",
    "phone": "Phone",
    "email": "Email",
    "estimated_value": "Estimated value",
    "status": "Status",
    "notes": "Notes",
}


def _lead_refs(actor: Any, workspace: Any, lead: Lead, data: dict[str, Any]) -> list[dict[str, Any]]:
    """Applies `company_id`, `contact_id` and `product_id`; returns the audit changes."""
    changes = []
    if "company_id" in data and str(data["company_id"] or "") != str(lead.company_id or ""):
        company = _visible_company(actor, workspace, data["company_id"]) if data["company_id"] else None
        changes.append(change("Company", _name(lead.company) if lead.company_id else None, _name(company)))
        lead.company = company
        if (
            lead.contact_id
            and company is not None
            and lead.contact is not None
            and lead.contact.company_id != company.pk
            and "contact_id" not in data
        ):
            changes.append(change("Contact", _name(lead.contact), None))
            lead.contact = None
    if "contact_id" in data and str(data["contact_id"] or "") != str(lead.contact_id or ""):
        company = lead.company if lead.company_id else None
        contact = _contact(actor, workspace, data["contact_id"], company)
        changes.append(change("Contact", _name(lead.contact) if lead.contact_id else None, _name(contact)))
        lead.contact = contact
    if "product_id" in data and str(data["product_id"] or "") != str(lead.product_id or ""):
        product = _product(workspace, data["product_id"], lead.product_id)
        changes.append(change("Product", _name(lead.product) if lead.product_id else None, _name(product)))
        lead.product = product
    return changes


def _lead_named(lead: Lead) -> None:
    if not (lead.company_id or lead.company_name_text or lead.contact_name):
        raise invalid({"companyName": "Name the company or the contact"})


def _lead_open(lead: Lead) -> None:
    if lead.status == Lead.CONVERTED:
        raise conflict(
            "lead_converted",
            "This lead has been converted. Work on its opportunity instead.",
            {"opportunityId": str(lead.converted_opportunity_id) if lead.converted_opportunity_id else None},
        )


def _lock_lead(lead: Lead) -> Lead:
    return Lead.objects.for_workspace(lead.workspace_id).select_for_update().get(pk=lead.pk)


@transaction.atomic
def create_lead(actor: Any, workspace: Any, data: dict[str, Any]) -> Lead:
    fields = {k: v for k, v in data.items() if k in LEAD_LABELS}
    lead = Lead(workspace_id=getattr(workspace, "pk", workspace), owner=actor, **fields)
    _lead_refs(actor, workspace, lead, data)
    _lead_named(lead)
    _owner_change(actor, workspace, perms.LEAD_ASSIGN, lead, data)
    lead.save()
    _audit(actor, workspace, "sales.lead.created", lead, lead.display_name, data={"ownerId": str(lead.owner_id)})
    _event("sales.lead.created", lead, actor, "sales.lead", {"leadId": str(lead.pk), "ownerId": str(lead.owner_id)})
    return lead


@transaction.atomic
def update_lead(actor: Any, lead: Lead, data: dict[str, Any]) -> Lead:
    scope.require_in_scope(actor, lead, perms.LEAD_EDIT)
    lead = _lock_lead(lead)
    _lead_open(lead)
    before_company = lead.company_id
    changes = _apply(lead, data, LEAD_LABELS)
    changes += _lead_refs(actor, lead.workspace_id, lead, data)
    if "owner_id" in data and str(data["owner_id"]) != str(lead.owner_id):
        scope.require_in_scope(actor, lead, perms.LEAD_ASSIGN)
        owner = _owner_change(actor, lead.workspace_id, perms.LEAD_ASSIGN, lead, data)
        if owner is not None:
            changes.append(owner)
    if changes:
        _lead_named(lead)
        lead.save()
        _audit(actor, lead.workspace_id, "sales.lead.updated", lead, lead.display_name, changes=changes)
        sync_company("lead", lead, before_company)
    return lead


@transaction.atomic
def qualify_lead(actor: Any, lead: Lead) -> Lead:
    scope.require_in_scope(actor, lead, perms.LEAD_CONVERT)
    lead = _lock_lead(lead)
    _lead_open(lead)
    if lead.status == Lead.QUALIFIED:
        return lead
    changes = [change("Status", lead.status, Lead.QUALIFIED, kind="status")]
    lead.status, lead.disqualify_reason = Lead.QUALIFIED, ""
    lead.save()
    _audit(actor, lead.workspace_id, "sales.lead.qualified", lead, lead.display_name, changes=changes)
    return lead


@transaction.atomic
def disqualify_lead(actor: Any, lead: Lead, reason: str) -> Lead:
    scope.require_in_scope(actor, lead, perms.LEAD_CONVERT)
    lead = _lock_lead(lead)
    _lead_open(lead)
    changes = _apply(
        lead,
        {"status": Lead.DISQUALIFIED, "disqualify_reason": reason},
        {"status": "Status", "disqualify_reason": "Reason"},
    )
    if changes:
        lead.save()
        _audit(actor, lead.workspace_id, "sales.lead.disqualified", lead, lead.display_name, changes=changes)
    return lead


def _matching_company(actor: Any, workspace: Any, name: str, phone: str) -> Company | None:
    """The oldest company in the caller's view scope with the same normalized name or phone (the duplicate check's
    normalization), so converting a lead links the customer instead of duplicating it."""
    from django.db.models import Q

    cond = Q()
    if normalize_name(name):
        cond |= Q(normalized_name=normalize_name(name))
    if normalize_phone(phone):
        cond |= Q(normalized_phone=normalize_phone(phone))
    if not cond:
        return None
    qs = scope.visible(Company.objects.for_workspace(workspace), actor, perms.COMPANY_VIEW, workspace)
    return qs.filter(cond).order_by("created_at", "id").first()


def _convert_company(
    actor: Any, workspace: Any, lead: Lead, data: dict[str, Any], owner_id: Any
) -> tuple[Company, bool]:
    if data.get("company_id"):
        return _visible_company(actor, workspace, data["company_id"]), False
    if data.get("company"):
        return create_company(actor, workspace, {**data["company"], "owner_id": owner_id}), True
    if lead.company is not None and lead.company.deleted_at is None:
        return lead.company, False
    name = lead.company_name_text or lead.contact_name
    match = _matching_company(actor, workspace, name, lead.phone)
    if match is not None:
        return match, False
    if not name.strip():
        raise invalid({"company": "Name the company to convert this lead into"})
    fields = {"name": name, "phone": lead.phone, "email": lead.email, "owner_id": owner_id}
    return create_company(actor, workspace, fields), True


def _convert_contact(
    actor: Any, workspace: Any, lead: Lead, data: dict[str, Any], company: Company, owner_id: Any
) -> tuple[Contact | None, bool]:
    if data.get("contact_id"):
        return _contact(actor, workspace, data["contact_id"], company), False
    primary = not Contact.objects.for_workspace(workspace).filter(company=company, is_primary=True).exists()
    if data.get("contact"):
        fields = {"is_primary": primary, **data["contact"], "company_id": company.pk, "owner_id": owner_id}
        return create_contact(actor, workspace, fields), True
    if lead.contact is not None and lead.contact.company_id == company.pk and lead.contact.deleted_at is None:
        return lead.contact, False
    if not lead.contact_name:
        return None, False
    qs = Contact.objects.for_workspace(workspace).filter(company=company, name__iexact=lead.contact_name)
    existing = scope.visible(qs, actor, perms.CONTACT_VIEW, workspace).order_by("created_at").first()
    if existing is not None:
        return existing, False
    fields = {
        "company_id": company.pk,
        "name": lead.contact_name,
        "phone": lead.phone,
        "email": lead.email,
        "is_primary": primary,
        "owner_id": owner_id,
    }
    return create_contact(actor, workspace, fields), True


@transaction.atomic
def convert_lead(actor: Any, lead: Lead, data: dict[str, Any]) -> dict[str, Any]:
    """Creates or links the company and contact, creates the opportunity in the first open stage (owner, product and
    value from the lead), marks the lead converted and links both ways. A second conversion answers 409."""
    scope.require_in_scope(actor, lead, perms.LEAD_CONVERT)
    lead = _lock_lead(lead)
    _lead_open(lead)
    if lead.status == Lead.DISQUALIFIED:
        raise conflict("lead_disqualified", "This lead is disqualified. Qualify it again before converting it.")
    workspace = _workspace(lead)
    before_company = lead.company_id
    owner_id = lead.owner_id or actor.pk
    company, company_created = _convert_company(actor, workspace, lead, data, owner_id)
    contact, contact_created = _convert_contact(actor, workspace, lead, data, company, owner_id)
    extra = data.get("opportunity") or {}
    product = lead.product
    title = extra.get("title") or (f"{company.name} – {product.name}" if product is not None else company.name)
    value = extra.get("expected_value", lead.estimated_value if lead.estimated_value is not None else Decimal("0"))
    opp = _new_opportunity(
        actor,
        workspace,
        company=company,
        contact=contact,
        product=product,
        stage=first_open_stage(workspace),
        owner=lead.owner or actor,
        fields={"title": title, "expected_value": value, "expected_close_date": extra.get("expected_close_date")},
        source_lead=lead,
    )
    before = lead.status
    lead.status, lead.converted_opportunity, lead.converted_at = Lead.CONVERTED, opp, timezone.now()
    lead.company, lead.contact = company, contact
    lead.save()
    sync_company("lead", lead, before_company)
    payload = {
        "leadId": str(lead.pk),
        "opportunityId": str(opp.pk),
        "companyId": str(company.pk),
        "contactId": str(contact.pk) if contact else None,
        "companyCreated": company_created,
        "contactCreated": contact_created,
    }
    _audit(
        actor,
        lead.workspace_id,
        "sales.lead.converted",
        lead,
        lead.display_name,
        changes=[change("Status", before, Lead.CONVERTED, kind="status")],
        data=payload,
    )
    _event("sales.lead.converted", lead, actor, "sales.lead", payload)
    return {"lead": lead, "opportunity": opp, "company": company, "contact": contact, **payload}


@transaction.atomic
def bulk_assign_leads(actor: Any, workspace: Any, lead_ids: list[Any], owner_id: Any) -> int:
    rows = _bulk_records(actor, workspace, Lead, lead_ids, perms.LEAD_VIEW, perms.LEAD_ASSIGN, "leadIds", "leads")
    new_owner = scope.check_owner_change(actor, workspace, perms.LEAD_ASSIGN, owner_id)
    changed = 0
    for lead in rows:
        if lead.owner_id == new_owner.pk:
            continue
        _lead_open(lead)
        before = lead.owner.name if lead.owner_id else None
        lead.owner = new_owner
        lead.save(update_fields=["owner", "updated_at"])
        _audit(
            actor,
            workspace,
            "sales.lead.updated",
            lead,
            lead.display_name,
            changes=[change("Owner", before, new_owner.name, kind="person")],
            data={"bulk": True},
        )
        changed += 1
    return changed


@transaction.atomic
def delete_lead(actor: Any, lead: Lead) -> None:
    scope.require_in_scope(actor, lead, perms.LEAD_DELETE)
    _soft_delete(actor, lead)
    _audit(actor, lead.workspace_id, "sales.lead.deleted", lead, lead.display_name)


@transaction.atomic
def restore_lead(actor: Any, lead: Lead) -> None:
    lead.deleted_at, lead.deleted_by = None, None
    lead.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit(actor, lead.workspace_id, "sales.lead.restored", lead, lead.display_name)


def purge_lead(actor: Any, lead: Lead) -> None:
    from core.collab.services import delete_target_records

    delete_target_records("sales.lead", [lead.pk])
    _audit(actor, lead.workspace_id, "sales.lead.purged", lead, lead.display_name)
    lead.delete()


# ───────────────────────── opportunities ─────────────────────────

OPPORTUNITY_LABELS = {
    "title": "Title",
    "expected_value": "Expected value",
    "probability_override": "Probability",
    "expected_close_date": "Expected close",
    "next_action": "Next step",
    "notes": "Notes",
}


def _lock_opportunity(opp: Opportunity) -> Opportunity:
    locked = Opportunity.objects.for_workspace(opp.workspace_id).select_for_update().get(pk=opp.pk)
    return (
        Opportunity.objects.for_workspace(opp.workspace_id)
        .select_related("stage", "owner", "company")
        .get(pk=locked.pk)
    )


def check_version(actor: Any, opp: Opportunity, version: Any, *, required: bool = True) -> None:
    """409 `version_conflict` (with the current record) when `version` isn't the opportunity's current version."""
    if version is None:
        if required:
            raise invalid({"version": "Send the version you edited (optimistic concurrency)."})
        return
    if version != opp.version:
        from .pipeline_serializers import opportunity_payload

        raise ApiError(
            409,
            "version_conflict",
            "Someone else changed this opportunity. Reload it and try again.",
            {"current": opportunity_payload(actor, opp)},
        )


def _history(opp: Opportunity, kind: str, from_stage: PipelineStage | None, actor: Any, at: Any = None) -> None:
    OpportunityStageHistory.objects.create(
        workspace_id=opp.workspace_id,
        opportunity=opp,
        kind=kind,
        from_stage=from_stage,
        from_stage_name=from_stage.name if from_stage else "",
        to_stage=opp.stage,
        to_stage_name=opp.stage.name,
        changed_by=actor,
        changed_at=at or timezone.now(),
    )


def _open_stage(workspace: Any, stage_id: Any) -> PipelineStage:
    stage = PipelineStage.objects.for_workspace(workspace).filter(pk=stage_id).first()
    if stage is None:
        raise invalid({"stageId": "Pick a stage of this pipeline"})
    if stage.category != PipelineStage.OPEN:
        raise invalid({"stageId": "Mark the deal won or lost instead"})
    return stage


def _require_open(opp: Opportunity) -> None:
    if opp.stage.category != PipelineStage.OPEN:
        raise conflict(
            "opportunity_closed",
            f"This opportunity is already {opp.stage.category}. Reopen it first.",
            {"status": opp.stage.category},
        )


def _new_opportunity(
    actor: Any,
    workspace: Any,
    *,
    company: Company,
    contact: Contact | None,
    product: Product | None,
    stage: PipelineStage | None,
    owner: Any,
    fields: dict[str, Any],
    source_lead: Lead | None = None,
) -> Opportunity:
    if stage is None:  # pragma: no cover - the defaults always keep an open stage
        raise conflict("last_open_stage", "Add an open stage first.")
    opp = Opportunity(
        workspace_id=getattr(workspace, "pk", workspace),
        company=company,
        contact=contact,
        product=product,
        stage=stage,
        owner=owner,
        source_lead=source_lead,
        **{k: v for k, v in fields.items() if k in OPPORTUNITY_LABELS},
    )
    opp.save()
    _history(opp, OpportunityStageHistory.CREATED, None, actor, opp.created_at)
    _audit(
        actor,
        workspace,
        "sales.opportunity.created",
        opp,
        opp.title,
        data={"ownerId": str(opp.owner_id), "companyId": str(company.pk), "stageId": str(stage.pk)},
    )
    _event(
        "sales.opportunity.created",
        opp,
        actor,
        "sales.opportunity",
        {
            "opportunityId": str(opp.pk),
            "ownerId": str(opp.owner_id),
            "sourceLeadId": str(source_lead.pk) if source_lead else None,
        },
    )
    return opp


@transaction.atomic
def create_opportunity(actor: Any, workspace: Any, data: dict[str, Any]) -> Opportunity:
    company = _visible_company(actor, workspace, data["company_id"])
    contact = _contact(actor, workspace, data.get("contact_id"), company)
    product = _product(workspace, data.get("product_id"))
    ensure_defaults(workspace)
    stage = _open_stage(workspace, data["stage_id"]) if data.get("stage_id") else first_open_stage(workspace)
    holder = Opportunity(owner=actor)
    _owner_change(actor, workspace, perms.OPPORTUNITY_ASSIGN, holder, data)
    return _new_opportunity(
        actor,
        workspace,
        company=company,
        contact=contact,
        product=product,
        stage=stage,
        owner=holder.owner,
        fields=data,
    )


def _reassign(actor: Any, opp: Opportunity, owner_id: Any) -> dict[str, Any] | None:
    """Hands the opportunity (and its quotations) to `owner_id` under `sales.opportunity.assign`; never touches
    `credited_user`. Returns the audit change; emits `sales.opportunity.reassigned`."""
    if str(owner_id) == str(opp.owner_id):
        return None
    scope.require_in_scope(actor, opp, perms.OPPORTUNITY_ASSIGN)
    new_owner = scope.check_owner_change(actor, opp.workspace_id, perms.OPPORTUNITY_ASSIGN, owner_id)
    before_id, before = opp.owner_id, _name(opp.owner)
    opp.owner = new_owner
    Quotation.all_objects.for_workspace(opp.workspace_id).filter(opportunity=opp).update(
        owner=new_owner, updated_at=timezone.now()
    )
    # Saved before the event, so its handlers (the new owner's notification) see the new owner.
    opp.save(update_fields=["owner", "updated_at"])
    _event(
        "sales.opportunity.reassigned",
        opp,
        actor,
        "sales.opportunity",
        {
            "opportunityId": str(opp.pk),
            "fromOwnerId": str(before_id) if before_id else None,
            "toOwnerId": str(new_owner.pk),
        },
    )
    return change("Owner", before, new_owner.name, kind="person")


def _credit(actor: Any, opp: Opportunity, user_id: Any) -> dict[str, Any] | None:
    """Changes who a won deal counts for: needs `sales.opportunity.reopen` on the record; audited."""
    from core.accounts.models import User
    from core.workspaces.models import WorkspaceMember

    if str(user_id or "") == str(opp.credited_user_id or ""):
        return None
    if opp.stage.category != PipelineStage.WON:
        raise invalid({"creditedUserId": "Only won deals are credited to someone"})
    scope.require_in_scope(actor, opp, perms.OPPORTUNITY_REOPEN)
    if user_id is None:
        raise invalid({"creditedUserId": "Pick a member of this workspace"})
    if not WorkspaceMember.objects.for_workspace(opp.workspace_id).filter(user_id=user_id, status="active").exists():
        raise invalid({"creditedUserId": "Pick a member of this workspace"})
    user = User.objects.get(pk=user_id)
    before = _name(opp.credited_user)
    opp.credited_user = user
    return change("Credited to", before, user.name, kind="person")


def _opportunity_refs(actor: Any, opp: Opportunity, data: dict[str, Any]) -> list[dict[str, Any]]:
    changes = []
    ws = opp.workspace_id
    if "company_id" in data and str(data["company_id"]) != str(opp.company_id):
        company = _visible_company(actor, ws, data["company_id"])
        changes.append(change("Company", opp.company.name, company.name))
        opp.company = company
        if opp.contact is not None and opp.contact.company_id != company.pk and "contact_id" not in data:
            changes.append(change("Contact", opp.contact.name, None))
            opp.contact = None
    if "contact_id" in data and str(data["contact_id"] or "") != str(opp.contact_id or ""):
        contact = _contact(actor, ws, data["contact_id"], opp.company)
        changes.append(change("Contact", _name(opp.contact) if opp.contact_id else None, _name(contact)))
        opp.contact = contact
    if "product_id" in data and str(data["product_id"] or "") != str(opp.product_id or ""):
        product = _product(ws, data["product_id"], opp.product_id)
        changes.append(change("Product", _name(opp.product) if opp.product_id else None, _name(product)))
        opp.product = product
    return changes


@transaction.atomic
def update_opportunity(actor: Any, opp: Opportunity, data: dict[str, Any]) -> Opportunity:
    scope.require_in_scope(actor, opp, perms.OPPORTUNITY_EDIT)
    opp = _lock_opportunity(opp)
    check_version(actor, opp, data.get("version"), required=False)
    before_company = opp.company_id
    changes = _apply(opp, data, OPPORTUNITY_LABELS)
    changes += _opportunity_refs(actor, opp, data)
    if "owner_id" in data:
        owner = _reassign(actor, opp, data["owner_id"])
        if owner is not None:
            changes.append(owner)
    if "credited_user_id" in data:
        credit = _credit(actor, opp, data["credited_user_id"])
        if credit is not None:
            changes.append(credit)
    if changes:
        opp.version += 1
        opp.save()
        _audit(actor, opp.workspace_id, "sales.opportunity.updated", opp, opp.title, changes=changes)
        sync_company("opportunity", opp, before_company)
    return opp


@transaction.atomic
def bulk_assign_opportunities(actor: Any, workspace: Any, ids: list[Any], owner_id: Any) -> int:
    rows = _bulk_records(
        actor,
        workspace,
        Opportunity,
        ids,
        perms.OPPORTUNITY_VIEW,
        perms.OPPORTUNITY_ASSIGN,
        "opportunityIds",
        "opportunities",
    )
    scope.check_owner_change(actor, workspace, perms.OPPORTUNITY_ASSIGN, owner_id)
    changed = 0
    for opp in rows:
        owner = _reassign(actor, opp, owner_id)
        if owner is None:
            continue
        opp.version += 1
        opp.save(update_fields=["owner", "version", "updated_at"])
        _audit(actor, workspace, "sales.opportunity.updated", opp, opp.title, changes=[owner], data={"bulk": True})
        changed += 1
    return changed


@transaction.atomic
def move_opportunity(actor: Any, opp: Opportunity, stage_id: Any, version: Any) -> Opportunity:
    scope.require_in_scope(actor, opp, perms.OPPORTUNITY_MOVE)
    opp = _lock_opportunity(opp)
    check_version(actor, opp, version)
    _require_open(opp)
    stage = _open_stage(opp.workspace_id, stage_id)
    if stage.pk == opp.stage_id:
        return opp
    before = opp.stage
    opp.stage = stage
    opp.version += 1
    opp.save()
    _history(opp, OpportunityStageHistory.MOVED, before, actor)
    _audit(
        actor,
        opp.workspace_id,
        "sales.opportunity.moved",
        opp,
        opp.title,
        changes=[change("Stage", before.name, stage.name, kind="status")],
    )
    _event(
        "sales.opportunity.moved",
        opp,
        actor,
        "sales.opportunity",
        {"opportunityId": str(opp.pk), "fromStageId": str(before.pk), "toStageId": str(stage.pk)},
    )
    return opp


def _closing_stage(workspace: Any, category: str) -> PipelineStage:
    ensure_defaults(workspace)
    return PipelineStage.objects.for_workspace(workspace).get(category=category)


def parse_won_at(actor: Any, workspace: Any, raw: Any, now: dt.datetime) -> dt.datetime:
    """`wonAt`: default now. A timestamp (naive = workspace time) or a business date (that date at 12:00 workspace
    time; today = now). Never in the future. An earlier business date needs `sales.opportunity.close` with scope
    `team` or `all` (else 403) and must fall within the current closing period, this month (else 422)."""
    if raw in (None, ""):
        return now
    text = str(raw).strip()
    try:
        day = parse_date(text) if len(text) == 10 else None
        instant = None if day is not None else parse_datetime(text)
    except ValueError:
        day = instant = None
    if day is not None:
        if day == workspace_today(workspace, now):
            return now
        instant = dt.datetime.combine(day, dt.time(12, 0), tzinfo=workspace_zone(workspace))
    elif instant is None:
        raise invalid({"wonAt": "Use a date (YYYY-MM-DD) or a timestamp"})
    elif instant.tzinfo is None:
        instant = instant.replace(tzinfo=workspace_zone(workspace))
    if instant > now + dt.timedelta(minutes=1):
        raise invalid({"wonAt": "A deal can’t be won in the future"})
    day, today = local_date(workspace, instant), workspace_today(workspace, now)
    if day < today:
        if scope.scope_of(actor, workspace, perms.OPPORTUNITY_CLOSE) not in (TEAM, ALL):
            raise forbidden(
                "Only managers can back-date a won deal.", {"permission": perms.OPPORTUNITY_CLOSE, "scope": TEAM}
            )
        period = current_period(workspace, CLOSING_PERIOD, now=now)
        if not period.contains(day):
            raise invalid({"wonAt": f"Pick a date in the current period (from {period.start:%Y-%m-%d})"})
    return instant


@transaction.atomic
def win_opportunity(actor: Any, opp: Opportunity, data: dict[str, Any]) -> Opportunity:
    scope.require_in_scope(actor, opp, perms.OPPORTUNITY_CLOSE)
    opp = _lock_opportunity(opp)
    check_version(actor, opp, data.get("version"), required=False)
    _require_open(opp)
    workspace = _workspace(opp)
    now = timezone.now()
    won_at = parse_won_at(actor, workspace, data.get("won_at"), now)
    before = opp.stage
    opp.stage = _closing_stage(workspace, PipelineStage.WON)
    opp.won_at = won_at
    opp.won_value = data["won_value"] if data.get("won_value") is not None else opp.expected_value
    opp.credited_user = opp.owner
    opp.lost_at, opp.lost_reason, opp.lost_note = None, None, ""
    opp.version += 1
    opp.save()
    _history(opp, OpportunityStageHistory.WON, before, actor)
    payload = {
        "opportunityId": str(opp.pk),
        "wonValue": f"{opp.won_value:.2f}",
        "wonAt": won_at.isoformat(),
        "creditedUserId": str(opp.credited_user_id) if opp.credited_user_id else None,
        "companyId": str(opp.company_id),
    }
    _audit(
        actor,
        opp.workspace_id,
        "sales.opportunity.won",
        opp,
        opp.title,
        changes=[change("Stage", before.name, opp.stage.name, kind="status")],
        data=payload,
    )
    company = Company.objects.for_workspace(opp.workspace_id).select_for_update().get(pk=opp.company_id)
    if company.status != Company.ACTIVE:
        status_change = change("Status", company.status, Company.ACTIVE, kind="status")
        company.status = Company.ACTIVE
        company.save(update_fields=["status", "updated_at"])
        _audit(actor, opp.workspace_id, "sales.company.updated", company, company.name, changes=[status_change])
    _event("sales.opportunity.won", opp, actor, "sales.opportunity", payload)
    return opp


@transaction.atomic
def lose_opportunity(actor: Any, opp: Opportunity, data: dict[str, Any]) -> Opportunity:
    scope.require_in_scope(actor, opp, perms.OPPORTUNITY_CLOSE)
    opp = _lock_opportunity(opp)
    check_version(actor, opp, data.get("version"), required=False)
    _require_open(opp)
    reason = (
        LostReason.objects.for_workspace(opp.workspace_id).filter(pk=data["lost_reason_id"], is_active=True).first()
    )
    if reason is None:
        raise invalid({"lostReasonId": "Pick an active lost reason"})
    before = opp.stage
    opp.stage = _closing_stage(opp.workspace_id, PipelineStage.LOST)
    opp.lost_at, opp.lost_reason, opp.lost_note = timezone.now(), reason, data.get("lost_note", "")
    opp.won_at, opp.won_value, opp.credited_user = None, None, None
    opp.version += 1
    opp.save()
    _history(opp, OpportunityStageHistory.LOST, before, actor)
    payload = {"opportunityId": str(opp.pk), "lostReasonId": str(reason.pk), "lostReason": reason.name}
    _audit(
        actor,
        opp.workspace_id,
        "sales.opportunity.lost",
        opp,
        opp.title,
        changes=[change("Stage", before.name, opp.stage.name, kind="status")],
        data=payload,
    )
    _event("sales.opportunity.lost", opp, actor, "sales.opportunity", payload)
    return opp


@transaction.atomic
def reopen_opportunity(actor: Any, opp: Opportunity, data: dict[str, Any]) -> Opportunity:
    """Back to an open stage (the given one, else the first), clearing the won or lost fields. Needs `close` and
    `reopen` in scope."""
    scope.require_in_scope(actor, opp, perms.OPPORTUNITY_REOPEN)
    scope.require_in_scope(actor, opp, perms.OPPORTUNITY_CLOSE)
    opp = _lock_opportunity(opp)
    check_version(actor, opp, data.get("version"), required=False)
    if opp.stage.category == PipelineStage.OPEN:
        raise conflict("opportunity_open", "This opportunity is already open.")
    stage = _open_stage(opp.workspace_id, data["stage_id"]) if data.get("stage_id") else None
    stage = stage or first_open_stage(opp.workspace_id)
    if stage is None:  # pragma: no cover - the defaults always keep an open stage
        raise conflict("last_open_stage", "Add an open stage first.")
    before = opp.stage
    changes = [change("Stage", before.name, stage.name, kind="status")]
    if opp.won_at is not None:
        changes.append(change("Won value", opp.won_value, None))
        changes.append(change("Credited to", _name(opp.credited_user), None, "person"))
    if opp.lost_reason_id is not None:
        changes.append(change("Lost reason", _name(opp.lost_reason), None))
    opp.stage = stage
    opp.won_at, opp.won_value, opp.credited_user = None, None, None
    opp.lost_at, opp.lost_reason, opp.lost_note = None, None, ""
    opp.version += 1
    opp.save()
    _history(opp, OpportunityStageHistory.REOPENED, before, actor)
    _audit(actor, opp.workspace_id, "sales.opportunity.reopened", opp, opp.title, changes=changes)
    return opp


@transaction.atomic
def delete_opportunity(actor: Any, opp: Opportunity) -> None:
    """Soft-deletes the opportunity and its live quotations (same instant: a restore brings exactly those back)."""
    scope.require_in_scope(actor, opp, perms.OPPORTUNITY_DELETE)
    now = timezone.now()
    Quotation.objects.for_workspace(opp.workspace_id).filter(opportunity=opp).update(
        deleted_at=now, deleted_by=actor, updated_at=now
    )
    _soft_delete(actor, opp, now)
    _audit(actor, opp.workspace_id, "sales.opportunity.deleted", opp, opp.title)


@transaction.atomic
def restore_opportunity(actor: Any, opp: Opportunity) -> None:
    Quotation.all_objects.for_workspace(opp.workspace_id).filter(opportunity=opp, deleted_at=opp.deleted_at).update(
        deleted_at=None, deleted_by=None, updated_at=timezone.now()
    )
    opp.deleted_at, opp.deleted_by = None, None
    opp.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit(actor, opp.workspace_id, "sales.opportunity.restored", opp, opp.title)


def purge_opportunity(actor: Any, opp: Opportunity) -> None:
    from core.collab.services import delete_target_records

    quotes = Quotation.all_objects.for_workspace(opp.workspace_id).filter(opportunity=opp)
    delete_target_records("sales.quotation", list(quotes.values_list("pk", flat=True)))
    delete_target_records("sales.opportunity", [opp.pk])
    _audit(actor, opp.workspace_id, "sales.opportunity.purged", opp, opp.title)
    opp.delete()


# ───────────────────────── quotations ─────────────────────────

QUOTATION_LABELS = {"title": "Title", "amount": "Amount", "valid_until": "Valid until", "notes": "Notes"}


def next_number(workspace: Any, year: int) -> str:
    """The next `Q-<year>-0001` of the workspace: a counter row locked for update (concurrent creates wait, so numbers
    never repeat or skip). Call inside a transaction."""
    wid = getattr(workspace, "pk", workspace)
    seq, _ = (
        SalesSequence.objects.for_workspace(wid)
        .select_for_update()
        .get_or_create(workspace_id=wid, key=f"quotation:{year}")
    )
    seq.last += 1
    seq.save(update_fields=["last", "updated_at"])
    return f"Q-{year}-{seq.last:04d}"


def _quote_label(q: Quotation) -> str:
    return f"{q.number} {q.title}"


def _transition(q: Quotation, action: str, allowed: tuple[str, ...]) -> None:
    if q.status not in allowed:
        raise conflict(
            "invalid_transition",
            f"A {q.status} quotation can’t be {action}.",
            {"status": q.status, "action": action},
        )


def _lock_quotation(q: Quotation) -> Quotation:
    return Quotation.objects.for_workspace(q.workspace_id).select_for_update().get(pk=q.pk)


@transaction.atomic
def create_quotation(actor: Any, workspace: Any, data: dict[str, Any]) -> Quotation:
    qs = Opportunity.objects.for_workspace(workspace).filter(pk=data["opportunity_id"])
    opp = scope.visible(qs, actor, perms.OPPORTUNITY_VIEW, workspace).first()
    if opp is None:
        raise invalid({"opportunityId": "Pick an opportunity you can see"})
    ws = _workspace(opp)
    q = Quotation(
        workspace_id=opp.workspace_id,
        opportunity=opp,
        owner_id=opp.owner_id,
        number=next_number(ws, workspace_today(ws).year),
        **{k: v for k, v in data.items() if k in QUOTATION_LABELS},
    )
    q.save()
    _audit(
        actor,
        workspace,
        "sales.quotation.created",
        q,
        _quote_label(q),
        data={"opportunityId": str(opp.pk), "amount": f"{q.amount:.2f}"},
    )
    return q


@transaction.atomic
def update_quotation(actor: Any, q: Quotation, data: dict[str, Any]) -> Quotation:
    scope.require_in_scope(actor, q, perms.QUOTATION_EDIT)
    q = _lock_quotation(q)
    _transition(q, "edited", (Quotation.DRAFT, Quotation.SENT))
    changes = _apply(q, data, QUOTATION_LABELS)
    if changes:
        q.save()
        _audit(actor, q.workspace_id, "sales.quotation.updated", q, _quote_label(q), changes=changes)
    return q


def on_quotation_sent(q: Quotation, actor: Any) -> None:
    """Spec §5: sending creates a `quotation` activity on the opportunity (and updates its `last_activity_at`). The
    opportunity timeline keeps showing the send as `quotation_sent` and leaves that activity out."""
    from .activity_services import log_quotation_sent

    log_quotation_sent(q, actor)


@transaction.atomic
def send_quotation(actor: Any, q: Quotation, data: dict[str, Any]) -> Quotation:
    """draft → sent. `validUntil` defaults to today + the validity days (workspace time)."""
    from .defaults import ensure_defaults as settings_of

    scope.require_in_scope(actor, q, perms.QUOTATION_EDIT)
    q = _lock_quotation(q)
    _transition(q, "sent", (Quotation.DRAFT,))
    ws = _workspace(q)
    today = workspace_today(ws)
    valid_until = data.get("valid_until")
    if valid_until is None:
        valid_until = today + dt.timedelta(days=settings_of(ws).quotation_validity_days)
    if valid_until < today:
        raise invalid({"validUntil": "Pick today or a later date"})
    q.status, q.sent_at, q.valid_until = Quotation.SENT, timezone.now(), valid_until
    q.save()
    payload = {
        "quotationId": str(q.pk),
        "opportunityId": str(q.opportunity_id),
        "number": q.number,
        "validUntil": valid_until.isoformat(),
    }
    _audit(
        actor,
        q.workspace_id,
        "sales.quotation.sent",
        q,
        _quote_label(q),
        changes=[change("Status", Quotation.DRAFT, Quotation.SENT, kind="status")],
        data=payload,
    )
    _event("sales.quotation.sent", q, actor, "sales.quotation", payload)
    on_quotation_sent(q, actor)
    return q


@transaction.atomic
def answer_quotation(actor: Any, q: Quotation, status: str) -> Quotation:
    """sent → accepted or rejected. Accepting never wins the opportunity (spec §5)."""
    scope.require_in_scope(actor, q, perms.QUOTATION_EDIT)
    q = _lock_quotation(q)
    _transition(q, status, (Quotation.SENT,))
    q.status, q.responded_at = status, timezone.now()
    q.save()
    _audit(
        actor,
        q.workspace_id,
        f"sales.quotation.{status}",
        q,
        _quote_label(q),
        changes=[change("Status", Quotation.SENT, status, kind="status")],
    )
    return q


#: A sent quotation is "expiring" (one notification to its owner) from this many days before `valid_until`.
EXPIRING_DAYS = 3


def notify_expiring_quotations(workspace: Any, *, now: dt.datetime) -> int:
    """Runs with the nightly job: one `sales.quotation.expiring` event per sent quotation valid until today or the
    next `EXPIRING_DAYS` days, once per quotation and valid-until date (`core.jobs.services.claim`)."""
    from core.jobs.services import claim

    today = now.date()
    rows = Quotation.objects.for_workspace(workspace).filter(
        status=Quotation.SENT,
        valid_until__gte=today,
        valid_until__lte=today + dt.timedelta(days=EXPIRING_DAYS),
        opportunity__deleted_at__isnull=True,
    )
    sent = 0
    for q in rows.order_by("valid_until", "id"):
        if claim(workspace, "sales_expire_quotations", f"expiring:{q.pk}:{q.valid_until}"):
            payload = {"quotationId": str(q.pk), "number": q.number, "validUntil": q.valid_until.isoformat()}
            emit(
                "sales.quotation.expiring",
                workspace=workspace,
                target_type="sales.quotation",
                target_id=q.pk,
                payload=payload,
            )
            sent += 1
    return sent


def expire_quotations(workspace: Any, *, now: dt.datetime) -> int:
    """The nightly `sales_expire_quotations` job: sent quotations whose `valid_until` is before today (workspace
    time) become `expired`. Idempotent: a second run finds nothing left to expire."""
    today = now.date()
    rows = Quotation.objects.for_workspace(workspace).filter(status=Quotation.SENT, valid_until__lt=today)
    count = 0
    for q in rows.select_for_update():
        q.status, q.expired_at = Quotation.EXPIRED, now
        q.save(update_fields=["status", "expired_at", "updated_at"])
        _audit(
            None,
            workspace,
            "sales.quotation.expired",
            q,
            _quote_label(q),
            changes=[change("Status", Quotation.SENT, Quotation.EXPIRED, kind="status")],
        )
        count += 1
    return count


@transaction.atomic
def delete_quotation(actor: Any, q: Quotation) -> None:
    scope.require_in_scope(actor, q, perms.QUOTATION_DELETE)
    _soft_delete(actor, q)
    _audit(actor, q.workspace_id, "sales.quotation.deleted", q, _quote_label(q))


@transaction.atomic
def restore_quotation(actor: Any, q: Quotation) -> None:
    q.deleted_at, q.deleted_by = None, None
    q.owner_id = q.opportunity.owner_id  # follow the opportunity's owner, which may have changed meanwhile
    q.save(update_fields=["deleted_at", "deleted_by", "owner", "updated_at"])
    _audit(actor, q.workspace_id, "sales.quotation.restored", q, _quote_label(q))


def purge_quotation(actor: Any, q: Quotation) -> None:
    from core.collab.services import delete_target_records

    delete_target_records("sales.quotation", [q.pk])
    _audit(actor, q.workspace_id, "sales.quotation.purged", q, _quote_label(q))
    q.delete()
