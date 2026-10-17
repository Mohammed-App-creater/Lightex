"""Sales writes (S1: reference data, companies, contacts; S2's leads, opportunities and quotations are in
`pipeline_services.py`). Every mutation writes one audit row (`sales.<entity>.<verb>`) inside its transaction. The
views have already checked the permission code and the record's view scope; the services check the action's scope on
the record (`scope.require_in_scope`) and the owner-change rule (`scope.check_owner_change`).

The in-use guards (`stage_in_use`, `product_in_use`, `lost_reason_in_use`, `company_has_opportunities`) look at S2's
leads and opportunities, including those in the trash.
"""

from __future__ import annotations

from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone

from core.audit.services import change, record
from core.common.exceptions import ApiError, conflict, invalid

from . import module as perms
from . import scope
from .defaults import ensure_defaults
from .models import (
    WEEKDAYS,
    Company,
    Contact,
    Holiday,
    Lead,
    LostReason,
    Opportunity,
    PipelineStage,
    Product,
    SalesCalendar,
    SalesSettings,
)
from .normalize import normalize_name, normalize_phone
from .selectors import get_calendar

MAX_OPEN_STAGES = 20

# ───────────────────────── in-use guards (S2 records) ─────────────────────────


def stage_in_use(stage: PipelineStage) -> bool:
    """True when an opportunity (live or in the trash) sits in the stage."""
    return Opportunity.all_objects.for_workspace(stage.workspace_id).filter(stage=stage).exists()


def product_in_use(product: Product) -> bool:
    """True when a lead or an opportunity (live or in the trash) names the product."""
    ws = product.workspace_id
    return (
        Lead.all_objects.for_workspace(ws).filter(product=product).exists()
        or Opportunity.all_objects.for_workspace(ws).filter(product=product).exists()
    )


def lost_reason_in_use(reason: LostReason) -> bool:
    """True when a lost opportunity (live or in the trash) names the reason."""
    return Opportunity.all_objects.for_workspace(reason.workspace_id).filter(lost_reason=reason).exists()


def company_has_opportunities(company: Company) -> bool:
    """True when the company has opportunities (live or in the trash); deleting it is then refused (archive it with
    status inactive)."""
    return Opportunity.all_objects.for_workspace(company.workspace_id).filter(company=company).exists()


# ───────────────────────── helpers ─────────────────────────


def _save_unique(obj: Any, error: ApiError) -> None:
    """Saves under a savepoint so a concurrent duplicate answers 409, not 500."""
    try:
        with transaction.atomic():
            obj.save()
    except IntegrityError as exc:
        raise error from exc


def _name_taken(name: str) -> ApiError:
    return conflict("name_taken", f"“{name}” already exists.", {"name": name})


def _apply(obj: Any, data: dict[str, Any], labels: dict[str, str]) -> list[dict[str, Any]]:
    """Sets the given fields and returns the audit changes (fields that really changed)."""
    changes = []
    for field, label in labels.items():
        if field in data and getattr(obj, field) != data[field]:
            changes.append(change(label, getattr(obj, field), data[field]))
            setattr(obj, field, data[field])
    return changes


def _audit(actor: Any, workspace: Any, action: str, obj: Any, target: str, **kwargs: Any) -> None:
    record(workspace=workspace, actor=actor, action=action, target=target, entity_id=obj.pk, **kwargs)


# ───────────────────────── settings ─────────────────────────

SETTINGS_LABELS = {
    "week_start": "Week start",
    "fiscal_year_start_month": "Fiscal year start",
    "status_green_pct": "Green from",
    "status_yellow_pct": "Yellow from",
    "upcoming_days": "Upcoming days",
    "stale_days": "Stale after",
    "large_deal_threshold": "Large deal threshold",
    "daily_report_cutoff": "Daily report cutoff",
    "daily_report_required": "Daily report required",
    "quotation_validity_days": "Quotation validity",
    "calendar_display": "Calendar display",
}


@transaction.atomic
def update_settings(actor: Any, workspace: Any, data: dict[str, Any]) -> SalesSettings:
    s = SalesSettings.objects.select_for_update().get(pk=ensure_defaults(workspace).pk)
    green = data.get("status_green_pct", s.status_green_pct)
    yellow = data.get("status_yellow_pct", s.status_yellow_pct)
    if yellow > green:
        raise invalid({"statusYellowPct": "Keep yellow at or below green"})
    changes = _apply(s, data, SETTINGS_LABELS)
    if changes:
        s.save()
        _audit(actor, workspace, "sales.settings.updated", s, "Sales settings", changes=changes)
    return s


