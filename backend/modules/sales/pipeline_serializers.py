"""Request and response shapes for leads, opportunities, the pipeline board, the timeline and quotations (S2;
camelCase, `Sales*` component names). Inputs only validate; `validated_data` uses the model's field names.

The `*_data` functions serialize pages of owned records with their per-record hints (`canEdit`, `canDelete`, and
`canMove` / `canClose` on opportunities), computed in one query per hint.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from core.common.utils import iso
from core.workspaces.timezone import workspace_today

from . import module as perms
from . import scope
from .models import Lead, Opportunity, PipelineStage, Quotation
from .pipeline_selectors import probability_of, related, status_of, weighted_value
from .serializers import (
    SalesCompanyBriefSerializer,
    SalesCompanySerializer,
    SalesContactSerializer,
    SalesStageSerializer,
    SalesUserBriefSerializer,
    _Owned,
    _user,
)

TIMELINE_KINDS = (
    "stage_created",
    "stage_moved",
    "stage_won",
    "stage_lost",
    "stage_reopened",
    "quotation_created",
    "quotation_sent",
    "quotation_accepted",
    "quotation_rejected",
    "quotation_expired",
)


def _money(value: Any) -> str | None:
    return None if value is None else f"{Decimal(value):.2f}"


def _brief(obj: Any) -> dict[str, Any] | None:
    return None if obj is None else {"id": str(obj.pk), "name": obj.name}


class SalesNamedBriefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class SalesStageBriefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()
    category = serializers.ChoiceField(choices=PipelineStage.CATEGORIES)


# ───────────────────────── leads ─────────────────────────


class SalesLeadSerializer(_Owned):
    id = serializers.UUIDField()
    displayName = serializers.CharField(
        source="display_name", help_text="The linked company's name, else the typed company name, else the contact."
    )
    source = serializers.ChoiceField(choices=Lead.SOURCES)  # type: ignore[assignment]
    status = serializers.ChoiceField(choices=Lead.STATUSES)
    companyId = serializers.UUIDField(source="company_id", allow_null=True)
    company = serializers.SerializerMethodField()
    companyName = serializers.CharField(source="company_name_text", help_text="As typed (no company linked yet).")
    contactId = serializers.UUIDField(source="contact_id", allow_null=True)
    contact = serializers.SerializerMethodField()
    contactName = serializers.CharField(source="contact_name")
    phone = serializers.CharField()
    email = serializers.CharField()
    productId = serializers.UUIDField(source="product_id", allow_null=True)
    product = serializers.SerializerMethodField()
    estimatedValue = serializers.DecimalField(
        source="estimated_value", allow_null=True, max_digits=14, decimal_places=2
    )
    disqualifyReason = serializers.CharField(source="disqualify_reason")
    convertedOpportunityId = serializers.UUIDField(source="converted_opportunity_id", allow_null=True)
    convertedAt = serializers.SerializerMethodField()
    notes = serializers.CharField()

    @extend_schema_field(SalesCompanyBriefSerializer(allow_null=True))
    def get_company(self, obj) -> dict[str, Any] | None:
        return _brief(obj.company) if obj.company_id else None

    @extend_schema_field(SalesNamedBriefSerializer(allow_null=True))
    def get_contact(self, obj) -> dict[str, Any] | None:
        return _brief(obj.contact) if obj.contact_id else None

    @extend_schema_field(SalesNamedBriefSerializer(allow_null=True))
    def get_product(self, obj) -> dict[str, Any] | None:
        return _brief(obj.product) if obj.product_id else None

    def get_convertedAt(self, obj) -> str | None:
        return iso(obj.converted_at)


class SalesLeadIn(serializers.Serializer):
    source = serializers.ChoiceField(choices=Lead.SOURCES, required=False)  # type: ignore[assignment]
    companyId = serializers.UUIDField(source="company_id", required=False, allow_null=True)
    companyName = serializers.CharField(source="company_name_text", max_length=200, required=False, allow_blank=True)
    contactId = serializers.UUIDField(source="contact_id", required=False, allow_null=True)
    contactName = serializers.CharField(source="contact_name", max_length=120, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=40, required=False, allow_blank=True)
    email = serializers.EmailField(max_length=254, required=False, allow_blank=True)
    productId = serializers.UUIDField(source="product_id", required=False, allow_null=True)
    estimatedValue = serializers.DecimalField(
        source="estimated_value",
        required=False,
        allow_null=True,
        min_value=Decimal("0"),
        max_digits=14,
        decimal_places=2,
    )
    status = serializers.ChoiceField(
        choices=(Lead.NEW, Lead.CONTACTED),
        required=False,
        help_text="new or contacted; qualify, disqualify and convert have their own routes.",
    )
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    ownerId = serializers.UUIDField(
        source="owner_id", required=False, help_text="Default: the caller. Someone else needs sales.lead.assign."
    )


class SalesLeadUpdateIn(SalesLeadIn):
    pass


class SalesLeadDisqualifyIn(serializers.Serializer):
    reason = serializers.CharField(max_length=500)


class SalesConvertCompanyIn(serializers.Serializer):
    name = serializers.CharField(max_length=200)
    industry = serializers.CharField(max_length=80, required=False, allow_blank=True)
    region = serializers.CharField(max_length=80, required=False, allow_blank=True)
    city = serializers.CharField(max_length=80, required=False, allow_blank=True)
    address = serializers.CharField(max_length=300, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=40, required=False, allow_blank=True)
    email = serializers.EmailField(max_length=254, required=False, allow_blank=True)
    website = serializers.CharField(max_length=200, required=False, allow_blank=True)


class SalesConvertContactIn(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    jobTitle = serializers.CharField(source="job_title", max_length=120, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=40, required=False, allow_blank=True)
    email = serializers.EmailField(max_length=254, required=False, allow_blank=True)


class SalesConvertOpportunityIn(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False)
    expectedValue = serializers.DecimalField(
        source="expected_value", required=False, min_value=Decimal("0"), max_digits=14, decimal_places=2
    )
    expectedCloseDate = serializers.DateField(source="expected_close_date", required=False, allow_null=True)


class SalesLeadConvertIn(serializers.Serializer):
    """Everything is optional: without a company, the lead's linked company is used, else a visible company matching
    the lead's company name or phone, else a new one."""

    companyId = serializers.UUIDField(source="company_id", required=False, help_text="Link an existing company.")
    company = SalesConvertCompanyIn(required=False, help_text="Create this company (owned by the lead's owner).")
    contactId = serializers.UUIDField(source="contact_id", required=False, help_text="A contact of that company.")
    contact = SalesConvertContactIn(required=False, help_text="Create this contact.")
    opportunity = SalesConvertOpportunityIn(required=False)

    def validate(self, attrs):
        if attrs.get("company_id") and attrs.get("company"):
            raise serializers.ValidationError({"company": "Send companyId or company, not both"})
        if attrs.get("contact_id") and attrs.get("contact"):
            raise serializers.ValidationError({"contact": "Send contactId or contact, not both"})
        return attrs


