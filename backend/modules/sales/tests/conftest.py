"""Sales test world: one workspace with sales on, one user per built-in and sales role, two teams, and companies and
contacts owned by each salesperson. An outsider owns a second workspace with sales on.

Teams: North = {manager (lead), rep, rep2}; South = {rep3, multi}. `multi` holds Member + Salesperson + Sales Manager
(widest scope wins: team). `rep2` is also in South (two teams).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from core.common.testing import UserFactory, add_member, client_for, make_workspace

#: Actors of the permission matrix: built-in roles, sales roles, an outsider and anonymous.
ACTORS = ("owner", "admin", "member", "sales_admin", "ceo", "manager", "rep", "outsider", "anon")
ROLE_KEYS = {
    "admin": "admin",
    "member": "member",
    "sales_admin": "sales_admin",
    "ceo": "sales_ceo",
    "manager": "sales_manager",
    "rep": "sales_salesperson",
    "rep2": "sales_salesperson",
    "rep3": "sales_salesperson",
}


@dataclass
class SalesWorld:
    ws: Any
    other_ws: Any
    users: dict[str, Any]
    teams: dict[str, Any] = field(default_factory=dict)
    companies: dict[str, Any] = field(default_factory=dict)
    contacts: dict[str, Any] = field(default_factory=dict)
    leads: dict[str, Any] = field(default_factory=dict)
    opportunities: dict[str, Any] = field(default_factory=dict)
    quotations: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)

    def client(self, actor: str):
        return client_for(None if actor == "anon" else self.users[actor])


def build_sales_world() -> SalesWorld:
    from core.teams.models import Team, TeamMember
    from modules.sales.models import Company, Contact
    from modules.sales.normalize import normalize_name, normalize_phone

    owner = UserFactory(name="Olivia Owner")
    ws = make_workspace(owner, name="Sales team", slug="platform", modules=["sales"])
    users: dict[str, Any] = {"owner": owner}
    for actor, key in ROLE_KEYS.items():
        users[actor] = add_member(ws, UserFactory(name=actor.replace("_", " ").title()), key)
    users["multi"] = add_member(ws, UserFactory(name="Multi Role"), ["member", "sales_salesperson", "sales_manager"])
    outsider = UserFactory(name="Outsider")
    other_ws = make_workspace(outsider, name="Elsewhere", slug="elsewhere", modules=["sales"])
    users["outsider"] = outsider

    north = Team.objects.create(workspace=ws, name="North")
    south = Team.objects.create(workspace=ws, name="South")
    for team, actor, lead in (
        (north, "manager", True),
        (north, "rep", False),
        (north, "rep2", False),
        (south, "rep2", False),
        (south, "rep3", False),
        (south, "multi", True),
    ):
        TeamMember.objects.create(workspace=ws, team=team, user=users[actor], is_lead=lead)

    world = SalesWorld(ws=ws, other_ws=other_ws, users=users, teams={"north": north, "south": south})
    for i, actor in enumerate(("rep", "rep2", "rep3", "manager", "sales_admin")):
        name, phone = f"{actor.title()} Trading PLC", f"+251 91{i} 00 00 0{i}"
        world.companies[actor] = Company.objects.create(
            workspace=ws,
            owner=users[actor],
            name=name,
            normalized_name=normalize_name(name),
            phone=phone,
            normalized_phone=normalize_phone(phone),
            city="Addis Ababa",
        )
        world.contacts[actor] = Contact.objects.create(
            workspace=ws, company=world.companies[actor], owner=users[actor], name=f"{actor.title()} Contact"
        )
    world.companies["other"] = Company.objects.create(workspace=other_ws, owner=outsider, name="Theirs Ltd")
    world.contacts["other"] = Contact.objects.create(
        workspace=other_ws, company=world.companies["other"], owner=outsider, name="Their Contact"
    )
    return world


#: The owners of the world's companies, contacts and (with `add_deals`) leads, opportunities and quotations.
OWNED = ("rep", "rep2", "rep3", "manager", "sales_admin")


def add_deals(world: SalesWorld) -> SalesWorld:
    """Per owner in OWNED: a new lead, an open opportunity on their company in the first open stage (expected value
    1000, 2000, ... by position) and a draft quotation on it."""
    from decimal import Decimal

    from modules.sales.models import Lead, Opportunity, Quotation
    from modules.sales.selectors import first_open_stage

    stage = first_open_stage(world.ws)
    for i, actor in enumerate(OWNED):
        owner = world.users[actor]
        world.leads[actor] = Lead.objects.create(
            workspace=world.ws,
            owner=owner,
            company_name_text=f"{actor.title()} Prospect",
            contact_name=f"{actor.title()} Person",
            phone=f"+251 92{i} 11 11 1{i}",
        )
        world.opportunities[actor] = Opportunity.objects.create(
            workspace=world.ws,
            owner=owner,
            company=world.companies[actor],
            title=f"{actor.title()} Deal",
            stage=stage,
            expected_value=Decimal(f"{(i + 1) * 1000}.00"),
        )
        world.quotations[actor] = Quotation.objects.create(
            workspace=world.ws,
            owner=owner,
            opportunity=world.opportunities[actor],
            number=f"Q-2000-{i + 1:04d}",
            title=f"{actor.title()} Quote",
            amount=Decimal("500.00"),
        )
    return world


@pytest.fixture
def world(db) -> SalesWorld:
    return build_sales_world()


@pytest.fixture
def deals(db) -> SalesWorld:
    return add_deals(build_sales_world())
