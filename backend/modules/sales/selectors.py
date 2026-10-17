"""Sales reads. Every list of owned records goes through `scope.visible()` (`visible_to()`)."""

from __future__ import annotations

import uuid
from typing import Any

from django.db.models import Q, QuerySet
from django.db.models.functions import Lower

from core.common.exceptions import invalid, not_found
from core.common.params import filter_values

from . import module as perms
from . import scope
from .defaults import ensure_defaults
from .models import Company, Contact, Holiday, LostReason, PipelineStage, Product, SalesCalendar, SalesSettings
from .normalize import normalize_name, normalize_phone

COMPANY_NOT_FOUND = "Company not found. It may have been deleted, or you may not have access."
CONTACT_NOT_FOUND = "Contact not found. It may have been deleted, or you may not have access."


def as_uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


# ───────────────────────── reference data ─────────────────────────


def get_settings(workspace: Any) -> SalesSettings:
    return ensure_defaults(workspace)


def stages(workspace: Any) -> QuerySet[PipelineStage]:
    """Open stages in their order, then Won, then Lost (the renumbering keeps that order)."""
    ensure_defaults(workspace)
    return PipelineStage.objects.for_workspace(workspace).order_by("order", "created_at")


def first_open_stage(workspace: Any) -> PipelineStage | None:
    """Where converted leads land (S2)."""
    return stages(workspace).filter(category=PipelineStage.OPEN).first()


def _active_filter(qs: QuerySet, raw: str | None, key: str = "filter[active]") -> QuerySet:
    if raw is None:
        return qs
    if raw not in ("true", "false"):
        raise invalid({key: "Use true or false"})
    return qs.filter(is_active=raw == "true")


def products(workspace: Any, active: str | None = None) -> QuerySet[Product]:
    qs = Product.objects.for_workspace(workspace).order_by(Lower("name"), "created_at")
    return _active_filter(qs, active)


def lost_reasons(workspace: Any, active: str | None = None) -> QuerySet[LostReason]:
    qs = LostReason.objects.for_workspace(workspace).order_by(Lower("name"), "created_at")
    return _active_filter(qs, active)


def get_calendar(workspace: Any) -> SalesCalendar:
    wid = getattr(workspace, "pk", workspace)
    cal, _ = SalesCalendar.objects.for_workspace(wid).get_or_create(workspace_id=wid)
    return cal


def holidays(workspace: Any, year: str | None = None) -> QuerySet[Holiday]:
    qs = Holiday.objects.for_workspace(workspace).order_by("date")
    if year is not None:
        if not year.isdigit() or not 1900 <= int(year) <= 2200:
            raise invalid({"filter[year]": "Pick a year"})
        qs = qs.filter(date__year=int(year))
    return qs


def get_record(model: Any, record_id: Any, message: str) -> Any:
    """A record by id in a live workspace, any tenant (the view then checks membership: 404 for outsiders)."""
    pk = as_uuid(record_id)
    obj = (
        model.objects.unscoped().select_related("workspace").filter(pk=pk, workspace__deleted_at__isnull=True).first()
        if pk
        else None
    )
    if obj is None:
        raise not_found(message)
    return obj


# ───────────────────────── companies ─────────────────────────


def companies_for(user: Any, workspace: Any) -> QuerySet[Company]:
    return scope.visible(Company.objects.for_workspace(workspace), user, perms.COMPANY_VIEW, workspace)


COMPANY_SORTS = {"name": "_sort_name", "createdAt": "created_at", "updatedAt": "updated_at", "status": "status"}


def _owner_ids(raw: list[str], user: Any, key: str) -> list[uuid.UUID]:
    out = []
    for v in raw:
        pk = user.pk if v == "me" else as_uuid(v)
        if pk is None:
            raise invalid({key: "Use user ids or me"})
        out.append(pk)
    return out