class SalesLeadBulkAssignIn(serializers.Serializer):
    leadIds = serializers.ListField(child=serializers.UUIDField(), allow_empty=False, max_length=200)
    ownerId = serializers.UUIDField(source="owner_id")


class SalesOpportunityBulkAssignIn(serializers.Serializer):
    opportunityIds = serializers.ListField(child=serializers.UUIDField(), allow_empty=False, max_length=200)
    ownerId = serializers.UUIDField(source="owner_id")


class SalesBulkAssignResultSerializer(serializers.Serializer):
    updated = serializers.IntegerField(help_text="Records whose owner changed (those already owned are skipped).")


# ───────────────────────── opportunities ─────────────────────────


class SalesOpportunityFlagsSerializer(serializers.Serializer):
    overdueClose = serializers.BooleanField(help_text="Open with an expected close date before today.")
    noNextStep = serializers.BooleanField(help_text="Open with no pending follow-up. Always false until S3.")
    stale = serializers.BooleanField(help_text="No activity for staleDays. Always false until S3.")


class SalesOpportunitySerializer(_Owned):
    id = serializers.UUIDField()
    title = serializers.CharField()
    status = serializers.SerializerMethodField(help_text="open, won or lost (the stage's category).")
    companyId = serializers.UUIDField(source="company_id")
    company = serializers.SerializerMethodField()
    contactId = serializers.UUIDField(source="contact_id", allow_null=True)
    contact = serializers.SerializerMethodField()
    productId = serializers.UUIDField(source="product_id", allow_null=True)
    product = serializers.SerializerMethodField()
    stageId = serializers.UUIDField(source="stage_id")
    stage = serializers.SerializerMethodField()
    expectedValue = serializers.DecimalField(source="expected_value", max_digits=14, decimal_places=2)
    probabilityOverride = serializers.IntegerField(source="probability_override", allow_null=True)
    probability = serializers.SerializerMethodField(help_text="The override, else the stage's default probability.")
    weightedValue = serializers.SerializerMethodField(help_text="expectedValue × probability / 100.")
    expectedCloseDate = serializers.DateField(source="expected_close_date", allow_null=True)
    nextAction = serializers.CharField(source="next_action")
    sourceLeadId = serializers.UUIDField(source="source_lead_id", allow_null=True)
    creditedUserId = serializers.UUIDField(source="credited_user_id", allow_null=True)
    creditedUser = serializers.SerializerMethodField()
    wonAt = serializers.SerializerMethodField()
    wonValue = serializers.DecimalField(source="won_value", allow_null=True, max_digits=14, decimal_places=2)
    lostAt = serializers.SerializerMethodField()
    lostReasonId = serializers.UUIDField(source="lost_reason_id", allow_null=True)
    lostReason = serializers.SerializerMethodField()
    lostNote = serializers.CharField(source="lost_note")
    lastActivityAt = serializers.SerializerMethodField(help_text="Set by activities (S3).")
    version = serializers.IntegerField(help_text="Send it back with move, won, lost, reopen and edits.")
    notes = serializers.CharField()
    flags = serializers.SerializerMethodField()
    canMove = serializers.SerializerMethodField(help_text="The caller's move scope reaches this record.")
    canClose = serializers.SerializerMethodField(help_text="The caller's close scope reaches this record.")

    def get_status(self, obj) -> str:
        return status_of(obj)

    @extend_schema_field(SalesCompanyBriefSerializer())
    def get_company(self, obj) -> dict[str, Any]:
        return {"id": str(obj.company_id), "name": obj.company.name}

    @extend_schema_field(SalesNamedBriefSerializer(allow_null=True))
    def get_contact(self, obj) -> dict[str, Any] | None:
        return _brief(obj.contact) if obj.contact_id else None

    @extend_schema_field(SalesNamedBriefSerializer(allow_null=True))
    def get_product(self, obj) -> dict[str, Any] | None:
        return _brief(obj.product) if obj.product_id else None

    @extend_schema_field(SalesStageBriefSerializer())
    def get_stage(self, obj) -> dict[str, Any]:
        return {"id": str(obj.stage_id), "name": obj.stage.name, "category": obj.stage.category}

    def get_probability(self, obj) -> int:
        return probability_of(obj)

    @extend_schema_field(serializers.DecimalField(max_digits=14, decimal_places=2))
    def get_weightedValue(self, obj) -> str:
        return f"{weighted_value(obj):.2f}"

    @extend_schema_field(SalesUserBriefSerializer(allow_null=True))
    def get_creditedUser(self, obj) -> dict[str, Any] | None:
        return _user(obj.credited_user) if obj.credited_user_id else None

    def get_wonAt(self, obj) -> str | None:
        return iso(obj.won_at)

    def get_lostAt(self, obj) -> str | None:
        return iso(obj.lost_at)

    @extend_schema_field(SalesNamedBriefSerializer(allow_null=True))
    def get_lostReason(self, obj) -> dict[str, Any] | None:
        return _brief(obj.lost_reason) if obj.lost_reason_id else None

    def get_lastActivityAt(self, obj) -> str | None:
        return iso(obj.last_activity_at)

    @extend_schema_field(SalesOpportunityFlagsSerializer())
    def get_flags(self, obj) -> dict[str, bool]:
        today = self.context.get("today")
        open_ = obj.stage.category == PipelineStage.OPEN
        overdue = bool(open_ and today and obj.expected_close_date and obj.expected_close_date < today)
        return {"overdueClose": overdue, "noNextStep": False, "stale": False}

    def get_canMove(self, obj) -> bool:
        return str(obj.pk) in self.context.get("movable", ())

    def get_canClose(self, obj) -> bool:
        return str(obj.pk) in self.context.get("closable", ())


