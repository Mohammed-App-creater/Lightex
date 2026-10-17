"""Sales tables (docs/sales/spec.md §4). S1: reference data and settings, companies and contacts. S2: leads,
opportunities with their stage history, quotations and the per-workspace number sequence. S3: activities and
follow-ups.

Every table has a non-null `workspace`. Companies, contacts, leads, opportunities and quotations are soft-deleted and
owned (`OwnedModel`: data scope through `visible_to()`). Money is `Decimal(14, 2)`; there is no currency field (ETB
only).
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
    #: Denormalized (S3): the latest activity or completed follow-up on the company or any record of it.
    last_activity_at = models.DateTimeField(null=True, blank=True)
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


# ───────────────────────── leads and the pipeline (S2) ─────────────────────────


class Lead(WorkspaceScopedSoftDeleteModel, OwnedModel):
    SOURCES = ("referral", "website", "call", "event", "visit", "social", "other")
    NEW, CONTACTED, QUALIFIED, DISQUALIFIED, CONVERTED = "new", "contacted", "qualified", "disqualified", "converted"
    STATUSES = (NEW, CONTACTED, QUALIFIED, DISQUALIFIED, CONVERTED)
    #: Still being worked (the pipeline's leads count).
    OPEN_STATUSES = (NEW, CONTACTED, QUALIFIED)

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    source = models.CharField(max_length=10, choices=[(s, s) for s in SOURCES], default="other")
    company = models.ForeignKey(Company, null=True, blank=True, on_delete=models.SET_NULL, related_name="leads")
    #: The company's name as typed, when it isn't a known company yet.
    company_name_text = models.CharField(max_length=200, blank=True, default="")
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    contact_name = models.CharField(max_length=120, blank=True, default="")
    phone = models.CharField(max_length=40, blank=True, default="")
    email = models.CharField(max_length=254, blank=True, default="")
    product = models.ForeignKey(Product, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    estimated_value = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    status = models.CharField(max_length=12, choices=[(s, s) for s in STATUSES], default=NEW)
    disqualify_reason = models.CharField(max_length=500, blank=True, default="")
    converted_opportunity = models.ForeignKey(
        "Opportunity", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    converted_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True, default="")
    #: Denormalized (S3): the latest activity or completed follow-up on the lead.
    last_activity_at = models.DateTimeField(null=True, blank=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta(WorkspaceScopedSoftDeleteModel.Meta):
        indexes = [
            models.Index(fields=["workspace", "owner", "status"], name="sales_lead_ws_owner_status"),
            models.Index(fields=["workspace", "created_at"], name="sales_lead_ws_created"),
        ]

    @property
    def display_name(self) -> str:
        """The company (linked or typed), else the contact's name."""
        if self.company_id is not None and self.company is not None:
            return self.company.name
        return self.company_name_text or self.contact_name

    def __str__(self) -> str:
        return self.display_name


