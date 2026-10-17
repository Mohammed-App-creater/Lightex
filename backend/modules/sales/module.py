"""The sales module's definition: the full permission catalogue (docs/sales/spec.md §3), the default roles and the
built-in roles' grants, and the navigation.

The whole catalogue is declared in S1 so later stages never change the roles. A scopable code (`S` in the spec) is
granted with a data scope (`own`, `team` or `all`); a non-scopable code is not. The grant table below is the single
source of the default roles; docs/sales/api.md §2 prints it for the frontend.
"""

from __future__ import annotations

from core.access.catalogue import ALL, OWN, TEAM, PermissionDef, workspace_permission
from core.modules.registry import DefaultRole, ModuleDefinition, NavItem

KEY = "sales"

# ───────────────────────── permission codes (spec §3) ─────────────────────────

DASHBOARD_VIEW = "sales.dashboard.view"

COMPANY_VIEW = "sales.company.view"
COMPANY_CREATE = "sales.company.create"
COMPANY_EDIT = "sales.company.edit"
COMPANY_DELETE = "sales.company.delete"

CONTACT_VIEW = "sales.contact.view"
CONTACT_CREATE = "sales.contact.create"
CONTACT_EDIT = "sales.contact.edit"
CONTACT_DELETE = "sales.contact.delete"

LEAD_VIEW = "sales.lead.view"
LEAD_CREATE = "sales.lead.create"
LEAD_EDIT = "sales.lead.edit"
LEAD_DELETE = "sales.lead.delete"
LEAD_ASSIGN = "sales.lead.assign"
LEAD_CONVERT = "sales.lead.convert"

OPPORTUNITY_VIEW = "sales.opportunity.view"
OPPORTUNITY_CREATE = "sales.opportunity.create"
OPPORTUNITY_EDIT = "sales.opportunity.edit"
OPPORTUNITY_MOVE = "sales.opportunity.move"
OPPORTUNITY_CLOSE = "sales.opportunity.close"
OPPORTUNITY_DELETE = "sales.opportunity.delete"
OPPORTUNITY_ASSIGN = "sales.opportunity.assign"
OPPORTUNITY_REOPEN = "sales.opportunity.reopen"

QUOTATION_VIEW = "sales.quotation.view"
QUOTATION_CREATE = "sales.quotation.create"
QUOTATION_EDIT = "sales.quotation.edit"
QUOTATION_DELETE = "sales.quotation.delete"

ACTIVITY_VIEW = "sales.activity.view"
ACTIVITY_CREATE = "sales.activity.create"
ACTIVITY_EDIT = "sales.activity.edit"
ACTIVITY_DELETE = "sales.activity.delete"

FOLLOWUP_VIEW = "sales.followup.view"
FOLLOWUP_CREATE = "sales.followup.create"
FOLLOWUP_EDIT = "sales.followup.edit"
FOLLOWUP_COMPLETE = "sales.followup.complete"
FOLLOWUP_REASSIGN = "sales.followup.reassign"
FOLLOWUP_DELETE = "sales.followup.delete"

TARGET_VIEW = "sales.target.view"
TARGET_MANAGE = "sales.target.manage"

DAILYREPORT_SUBMIT = "sales.dailyreport.submit"
DAILYREPORT_VIEW = "sales.dailyreport.view"
DAILYREPORT_REVIEW = "sales.dailyreport.review"

PERFORMANCE_VIEW = "sales.performance.view"

REPORT_VIEW = "sales.report.view"
REPORT_EXPORT = "sales.report.export"

SETTINGS_MANAGE = "sales.settings.manage"


def _p(code: str, group: str, label: str, description: str, scopable: bool = True) -> PermissionDef:
    return workspace_permission(code, group, label, description, scopable=scopable)


