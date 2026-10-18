"""Data scope on companies and contacts (docs/sales/api.md §3): own, team and all on lists, detail routes and
searches; users in several teams; users holding several roles (widest scope wins). Out-of-scope records are 404."""

import pytest

from core.access.services import my_data_scopes
from core.teams.models import TeamMember
from modules.sales.models import Contact

pytestmark = pytest.mark.django_db

BASE = "/api/v1/sales/workspaces/platform"
OWNED = ("rep", "rep2", "rep3", "manager", "sales_admin")


def company_owners(world, actor, query=""):
    """Owner keys of the companies `actor` lists."""
    by_name = {f"{a.title()} Trading PLC": a for a in OWNED}
    rows = world.client(actor).get(f"{BASE}/companies{query}").json()["data"]
    return {by_name[c["name"]] for c in rows}


def contact_owners(world, actor):
    by_name = {f"{a.title()} Contact": a for a in OWNED}
    rows = world.client(actor).get(f"{BASE}/contacts").json()["data"]
    return {by_name[c["name"]] for c in rows if c["name"] in by_name}


@pytest.mark.parametrize(
    ("actor", "expected"),
    [
        ("rep", {"rep"}),  # own
        ("rep2", {"rep2"}),
        ("manager", {"manager", "rep", "rep2"}),  # team North
        ("multi", {"rep2", "rep3"}),  # team South, via Sales Manager on top of Salesperson
        ("ceo", set(OWNED)),  # all
        ("sales_admin", set(OWNED)),
        ("owner", set(OWNED)),
        ("admin", set(OWNED)),
    ],
)
def test_lists_follow_the_data_scope(world, actor, expected):
    assert company_owners(world, actor) == expected
    assert contact_owners(world, actor) == expected


def test_multi_role_user_gets_the_widest_scope(world):
    scopes = my_data_scopes(world.users["multi"], world.ws)
    assert scopes["sales.company.view"] == "team"  # Salesperson (own) + Sales Manager (team)
    assert scopes["sales.company.edit"] == "team"
    res = world.client("multi").patch(
        f"/api/v1/sales/companies/{world.companies['rep3'].pk}", {"notes": "x"}, format="json"
    )
    assert res.status_code == 200


def test_a_user_in_two_teams_sees_both(world):
    TeamMember.objects.create(workspace=world.ws, team=world.teams["south"], user=world.users["manager"])
    world.users["manager"].__dict__.pop("_lx_access_cache", None)
    assert company_owners(world, "manager") == {"manager", "rep", "rep2", "rep3"}
    # rep2 sits in both teams: the South lead (multi) and the North manager both reach rep2's records.
    assert "rep2" in company_owners(world, "multi")


def test_a_deleted_team_no_longer_widens_the_scope(world):
    from django.utils import timezone

    world.teams["north"].deleted_at = timezone.now()
    world.teams["north"].save()
    assert company_owners(world, "manager") == {"manager"}


@pytest.mark.parametrize("method", ["get", "patch", "delete"])
def test_out_of_scope_records_are_404(world, method):
    """A salesperson can't tell another salesperson's company or contact from a missing one."""
    rep = world.client("rep")
    for url in (
        f"/api/v1/sales/companies/{world.companies['rep3'].pk}",
        f"/api/v1/sales/contacts/{world.contacts['rep3'].pk}",
        f"/api/v1/sales/companies/{world.companies['manager'].pk}",
    ):
        call = getattr(rep, method)
        res = call(url, {}, format="json") if method == "patch" else call(url)
        # DELETE: Salespeople hold no delete code, but the record is outside their view scope: 404 too (S7).
        assert res.status_code == 404, (url, res.json())
    manager = world.client("manager")
    assert manager.get(f"/api/v1/sales/companies/{world.companies['rep3'].pk}").status_code == 404
    assert manager.get(f"/api/v1/sales/companies/{world.companies['rep'].pk}").status_code == 200


def test_contact_scope_is_its_own_owner(world):
    """Contacts are scoped by their own owner, not by their company's."""
    theirs = Contact.objects.create(
        workspace=world.ws, company=world.companies["rep"], owner=world.users["rep3"], name="Rep3 on Rep's"
    )
    rep_names = {c["name"] for c in world.client("rep").get(f"{BASE}/contacts").json()["data"]}
    assert "Rep3 on Rep's" not in rep_names
    assert world.client("rep").get(f"/api/v1/sales/contacts/{theirs.pk}").status_code == 404
    assert world.client("rep3").get(f"/api/v1/sales/contacts/{theirs.pk}").status_code == 200


def test_can_edit_and_can_delete_flags(world):
    rows = {c["name"]: c for c in world.client("manager").get(f"{BASE}/companies").json()["data"]}
    assert {n: (c["canEdit"], c["canDelete"]) for n, c in rows.items()} == {
        "Manager Trading PLC": (True, False),
        "Rep Trading PLC": (True, False),
        "Rep2 Trading PLC": (True, False),
    }
    ceo = world.client("ceo").get(f"{BASE}/companies").json()["data"]
    assert {(c["canEdit"], c["canDelete"]) for c in ceo} == {(False, False)}
    admin = world.client("sales_admin").get(f"{BASE}/contacts").json()["data"]
    assert all(c["canEdit"] and c["canDelete"] for c in admin)


def test_empty_list_for_a_scope_with_no_records(world):
    newbie = world.users["rep"].__class__.objects.create(email="new@team.dev", name="Newbie")
    from core.common.testing import add_member, client_for

    add_member(world.ws, newbie, "sales_salesperson")
    assert client_for(newbie).get(f"{BASE}/companies").json() == {"data": [], "nextCursor": None}
