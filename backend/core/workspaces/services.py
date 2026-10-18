"""Workspace writes: create/update/delete, membership, invitations, access requests."""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from core.access import services as access
from core.access.catalogue import OWNER_PERMISSION, WORKSPACE, grantable_without_holding, role_precedence_key
from core.access.models import Role
from core.accounts.models import User
from core.accounts.services import EMAIL_RE, normalize_email, password_problem
from core.audit.services import change, record
from core.common.exceptions import ApiError, conflict, forbidden, invalid, not_found
from core.common.tokens import hash_token, new_token, token_matches
from core.modules.services import enable_initial_modules
from core.teams.services import drop_workspace_member as drop_team_memberships
from core.workspaces.hooks import member_removed

from .models import (
    Invitation,
    InvitationRole,
    Workspace,
    WorkspaceAccessRequest,
    WorkspaceMember,
    WorkspaceMemberRole,
)
from .timezone import is_valid_timezone

RESERVED_SLUGS = {
    "admin", "lightex", "api", "app", "login", "register", "onboarding", "dev", "invite", "invites",
    "forgot-password", "reset-password", "settings", "static", "health", "docs",
}  # fmt: skip
MAX_INVITES_PER_REQUEST = 20


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")[:32]


def slug_available(slug: str, *, exclude: Workspace | None = None) -> bool:
    if len(slug) < 2 or slug in RESERVED_SLUGS:
        return False
    qs = Workspace.all_objects.filter(slug=slug)
    if exclude is not None:
        qs = qs.exclude(pk=exclude.pk)
    return not qs.exists()


# ───────────────────────── workspaces ─────────────────────────


@transaction.atomic
def create_workspace(user: User, *, name: str, slug: str | None = None, modules: Any = None) -> Workspace:
    """`modules`: extra toggleable modules to enable (tracking is always enabled)."""
    name = (name or "").strip()
    clean = slugify(slug or name)
    fields: dict[str, str] = {}
    if len(name) < 2:
        fields["name"] = "Use at least 2 characters"
    if len(clean) < 2:
        fields["slug"] = "Use at least 2 characters"
    elif not slug_available(clean):
        fields["slug"] = f"lightex.app/{clean} is taken"
    if fields:
        raise invalid(fields)
    try:
        with transaction.atomic():
            ws = Workspace.objects.create(slug=clean, name=name[:40])
    except IntegrityError as exc:
        raise invalid({"slug": f"lightex.app/{clean} is taken"}) from exc
    enable_initial_modules(user, ws, modules)
    roles = access.seed_default_roles(ws)
    add_workspace_member(ws, user, [roles["owner"]], joined_at=timezone.now(), last_active_at=timezone.now())
    access.invalidate(user)
    record(workspace=ws, actor=user, action="core.workspace.created", target=ws.name, entity_id=ws.pk)
    return ws


@transaction.atomic
def update_workspace(actor: User, ws: Workspace, data: dict[str, Any]) -> Workspace:
    fields: dict[str, str] = {}
    changes = []
    if "name" in data:
        name = str(data.get("name") or "").strip()
        if len(name) < 2:
            fields["name"] = "Use at least 2 characters"
        elif name[:40] != ws.name:
            changes.append(change("Name", ws.name, name[:40]))
            ws.name = name[:40]
    if "slug" in data:
        clean = slugify(str(data.get("slug") or ""))
        if len(clean) < 2:
            fields["slug"] = "Use at least 2 characters"
        elif clean != ws.slug:
            if not slug_available(clean, exclude=ws):
                fields["slug"] = f"lightex.app/{clean} is taken"
            else:
                changes.append(change("URL", ws.slug, clean))
                ws.slug = clean
    if "timezone" in data:
        tz = data.get("timezone")
        if not is_valid_timezone(tz):
            fields["timezone"] = "Pick a valid time zone"
        elif tz != ws.timezone:
            changes.append(change("Time zone", ws.timezone, tz))
            ws.timezone = tz
    policy = data.get("notificationPolicy")
    if policy is not None:  # board 38 §4.2 (the view already requires workspace.update)
        sms = policy.get("sms") if isinstance(policy, dict) else None
        if "sms" in (policy if isinstance(policy, dict) else {}) and not isinstance(sms, bool):
            fields["notificationPolicy.sms"] = "Send true or false"
        elif isinstance(sms, bool) and sms != ws.sms_enabled:
            changes.append(change("smsNotifications", ws.sms_enabled, sms))
            ws.sms_enabled = sms
    if fields:
        raise invalid(fields)
    if changes:
        ws.save()
        record(
            workspace=ws, actor=actor, action="core.workspace.updated", target=ws.name, entity_id=ws.pk, changes=changes
        )
    return ws