# ───────────────────────── pipeline stages ─────────────────────────

_CATEGORY_RANK = {PipelineStage.OPEN: 0, PipelineStage.WON: 1, PipelineStage.LOST: 2}


def _renumber(workspace: Any, open_ids: list[Any] | None = None) -> None:
    """Open stages first (in `open_ids` order when given), then Won, then Lost; `order` = 0..n-1."""
    rows = list(PipelineStage.objects.for_workspace(workspace).select_for_update().order_by("order", "created_at"))
    if open_ids is not None:
        rank = {str(pk): i for i, pk in enumerate(open_ids)}
        rows.sort(key=lambda s: (_CATEGORY_RANK[s.category], rank.get(str(s.pk), 0)))
    else:
        rows.sort(key=lambda s: _CATEGORY_RANK[s.category])
    changed = []
    for i, s in enumerate(rows):
        if s.order != i:
            s.order = i
            changed.append(s)
    PipelineStage.objects.bulk_update(changed, ["order", "updated_at"])


@transaction.atomic
def create_stage(actor: Any, workspace: Any, data: dict[str, Any]) -> PipelineStage:
    ensure_defaults(workspace)
    stages = PipelineStage.objects.for_workspace(workspace)
    if stages.filter(category=PipelineStage.OPEN).count() >= MAX_OPEN_STAGES:
        raise conflict("too_many_stages", f"A pipeline can have at most {MAX_OPEN_STAGES} open stages.")
    top = stages.aggregate(m=Max("order"))["m"] or 0
    stage = PipelineStage(
        workspace_id=getattr(workspace, "pk", workspace),
        name=data["name"],
        default_probability=data["default_probability"],
        category=PipelineStage.OPEN,
        order=top + 1,
    )
    _save_unique(stage, _name_taken(stage.name))
    _renumber(workspace)
    stage.refresh_from_db()
    _audit(actor, workspace, "sales.stage.created", stage, stage.name)
    return stage


@transaction.atomic
def update_stage(actor: Any, stage: PipelineStage, data: dict[str, Any]) -> PipelineStage:
    if stage.is_system and "default_probability" in data and data["default_probability"] != stage.default_probability:
        raise invalid({"defaultProbability": f"The {stage.category} stage’s probability is fixed"})
    changes = _apply(stage, data, {"name": "Name", "default_probability": "Probability"})
    if changes:
        _save_unique(stage, _name_taken(stage.name))
        _audit(actor, stage.workspace_id, "sales.stage.updated", stage, stage.name, changes=changes)
    return stage


@transaction.atomic
def delete_stage(actor: Any, stage: PipelineStage) -> None:
    if stage.is_system:
        raise conflict("stage_is_system", "The Won and Lost stages can’t be deleted. You can rename them.")
    others = PipelineStage.objects.for_workspace(stage.workspace_id).filter(category=PipelineStage.OPEN)
    if not others.exclude(pk=stage.pk).exists():
        raise conflict("last_open_stage", "Keep at least one open stage.")
    if stage_in_use(stage):
        raise conflict("stage_in_use", "Move this stage’s opportunities to another stage first.")
    _audit(actor, stage.workspace_id, "sales.stage.deleted", stage, stage.name)
    workspace = stage.workspace_id
    stage.delete()
    _renumber(workspace)


@transaction.atomic
def reorder_stages(actor: Any, workspace: Any, stage_ids: list[Any]) -> None:
    ensure_defaults(workspace)
    open_ids = [
        str(pk)
        for pk in PipelineStage.objects.for_workspace(workspace)
        .filter(category=PipelineStage.OPEN)
        .order_by("order")
        .values_list("pk", flat=True)
    ]
    sent = [str(pk) for pk in stage_ids]
    if len(sent) != len(set(sent)) or set(sent) != set(open_ids):
        raise invalid({"stageIds": "List every open stage once"})
    if sent == open_ids:
        return
    _renumber(workspace, sent)
    names = {str(pk): name for pk, name in PipelineStage.objects.for_workspace(workspace).values_list("pk", "name")}
    record(
        workspace=workspace,
        actor=actor,
        action="sales.stage.reordered",
        target="Pipeline stages",
        changes=[change("Order", ", ".join(names[i] for i in open_ids), ", ".join(names[i] for i in sent))],
    )