class SalesOpportunityIn(serializers.Serializer):
    title = serializers.CharField(max_length=200)
    companyId = serializers.UUIDField(source="company_id")
    contactId = serializers.UUIDField(source="contact_id", required=False, allow_null=True)
    productId = serializers.UUIDField(source="product_id", required=False, allow_null=True)
    stageId = serializers.UUIDField(source="stage_id", required=False, help_text="An open stage; default the first.")
    expectedValue = serializers.DecimalField(
        source="expected_value", required=False, min_value=Decimal("0"), max_digits=14, decimal_places=2
    )
    probabilityOverride = serializers.IntegerField(
        source="probability_override", required=False, allow_null=True, min_value=0, max_value=100
    )
    expectedCloseDate = serializers.DateField(source="expected_close_date", required=False, allow_null=True)
    nextAction = serializers.CharField(source="next_action", max_length=300, required=False, allow_blank=True)
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    ownerId = serializers.UUIDField(
        source="owner_id", required=False, help_text="Default: the caller. Someone else needs sales.opportunity.assign."
    )


class SalesOpportunityUpdateIn(serializers.Serializer):
    """The stage changes only through move, won, lost and reopen."""

    title = serializers.CharField(max_length=200, required=False)
    companyId = serializers.UUIDField(source="company_id", required=False)
    contactId = serializers.UUIDField(source="contact_id", required=False, allow_null=True)
    productId = serializers.UUIDField(source="product_id", required=False, allow_null=True)
    expectedValue = serializers.DecimalField(
        source="expected_value", required=False, min_value=Decimal("0"), max_digits=14, decimal_places=2
    )
    probabilityOverride = serializers.IntegerField(
        source="probability_override", required=False, allow_null=True, min_value=0, max_value=100
    )
    expectedCloseDate = serializers.DateField(source="expected_close_date", required=False, allow_null=True)
    nextAction = serializers.CharField(source="next_action", max_length=300, required=False, allow_blank=True)
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    ownerId = serializers.UUIDField(source="owner_id", required=False, help_text="Needs sales.opportunity.assign.")
    creditedUserId = serializers.UUIDField(
        source="credited_user_id",
        required=False,
        help_text="Won deals only; needs sales.opportunity.reopen. Reassigning never changes it.",
    )
    version = serializers.IntegerField(required=False, help_text="Optional here: when sent, a mismatch is a 409.")


