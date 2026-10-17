"""Sales tables (docs/sales/spec.md §4). S1: reference data and settings, companies and contacts.

Every table has a non-null `workspace`. Companies and contacts are soft-deleted and owned (`OwnedModel`: data scope
through `visible_to()`). Money is `Decimal(14, 2)`; there is no currency field (ETB only).
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower

from core.common.models import OwnedModel, WorkspaceScopedModel, WorkspaceScopedSoftDeleteModel

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


# ───────────────────────── reference and settings ─────────────────────────


class SalesSettings(WorkspaceScopedModel):
    """One per workspace, created with the defaults on first read (`services.ensure_defaults`)."""

    CALENDAR_DISPLAYS = ("gregorian", "ethiopian")

    workspace = models.OneToOneField("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    week_start = models.CharField(max_length=9, choices=[(d, d) for d in WEEKDAYS], default="monday")
    fiscal_year_start_month = models.PositiveSmallIntegerField(default=1)
    status_green_pct = models.PositiveSmallIntegerField(default=100)
    status_yellow_pct = models.PositiveSmallIntegerField(default=70)
    upcoming_days = models.PositiveSmallIntegerField(default=7)
    stale_days = models.PositiveSmallIntegerField(default=14)
    large_deal_threshold = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("1000000.00"))
    daily_report_cutoff = models.TimeField(default=dt.time(18, 0))
    daily_report_required = models.BooleanField(default=True)
    quotation_validity_days = models.PositiveSmallIntegerField(default=30)
    #: Reserved (spec §1): dates are stored Gregorian; an Ethiopian display is a later client feature.
    calendar_display = models.CharField(max_length=10, choices=[(c, c) for c in CALENDAR_DISPLAYS], default="gregorian")


class PipelineStage(WorkspaceScopedModel):
    OPEN, WON, LOST = "open", "won", "lost"
    CATEGORIES = (OPEN, WON, LOST)
    NAME_MAX = 60

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=NAME_MAX)
    order = models.PositiveIntegerField(default=0)
    category = models.CharField(max_length=4, choices=[(c, c) for c in CATEGORIES], default=OPEN)
    default_probability = models.PositiveSmallIntegerField(default=0)
    is_system = models.BooleanField(default=False)

    class Meta(WorkspaceScopedModel.Meta):
        ordering = ["order", "created_at"]
        constraints = [
            models.UniqueConstraint("workspace", Lower("name"), name="sales_stage_name_unique"),
            # Exactly one won and one lost stage per workspace.
            models.UniqueConstraint(
                fields=["workspace", "category"], condition=~Q(category="open"), name="sales_stage_one_won_one_lost"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class Product(WorkspaceScopedModel):
    NAME_MAX = 120

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=NAME_MAX)
    code = models.CharField(max_length=40, blank=True, default="")
    category = models.CharField(max_length=60, blank=True, default="")
    is_active = models.BooleanField(default=True)

    class Meta(WorkspaceScopedModel.Meta):
        constraints = [
            models.UniqueConstraint("workspace", Lower("name"), name="sales_product_name_unique"),
            models.UniqueConstraint(
                "workspace", Lower("code"), condition=~Q(code=""), name="sales_product_code_unique"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class LostReason(WorkspaceScopedModel):
    NAME_MAX = 120

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=NAME_MAX)
    is_active = models.BooleanField(default=True)

    class Meta(WorkspaceScopedModel.Meta):
        constraints = [models.UniqueConstraint("workspace", Lower("name"), name="sales_lost_reason_name_unique")]

    def __str__(self) -> str:
        return self.name


def _weight(default: str) -> models.DecimalField:
    return models.DecimalField(max_digits=3, decimal_places=2, default=Decimal(default))


class SalesCalendar(WorkspaceScopedModel):
    """Working-day weights, Monday to Sunday (1 = full day, 0.5 = half day, 0 = not a working day)."""

    workspace = models.OneToOneField("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    monday = _weight("1.00")
    tuesday = _weight("1.00")
    wednesday = _weight("1.00")
    thursday = _weight("1.00")
    friday = _weight("1.00")
    saturday = _weight("0.00")
    sunday = _weight("0.00")

    def weights(self) -> list[Decimal]:
        return [getattr(self, d) for d in WEEKDAYS]


class Holiday(WorkspaceScopedModel):
    NAME_MAX = 120

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    date = models.DateField()
    name = models.CharField(max_length=NAME_MAX)

    class Meta(WorkspaceScopedModel.Meta):
        ordering = ["date"]
        constraints = [models.UniqueConstraint(fields=["workspace", "date"], name="sales_holiday_date_unique")]

    def __str__(self) -> str:
        return f"{self.date} {self.name}"


# ───────────────────────── customers ─────────────────────────


class Company(WorkspaceScopedSoftDeleteModel, OwnedModel):
    PROSPECT, ACTIVE, INACTIVE = "prospect", "active", "inactive"
    STATUSES = (PROSPECT, ACTIVE, INACTIVE)

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=200)
    #: Lower case, punctuation and legal suffixes dropped (`services.normalize_name`): the duplicate check's key.
    normalized_name = models.CharField(max_length=200, default="", editable=False)
    industry = models.CharField(max_length=80, blank=True, default="")
    region = models.CharField(max_length=80, blank=True, default="")
    city = models.CharField(max_length=80, blank=True, default="")
    address = models.CharField(max_length=300, blank=True, default="")
    phone = models.CharField(max_length=40, blank=True, default="")
    #: The last nine digits of `phone` (`services.normalize_phone`), "" without a usable number.
    normalized_phone = models.CharField(max_length=20, blank=True, default="", editable=False)
    email = models.CharField(max_length=254, blank=True, default="")
    website = models.CharField(max_length=200, blank=True, default="")
    status = models.CharField(max_length=8, choices=[(s, s) for s in STATUSES], default=PROSPECT)
    notes = models.TextField(blank=True, default="")
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta(WorkspaceScopedSoftDeleteModel.Meta):
        indexes = [
            models.Index(fields=["workspace", "owner"], name="sales_company_ws_owner"),
            models.Index(fields=["workspace", "normalized_name"], name="sales_company_ws_norm_name"),
            models.Index(fields=["workspace", "normalized_phone"], name="sales_company_ws_norm_phone"),
            models.Index(fields=["workspace", "status"], name="sales_company_ws_status"),
        ]

    def __str__(self) -> str:
        return self.name


class Contact(WorkspaceScopedSoftDeleteModel, OwnedModel):
    workspace_parent = "company"

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name="contacts")
    name = models.CharField(max_length=120)
    job_title = models.CharField(max_length=120, blank=True, default="")
    phone = models.CharField(max_length=40, blank=True, default="")
    email = models.CharField(max_length=254, blank=True, default="")
    is_primary = models.BooleanField(default=False)
    notes = models.TextField(blank=True, default="")
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta(WorkspaceScopedSoftDeleteModel.Meta):
        indexes = [
            models.Index(fields=["workspace", "owner"], name="sales_contact_ws_owner"),
            models.Index(fields=["workspace", "company"], name="sales_contact_ws_company"),
        ]

    def __str__(self) -> str:
        return self.name
