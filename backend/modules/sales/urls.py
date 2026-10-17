"""Sales routes, mounted at /api/v1/sales/ behind the module guard (config/api_urls.py). Workspace collections under
`workspaces/<slug>/…`, single records under `<collection>/<id>`. Literal paths come before `<uuid>` paths."""

from django.urls import path

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
]