class SalesOpportunityMoveIn(serializers.Serializer):
    stageId = serializers.UUIDField(source="stage_id", help_text="An open stage.")
    version = serializers.IntegerField()


class SalesOpportunityWonIn(serializers.Serializer):
    wonValue = serializers.DecimalField(
        source="won_value", required=False, allow_null=True, min_value=Decimal("0"), max_digits=14, decimal_places=2
    )
    wonAt = serializers.CharField(
        source="won_at",
        required=False,
        allow_blank=True,
        help_text="Default now. A timestamp (no offset = workspace time) or a date. An earlier date needs close scope "
        "team or all and must be in the current month.",
    )
    version = serializers.IntegerField(required=False)


class SalesOpportunityLostIn(serializers.Serializer):
    lostReasonId = serializers.UUIDField(source="lost_reason_id")
    lostNote = serializers.CharField(source="lost_note", max_length=1000, required=False, allow_blank=True)
    version = serializers.IntegerField(required=False)


class SalesOpportunityReopenIn(serializers.Serializer):
    stageId = serializers.UUIDField(source="stage_id", required=False, help_text="An open stage; default the first.")
    version = serializers.IntegerField(required=False)


class SalesLeadConvertResultSerializer(serializers.Serializer):
    lead = SalesLeadSerializer()
    opportunity = SalesOpportunitySerializer()
    company = SalesCompanySerializer()
    contact = SalesContactSerializer(allow_null=True)
    companyCreated = serializers.BooleanField()
    contactCreated = serializers.BooleanField()


