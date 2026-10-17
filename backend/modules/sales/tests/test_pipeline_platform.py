"""S2 records on data scope and the platform (docs/sales/api.md §3, §12): own / team / all on the lead, opportunity
and quotation lists and the pipeline board (multiple teams, multiple roles), 404 outside the view scope, collab on
`sales.lead` / `sales.opportunity` / `sales.quotation`, search, audit groups, event types and the module guard."""

import pytest

from core.common.targets import get_resolver
from core.events.registry import event_type
from core.modules.services import set_module_enabled
from core.teams.models import TeamMember
from modules.sales.models import Opportunity

from .conftest import OWNED

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform"
DOC = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Hi"}]}]}

SCOPES = [
    ("rep", {"rep"}),
    ("manager", {"manager", "rep", "rep2"}),
    ("multi", {"rep2", "rep3"}),  # Member + Salesperson + Sales Manager: team scope over South
    ("ceo", set(OWNED)),
    ("sales_admin", set(OWNED)),
    ("owner", set(OWNED)),
]


def owners(world, actor, collection, field):
    by_title = {}
    for a in OWNED:
        by_title[f"{a.title()} {field}"] = a
    rows = world.client(actor).get(f"{BASE}/{collection}").json()["data"]
    key = {"leads": "displayName", "opportunities": "title", "quotations": "title"}[collection]
    return {by_title[r[key]] for r in rows if r[key] in by_title}


@pytest.mark.parametrize(("actor", "expected"), SCOPES)
def test_lists_and_the_board_follow_the_data_scope(deals, actor, expected):
    assert owners(deals, actor, "leads", "Prospect") == expected
    assert owners(deals, actor, "opportunities", "Deal") == expected
    assert owners(deals, actor, "quotations", "Quote") == expected
    board = deals.client(actor).get(f"{BASE}/pipeline").json()
    titles = {o["title"] for col in board["stages"] for o in col["opportunities"]}
    assert titles == {f"{a.title()} Deal" for a in expected}
    assert (board["count"], board["leadCount"]) == (len(expected), len(expected))


def test_a_user_in_two_teams_sees_both_on_the_board(deals):
    TeamMember.objects.create(workspace=deals.ws, team=deals.teams["south"], user=deals.users["manager"])
    deals.users["manager"].__dict__.pop("_lx_access_cache", None)
    assert owners(deals, "manager", "opportunities", "Deal") == {"manager", "rep", "rep2", "rep3"}
    assert deals.client("manager").get(f"{BASE}/pipeline").json()["count"] == 4


def test_out_of_scope_records_are_404_on_every_route(deals):
    rep = deals.client("rep")
    lead, opp, quote = deals.leads["rep3"], deals.opportunities["rep3"], deals.quotations["rep3"]
    urls = [
        ("get", f"/api/v1/sales/leads/{lead.pk}"),
        ("patch", f"/api/v1/sales/leads/{lead.pk}"),
        ("post", f"/api/v1/sales/leads/{lead.pk}/qualify"),
        ("post", f"/api/v1/sales/leads/{lead.pk}/disqualify"),
        ("post", f"/api/v1/sales/leads/{lead.pk}/convert"),
        ("get", f"/api/v1/sales/opportunities/{opp.pk}"),
        ("patch", f"/api/v1/sales/opportunities/{opp.pk}"),
        ("post", f"/api/v1/sales/opportunities/{opp.pk}/move"),
        ("post", f"/api/v1/sales/opportunities/{opp.pk}/won"),
        ("post", f"/api/v1/sales/opportunities/{opp.pk}/lost"),
        ("get", f"/api/v1/sales/opportunities/{opp.pk}/timeline"),
        ("get", f"/api/v1/sales/quotations/{quote.pk}"),
        ("patch", f"/api/v1/sales/quotations/{quote.pk}"),
        ("post", f"/api/v1/sales/quotations/{quote.pk}/send"),
        ("post", f"/api/v1/sales/quotations/{quote.pk}/accept"),
        ("post", f"/api/v1/sales/quotations/{quote.pk}/reject"),
    ]
    for method, url in urls:
        res = getattr(rep, method)(url, {}, format="json") if method != "get" else rep.get(url)
        assert res.status_code == 404, (url, res.status_code)
    # Quotations of a deleted opportunity are hidden too.
    Opportunity.objects.filter(pk=deals.opportunities["rep"].pk).update(deleted_at=deals.ws.created_at)
    assert rep.get(f"/api/v1/sales/quotations/{deals.quotations['rep'].pk}").status_code == 404


