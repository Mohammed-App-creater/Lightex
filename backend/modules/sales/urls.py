"""Sales routes, mounted at /api/v1/sales/ behind the module guard (config/api_urls.py). Workspace collections under
`workspaces/<slug>/…`, single records under `<collection>/<id>`. Literal paths come before `<uuid>` paths."""

from django.urls import path

from . import activity_views as av
from . import pipeline_views as pv
from . import views

W = "workspaces/<str:slug>"

urlpatterns = [
    path(f"{W}/settings", views.SettingsView.as_view(), name="sales-settings"),
    path(f"{W}/stages", views.StageListView.as_view(), name="sales-stages"),
    path(f"{W}/stages/reorder", views.StageReorderView.as_view(), name="sales-stages-reorder"),
    path("stages/<uuid:stage_id>", views.StageDetailView.as_view(), name="sales-stage-detail"),
    path(f"{W}/products", views.ProductListView.as_view(), name="sales-products"),
    path("products/<uuid:product_id>", views.ProductDetailView.as_view(), name="sales-product-detail"),
    path(f"{W}/lost-reasons", views.LostReasonListView.as_view(), name="sales-lost-reasons"),
    path("lost-reasons/<uuid:lost_reason_id>", views.LostReasonDetailView.as_view(), name="sales-lost-reason-detail"),
    path(f"{W}/calendar", views.CalendarView.as_view(), name="sales-calendar"),
    path(f"{W}/holidays", views.HolidayListView.as_view(), name="sales-holidays"),
    path("holidays/<uuid:holiday_id>", views.HolidayDetailView.as_view(), name="sales-holiday-detail"),
    path(f"{W}/companies", views.CompanyListView.as_view(), name="sales-companies"),
    path(
        f"{W}/companies/check-duplicate",
        views.CompanyDuplicateCheckView.as_view(),
        name="sales-companies-check-duplicate",
    ),
    path("companies/<uuid:company_id>", views.CompanyDetailView.as_view(), name="sales-company-detail"),
    path("companies/<uuid:company_id>/summary", views.CompanySummaryView.as_view(), name="sales-company-summary"),
    path(f"{W}/contacts", views.ContactListView.as_view(), name="sales-contacts"),
    path("contacts/<uuid:contact_id>", views.ContactDetailView.as_view(), name="sales-contact-detail"),
    # S2: leads, opportunities, the pipeline board and quotations
    path(f"{W}/leads", pv.LeadListView.as_view(), name="sales-leads"),
    path(f"{W}/leads/bulk-assign", pv.LeadBulkAssignView.as_view(), name="sales-leads-bulk-assign"),
    path("leads/<uuid:lead_id>", pv.LeadDetailView.as_view(), name="sales-lead-detail"),
    path("leads/<uuid:lead_id>/qualify", pv.LeadQualifyView.as_view(), name="sales-lead-qualify"),
    path("leads/<uuid:lead_id>/disqualify", pv.LeadDisqualifyView.as_view(), name="sales-lead-disqualify"),
    path("leads/<uuid:lead_id>/convert", pv.LeadConvertView.as_view(), name="sales-lead-convert"),
    path(f"{W}/pipeline", pv.PipelineView.as_view(), name="sales-pipeline"),
    path(f"{W}/opportunities", pv.OpportunityListView.as_view(), name="sales-opportunities"),
    path(
        f"{W}/opportunities/bulk-assign",
        pv.OpportunityBulkAssignView.as_view(),
        name="sales-opportunities-bulk-assign",
    ),
    path("opportunities/<uuid:opportunity_id>", pv.OpportunityDetailView.as_view(), name="sales-opportunity-detail"),
    path("opportunities/<uuid:opportunity_id>/move", pv.OpportunityMoveView.as_view(), name="sales-opportunity-move"),
    path("opportunities/<uuid:opportunity_id>/won", pv.OpportunityWonView.as_view(), name="sales-opportunity-won"),
    path("opportunities/<uuid:opportunity_id>/lost", pv.OpportunityLostView.as_view(), name="sales-opportunity-lost"),
    path(
        "opportunities/<uuid:opportunity_id>/reopen",
        pv.OpportunityReopenView.as_view(),
        name="sales-opportunity-reopen",
    ),
    path(
        "opportunities/<uuid:opportunity_id>/timeline",
        pv.OpportunityTimelineView.as_view(),
        name="sales-opportunity-timeline",
    ),
    path(f"{W}/quotations", pv.QuotationListView.as_view(), name="sales-quotations"),
    path("quotations/<uuid:quotation_id>", pv.QuotationDetailView.as_view(), name="sales-quotation-detail"),
    path("quotations/<uuid:quotation_id>/send", pv.QuotationSendView.as_view(), name="sales-quotation-send"),
    path("quotations/<uuid:quotation_id>/accept", pv.QuotationAcceptView.as_view(), name="sales-quotation-accept"),
    path("quotations/<uuid:quotation_id>/reject", pv.QuotationRejectView.as_view(), name="sales-quotation-reject"),
    # S3: activities, follow-ups and the company timeline
    path(f"{W}/activities", av.ActivityListView.as_view(), name="sales-activities"),
    path("activities/<uuid:activity_id>", av.ActivityDetailView.as_view(), name="sales-activity-detail"),
    path(f"{W}/follow-ups", av.FollowUpListView.as_view(), name="sales-follow-ups"),
    path("follow-ups/<uuid:follow_up_id>", av.FollowUpDetailView.as_view(), name="sales-follow-up-detail"),
    path("follow-ups/<uuid:follow_up_id>/complete", av.FollowUpCompleteView.as_view(), name="sales-follow-up-complete"),
    path(
        "follow-ups/<uuid:follow_up_id>/reschedule",
        av.FollowUpRescheduleView.as_view(),
        name="sales-follow-up-reschedule",
    ),
    path("follow-ups/<uuid:follow_up_id>/reassign", av.FollowUpReassignView.as_view(), name="sales-follow-up-reassign"),
    path("companies/<uuid:company_id>/timeline", av.CompanyTimelineView.as_view(), name="sales-company-timeline"),
]