# ───────────────────────── pipeline board ─────────────────────────


class SalesPipelineColumnSerializer(serializers.Serializer):
    stage = SalesStageSerializer()
    count = serializers.IntegerField()
    value = serializers.DecimalField(help_text="Sum of expected values.", max_digits=14, decimal_places=2)
    weightedValue = serializers.DecimalField(
        help_text="Sum of expected value × probability.", max_digits=14, decimal_places=2
    )
    opportunities = SalesOpportunitySerializer(many=True, help_text="The first cards, most recently updated first.")
    nextCursor = serializers.CharField(
        allow_null=True,
        help_text="More cards: GET opportunities?filter[stage]=<id>&sort=-updatedAt&cursor=… (same filters).",
    )


class SalesPipelineSerializer(serializers.Serializer):
    stages = SalesPipelineColumnSerializer(many=True, help_text="Open stages in board order.")
    count = serializers.IntegerField()
    value = serializers.DecimalField(max_digits=14, decimal_places=2)
    weightedValue = serializers.DecimalField(max_digits=14, decimal_places=2)
    leadCount = serializers.IntegerField(
        allow_null=True, help_text="Open leads (new, contacted, qualified) in scope; null without sales.lead.view."
    )


# ───────────────────────── timeline ─────────────────────────


class SalesTimelineStageChangeSerializer(serializers.Serializer):
    fromStageId = serializers.UUIDField(allow_null=True)
    fromStage = serializers.CharField(allow_null=True)
    toStageId = serializers.UUIDField(allow_null=True)
    toStage = serializers.CharField(allow_null=True)


class SalesTimelineQuotationSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    number = serializers.CharField()
    title = serializers.CharField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    status = serializers.ChoiceField(choices=Quotation.STATUSES, help_text="The quotation's current status.")


class SalesTimelineItemSerializer(serializers.Serializer):
    id = serializers.CharField(help_text="Unique within the timeline (not always a record id).")
    kind = serializers.ChoiceField(choices=TIMELINE_KINDS, help_text="S3 adds activity and follow-up kinds.")
    at = serializers.DateTimeField()
    actor = SalesUserBriefSerializer(allow_null=True)
    summary = serializers.CharField()
    stageChange = SalesTimelineStageChangeSerializer(allow_null=True)
    quotation = SalesTimelineQuotationSerializer(allow_null=True)
    activity = serializers.JSONField(allow_null=True, help_text="null until S3.")
    followUp = serializers.JSONField(allow_null=True, help_text="null until S3.")


# ───────────────────────── quotations ─────────────────────────


class SalesQuotationOpportunityBriefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    title = serializers.CharField()
    companyId = serializers.UUIDField()
    companyName = serializers.CharField()


class SalesQuotationSerializer(_Owned):
    id = serializers.UUIDField()
    number = serializers.CharField()
    opportunityId = serializers.UUIDField(source="opportunity_id")
    opportunity = serializers.SerializerMethodField()
    title = serializers.CharField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    status = serializers.ChoiceField(choices=Quotation.STATUSES)
    sentAt = serializers.SerializerMethodField()
    validUntil = serializers.DateField(source="valid_until", allow_null=True)
    respondedAt = serializers.SerializerMethodField()
    expiredAt = serializers.SerializerMethodField()
    notes = serializers.CharField()

    @extend_schema_field(SalesQuotationOpportunityBriefSerializer())
    def get_opportunity(self, obj) -> dict[str, Any]:
        o = obj.opportunity
        return {"id": str(o.pk), "title": o.title, "companyId": str(o.company_id), "companyName": o.company.name}

    def get_sentAt(self, obj) -> str | None:
        return iso(obj.sent_at)

    def get_respondedAt(self, obj) -> str | None:
        return iso(obj.responded_at)

    def get_expiredAt(self, obj) -> str | None:
        return iso(obj.expired_at)