class Opportunity(WorkspaceScopedSoftDeleteModel, OwnedModel):
    """A deal. Open, won or lost follows its stage's category; `version` guards concurrent moves and edits."""

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    #: RESTRICT: a company with opportunities (live or in the trash) can't be deleted on its own (the API answers 409
    #: `company_has_opportunities`); deleting the whole workspace takes both.
    company = models.ForeignKey(Company, on_delete=models.RESTRICT, related_name="opportunities")
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    title = models.CharField(max_length=200)
    product = models.ForeignKey(Product, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    expected_value = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0.00"))
    #: 0–100; null = the stage's default probability.
    probability_override = models.PositiveSmallIntegerField(null=True, blank=True)
    #: RESTRICT: a stage with opportunities (live or in the trash) can't be deleted (409 `stage_in_use`).
    stage = models.ForeignKey(PipelineStage, on_delete=models.RESTRICT, related_name="+")
    expected_close_date = models.DateField(null=True, blank=True)
    next_action = models.CharField(max_length=300, blank=True, default="")
    source_lead = models.ForeignKey(Lead, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    #: Who the won value counts for: the owner at the moment it was won. Reassignment never changes it.
    credited_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    won_at = models.DateTimeField(null=True, blank=True)
    won_value = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    lost_at = models.DateTimeField(null=True, blank=True)
    lost_reason = models.ForeignKey(LostReason, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    lost_note = models.CharField(max_length=1000, blank=True, default="")
    #: Denormalized (S3): the latest activity or completed follow-up on the opportunity (`activity_services`).
    last_activity_at = models.DateTimeField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)
    notes = models.TextField(blank=True, default="")
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta(WorkspaceScopedSoftDeleteModel.Meta):
        indexes = [
            # Spec §11 hot paths.
            models.Index(fields=["workspace", "owner", "stage"], name="sales_opp_ws_owner_stage"),
            models.Index(fields=["workspace", "won_at"], name="sales_opp_ws_won_at"),
            models.Index(fields=["workspace", "expected_close_date"], name="sales_opp_ws_close_date"),
            models.Index(fields=["workspace", "company"], name="sales_opp_ws_company"),
        ]

    def __str__(self) -> str:
        return self.title


class OpportunityStageHistory(WorkspaceScopedModel):
    """One row per stage change: creation, move, won, lost and reopen. Stage names are copied so the history reads
    the same after a stage is renamed or deleted."""

    CREATED, MOVED, WON, LOST, REOPENED = "created", "moved", "won", "lost", "reopened"
    KINDS = (CREATED, MOVED, WON, LOST, REOPENED)
    workspace_parent = "opportunity"

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    opportunity = models.ForeignKey(Opportunity, on_delete=models.CASCADE, related_name="stage_history")
    kind = models.CharField(max_length=8, choices=[(k, k) for k in KINDS], default=MOVED)
    from_stage = models.ForeignKey(PipelineStage, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    from_stage_name = models.CharField(max_length=PipelineStage.NAME_MAX, blank=True, default="")
    to_stage = models.ForeignKey(PipelineStage, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    to_stage_name = models.CharField(max_length=PipelineStage.NAME_MAX, blank=True, default="")
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    changed_at = models.DateTimeField()

    class Meta(WorkspaceScopedModel.Meta):
        ordering = ["changed_at", "created_at"]
        indexes = [models.Index(fields=["opportunity", "changed_at"], name="sales_opp_history_opp_at")]


class Quotation(WorkspaceScopedSoftDeleteModel, OwnedModel):
    """A light quotation on an opportunity. Its owner is always the opportunity's owner (kept in sync on
    reassignment); files go through the generic attachments."""

    DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED = "draft", "sent", "accepted", "rejected", "expired"
    STATUSES = (DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED)
    workspace_parent = "opportunity"

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    opportunity = models.ForeignKey(Opportunity, on_delete=models.CASCADE, related_name="quotations")
    #: `Q-<year>-0001`, from the per-workspace, per-year sequence (`SalesSequence`).
    number = models.CharField(max_length=20)
    title = models.CharField(max_length=200)
    amount = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0.00"))
    status = models.CharField(max_length=8, choices=[(s, s) for s in STATUSES], default=DRAFT)
    sent_at = models.DateTimeField(null=True, blank=True)
    valid_until = models.DateField(null=True, blank=True)
    responded_at = models.DateTimeField(null=True, blank=True)
    expired_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(blank=True, default="")
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta(WorkspaceScopedSoftDeleteModel.Meta):
        constraints = [models.UniqueConstraint(fields=["workspace", "number"], name="sales_quotation_number_unique")]
        indexes = [
            models.Index(fields=["workspace", "owner", "status"], name="sales_quote_ws_owner_status"),
            models.Index(fields=["workspace", "status", "valid_until"], name="sales_quote_ws_status_valid"),
            models.Index(fields=["opportunity", "created_at"], name="sales_quote_opp_created"),
        ]

    def __str__(self) -> str:
        return f"{self.number} {self.title}"


class SalesSequence(WorkspaceScopedModel):
    """Per-workspace counters (`quotation:2026` → the last quotation number of 2026), incremented under a row lock."""

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    key = models.CharField(max_length=40)
    last = models.PositiveIntegerField(default=0)

    class Meta(WorkspaceScopedModel.Meta):
        constraints = [models.UniqueConstraint(fields=["workspace", "key"], name="sales_sequence_unique")]


# ───────────────────────── activities and follow-ups (S3) ─────────────────────────


class _Targeted(models.Model):
    """A child of a lead, opportunity, company or contact. `target_type` / `target_id` name it (the API's shape); the
    matching foreign key is set too (`target_company` for a company), so purging the parent removes its children and
    joins stay cheap. `company` is denormalized: the target's company (a lead's linked company, an opportunity's or a
    contact's company, or the company itself); purging that company only clears it."""

    LEAD, OPPORTUNITY, COMPANY, CONTACT = "sales.lead", "sales.opportunity", "sales.company", "sales.contact"
    #: target type → foreign key field.
    TARGET_FIELDS = {LEAD: "lead", OPPORTUNITY: "opportunity", COMPANY: "target_company", CONTACT: "contact"}

    target_type = models.CharField(max_length=20)
    target_id = models.UUIDField()
    lead = models.ForeignKey(Lead, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    opportunity = models.ForeignKey(Opportunity, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    contact = models.ForeignKey(Contact, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    target_company = models.ForeignKey(Company, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    company = models.ForeignKey(Company, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        abstract = True


class Activity(WorkspaceScopedModel, OwnedModel, _Targeted):
    """A logged touch: a call, visit, meeting, email, note or other (spec §4). `quotation` entries are written by the
    system when a quotation is sent (`pipeline_services.on_quotation_sent`); people can't log that type."""

    CALL, VISIT, MEETING, EMAIL, NOTE, OTHER = "call", "visit", "meeting", "email", "note", "other"
    QUOTATION = "quotation"
    TYPES = (CALL, VISIT, MEETING, EMAIL, NOTE, OTHER, QUOTATION)
    #: The types a person logs.
    LOGGED_TYPES = (CALL, VISIT, MEETING, EMAIL, NOTE, OTHER)
    #: Customer contact: spec §5 `last_contact`.
    CONTACT_TYPES = (CALL, VISIT, MEETING, EMAIL)
    TARGET_TYPES = (_Targeted.LEAD, _Targeted.OPPORTUNITY, _Targeted.COMPANY, _Targeted.CONTACT)

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    type = models.CharField(max_length=10, choices=[(t, t) for t in TYPES], default=CALL)
    occurred_at = models.DateTimeField()
    duration_minutes = models.PositiveIntegerField(null=True, blank=True)
    summary = models.CharField(max_length=1000, blank=True, default="")
    outcome = models.CharField(max_length=1000, blank=True, default="")
    #: The quotation a `quotation` entry records.
    quotation = models.ForeignKey(Quotation, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta(WorkspaceScopedModel.Meta):
        indexes = [
            # Spec §11 hot path.
            models.Index(fields=["workspace", "owner", "occurred_at"], name="sales_activity_ws_owner_at"),
            models.Index(fields=["workspace", "occurred_at"], name="sales_activity_ws_at"),
            models.Index(fields=["opportunity", "occurred_at"], name="sales_activity_opp_at"),
            models.Index(fields=["company", "occurred_at"], name="sales_activity_company_at"),
            models.Index(fields=["lead", "occurred_at"], name="sales_activity_lead_at"),
        ]

    def __str__(self) -> str:
        return f"{self.type} {self.occurred_at:%Y-%m-%d}"


class FollowUp(WorkspaceScopedModel, OwnedModel, _Targeted):
    """A dated next step on a lead, opportunity or company (spec §4): pending, then done (`complete`) or cancelled."""

    PENDING, DONE, CANCELLED = "pending", "done", "cancelled"
    STATUSES = (PENDING, DONE, CANCELLED)
    TARGET_TYPES = (_Targeted.LEAD, _Targeted.OPPORTUNITY, _Targeted.COMPANY)

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    title = models.CharField(max_length=200)
    notes = models.TextField(blank=True, default="")
    due_date = models.DateField()
    status = models.CharField(max_length=9, choices=[(s, s) for s in STATUSES], default=PENDING)
    completed_at = models.DateTimeField(null=True, blank=True)
    completed_activity = models.ForeignKey(Activity, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    cancelled_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta(WorkspaceScopedModel.Meta):
        indexes = [
            # Spec §11 hot path: the buckets and the digest.
            models.Index(fields=["workspace", "owner", "status", "due_date"], name="sales_followup_ws_owner_due"),
            models.Index(fields=["workspace", "status", "due_date"], name="sales_followup_ws_status_due"),
            models.Index(fields=["opportunity", "status"], name="sales_followup_opp_status"),
            models.Index(fields=["company", "status"], name="sales_followup_company_status"),
        ]

    def __str__(self) -> str:
        return self.title


# ───────────────────────── targets (S4) ─────────────────────────


class Target(WorkspaceScopedModel):
    """A stored year, quarter or month target of a user, a team or the whole company (subject_id null). Day and week
    targets are derived, never stored (`targets.py`). Fiscal years and quarters start at `fiscal_year_start_month`."""

    USER, TEAM, COMPANY = "user", "team", "company"
    SUBJECTS = (USER, TEAM, COMPANY)
    YEAR, QUARTER, MONTH = "year", "quarter", "month"
    PERIOD_TYPES = (YEAR, QUARTER, MONTH)

    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.CASCADE, related_name="+")
    subject_type = models.CharField(max_length=7, choices=[(s, s) for s in SUBJECTS])
    #: The user or team id; null for the company.
    subject_id = models.UUIDField(null=True, blank=True)
    period_type = models.CharField(max_length=7, choices=[(p, p) for p in PERIOD_TYPES])
    period_start = models.DateField()
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    note = models.CharField(max_length=500, blank=True, default="")
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta(WorkspaceScopedModel.Meta):
        ordering = ["period_start", "period_type"]
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "subject_type", "subject_id", "period_type", "period_start"],
                condition=Q(subject_id__isnull=False),
                name="sales_target_unique",
            ),
            models.UniqueConstraint(
                fields=["workspace", "subject_type", "period_type", "period_start"],
                condition=Q(subject_id__isnull=True),
                name="sales_target_company_unique",
            ),
        ]
        indexes = [
            models.Index(fields=["workspace", "subject_type", "period_start"], name="sales_target_ws_subj_start")
        ]

    def __str__(self) -> str:
        return f"{self.subject_type}:{self.subject_id or '-'} {self.period_type} {self.period_start} {self.amount}"