PERMISSIONS: tuple[PermissionDef, ...] = (
    _p(DASHBOARD_VIEW, "Sales", "Use sales", "Open Sales and see dashboards over the people in scope"),
    _p(COMPANY_VIEW, "Sales: customers", "View companies", "See companies in scope"),
    _p(COMPANY_CREATE, "Sales: customers", "Create companies", "Add companies", scopable=False),
    _p(COMPANY_EDIT, "Sales: customers", "Edit companies", "Edit companies in scope and change their owner"),
    _p(COMPANY_DELETE, "Sales: customers", "Delete companies", "Delete and restore companies in scope"),
    _p(CONTACT_VIEW, "Sales: customers", "View contacts", "See contacts in scope"),
    _p(CONTACT_CREATE, "Sales: customers", "Create contacts", "Add contacts", scopable=False),
    _p(CONTACT_EDIT, "Sales: customers", "Edit contacts", "Edit contacts in scope and change their owner"),
    _p(CONTACT_DELETE, "Sales: customers", "Delete contacts", "Delete and restore contacts in scope"),
    _p(LEAD_VIEW, "Sales: leads", "View leads", "See leads in scope"),
    _p(LEAD_CREATE, "Sales: leads", "Create leads", "Add leads", scopable=False),
    _p(LEAD_EDIT, "Sales: leads", "Edit leads", "Edit leads in scope"),
    _p(LEAD_DELETE, "Sales: leads", "Delete leads", "Delete leads in scope"),
    _p(LEAD_ASSIGN, "Sales: leads", "Assign leads", "Change the owner of leads in scope"),
    _p(LEAD_CONVERT, "Sales: leads", "Convert leads", "Qualify, disqualify and convert leads in scope"),
    _p(OPPORTUNITY_VIEW, "Sales: pipeline", "View opportunities", "See opportunities in scope"),
    _p(OPPORTUNITY_CREATE, "Sales: pipeline", "Create opportunities", "Add opportunities", scopable=False),
    _p(OPPORTUNITY_EDIT, "Sales: pipeline", "Edit opportunities", "Edit opportunities in scope"),
    _p(OPPORTUNITY_MOVE, "Sales: pipeline", "Move opportunities", "Move opportunities in scope between open stages"),
    _p(OPPORTUNITY_CLOSE, "Sales: pipeline", "Close opportunities", "Mark opportunities in scope won or lost"),
    _p(OPPORTUNITY_DELETE, "Sales: pipeline", "Delete opportunities", "Delete opportunities in scope"),
    _p(OPPORTUNITY_ASSIGN, "Sales: pipeline", "Assign opportunities", "Change the owner of opportunities in scope"),
    _p(OPPORTUNITY_REOPEN, "Sales: pipeline", "Reopen opportunities", "Reopen won or lost opportunities in scope"),
    _p(QUOTATION_VIEW, "Sales: quotations", "View quotations", "See quotations in scope"),
    _p(QUOTATION_CREATE, "Sales: quotations", "Create quotations", "Add quotations", scopable=False),
    _p(QUOTATION_EDIT, "Sales: quotations", "Edit quotations", "Edit, send and record answers to quotations in scope"),
    _p(QUOTATION_DELETE, "Sales: quotations", "Delete quotations", "Delete quotations in scope"),
    _p(ACTIVITY_VIEW, "Sales: activities", "View activities", "See calls, visits, meetings and notes in scope"),
    _p(ACTIVITY_CREATE, "Sales: activities", "Log activities", "Log calls, visits, meetings and notes", scopable=False),
    _p(ACTIVITY_EDIT, "Sales: activities", "Edit activities", "Edit activities in scope"),
    _p(ACTIVITY_DELETE, "Sales: activities", "Delete activities", "Delete activities in scope"),
    _p(FOLLOWUP_VIEW, "Sales: follow-ups", "View follow-ups", "See follow-ups in scope"),
    _p(FOLLOWUP_CREATE, "Sales: follow-ups", "Create follow-ups", "Add follow-ups", scopable=False),
    _p(FOLLOWUP_EDIT, "Sales: follow-ups", "Edit follow-ups", "Edit and reschedule follow-ups in scope"),
    _p(FOLLOWUP_COMPLETE, "Sales: follow-ups", "Complete follow-ups", "Complete follow-ups in scope"),
    _p(FOLLOWUP_REASSIGN, "Sales: follow-ups", "Reassign follow-ups", "Change the owner of follow-ups in scope"),
    _p(FOLLOWUP_DELETE, "Sales: follow-ups", "Delete follow-ups", "Delete follow-ups in scope"),
    _p(TARGET_VIEW, "Sales: targets", "View targets", "See targets of the people in scope"),
    _p(TARGET_MANAGE, "Sales: targets", "Manage targets", "Set and allocate targets for people in scope"),
    _p(DAILYREPORT_SUBMIT, "Sales: daily reports", "Submit daily report", "Submit your own daily report", False),
    _p(DAILYREPORT_VIEW, "Sales: daily reports", "View daily reports", "See daily reports in scope"),
    _p(DAILYREPORT_REVIEW, "Sales: daily reports", "Review daily reports", "Review and reopen daily reports in scope"),
    _p(PERFORMANCE_VIEW, "Sales: performance", "View performance", "See performance pages and ranking in scope"),
    _p(REPORT_VIEW, "Sales: reports", "View reports", "Run sales reports over the people in scope"),
    _p(REPORT_EXPORT, "Sales: reports", "Export reports", "Download sales reports as CSV"),
    _p(
        SETTINGS_MANAGE,
        "Sales: settings",
        "Manage sales settings",
        "Edit stages, products, lost reasons, the working calendar and thresholds",
        scopable=False,
    ),
)

ALL_CODES: tuple[str, ...] = tuple(p.code for p in PERMISSIONS)
SCOPABLE_CODES: frozenset[str] = frozenset(p.code for p in PERMISSIONS if p.scopable)

# ───────────────────────── default roles (one readable table) ─────────────────────────
#
# Columns: Sales Admin (all) · CEO / GM (all) · Sales Manager (team) · Salesperson (own). "X" = granted, with the
# role's data scope for a scopable code (no scope for a non-scopable one); "o" = not granted.
#
# Every sales role also grants `core.workspace.view`, so a person whose only role is a sales role can open the
# workspace. Owner and Admin get every sales code with scope `all`; plain Member gets nothing in sales (people get
# sales access through the sales roles; members may hold several roles).

