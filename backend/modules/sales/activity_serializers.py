"""Request and response shapes for activities, follow-ups, the company timeline and the company summary (S3;
camelCase, `Sales*` component names). Inputs only validate; `validated_data` uses the model's field names.
"""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from core.common.schema import page_of
from core.common.utils import iso

from . import activity_selectors as acts
from . import module as perms
from .models import Activity, FollowUp
from .pipeline_serializers import SalesTimelineItemSerializer, _hints
from .serializers import (
    SalesCompanyBriefSerializer,
    SalesCompanySerializer,
    SalesContactSerializer,
    SalesUserBriefSerializer,
    _Owned,
    _user,
)


class SalesTargetBriefSerializer(serializers.Serializer):
    type = serializers.ChoiceField(choices=Activity.TARGET_TYPES)
    id = serializers.UUIDField()
    name = serializers.CharField(help_text="The lead's display name, the opportunity's title, or the name.")


class _Targeted(_Owned):
    targetType = serializers.ChoiceField(source="target_type", choices=Activity.TARGET_TYPES)
    targetId = serializers.UUIDField(source="target_id")
    target = serializers.SerializerMethodField()
    companyId = serializers.UUIDField(source="company_id", allow_null=True, help_text="The target's company.")
    company = serializers.SerializerMethodField()

    @extend_schema_field(SalesTargetBriefSerializer())
    def get_target(self, obj) -> dict[str, Any]:
        return {"type": obj.target_type, "id": str(obj.target_id), "name": acts.target_name(obj)}

    @extend_schema_field(SalesCompanyBriefSerializer(allow_null=True))
    def get_company(self, obj) -> dict[str, Any] | None:
        return {"id": str(obj.company_id), "name": obj.company.name} if obj.company_id else None


# ───────────────────────── activities ─────────────────────────


class SalesActivitySerializer(_Targeted):
    id = serializers.UUIDField()
    type = serializers.ChoiceField(
        choices=Activity.TYPES, help_text="`quotation` entries are logged by the system when a quotation is sent."
    )
    occurredAt = serializers.SerializerMethodField()
    durationMinutes = serializers.IntegerField(source="duration_minutes", allow_null=True)
    summary = serializers.CharField()
    outcome = serializers.CharField()
    quotationId = serializers.UUIDField(source="quotation_id", allow_null=True)

    def get_occurredAt(self, obj) -> str:
        return iso(obj.occurred_at) or ""


class SalesActivityFollowUpIn(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False, allow_blank=True, help_text="Default: Follow up.")
    dueDate = serializers.DateField(source="due_date", help_text="Today or later (workspace time).")
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)


class _ActivityFields(serializers.Serializer):
    type = serializers.ChoiceField(choices=Activity.LOGGED_TYPES)
    occurredAt = serializers.DateTimeField(
        source="occurred_at", required=False, help_text="Default now; not in the future."
    )
    durationMinutes = serializers.IntegerField(
        source="duration_minutes", required=False, allow_null=True, min_value=0, max_value=24 * 60
    )
    summary = serializers.CharField(max_length=1000, required=False, allow_blank=True)
    outcome = serializers.CharField(max_length=1000, required=False, allow_blank=True)


class SalesActivityIn(_ActivityFields):
    targetType = serializers.ChoiceField(source="target_type", choices=Activity.TARGET_TYPES)
    targetId = serializers.UUIDField(source="target_id", help_text="A record you can see.")
    followUp = SalesActivityFollowUpIn(
        source="follow_up",
        required=False,
        allow_null=True,
        help_text="Plan the next step on the same record (a contact's company) in the same call; needs "
        "sales.followup.create.",
    )


class SalesActivityUpdateIn(_ActivityFields):
    type = serializers.ChoiceField(choices=Activity.LOGGED_TYPES, required=False)
    targetType = serializers.ChoiceField(source="target_type", choices=Activity.TARGET_TYPES, required=False)
    targetId = serializers.UUIDField(source="target_id", required=False)

    def validate(self, attrs):
        if ("target_type" in attrs) != ("target_id" in attrs):
            raise serializers.ValidationError({"targetId": "Send targetType and targetId together"})
        return attrs