# ───────────────────────── products and lost reasons ─────────────────────────


def _code_taken(code: str) -> ApiError:
    return conflict("code_taken", f"Another product uses the code “{code}”.", {"code": code})


def _product_unique(product: Product) -> None:
    clash = Product.objects.for_workspace(product.workspace_id).exclude(pk=product.pk)
    if clash.filter(name__iexact=product.name).exists():
        raise _name_taken(product.name)
    if product.code and clash.filter(code__iexact=product.code).exists():
        raise _code_taken(product.code)


PRODUCT_LABELS = {"name": "Name", "code": "Code", "category": "Category", "is_active": "Active"}


@transaction.atomic
def create_product(actor: Any, workspace: Any, data: dict[str, Any]) -> Product:
    product = Product(workspace_id=getattr(workspace, "pk", workspace), **data)
    _product_unique(product)
    _save_unique(product, _name_taken(product.name))
    _audit(actor, workspace, "sales.product.created", product, product.name)
    return product


@transaction.atomic
def update_product(actor: Any, product: Product, data: dict[str, Any]) -> Product:
    changes = _apply(product, data, PRODUCT_LABELS)
    if changes:
        _product_unique(product)
        _save_unique(product, _name_taken(product.name))
        _audit(actor, product.workspace_id, "sales.product.updated", product, product.name, changes=changes)
    return product


@transaction.atomic
def delete_product(actor: Any, product: Product) -> None:
    if product_in_use(product):
        raise conflict("product_in_use", "Leads or opportunities use this product. Deactivate it instead.")
    _audit(actor, product.workspace_id, "sales.product.deleted", product, product.name)
    product.delete()


def _reason_unique(reason: LostReason) -> None:
    clash = LostReason.objects.for_workspace(reason.workspace_id).exclude(pk=reason.pk)
    if clash.filter(name__iexact=reason.name).exists():
        raise _name_taken(reason.name)


@transaction.atomic
def create_lost_reason(actor: Any, workspace: Any, data: dict[str, Any]) -> LostReason:
    reason = LostReason(workspace_id=getattr(workspace, "pk", workspace), **data)
    _reason_unique(reason)
    _save_unique(reason, _name_taken(reason.name))
    _audit(actor, workspace, "sales.lostreason.created", reason, reason.name)
    return reason


@transaction.atomic
def update_lost_reason(actor: Any, reason: LostReason, data: dict[str, Any]) -> LostReason:
    changes = _apply(reason, data, {"name": "Name", "is_active": "Active"})
    if changes:
        _reason_unique(reason)
        _save_unique(reason, _name_taken(reason.name))
        _audit(actor, reason.workspace_id, "sales.lostreason.updated", reason, reason.name, changes=changes)
    return reason


@transaction.atomic
def delete_lost_reason(actor: Any, reason: LostReason) -> None:
    if lost_reason_in_use(reason):
        raise conflict("lost_reason_in_use", "Lost opportunities use this reason. Deactivate it instead.")
    _audit(actor, reason.workspace_id, "sales.lostreason.deleted", reason, reason.name)
    reason.delete()


# ───────────────────────── calendar and holidays ─────────────────────────


@transaction.atomic
def update_calendar(actor: Any, workspace: Any, weights: list[Any]) -> SalesCalendar:
    cal = SalesCalendar.objects.select_for_update().get(pk=get_calendar(workspace).pk)
    changes = _apply(cal, dict(zip(WEEKDAYS, weights, strict=True)), {d: d.capitalize() for d in WEEKDAYS})
    if changes:
        cal.save()
        _audit(actor, workspace, "sales.calendar.updated", cal, "Working calendar", changes=changes)
    return cal


def _date_taken(day: Any) -> ApiError:
    return conflict("date_taken", f"There’s already a holiday on {day:%Y-%m-%d}.", {"date": day.isoformat()})


def _holiday_unique(h: Holiday) -> None:
    if Holiday.objects.for_workspace(h.workspace_id).exclude(pk=h.pk).filter(date=h.date).exists():
        raise _date_taken(h.date)