def filter_companies(qs: QuerySet[Company], request: Any) -> QuerySet[Company]:
    statuses = filter_values(request, "status")
    if any(s not in Company.STATUSES for s in statuses):
        raise invalid({"filter[status]": f"Use {', '.join(Company.STATUSES)}"})
    if statuses:
        qs = qs.filter(status__in=statuses)
    owners = filter_values(request, "owner")
    if owners:
        qs = qs.filter(owner_id__in=_owner_ids(owners, request.user, "filter[owner]"))
    for key in ("industry", "region", "city"):
        values = filter_values(request, key)
        if values:
            cond = Q()
            for v in values:
                cond |= Q(**{f"{key}__iexact": v})
            qs = qs.filter(cond)
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(email__icontains=q) | Q(city__icontains=q))
    return qs


def sort_spec(raw: str | None, sorts: dict[str, str], default: str = "name") -> tuple[list[tuple[str, bool]], str]:
    raw = raw or default
    desc = raw.startswith("-")
    name = raw[1:] if desc else raw
    if name not in sorts:
        raise invalid({"sort": f"Sort by one of: {', '.join(sorts)}"})
    return [(sorts[name], desc), ("id", False)], name


def with_sort(qs: QuerySet, name: str) -> QuerySet:
    return qs.annotate(_sort_name=Lower("name")) if name == "name" else qs


def company_for(user: Any, company: Company) -> Company:
    """The company if the user's view scope reaches it; 404 otherwise."""
    scope.require_visible(user, company, perms.COMPANY_VIEW, COMPANY_NOT_FOUND)
    return company


def duplicate_of(workspace: Any, name: str, phone: str, exclude: Any = None) -> Company | None:
    """The oldest live company matching the normalized name or phone, whatever the caller's scope."""
    cond = Q()
    norm_name, norm_phone = normalize_name(name), normalize_phone(phone)
    if norm_name:
        cond |= Q(normalized_name=norm_name)
    if norm_phone:
        cond |= Q(normalized_phone=norm_phone)
    if not cond:
        return None
    qs = Company.objects.for_workspace(workspace).filter(cond).select_related("owner")
    if exclude is not None:
        qs = qs.exclude(pk=exclude)
    return qs.order_by("created_at", "id").first()


# ───────────────────────── contacts ─────────────────────────


def contacts_for(user: Any, workspace: Any) -> QuerySet[Contact]:
    """Live contacts of live companies in the user's contact view scope."""
    qs = Contact.objects.for_workspace(workspace).filter(company__deleted_at__isnull=True)
    return scope.visible(qs, user, perms.CONTACT_VIEW, workspace)


CONTACT_SORTS = {"name": "_sort_name", "createdAt": "created_at", "updatedAt": "updated_at"}


def filter_contacts(qs: QuerySet[Contact], request: Any) -> QuerySet[Contact]:
    companies = filter_values(request, "company")
    if companies:
        if any(as_uuid(c) is None for c in companies):
            raise invalid({"filter[company]": "Use company ids"})
        qs = qs.filter(company_id__in=companies)
    owners = filter_values(request, "owner")
    if owners:
        qs = qs.filter(owner_id__in=_owner_ids(owners, request.user, "filter[owner]"))
    primary = filter_values(request, "primary")
    if primary:
        if primary[0] not in ("true", "false"):
            raise invalid({"filter[primary]": "Use true or false"})
        qs = qs.filter(is_primary=primary[0] == "true")
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(
            Q(name__icontains=q) | Q(phone__icontains=q) | Q(email__icontains=q) | Q(company__name__icontains=q)
        )
    return qs


def contact_for(user: Any, contact: Contact) -> Contact:
    if contact.company.deleted_at is not None:
        raise not_found(CONTACT_NOT_FOUND)
    scope.require_visible(user, contact, perms.CONTACT_VIEW, CONTACT_NOT_FOUND)
    return contact


# ───────────────────────── company summary (S1 stub; S2/S3 fill in deals and activity) ─────────────────────────


def company_summary(user: Any, company: Company) -> dict[str, Any]:
    contacts = contacts_for(user, company.workspace_id).filter(company=company)
    primary = contacts.select_related("owner", "company").filter(is_primary=True).order_by("created_at").first()
    return {"contactCount": contacts.count(), "primaryContact": primary}