@transaction.atomic
def delete_workspace(actor: User, ws: Workspace, confirm: str) -> None:
    if confirm != ws.slug:
        raise invalid({"confirm": f"Type {ws.slug} to confirm"})
    ws.deleted_at = timezone.now()
    ws.deleted_by = actor
    ws.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    record(workspace=ws, actor=actor, action="core.workspace.deleted", target=ws.name, entity_id=ws.pk)


# ───────────────────────── members ─────────────────────────


def add_workspace_member(ws: Workspace, user: User, roles: list[Role], **fields: Any) -> WorkspaceMember:
    """Creates the membership with its roles (sales S0: one or more workspace roles)."""
    member = WorkspaceMember.objects.create(workspace=ws, user=user, **fields)
    set_member_roles(member, roles)
    return member


def set_member_roles(member: WorkspaceMember, roles: list[Role]) -> None:
    """Replaces the member's roles (no checks: the callers validate)."""
    links = WorkspaceMemberRole.objects.for_workspace(member.workspace_id).filter(member=member)
    keep = {r.pk for r in roles}
    links.exclude(role_id__in=keep).delete()
    have = set(links.values_list("role_id", flat=True))
    WorkspaceMemberRole.objects.bulk_create(
        [
            WorkspaceMemberRole(workspace_id=member.workspace_id, member=member, role=r)
            for r in roles
            if r.pk not in have
        ]
    )
    getattr(member, "_prefetched_objects_cache", {}).pop("role_links", None)


def _codes_of(roles: list[Role]) -> set[str]:
    codes: set[str] = set()
    for r in roles:
        codes |= access.role_permission_codes(r)
    return codes


def _ensure_can_grant(actor: User, ws: Workspace, roles: list[Role]) -> None:
    """No privilege escalation: you can only hand out (or take away) permissions you hold, with data scopes no wider
    than yours."""
    mine = access.workspace_permissions(actor, ws)
    missing = grantable_without_holding(_codes_of(roles) - mine)
    if missing:
        raise forbidden("You can’t assign a role with permissions you don’t have.", {"permission": sorted(missing)[0]})
    from core.access.roles import ensure_scopes_within_own

    ensure_scopes_within_own(actor, ws, roles)


def _owner_count(ws: Workspace, *, excluding_user: Any = None) -> int:
    qs = WorkspaceMember.objects.for_workspace(ws).filter(status="active", roles__permissions__code=OWNER_PERMISSION)
    if excluding_user is not None:
        qs = qs.exclude(user_id=excluding_user)
    return qs.values("user_id").distinct().count()


def _workspace_role(ws: Workspace, role_id: Any, field: str = "roleId") -> Role:
    role = Role.objects.filter(pk=role_id, workspace=ws, scope=WORKSPACE).first() if _is_uuid(role_id) else None
    if role is None:
        raise invalid({field: "Pick a workspace role"})
    return role


def workspace_roles_from(ws: Workspace, data: dict[str, Any]) -> list[Role]:
    """The roles a request names: `roleIds` (a non-empty list), else the old single `roleId`. In precedence order,
    duplicates dropped. 422 for an empty list or an id that isn't a workspace role of `ws`."""
    if "roleIds" in data:
        raw = data.get("roleIds")
        if not isinstance(raw, list) or not raw:
            raise invalid({"roleIds": "Pick at least one role"})
        ids = list(dict.fromkeys(str(r) for r in raw))
        if not all(_is_uuid(i) for i in ids):
            raise invalid({"roleIds": "Pick workspace roles"})
        roles = list(Role.objects.filter(pk__in=ids, workspace=ws, scope=WORKSPACE))
        if len(roles) != len(ids):
            raise invalid({"roleIds": "Pick workspace roles"})
        return sorted(roles, key=role_precedence_key)
    if data.get("roleId") in (None, ""):
        raise invalid({"roleIds": "Pick at least one role"})
    return [_workspace_role(ws, data.get("roleId"))]


def _is_uuid(value: Any) -> bool:
    import uuid

    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def get_member(ws: Workspace, user_id: Any) -> WorkspaceMember:
    member = (
        WorkspaceMember.objects.for_workspace(ws).select_related("user").filter(user_id=user_id).first()
        if _is_uuid(user_id)
        else None
    )
    if member is None:
        raise not_found("Member not found.")
    return member


def _names(roles: list[Role]) -> str:
    return ", ".join(r.name for r in roles)