@transaction.atomic
def create_holiday(actor: Any, workspace: Any, data: dict[str, Any]) -> Holiday:
    h = Holiday(workspace_id=getattr(workspace, "pk", workspace), **data)
    _holiday_unique(h)
    _save_unique(h, _date_taken(h.date))
    _audit(actor, workspace, "sales.holiday.created", h, f"{h.name} ({h.date:%Y-%m-%d})")
    return h


@transaction.atomic
def update_holiday(actor: Any, h: Holiday, data: dict[str, Any]) -> Holiday:
    changes = _apply(h, data, {"date": "Date", "name": "Name"})
    if changes:
        _holiday_unique(h)
        _save_unique(h, _date_taken(h.date))
        _audit(actor, h.workspace_id, "sales.holiday.updated", h, f"{h.name} ({h.date:%Y-%m-%d})", changes=changes)
    return h


@transaction.atomic
def delete_holiday(actor: Any, h: Holiday) -> None:
    _audit(actor, h.workspace_id, "sales.holiday.deleted", h, f"{h.name} ({h.date:%Y-%m-%d})")
    h.delete()


# ───────────────────────── companies ─────────────────────────

COMPANY_LABELS = {
    "name": "Name",
    "industry": "Industry",
    "region": "Region",
    "city": "City",
    "address": "Address",
    "phone": "Phone",
    "email": "Email",
    "website": "Website",
    "status": "Status",
    "notes": "Notes",
}


def _owner_change(actor: Any, workspace: Any, code: str, obj: Any, data: dict[str, Any]) -> dict[str, Any] | None:
    """Applies `owner_id` from `data` (checked by the owner-change rule); returns the audit change, if any."""
    if "owner_id" not in data or str(data["owner_id"]) == str(obj.owner_id):
        return None
    new_owner = scope.check_owner_change(actor, workspace, code, data["owner_id"])
    before = obj.owner.name if obj.owner_id else None
    obj.owner = new_owner
    return change("Owner", before, new_owner.name, kind="person")


def _normalize(company: Company) -> None:
    company.normalized_name = normalize_name(company.name)
    company.normalized_phone = normalize_phone(company.phone)


@transaction.atomic
def create_company(actor: Any, workspace: Any, data: dict[str, Any]) -> Company:
    fields = {k: v for k, v in data.items() if k in COMPANY_LABELS}
    company = Company(workspace_id=getattr(workspace, "pk", workspace), owner=actor, **fields)
    _owner_change(actor, workspace, perms.COMPANY_EDIT, company, data)
    _normalize(company)
    company.save()
    _audit(actor, workspace, "sales.company.created", company, company.name, data={"ownerId": str(company.owner_id)})
    return company


@transaction.atomic
def update_company(actor: Any, company: Company, data: dict[str, Any]) -> Company:
    scope.require_in_scope(actor, company, perms.COMPANY_EDIT)
    changes = _apply(company, data, COMPANY_LABELS)
    owner = _owner_change(actor, company.workspace_id, perms.COMPANY_EDIT, company, data)
    if owner is not None:
        changes.append(owner)
    if changes:
        _normalize(company)
        company.save()
        _audit(actor, company.workspace_id, "sales.company.updated", company, company.name, changes=changes)
    return company


@transaction.atomic
def delete_company(actor: Any, company: Company) -> None:
    """Soft-deletes the company and its live contacts (same instant, so a restore brings exactly those back)."""
    scope.require_in_scope(actor, company, perms.COMPANY_DELETE)
    if company_has_opportunities(company):
        raise conflict(
            "company_has_opportunities", "This company has opportunities. Set its status to inactive to archive it."
        )
    now = timezone.now()
    Contact.objects.for_workspace(company.workspace_id).filter(company=company).update(
        deleted_at=now, deleted_by=actor, updated_at=now
    )
    company.deleted_at, company.deleted_by = now, actor
    company.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit(actor, company.workspace_id, "sales.company.deleted", company, company.name)


@transaction.atomic
def restore_company(actor: Any, company: Company) -> None:
    Contact.all_objects.for_workspace(company.workspace_id).filter(
        company=company, deleted_at=company.deleted_at
    ).update(deleted_at=None, deleted_by=None, updated_at=timezone.now())
    company.deleted_at, company.deleted_by = None, None
    company.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit(actor, company.workspace_id, "sales.company.restored", company, company.name)