X, o = True, False
GRANT_TABLE: dict[str, tuple[bool, bool, bool, bool]] = {
    #                        Admin CEO  Mgr  Rep
    DASHBOARD_VIEW:          (X,   X,   X,   X),
    COMPANY_VIEW:            (X,   X,   X,   X),
    COMPANY_CREATE:          (X,   o,   X,   X),
    COMPANY_EDIT:            (X,   o,   X,   X),
    COMPANY_DELETE:          (X,   o,   o,   o),
    CONTACT_VIEW:            (X,   X,   X,   X),
    CONTACT_CREATE:          (X,   o,   X,   X),
    CONTACT_EDIT:            (X,   o,   X,   X),
    CONTACT_DELETE:          (X,   o,   o,   o),
    LEAD_VIEW:               (X,   X,   X,   X),
    LEAD_CREATE:             (X,   o,   X,   X),
    LEAD_EDIT:               (X,   o,   X,   X),
    LEAD_DELETE:             (X,   o,   X,   o),
    LEAD_ASSIGN:             (X,   o,   X,   o),
    LEAD_CONVERT:            (X,   o,   X,   X),
    OPPORTUNITY_VIEW:        (X,   X,   X,   X),
    OPPORTUNITY_CREATE:      (X,   o,   X,   X),
    OPPORTUNITY_EDIT:        (X,   o,   X,   X),
    OPPORTUNITY_MOVE:        (X,   o,   X,   X),
    OPPORTUNITY_CLOSE:       (X,   o,   X,   X),
    OPPORTUNITY_DELETE:      (X,   o,   o,   o),
    OPPORTUNITY_ASSIGN:      (X,   o,   X,   o),
    OPPORTUNITY_REOPEN:      (X,   o,   o,   o),
    QUOTATION_VIEW:          (X,   X,   X,   X),
    QUOTATION_CREATE:        (X,   o,   X,   X),
    QUOTATION_EDIT:          (X,   o,   X,   X),
    QUOTATION_DELETE:        (X,   o,   X,   o),
    ACTIVITY_VIEW:           (X,   X,   X,   X),
    ACTIVITY_CREATE:         (X,   o,   X,   X),
    ACTIVITY_EDIT:           (X,   o,   X,   X),
    ACTIVITY_DELETE:         (X,   o,   X,   X),
    FOLLOWUP_VIEW:           (X,   X,   X,   X),
    FOLLOWUP_CREATE:         (X,   o,   X,   X),
    FOLLOWUP_EDIT:           (X,   o,   X,   X),
    FOLLOWUP_COMPLETE:       (X,   o,   X,   X),
    FOLLOWUP_REASSIGN:       (X,   o,   X,   o),
    FOLLOWUP_DELETE:         (X,   o,   X,   X),
    TARGET_VIEW:             (X,   X,   X,   X),
    TARGET_MANAGE:           (X,   X,   X,   o),
    DAILYREPORT_SUBMIT:      (X,   o,   X,   X),
    DAILYREPORT_VIEW:        (X,   X,   X,   X),
    DAILYREPORT_REVIEW:      (X,   X,   X,   o),
    PERFORMANCE_VIEW:        (X,   X,   X,   X),
    REPORT_VIEW:             (X,   X,   X,   o),
    REPORT_EXPORT:           (X,   X,   X,   o),
    SETTINGS_MANAGE:         (X,   o,   o,   o),
}  # fmt: skip
del X, o

#: (system_key, name, data scope, description), in the table's column order.
ROLE_COLUMNS: tuple[tuple[str, str, str, str], ...] = (
    ("sales_admin", "Sales Admin", ALL, "Everything in Sales, including settings."),
    ("sales_ceo", "CEO / GM", ALL, "Sees everything, reviews reports and sets targets; no day-to-day editing."),
    ("sales_manager", "Sales Manager", TEAM, "Runs the team's pipeline, targets and daily reports."),
    ("sales_salesperson", "Salesperson", OWN, "Works their own customers, leads and deals."),
)


def _grants(column: int, scope: str) -> dict[str, str | None]:
    out: dict[str, str | None] = {"core.workspace.view": None}
    for code, row in GRANT_TABLE.items():
        if row[column]:
            out[code] = scope if code in SCOPABLE_CODES else None
    return out


DEFAULT_ROLES: tuple[DefaultRole, ...] = tuple(
    DefaultRole(key, name, description, _grants(i, scope))
    for i, (key, name, scope, description) in enumerate(ROLE_COLUMNS)
)

DEFINITION = ModuleDefinition(
    key=KEY,
    name="Sales",
    description="Customers, leads, pipeline, targets and daily reports for sales teams.",
    is_core=False,
    depends_on=(),
    permissions=PERMISSIONS,
    # Owner and Admin: every sales code, scope `all` (the default for those two roles). Member: nothing.
    default_role_grants={"owner": list(ALL_CODES), "admin": list(ALL_CODES)},
    default_roles=DEFAULT_ROLES,
    target_types=("sales.company", "sales.contact"),
    search_provider=KEY,
    nav_items=(NavItem("sales", "Sales", "briefcase", "sales", DASHBOARD_VIEW),),
    toggleable=True,
)
