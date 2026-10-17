"""Sales API views for activities, follow-ups and the company timeline (S3, docs/sales/api.md §14–§16). Same pattern
as `views.py`: permission per method, then a selector or a service; record routes answer 404 outside the view scope.
"""

from __future__ import annotations

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.response import Response

from core.common.pagination import paginate_queryset
from core.workspaces.views import WorkspaceScopedView

from . import activity_selectors as acts
from . import activity_services as svc
from . import module as perms
from . import selectors
from .activity_serializers import (
    SalesActivityIn,
    SalesActivityLogResultSerializer,
    SalesActivityPage,
    SalesActivitySerializer,
    SalesActivityUpdateIn,
    SalesFollowUpCompleteIn,
    SalesFollowUpCompleteResultSerializer,
    SalesFollowUpIn,
    SalesFollowUpPage,
    SalesFollowUpReassignIn,
    SalesFollowUpRescheduleIn,
    SalesFollowUpSerializer,
    SalesFollowUpUpdateIn,
    activity_data,
    followup_data,
    one_activity,
    one_followup,
)
from .models import Activity, FollowUp
from .pipeline_views import OWNER_PARAMS, SalesTimelinePage
from .views import PAGE_PARAMS, TAGS, CompanyRecordView, SalesRecordView, valid

TARGET_PARAMS = [
    OpenApiParameter("filter[target]", str, many=True, description="the record's id (lead, opportunity, …)"),
    OpenApiParameter("filter[company]", str, many=True, description="company id: everything on the company"),
]

# ───────────────────────── activities ─────────────────────────

ACTIVITY_LIST_PARAMS = [
    OpenApiParameter("filter[type]", str, many=True, enum=list(Activity.TYPES)),
    *OWNER_PARAMS,
    OpenApiParameter("filter[targetType]", str, many=True, enum=list(Activity.TARGET_TYPES)),
    *TARGET_PARAMS,
    OpenApiParameter("filter[occurredFrom]", str, description="YYYY-MM-DD, workspace time, inclusive"),
    OpenApiParameter("filter[occurredTo]", str, description="YYYY-MM-DD, workspace time, inclusive"),
    OpenApiParameter("q", str, description="Matches summary or outcome"),
    OpenApiParameter("sort", str, description="-occurredAt (default), occurredAt, createdAt"),
    *PAGE_PARAMS,
]


class ActivityListView(WorkspaceScopedView):
    required = {"GET": perms.ACTIVITY_VIEW, "POST": perms.ACTIVITY_CREATE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_activities_list",
        parameters=ACTIVITY_LIST_PARAMS,
        responses={200: SalesActivityPage},
    )
    def get(self, request, slug):
        qs = acts.filter_activities(acts.activities_for(request.user, self.scope), request, self.scope)
        qs, order = acts.activity_sort(qs, request.query_params.get("sort"))
        page = paginate_queryset(
            qs, request.query_params, order=order, serialize=lambda rows: activity_data(request.user, rows)
        )
        return Response(page)

    @extend_schema(
        tags=TAGS,
        operation_id="sales_activities_create",
        request=SalesActivityIn,
        responses={201: SalesActivityLogResultSerializer},
    )
    def post(self, request, slug):
        activity, follow_up = svc.log_activity(request.user, self.scope, valid(SalesActivityIn, request))
        body = {
            "activity": one_activity(request.user, activity),
            "followUp": one_followup(request.user, follow_up) if follow_up is not None else None,
        }
        return Response(body, status=status.HTTP_201_CREATED)