def purge_company(actor: Any, company: Company) -> None:
    from core.collab.services import delete_target_records

    contact_ids = list(
        Contact.all_objects.for_workspace(company.workspace_id).filter(company=company).values_list("pk", flat=True)
    )
    delete_target_records("sales.contact", contact_ids)
    delete_target_records("sales.company", [company.pk])
    _audit(actor, company.workspace_id, "sales.company.purged", company, company.name)
    company.delete()


# ───────────────────────── contacts ─────────────────────────

CONTACT_LABELS = {
    "name": "Name",
    "job_title": "Job title",
    "phone": "Phone",
    "email": "Email",
    "is_primary": "Primary",
    "notes": "Notes",
}


def _visible_company(actor: Any, workspace: Any, company_id: Any) -> Company:
    qs = scope.visible(Company.objects.for_workspace(workspace), actor, perms.COMPANY_VIEW, workspace)
    company = qs.filter(pk=company_id).first()
    if company is None:
        raise invalid({"companyId": "Pick a company you can see"})
    return company


def _only_primary(contact: Contact) -> None:
    if contact.is_primary:
        Contact.objects.for_workspace(contact.workspace_id).filter(
            company_id=contact.company_id, is_primary=True
        ).exclude(pk=contact.pk).update(is_primary=False, updated_at=timezone.now())


@transaction.atomic
def create_contact(actor: Any, workspace: Any, data: dict[str, Any]) -> Contact:
    company = _visible_company(actor, workspace, data["company_id"])
    fields = {k: v for k, v in data.items() if k in CONTACT_LABELS}
    contact = Contact(workspace_id=company.workspace_id, company=company, owner=actor, **fields)
    _owner_change(actor, workspace, perms.CONTACT_EDIT, contact, data)
    contact.save()
    _only_primary(contact)
    _audit(
        actor,
        workspace,
        "sales.contact.created",
        contact,
        f"{contact.name} ({company.name})",
        data={"companyId": str(company.pk), "ownerId": str(contact.owner_id)},
    )
    return contact


@transaction.atomic
def update_contact(actor: Any, contact: Contact, data: dict[str, Any]) -> Contact:
    scope.require_in_scope(actor, contact, perms.CONTACT_EDIT)
    before_company = contact.company_id
    changes = _apply(contact, data, CONTACT_LABELS)
    if "company_id" in data and str(data["company_id"]) != str(contact.company_id):
        company = _visible_company(actor, contact.workspace_id, data["company_id"])
        changes.append(change("Company", contact.company.name, company.name))
        contact.company = company
    owner = _owner_change(actor, contact.workspace_id, perms.CONTACT_EDIT, contact, data)
    if owner is not None:
        changes.append(owner)
    if changes:
        contact.save()
        _only_primary(contact)
        _audit(
            actor,
            contact.workspace_id,
            "sales.contact.updated",
            contact,
            f"{contact.name} ({contact.company.name})",
            changes=changes,
        )
        from .activity_services import sync_company

        sync_company("contact", contact, before_company)
    return contact


@transaction.atomic
def delete_contact(actor: Any, contact: Contact) -> None:
    scope.require_in_scope(actor, contact, perms.CONTACT_DELETE)
    contact.deleted_at, contact.deleted_by = timezone.now(), actor
    contact.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _audit(actor, contact.workspace_id, "sales.contact.deleted", contact, f"{contact.name} ({contact.company.name})")


@transaction.atomic
def restore_contact(actor: Any, contact: Contact) -> None:
    contact.deleted_at, contact.deleted_by = None, None
    if (
        contact.is_primary
        and Contact.objects.for_workspace(contact.workspace_id)
        .filter(company_id=contact.company_id, is_primary=True)
        .exists()
    ):
        contact.is_primary = False  # the company got a new primary contact meanwhile
    contact.save(update_fields=["deleted_at", "deleted_by", "is_primary", "updated_at"])
    _audit(actor, contact.workspace_id, "sales.contact.restored", contact, f"{contact.name} ({contact.company.name})")


def purge_contact(actor: Any, contact: Contact) -> None:
    from core.collab.services import delete_target_records

    delete_target_records("sales.contact", [contact.pk])
    _audit(actor, contact.workspace_id, "sales.contact.purged", contact, f"{contact.name} ({contact.company.name})")
    contact.delete()