class SalesFollowUpSerializer(_Targeted):
    id = serializers.UUIDField()
    title = serializers.CharField()
    notes = serializers.CharField()
    dueDate = serializers.DateField(source="due_date")
    status = serializers.ChoiceField(choices=FollowUp.STATUSES)
    bucket = serializers.SerializerMethodField(
        help_text="Pending only: overdue, today, upcoming (within upcomingDays) or later; null when done or cancelled."
    )
    completedAt = serializers.SerializerMethodField()
    completedActivityId = serializers.UUIDField(source="completed_activity_id", allow_null=True)
    cancelledAt = serializers.SerializerMethodField()
    createdById = serializers.UUIDField(source="created_by_id", allow_null=True)
    createdBy = serializers.SerializerMethodField()
    canComplete = serializers.SerializerMethodField(help_text="The caller's complete scope reaches this record.")
    canReassign = serializers.SerializerMethodField(help_text="The caller's reassign scope reaches this record.")

    @extend_schema_field(
        serializers.ChoiceField(choices=[acts.OVERDUE, acts.TODAY, acts.UPCOMING, acts.LATER], allow_null=True)
    )
    def get_bucket(self, obj) -> str | None:
        today, until = self.context["window"]
        return acts.bucket_of(obj, today, until)

    def get_completedAt(self, obj) -> str | None:
        return iso(obj.completed_at)

    def get_cancelledAt(self, obj) -> str | None:
        return iso(obj.cancelled_at)

    @extend_schema_field(SalesUserBriefSerializer(allow_null=True))
    def get_createdBy(self, obj) -> dict[str, Any] | None:
        return _user(obj.created_by) if obj.created_by_id else None

    def get_canComplete(self, obj) -> bool:
        return str(obj.pk) in self.context.get("completable", ())

    def get_canReassign(self, obj) -> bool:
        return str(obj.pk) in self.context.get("reassignable", ())


class SalesActivityLogResultSerializer(serializers.Serializer):
    activity = SalesActivitySerializer()
    followUp = SalesFollowUpSerializer(allow_null=True, help_text="The follow-up created with it, if any.")


# ───────────────────────── follow-ups ─────────────────────────


class SalesFollowUpIn(serializers.Serializer):
    targetType = serializers.ChoiceField(source="target_type", choices=FollowUp.TARGET_TYPES)
    targetId = serializers.UUIDField(source="target_id", help_text="A record you can see.")
    title = serializers.CharField(max_length=200)
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    dueDate = serializers.DateField(source="due_date", help_text="Today or later (workspace time).")
    ownerId = serializers.UUIDField(
        source="owner_id",
        required=False,
        help_text="Default: the caller. Someone else needs sales.followup.reassign with scope team or all.",
    )


class SalesFollowUpUpdateIn(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False)
    notes = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    dueDate = serializers.DateField(source="due_date", required=False, help_text="Today or later.")
    status = serializers.ChoiceField(
        choices=[FollowUp.CANCELLED], required=False, help_text="`cancelled` cancels a pending follow-up."
    )


class SalesFollowUpRescheduleIn(serializers.Serializer):
    dueDate = serializers.DateField(source="due_date", help_text="Today or later (workspace time).")


class SalesFollowUpReassignIn(serializers.Serializer):
    ownerId = serializers.UUIDField(source="owner_id")


class SalesCompleteActivityIn(_ActivityFields):
    pass


class SalesCreateNextIn(serializers.Serializer):
    dueDate = serializers.DateField(source="due_date", help_text="Today or later (workspace time).")
    title = serializers.CharField(max_length=200, required=False, allow_blank=True, help_text="Default: the same.")


