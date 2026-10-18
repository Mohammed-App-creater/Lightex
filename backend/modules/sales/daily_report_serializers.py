"""Daily report payloads (S5, docs/sales/api.md §20)."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from .models import DailyReport

MONEY: dict[str, Any] = {"max_digits": 16, "decimal_places": 2, "allow_null": True}
PCT: dict[str, Any] = {"max_digits": 9, "decimal_places": 1, "coerce_to_string": False, "allow_null": True}
PLAN_TARGETS = ("sales.lead", "sales.opportunity", "sales.company", "sales.contact")


class SalesDailyMetricsSerializer(serializers.Serializer):
    target = serializers.DecimalField(**MONEY, help_text="Today's effective target; null without a target")
    sales = serializers.DecimalField(**MONEY, help_text="Won value credited to the user that day")
    achievement = serializers.DecimalField(**PCT)
    newLeads = serializers.IntegerField()
    calls = serializers.IntegerField()
    visits = serializers.IntegerField()
    meetings = serializers.IntegerField()
    quotationsSent = serializers.IntegerField()
    followUpsCompleted = serializers.IntegerField()
    newOpportunities = serializers.IntegerField()
    dealsWon = serializers.IntegerField()
    dealsLost = serializers.IntegerField()


class SalesDailyPlanItemSerializer(serializers.Serializer):
    text = serializers.CharField(max_length=500)
    targetType = serializers.ChoiceField(choices=PLAN_TARGETS, required=False, allow_null=True)
    targetId = serializers.UUIDField(required=False, allow_null=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if bool(attrs.get("targetType")) != bool(attrs.get("targetId")):
            raise serializers.ValidationError("Give targetType and targetId together")
        return attrs


class SalesDailyReportIn(serializers.Serializer):
    comments = serializers.ListField(child=serializers.CharField(max_length=2000), max_length=30, required=False)
    tomorrowPlan = SalesDailyPlanItemSerializer(many=True, required=False, max_length=30)  # type: ignore[call-arg]


class SalesDailyReviewIn(serializers.Serializer):
    comment = serializers.CharField(max_length=2000, required=False, allow_blank=True)


class _UserRef(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class SalesDailyReportSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    user = _UserRef()
    reportDate = serializers.DateField()
    status = serializers.ChoiceField(choices=DailyReport.STATUSES)
    required = serializers.BooleanField(  # type: ignore[assignment]
        help_text="False on non-working days or when reports are optional"
    )
    cutoffAt = serializers.DateTimeField()
    comments = serializers.ListField(child=serializers.CharField())
    tomorrowPlan = SalesDailyPlanItemSerializer(many=True)
    submittedAt = serializers.DateTimeField(allow_null=True)
    isLate = serializers.BooleanField()
    reviewedBy = _UserRef(allow_null=True)
    reviewedAt = serializers.DateTimeField(allow_null=True)
    reviewComment = serializers.CharField(allow_blank=True)
    metrics = SalesDailyMetricsSerializer(help_text="Live while a draft, frozen at submit")
    canEdit = serializers.BooleanField()
    updatedAt = serializers.DateTimeField()


class SalesTeamDailyRowSerializer(serializers.Serializer):
    user = _UserRef()
    reportId = serializers.UUIDField(allow_null=True)
    status = serializers.ChoiceField(choices=(*DailyReport.STATUSES, "missing"))
    isLate = serializers.BooleanField()
    submittedAt = serializers.DateTimeField(allow_null=True)
    comments = serializers.ListField(child=serializers.CharField())
    tomorrowPlan = SalesDailyPlanItemSerializer(many=True)
    metrics = SalesDailyMetricsSerializer()


class SalesTeamDailyTotalsSerializer(SalesDailyMetricsSerializer):
    people = serializers.IntegerField()
    submitted = serializers.IntegerField(help_text="Submitted or reviewed")
    reviewed = serializers.IntegerField()
    drafts = serializers.IntegerField()
    missing = serializers.IntegerField()
    late = serializers.IntegerField()


class SalesTeamDailyReportSerializer(serializers.Serializer):
    date = serializers.DateField()
    required = serializers.BooleanField()  # type: ignore[assignment]
    users = SalesTeamDailyRowSerializer(many=True)
    totals = SalesTeamDailyTotalsSerializer()