class SalesQuotationIn(serializers.Serializer):
    opportunityId = serializers.UUIDField(source="opportunity_id")
    title = serializers.CharField(max_length=200)
    amount = serializers.DecimalField(min_value=Decimal("0"), max_digits=14, decimal_places=2)
    validUntil = serializers.DateField(source="valid_until", required=False, allow_null=True)
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)


class SalesQuotationUpdateIn(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False)
    amount = serializers.DecimalField(required=False, min_value=Decimal("0"), max_digits=14, decimal_places=2)
    validUntil = serializers.DateField(source="valid_until", required=False, allow_null=True)
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)


class SalesQuotationSendIn(serializers.Serializer):
    validUntil = serializers.DateField(
        source="valid_until", required=False, help_text="Default: today + quotationValidityDays (workspace time)."
    )


# ───────────────────────── page serializers ─────────────────────────


def _hints(user: Any, ws: Any, model: Any, rows: list[Any], codes: dict[str, str]) -> dict[str, Any]:
    ids = [r.pk for r in rows]
    return {key: scope.ids_in_scope(user, ws, model, ids, code) for key, code in codes.items()}


def lead_data(user: Any, rows: list[Lead]) -> Any:
    if not rows:
        return []
    ctx = _hints(user, rows[0].workspace_id, Lead, rows, {"editable": perms.LEAD_EDIT, "deletable": perms.LEAD_DELETE})
    return SalesLeadSerializer(rows, many=True, context=ctx).data


def one_lead(user: Any, lead: Lead) -> dict[str, Any]:
    fresh = (
        Lead.objects.for_workspace(lead.workspace_id)
        .select_related("owner", "company", "contact", "product")
        .get(pk=lead.pk)
    )
    return lead_data(user, [fresh])[0]


OPPORTUNITY_HINTS = {
    "editable": perms.OPPORTUNITY_EDIT,
    "deletable": perms.OPPORTUNITY_DELETE,
    "movable": perms.OPPORTUNITY_MOVE,
    "closable": perms.OPPORTUNITY_CLOSE,
}


def opportunity_data(user: Any, rows: list[Opportunity], workspace: Any = None) -> Any:
    if not rows:
        return []
    ctx = _hints(user, rows[0].workspace_id, Opportunity, rows, OPPORTUNITY_HINTS)
    ws = workspace if workspace is not None and hasattr(workspace, "timezone") else rows[0].workspace
    ctx["today"] = workspace_today(ws)
    return SalesOpportunitySerializer(rows, many=True, context=ctx).data


def opportunity_payload(user: Any, opp: Opportunity) -> dict[str, Any]:
    fresh = related(Opportunity.objects.for_workspace(opp.workspace_id)).select_related("workspace").get(pk=opp.pk)
    return opportunity_data(user, [fresh])[0]


def quotation_data(user: Any, rows: list[Quotation]) -> Any:
    if not rows:
        return []
    ctx = _hints(
        user,
        rows[0].workspace_id,
        Quotation,
        rows,
        {"editable": perms.QUOTATION_EDIT, "deletable": perms.QUOTATION_DELETE},
    )
    return SalesQuotationSerializer(rows, many=True, context=ctx).data


def one_quotation(user: Any, q: Quotation) -> dict[str, Any]:
    fresh = (
        Quotation.objects.for_workspace(q.workspace_id)
        .select_related("owner", "opportunity", "opportunity__company")
        .get(pk=q.pk)
    )
    return quotation_data(user, [fresh])[0]