class SalesFollowUpCompleteIn(serializers.Serializer):
    activity = SalesCompleteActivityIn(
        required=False,
        allow_null=True,
        help_text="Log what happened (on the same record); needs sales.activity.create.",
    )
    createNext = SalesCreateNextIn(
        source="create_next",
        required=False,
        allow_null=True,
        help_text="Plan the next follow-up for the same owner and record; needs sales.followup.create.",
    )


class SalesFollowUpCompleteResultSerializer(serializers.Serializer):
    followUp = SalesFollowUpSerializer()
    activity = SalesActivitySerializer(allow_null=True)
    next = SalesFollowUpSerializer(allow_null=True)


class SalesFollowUpCountsSerializer(serializers.Serializer):
    overdue = serializers.IntegerField()
    today = serializers.IntegerField()
    upcoming = serializers.IntegerField()


SalesActivityPage = page_of("SalesActivityPage", SalesActivitySerializer)
SalesFollowUpPage = page_of(
    "SalesFollowUpPage",
    SalesFollowUpSerializer,
    counts=SalesFollowUpCountsSerializer(help_text="Pending follow-ups per bucket, over the same filters."),
)


class SalesCompanySummarySerializer(serializers.Serializer):
    company = SalesCompanySerializer()
    contactCount = serializers.IntegerField(help_text="Contacts of this company the caller can see.")
    primaryContact = SalesContactSerializer(allow_null=True)
    openOpportunityCount = serializers.IntegerField(help_text="Open opportunities of the company the caller can see.")
    pipelineValue = serializers.DecimalField(
        max_digits=14, decimal_places=2, help_text="Sum of their expected values (open opportunities in scope)."
    )
    wonValue = serializers.DecimalField(
        max_digits=14, decimal_places=2, help_text="Sum of won values of won opportunities in scope."
    )
    openFollowUpCount = serializers.IntegerField(help_text="Pending follow-ups on the company the caller can see.")
    lastContactAt = serializers.DateTimeField(
        allow_null=True, help_text="The latest call, visit, meeting or email on the company or any of its records."
    )
    timeline = SalesTimelineItemSerializer(
        many=True, help_text="The newest 20 items; the whole timeline is GET /sales/companies/{id}/timeline."
    )


# ───────────────────────── page serializers ─────────────────────────


def activity_data(user: Any, rows: list[Activity]) -> Any:
    if not rows:
        return []
    ctx = _hints(
        user,
        rows[0].workspace_id,
        Activity,
        rows,
        {"editable": perms.ACTIVITY_EDIT, "deletable": perms.ACTIVITY_DELETE},
    )
    return SalesActivitySerializer(rows, many=True, context=ctx).data


def one_activity(user: Any, a: Activity) -> dict[str, Any]:
    fresh = acts.related_activities(Activity.objects.for_workspace(a.workspace_id)).get(pk=a.pk)
    return activity_data(user, [fresh])[0]


FOLLOWUP_HINTS = {
    "editable": perms.FOLLOWUP_EDIT,
    "deletable": perms.FOLLOWUP_DELETE,
    "completable": perms.FOLLOWUP_COMPLETE,
    "reassignable": perms.FOLLOWUP_REASSIGN,
}


def followup_data(user: Any, rows: list[FollowUp], workspace: Any) -> Any:
    if not rows:
        return []
    ctx = _hints(user, rows[0].workspace_id, FollowUp, rows, FOLLOWUP_HINTS)
    ctx["window"] = acts.window(workspace)
    return SalesFollowUpSerializer(rows, many=True, context=ctx).data


def one_followup(user: Any, f: FollowUp) -> dict[str, Any]:
    qs = FollowUp.objects.for_workspace(f.workspace_id).select_related(
        "workspace",
        "owner",
        "created_by",
        "lead",
        "lead__company",
        "opportunity",
        "target_company",
        "contact",
        "company",
    )
    fresh = qs.get(pk=f.pk)
    return followup_data(user, [fresh], fresh.workspace)[0]
