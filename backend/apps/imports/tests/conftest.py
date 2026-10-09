import pytest

from .fixtures import World


@pytest.fixture
def world(db):
    return World()


@pytest.fixture
def custom_member(world):
    """custom_member(*codes) → a project member whose custom role holds exactly `codes`."""
    from apps.access.models import Permission, Role, RolePermission
    from apps.common.testing import UserFactory, add_project_member

    def make(*codes: str, name: str = "Casey Custom"):
        role = Role.objects.create(workspace=world.ws, name=f"Custom {len(codes)} {name}", scope="project")
        for code in codes:
            RolePermission.objects.create(role=role, permission=Permission.objects.get(code=code))
        user = add_project_member(world.project, UserFactory(name=name))
        world.project.members.filter(user=user).update(role=role)
        return user

    return make