@transaction.atomic
def change_member_roles(actor: User, ws: Workspace, user_id: Any, data: dict[str, Any]) -> WorkspaceMember:
    """Replaces the member's workspace roles with the request's `roleIds` (or the old single `roleId`)."""
    member = get_member(ws, user_id)
    roles = workspace_roles_from(ws, data)
    current = member.role_list()
    before, after = {r.pk for r in current}, {r.pk for r in roles}
    if before == after:
        return member
    _ensure_can_grant(actor, ws, [r for r in roles if r.pk not in before] + [r for r in current if r.pk not in after])
    if (
        OWNER_PERMISSION in _codes_of(current)
        and OWNER_PERMISSION not in _codes_of(roles)
        and _owner_count(ws, excluding_user=member.user_id) == 0
    ):
        raise conflict("last_owner", "A workspace needs at least one owner. Make someone else an owner first.")
    set_member_roles(member, roles)
    member.save(update_fields=["updated_at"])
    access.invalidate(member.user)
    record(
        workspace=ws,
        actor=actor,
        action="core.member.role_changed",
        target=member.user.name,
        entity_id=member.user_id,
        changes=[change("Roles", _names(current), _names(roles))],
    )
    return member


@transaction.atomic
def remove_member(actor: User, ws: Workspace, user_id: Any) -> None:
    member = get_member(ws, user_id)
    if member.user_id == actor.pk:
        raise forbidden("You can’t remove yourself.")
    roles = member.role_list()
    _ensure_can_grant(actor, ws, roles)
    if OWNER_PERMISSION in _codes_of(roles) and _owner_count(ws, excluding_user=member.user_id) == 0:
        raise conflict("last_owner", "A workspace needs at least one owner.")
    member_removed(ws, member.user_id)  # modules drop what the member had in this workspace
    drop_team_memberships(ws, member.user_id)
    WorkspaceAccessRequest.objects.filter(workspace=ws, user_id=member.user_id).delete()
    name = member.user.name
    member.delete()
    record(workspace=ws, actor=actor, action="core.member.removed", target=name, entity_id=user_id)


def touch_last_active(user: User) -> None:
    WorkspaceMember.objects.filter(user=user, status="active").update(last_active_at=timezone.now())


# ───────────────────────── invitations ─────────────────────────


def _send_invitation(inv: Invitation, raw_token: str) -> None:
    from core.notifications.emails import base_context, queue_email

    inviter = inv.invited_by
    queue_email(
        inv.email,
        "invitation",
        {
            **base_context(),
            "cta_url": f"{settings.FRONTEND_URL}/invite/{raw_token}",
            "invite_expires": f"{inv.expires_at:%b} {inv.expires_at.day}, {inv.expires_at.year}",
            "inviter_email": inviter.email if inviter else "",
            "inviter_name": inviter.name if inviter else "A teammate",
            "recipient_email": inv.email,
            "role": _names(inv.role_list()),
            "workspace_name": inv.workspace.name,
        },
    )


@transaction.atomic
def create_invitations(actor: User, ws: Workspace, emails: Any, data: dict[str, Any]) -> list[Invitation]:
    """`data` names the roles: `roleIds` (one or more) or the old single `roleId`."""
    if not isinstance(emails, list) or not emails:
        raise invalid({"emails": "Add at least one email"})
    roles = workspace_roles_from(ws, data)
    cleaned = [normalize_email(e) for e in emails if isinstance(e, str)]
    bad = [e for e in cleaned if not EMAIL_RE.match(e)]
    if bad or len(cleaned) != len(emails):
        raise invalid({"emails": f"“{bad[0]}” isn’t an email" if len(bad) == 1 else "Some emails need fixing"})
    if len(cleaned) > MAX_INVITES_PER_REQUEST:
        raise invalid({"emails": f"Invite up to {MAX_INVITES_PER_REQUEST} people at a time"})
    _ensure_can_grant(actor, ws, roles)
    created: list[Invitation] = []
    expires = timezone.now() + dt.timedelta(days=settings.INVITATION_TTL_DAYS)
    for email in dict.fromkeys(cleaned):
        if WorkspaceMember.objects.filter(workspace=ws, user__email__iexact=email).exists():
            continue
        if Invitation.objects.filter(
            workspace=ws, email=email, status="pending", expires_at__gt=timezone.now()
        ).exists():
            continue
        # An expired pending invite is closed so the new one can take its place.
        Invitation.objects.filter(workspace=ws, email=email, status="pending").update(status="revoked")
        raw, digest = new_token()
        inv = Invitation.objects.create(
            workspace=ws, email=email, invited_by=actor, token_hash=digest, expires_at=expires
        )
        InvitationRole.objects.bulk_create([InvitationRole(workspace=ws, invitation=inv, role=r) for r in roles])
        _send_invitation(inv, raw)
        record(
            workspace=ws,
            actor=actor,
            action="core.member.invited",
            target=email,
            entity_id=inv.pk,
            changes=[change("Email", None, email), change("Roles", None, _names(roles))],
        )
        _emit_invitation_event(actor, inv)
        created.append(inv)
    return created


def _emit_invitation_event(actor: User, inv: Invitation) -> None:
    from core.events.services import emit

    emit(
        "core.member.invited",
        workspace=inv.workspace,
        actor=actor,
        payload={"invitationId": str(inv.pk), "email": inv.email},
    )