class ActivityDetailView(SalesRecordView):
    model = Activity
    kwarg = "activity_id"
    not_found_message = acts.ACTIVITY_NOT_FOUND
    required = {"GET": perms.ACTIVITY_VIEW, "PATCH": perms.ACTIVITY_EDIT, "DELETE": perms.ACTIVITY_DELETE}

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        acts.activity_for(request.user, self.record)

    @extend_schema(tags=TAGS, operation_id="sales_activities_retrieve", responses={200: SalesActivitySerializer})
    def get(self, request, activity_id):
        return Response(one_activity(request.user, self.record))

    @extend_schema(
        tags=TAGS,
        operation_id="sales_activities_partial_update",
        request=SalesActivityUpdateIn,
        responses={200: SalesActivitySerializer},
    )
    def patch(self, request, activity_id):
        a = svc.update_activity(request.user, self.record, valid(SalesActivityUpdateIn, request))
        return Response(one_activity(request.user, a))

    @extend_schema(tags=TAGS, operation_id="sales_activities_destroy", responses={204: None})
    def delete(self, request, activity_id):
        svc.delete_activity(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ───────────────────────── follow-ups ─────────────────────────

FOLLOWUP_LIST_PARAMS = [
    OpenApiParameter(
        "bucket",
        str,
        enum=list(acts.BUCKETS),
        description="overdue, today or upcoming (pending only, workspace time); all (default) applies no bucket",
    ),
    OpenApiParameter("filter[status]", str, many=True, enum=list(FollowUp.STATUSES)),
    *OWNER_PARAMS,
    OpenApiParameter("filter[targetType]", str, many=True, enum=list(FollowUp.TARGET_TYPES)),
    *TARGET_PARAMS,
    OpenApiParameter("filter[dueFrom]", str, description="YYYY-MM-DD, inclusive"),
    OpenApiParameter("filter[dueTo]", str, description="YYYY-MM-DD, inclusive"),
    OpenApiParameter("q", str, description="Matches title or notes"),
    OpenApiParameter("sort", str, description="dueDate (default), createdAt, updatedAt; - for descending"),
    *PAGE_PARAMS,
]


class FollowUpListView(WorkspaceScopedView):
    required = {"GET": perms.FOLLOWUP_VIEW, "POST": perms.FOLLOWUP_CREATE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_follow_ups_list",
        parameters=FOLLOWUP_LIST_PARAMS,
        responses={200: SalesFollowUpPage},
    )
    def get(self, request, slug):
        bucket = acts.parse_bucket(request.query_params.get("bucket"))
        qs = acts.filter_followups(acts.followups_for(request.user, self.scope), request, self.scope)
        today, until = acts.window(self.scope)
        counts = acts.bucket_counts(qs, today, until)
        qs, order = acts.followup_sort(qs.filter(acts.bucket_q(bucket, today, until)), request.query_params.get("sort"))
        page = paginate_queryset(
            qs, request.query_params, order=order, serialize=lambda rows: followup_data(request.user, rows, self.scope)
        )
        return Response({**page, "counts": counts})

    @extend_schema(
        tags=TAGS,
        operation_id="sales_follow_ups_create",
        request=SalesFollowUpIn,
        responses={201: SalesFollowUpSerializer},
    )
    def post(self, request, slug):
        f = svc.create_followup(request.user, self.scope, valid(SalesFollowUpIn, request))
        return Response(one_followup(request.user, f), status=status.HTTP_201_CREATED)


class FollowUpRecordView(SalesRecordView):
    model = FollowUp
    kwarg = "follow_up_id"
    not_found_message = acts.FOLLOWUP_NOT_FOUND

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        acts.followup_for(request.user, self.record)

    def respond(self, f: FollowUp) -> Response:
        return Response(one_followup(self.request.user, f))


class FollowUpDetailView(FollowUpRecordView):
    required = {"GET": perms.FOLLOWUP_VIEW, "PATCH": perms.FOLLOWUP_EDIT, "DELETE": perms.FOLLOWUP_DELETE}

    @extend_schema(tags=TAGS, operation_id="sales_follow_ups_retrieve", responses={200: SalesFollowUpSerializer})
    def get(self, request, follow_up_id):
        return self.respond(self.record)

    @extend_schema(
        tags=TAGS,
        operation_id="sales_follow_ups_partial_update",
        request=SalesFollowUpUpdateIn,
        responses={200: SalesFollowUpSerializer},
    )
    def patch(self, request, follow_up_id):
        return self.respond(svc.update_followup(request.user, self.record, valid(SalesFollowUpUpdateIn, request)))

    @extend_schema(tags=TAGS, operation_id="sales_follow_ups_destroy", responses={204: None})
    def delete(self, request, follow_up_id):
        svc.delete_followup(request.user, self.record)
        return Response(status=status.HTTP_204_NO_CONTENT)


class FollowUpCompleteView(FollowUpRecordView):
    required = {"POST": perms.FOLLOWUP_COMPLETE}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_follow_ups_complete",
        request=SalesFollowUpCompleteIn,
        responses={200: SalesFollowUpCompleteResultSerializer},
    )
    def post(self, request, follow_up_id):
        user = request.user
        out = svc.complete_followup(user, self.record, valid(SalesFollowUpCompleteIn, request))
        return Response(
            {
                "followUp": one_followup(user, out["followUp"]),
                "activity": one_activity(user, out["activity"]) if out["activity"] is not None else None,
                "next": one_followup(user, out["next"]) if out["next"] is not None else None,
            }
        )


class FollowUpRescheduleView(FollowUpRecordView):
    required = {"POST": perms.FOLLOWUP_EDIT}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_follow_ups_reschedule",
        request=SalesFollowUpRescheduleIn,
        responses={200: SalesFollowUpSerializer},
    )
    def post(self, request, follow_up_id):
        due = valid(SalesFollowUpRescheduleIn, request)["due_date"]
        return self.respond(svc.reschedule_followup(request.user, self.record, due))


class FollowUpReassignView(FollowUpRecordView):
    """Needs sales.followup.reassign reaching the follow-up; the new owner follows the owner rule. Audited."""

    required = {"POST": perms.FOLLOWUP_REASSIGN}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_follow_ups_reassign",
        request=SalesFollowUpReassignIn,
        responses={200: SalesFollowUpSerializer},
    )
    def post(self, request, follow_up_id):
        owner_id = valid(SalesFollowUpReassignIn, request)["owner_id"]
        return self.respond(svc.reassign_followup(request.user, self.record, owner_id))


# ───────────────────────── company timeline ─────────────────────────


class CompanyTimelineView(CompanyRecordView):
    """Every activity and follow-up on the company or any of its records, newest first, whatever their owner."""

    required = {"GET": perms.COMPANY_VIEW}

    @extend_schema(
        tags=TAGS,
        operation_id="sales_companies_timeline",
        parameters=PAGE_PARAMS,
        responses={200: SalesTimelinePage},
    )
    def get(self, request, company_id):
        company = selectors.company_for(request.user, self.record)
        return Response(acts.company_timeline(company, request.query_params))