def test_action_scope_narrower_than_view_is_403(deals):
    """A CEO sees every deal but holds no move or close code: 403 with the permission."""
    ceo = deals.client("ceo")
    opp = deals.opportunities["rep"]
    assert ceo.get(f"/api/v1/sales/opportunities/{opp.pk}").json()["canMove"] is False
    res = ceo.post(f"/api/v1/sales/opportunities/{opp.pk}/won", {}, format="json")
    assert (res.status_code, res.json()["details"]["permission"]) == (403, "sales.opportunity.close")
    rows = deals.client("manager").get(f"{BASE}/opportunities").json()["data"]
    assert {(r["canEdit"], r["canMove"], r["canClose"], r["canDelete"]) for r in rows} == {(True, True, True, False)}


# ───────────────────────── collab, search, audit, events ─────────────────────────


@pytest.mark.parametrize(
    ("kind", "attr"), [("lead", "leads"), ("opportunity", "opportunities"), ("quotation", "quotations")]
)
def test_comments_on_s2_targets_follow_the_scope(deals, kind, attr):
    obj = getattr(deals, attr)["rep"]
    url = f"/api/v1/targets/sales.{kind}/{obj.pk}/comments"
    assert deals.client("rep").post(url, {"body": DOC}, format="json").status_code == 201
    assert len(deals.client("manager").get(url).json()) == 1
    for actor in ("rep3", "member", "outsider"):
        assert deals.client(actor).get(url).status_code == 404, actor
    resolver = get_resolver(f"sales.{kind}")
    info = resolver.describe(obj.pk)
    assert info["link"].endswith(f"/platform/sales/{attr}/{obj.pk}")
    assert resolver.subscribers(obj.pk) == [deals.users["rep"].pk]
    assert resolver.describe("nope") == {}


def test_quotations_of_a_deleted_opportunity_are_not_targets(deals):
    quote = deals.quotations["rep"]
    Opportunity.objects.filter(pk=quote.opportunity_id).update(deleted_at=deals.ws.created_at)
    assert get_resolver("sales.quotation").workspace_of(quote.pk) is None


def search(world, actor, q, kind):
    res = world.client(actor).get(f"/api/v1/workspaces/platform/search?q={q}&filter[type]={kind}")
    assert res.status_code == 200, res.json()
    return res.json()


def test_search_finds_s2_records_in_scope(deals):
    assert {r["title"] for r in search(deals, "rep", "prospect", "lead")} == {"Rep Prospect"}
    assert {r["title"] for r in search(deals, "manager", "deal", "opportunity")} == {
        "Rep Deal",
        "Rep2 Deal",
        "Manager Deal",
    }
    hit = search(deals, "rep", "deal", "opportunity")[0]
    assert hit["opportunity"]["status"] == "open" and hit["opportunity"]["companyName"] == "Rep Trading PLC"
    quotes = search(deals, "ceo", "Q-2000", "quotation")
    assert len(quotes) == 5 and quotes[0]["targetType"] == "sales.quotation"
    assert search(deals, "member", "deal", "opportunity") == []
    res = deals.client("rep").get("/api/v1/search?q=deal&type=opportunity").json()["data"]
    assert {r["title"] for r in res} == {"Rep Deal"}
    lead = search(deals, "rep", "", "lead")[0]
    assert lead["lead"]["contactName"] == "Rep Person"


def test_audit_groups_and_event_types(deals):
    rep = deals.client("rep")
    rep.patch(f"/api/v1/sales/leads/{deals.leads['rep'].pk}", {"notes": "x"}, format="json")
    rep.post(f"/api/v1/sales/opportunities/{deals.opportunities['rep'].pk}/won", {}, format="json")
    owner = deals.client("owner")
    for group, action in (("lead", "sales.lead.updated"), ("opportunity", "sales.opportunity.won")):
        rows = owner.get(f"/api/v1/workspaces/platform/audit?filter[entity]={group}").json()["data"]
        assert action in [r["action"] for r in rows], group
    for key in (
        "sales.lead.created",
        "sales.lead.converted",
        "sales.opportunity.created",
        "sales.opportunity.moved",
        "sales.opportunity.won",
        "sales.opportunity.lost",
        "sales.opportunity.reassigned",
        "sales.quotation.sent",
    ):
        et = event_type(key)
        assert et is not None and et.module == "sales" and et.preference is False, key


def test_module_disabled_covers_s2_routes(deals):
    set_module_enabled(deals.users["owner"], deals.ws, "sales", False)
    rep = deals.client("rep")
    for url in (
        f"{BASE}/leads",
        f"{BASE}/opportunities",
        f"{BASE}/pipeline",
        f"{BASE}/quotations",
        f"/api/v1/sales/leads/{deals.leads['rep'].pk}",
        f"/api/v1/sales/opportunities/{deals.opportunities['rep'].pk}/timeline",
        f"/api/v1/sales/quotations/{deals.quotations['rep'].pk}",
    ):
        res = rep.get(url)
        assert (res.status_code, res.json()["code"]) == (403, "module_disabled"), url
    assert search(deals, "owner", "deal", "opportunity") == []
    set_module_enabled(deals.users["owner"], deals.ws, "sales", True)
    assert rep.get(f"{BASE}/pipeline").json()["count"] == 1