def get_invitation(ws: Workspace, invite_id: Any) -> Invitation:
    inv = (
        Invitation.objects.select_related("invited_by", "workspace").filter(pk=invite_id, workspace=ws).first()
        if _is_uuid(invite_id)
        else None
    )
    if inv is None:
        raise not_found("Invite not found.")
    return inv


@transaction.atomic
def revoke_invitation(actor: User, ws: Workspace, invite_id: Any) -> None:
    inv = get_invitation(ws, invite_id)
    if inv.status == "pending":
        inv.status = "revoked"
        inv.save(update_fields=["status", "updated_at"])
        record(workspace=ws, actor=actor, action="core.member.invite_revoked", target=inv.email, entity_id=inv.pk)


@transaction.atomic
def resend_invitation(actor: User, ws: Workspace, invite_id: Any) -> Invitation:
    inv = get_invitation(ws, invite_id)
    if inv.status != "pending":
        raise conflict("invite_unavailable", "Only pending invites can be resent.")
    raw, digest = new_token()  # a new link; the old one stops working
    inv.token_hash = digest
    inv.expires_at = timezone.now() + dt.timedelta(days=settings.INVITATION_TTL_DAYS)
    inv.save(update_fields=["token_hash", "expires_at", "updated_at"])
    _send_invitation(inv, raw)
    record(workspace=ws, actor=actor, action="core.member.invite_resent", target=inv.email, entity_id=inv.pk)
    return inv


def invitation_by_token(raw: str) -> Invitation:
    inv = (
        Invitation.objects.unscoped()  # the token decides the workspace
        .select_related("workspace", "invited_by")
        .filter(token_hash=hash_token(raw or ""), workspace__deleted_at__isnull=True)
        .first()
    )
    if inv is None or not token_matches(raw or "", inv.token_hash):
        raise not_found("This invite link isn’t valid.")
    return inv


@transaction.atomic
def accept_invitation(raw: str, *, request_user: Any, name: str, password: str) -> tuple[User, Workspace]:
    inv = invitation_by_token(raw)
    inv = Invitation.objects.unscoped().select_for_update().select_related("workspace").get(pk=inv.pk)
    if inv.effective_status != "pending":
        raise ApiError(410, "invite_unavailable", "This invite has expired or was revoked.")
    user = User.objects.filter(email__iexact=inv.email).first()
    signed_in = getattr(request_user, "is_authenticated", False)
    if signed_in and normalize_email(request_user.email) != inv.email:
        raise forbidden("This invite was sent to a different email address.", {"code": "invite_email_mismatch"})
    if user is None:
        fields: dict[str, str] = {}
        name = (name or "").strip()
        if len(name) < 2:
            fields["name"] = "Enter your name"
        problem = password_problem(password or "", User(email=inv.email, name=name))
        if problem:
            fields["password"] = problem
        if fields:
            raise invalid(fields)
        user = User.objects.create_user(email=inv.email, password=password, name=name[:60])
    elif not (signed_in and request_user.pk == user.pk):
        # Existing account: prove it with the account's password (no login by link alone).
        if not user.check_password(password or "") or not user.is_active:
            raise invalid({"password": "An account with this email already exists. Enter its password to join."})
    member = WorkspaceMember.objects.for_workspace(inv.workspace).filter(user=user).first()
    if member is None:
        roles = [r for r in inv.role_list() if r.scope == WORKSPACE]
        if not roles:  # every role on the invite was deleted since: join as a plain member
            roles = [Role.objects.get(workspace=inv.workspace, system_key="member")]
        add_workspace_member(inv.workspace, user, roles, last_active_at=timezone.now())
    inv.status = "accepted"
    inv.accepted_by = user
    inv.accepted_at = timezone.now()
    inv.save(update_fields=["status", "accepted_by", "accepted_at", "updated_at"])
    record(workspace=inv.workspace, actor=user, action="core.member.joined", target=user.name, entity_id=user.pk)
    return user, inv.workspace


# ───────────────────────── workspace access requests (board 24) ─────────────────────────


@transaction.atomic
def request_workspace_access(user: User, ws: Workspace) -> WorkspaceAccessRequest:
    if access.can(user, "tracking.project.create", ws):
        raise conflict("conflict", "You can create projects yourself.")
    req, created = WorkspaceAccessRequest.objects.get_or_create(workspace=ws, user=user)
    if created:
        from core.events.services import emit

        emit("core.workspace.access_requested", workspace=ws, actor=user, payload={"requestId": str(req.pk)})
    return req


def withdraw_workspace_access(user: User, ws: Workspace) -> None:
    WorkspaceAccessRequest.objects.filter(workspace=ws, user=user).delete()
