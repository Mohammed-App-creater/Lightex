"""Sales request and response shapes (camelCase, `Sales*` component names). Inputs only validate; their
`validated_data` uses the model's field names (`source=`), which the services take as they are."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from core.common.utils import iso

from .models import WEEKDAYS, Company, PipelineStage, SalesSettings

# ───────────────────────── shared ─────────────────────────


class SalesUserBriefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()
    hue = serializers.IntegerField()


def _user(user: Any) -> dict[str, Any] | None:
    return None if user is None else {"id": str(user.pk), "name": user.name, "hue": user.hue}


class _Timestamps(serializers.Serializer):
    createdAt = serializers.SerializerMethodField()
    updatedAt = serializers.SerializerMethodField()

    def get_createdAt(self, obj) -> str | None:
        return iso(obj.created_at)

    def get_updatedAt(self, obj) -> str | None:
        return iso(obj.updated_at)


# ───────────────────────── settings ─────────────────────────


class SalesSettingsSerializer(serializers.Serializer):
    weekStart = serializers.ChoiceField(source="week_start", choices=WEEKDAYS)
    fiscalYearStartMonth = serializers.IntegerField(source="fiscal_year_start_month")
    statusGreenPct = serializers.IntegerField(source="status_green_pct")
    statusYellowPct = serializers.IntegerField(source="status_yellow_pct")
    upcomingDays = serializers.IntegerField(source="upcoming_days")
    staleDays = serializers.IntegerField(source="stale_days")
    largeDealThreshold = serializers.DecimalField(source="large_deal_threshold", max_digits=14, decimal_places=2)
    dailyReportCutoff = serializers.TimeField(source="daily_report_cutoff", format="%H:%M")
    dailyReportRequired = serializers.BooleanField(source="daily_report_required")
    quotationValidityDays = serializers.IntegerField(source="quotation_validity_days")
    calendarDisplay = serializers.ChoiceField(source="calendar_display", choices=SalesSettings.CALENDAR_DISPLAYS)
    updatedAt = serializers.SerializerMethodField()

    def get_updatedAt(self, obj) -> str | None:
        return iso(obj.updated_at)


class SalesSettingsIn(serializers.Serializer):
    """Every field is optional: the fields sent are changed, the others kept."""

    weekStart = serializers.ChoiceField(source="week_start", choices=WEEKDAYS, required=False)
    fiscalYearStartMonth = serializers.IntegerField(
        source="fiscal_year_start_month", min_value=1, max_value=12, required=False
    )
    statusGreenPct = serializers.IntegerField(source="status_green_pct", min_value=1, max_value=1000, required=False)
    statusYellowPct = serializers.IntegerField(source="status_yellow_pct", min_value=0, max_value=1000, required=False)
    upcomingDays = serializers.IntegerField(source="upcoming_days", min_value=1, max_value=90, required=False)
    staleDays = serializers.IntegerField(source="stale_days", min_value=1, max_value=365, required=False)
    largeDealThreshold = serializers.DecimalField(
        source="large_deal_threshold", max_digits=14, decimal_places=2, min_value=Decimal("0"), required=False
    )
    dailyReportCutoff = serializers.TimeField(
        source="daily_report_cutoff", input_formats=["%H:%M"], format="%H:%M", required=False
    )
    dailyReportRequired = serializers.BooleanField(source="daily_report_required", required=False)
    quotationValidityDays = serializers.IntegerField(
        source="quotation_validity_days", min_value=1, max_value=365, required=False
    )
    calendarDisplay = serializers.ChoiceField(
        source="calendar_display", choices=SalesSettings.CALENDAR_DISPLAYS, required=False
    )


# ───────────────────────── stages ─────────────────────────


class SalesStageSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()
    order = serializers.IntegerField()
    category = serializers.ChoiceField(choices=PipelineStage.CATEGORIES)
    defaultProbability = serializers.IntegerField(source="default_probability")
    isSystem = serializers.BooleanField(source="is_system")


class SalesStageIn(serializers.Serializer):
    name = serializers.CharField(max_length=PipelineStage.NAME_MAX)
    defaultProbability = serializers.IntegerField(source="default_probability", min_value=0, max_value=100)


class SalesStageUpdateIn(serializers.Serializer):
    name = serializers.CharField(max_length=PipelineStage.NAME_MAX, required=False)
    defaultProbability = serializers.IntegerField(
        source="default_probability", min_value=0, max_value=100, required=False
    )


class SalesStageReorderIn(serializers.Serializer):
    stageIds = serializers.ListField(child=serializers.UUIDField(), allow_empty=False, max_length=50)


# ───────────────────────── products, lost reasons ─────────────────────────


class SalesProductSerializer(_Timestamps):
    id = serializers.UUIDField()
    name = serializers.CharField()
    code = serializers.CharField()
    category = serializers.CharField()
    isActive = serializers.BooleanField(source="is_active")


class SalesProductIn(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    code = serializers.CharField(max_length=40, required=False, allow_blank=True)
    category = serializers.CharField(max_length=60, required=False, allow_blank=True)
    isActive = serializers.BooleanField(source="is_active", required=False)


class SalesProductUpdateIn(SalesProductIn):
    name = serializers.CharField(max_length=120, required=False)


class SalesLostReasonSerializer(_Timestamps):
    id = serializers.UUIDField()
    name = serializers.CharField()
    isActive = serializers.BooleanField(source="is_active")


class SalesLostReasonIn(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    isActive = serializers.BooleanField(source="is_active", required=False)


class SalesLostReasonUpdateIn(SalesLostReasonIn):
    name = serializers.CharField(max_length=120, required=False)


# ───────────────────────── calendar, holidays ─────────────────────────


class SalesCalendarSerializer(serializers.Serializer):
    weekdayWeights = serializers.SerializerMethodField(
        help_text="Seven weights, Monday first: 1 = full working day, 0.5 = half day, 0 = not a working day."
    )
    updatedAt = serializers.SerializerMethodField()

    def get_weekdayWeights(self, obj) -> list[float]:
        return [float(w) for w in obj.weights()]

    def get_updatedAt(self, obj) -> str | None:
        return iso(obj.updated_at)


class SalesCalendarIn(serializers.Serializer):
    weekdayWeights = serializers.ListField(
        child=serializers.DecimalField(max_digits=3, decimal_places=2, min_value=Decimal("0"), max_value=Decimal("1")),
        min_length=7,
        max_length=7,
        help_text="Seven weights between 0 and 1, Monday first.",
    )

    def validate_weekdayWeights(self, value: list[Decimal]) -> list[Decimal]:
        if not any(value):
            raise serializers.ValidationError("Keep at least one working day")
        return value


class SalesHolidaySerializer(serializers.Serializer):
    id = serializers.UUIDField()
    date = serializers.DateField()
    name = serializers.CharField()


class SalesHolidayIn(serializers.Serializer):
    date = serializers.DateField()
    name = serializers.CharField(max_length=120)


class SalesHolidayUpdateIn(serializers.Serializer):
    date = serializers.DateField(required=False)
    name = serializers.CharField(max_length=120, required=False)


# ───────────────────────── companies ─────────────────────────


class _Owned(_Timestamps):
    ownerId = serializers.UUIDField(source="owner_id", allow_null=True)
    owner = serializers.SerializerMethodField()
    canEdit = serializers.SerializerMethodField(help_text="The caller's edit scope reaches this record.")
    canDelete = serializers.SerializerMethodField(help_text="The caller's delete scope reaches this record.")

    @extend_schema_field(SalesUserBriefSerializer(allow_null=True))
    def get_owner(self, obj) -> dict[str, Any] | None:
        return _user(obj.owner)

    def get_canEdit(self, obj) -> bool:
        return str(obj.pk) in self.context.get("editable", ())

    def get_canDelete(self, obj) -> bool:
        return str(obj.pk) in self.context.get("deletable", ())


class SalesCompanySerializer(_Owned):
    id = serializers.UUIDField()
    name = serializers.CharField()
    industry = serializers.CharField()
    region = serializers.CharField()
    city = serializers.CharField()
    address = serializers.CharField()
    phone = serializers.CharField()
    email = serializers.CharField()
    website = serializers.CharField()
    status = serializers.ChoiceField(choices=Company.STATUSES)
    notes = serializers.CharField()
    lastActivityAt = serializers.SerializerMethodField(
        help_text="The latest activity or completed follow-up on the company or any of its records."
    )

    def get_lastActivityAt(self, obj) -> str | None:
        return iso(obj.last_activity_at)


class SalesCompanyIn(serializers.Serializer):
    name = serializers.CharField(max_length=200)
    industry = serializers.CharField(max_length=80, required=False, allow_blank=True)
    region = serializers.CharField(max_length=80, required=False, allow_blank=True)
    city = serializers.CharField(max_length=80, required=False, allow_blank=True)
    address = serializers.CharField(max_length=300, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=40, required=False, allow_blank=True)
    email = serializers.EmailField(max_length=254, required=False, allow_blank=True)
    website = serializers.CharField(max_length=200, required=False, allow_blank=True)
    status = serializers.ChoiceField(choices=Company.STATUSES, required=False)
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    ownerId = serializers.UUIDField(
        source="owner_id", required=False, help_text="Default: the caller. Someone else needs edit scope team or all."
    )


class SalesCompanyUpdateIn(SalesCompanyIn):
    name = serializers.CharField(max_length=200, required=False)


class SalesDuplicateCheckSerializer(serializers.Serializer):
    exists = serializers.BooleanField()
    ownerName = serializers.CharField(allow_null=True, help_text="The matching company's owner, even out of scope.")


# ───────────────────────── contacts ─────────────────────────


class SalesCompanyBriefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class SalesContactSerializer(_Owned):
    id = serializers.UUIDField()
    companyId = serializers.UUIDField(source="company_id")
    company = serializers.SerializerMethodField()
    name = serializers.CharField()
    jobTitle = serializers.CharField(source="job_title")
    phone = serializers.CharField()
    email = serializers.CharField()
    isPrimary = serializers.BooleanField(source="is_primary")
    notes = serializers.CharField()

    @extend_schema_field(SalesCompanyBriefSerializer())
    def get_company(self, obj) -> dict[str, Any]:
        return {"id": str(obj.company_id), "name": obj.company.name}


class SalesContactIn(serializers.Serializer):
    companyId = serializers.UUIDField(source="company_id")
    name = serializers.CharField(max_length=120)
    jobTitle = serializers.CharField(source="job_title", max_length=120, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=40, required=False, allow_blank=True)
    email = serializers.EmailField(max_length=254, required=False, allow_blank=True)
    isPrimary = serializers.BooleanField(source="is_primary", required=False)
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    ownerId = serializers.UUIDField(
        source="owner_id", required=False, help_text="Default: the caller. Someone else needs edit scope team or all."
    )


class SalesContactUpdateIn(SalesContactIn):
    companyId = serializers.UUIDField(source="company_id", required=False)
    name = serializers.CharField(max_length=120, required=False)
