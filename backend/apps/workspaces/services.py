"""Workspace writes: create/update/delete, membership, invitations, access requests."""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.access import services as access
from apps.access.catalogue import OWNER_PERMISSION, WORKSPACE
from apps.access.models import Role
from apps.accounts.models import User
from apps.accounts.services import EMAIL_RE, normalize_email, password_problem
from apps.audit.services import change, record
from apps.common.exceptions import ApiError, conflict, forbidden, invalid, not_found
from apps.common.tokens import hash_token, new_token, token_matches

from .models import Invitation, Workspace, WorkspaceAccessRequest, WorkspaceMember

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
def create_workspace(user: User, *, name: str, slug: str | None = None) -> Workspace:
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
    roles = access.seed_default_roles(ws)
    WorkspaceMember.objects.create(
        workspace=ws, user=user, role=roles["owner"], joined_at=timezone.now(), last_active_at=timezone.now()
    )
    access.invalidate(user)
    record(workspace=ws, actor=user, action="workspace.created", target=ws.name, entity_id=ws.pk)
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
    if fields:
        raise invalid(fields)
    if changes:
        ws.save()
        record(workspace=ws, actor=actor, action="workspace.updated", target=ws.name, entity_id=ws.pk, changes=changes)
    return ws


@transaction.atomic
def delete_workspace(actor: User, ws: Workspace, confirm: str) -> None:
    if confirm != ws.slug:
        raise invalid({"confirm": f"Type {ws.slug} to confirm"})
    ws.deleted_at = timezone.now()
    ws.deleted_by = actor
    ws.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    record(workspace=ws, actor=actor, action="workspace.deleted", target=ws.name, entity_id=ws.pk)


# ───────────────────────── members ─────────────────────────


def _role_codes(role: Role) -> set[str]:
    return access.role_permission_codes(role)


def _ensure_can_grant(actor: User, ws: Workspace, role: Role) -> None:
    """No privilege escalation: you can only hand out (or take away) permissions you hold."""
    mine = access.workspace_permissions(actor, ws)
    missing = _role_codes(role) - mine
    if missing:
        raise forbidden("You can’t assign a role with permissions you don’t have.", {"permission": sorted(missing)[0]})


def _owner_count(ws: Workspace, *, excluding_user: Any = None) -> int:
    qs = WorkspaceMember.objects.filter(
        workspace=ws, status="active", role__permissions__code=OWNER_PERMISSION
    ).distinct()
    if excluding_user is not None:
        qs = qs.exclude(user_id=excluding_user)
    return qs.count()


def _workspace_role(ws: Workspace, role_id: Any, field: str = "roleId") -> Role:
    role = Role.objects.filter(pk=role_id, workspace=ws, scope=WORKSPACE).first() if _is_uuid(role_id) else None
    if role is None:
        raise invalid({field: "Pick a workspace role"})
    return role


def _is_uuid(value: Any) -> bool:
    import uuid

    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def get_member(ws: Workspace, user_id: Any) -> WorkspaceMember:
    member = (
        WorkspaceMember.objects.select_related("user", "role").filter(workspace=ws, user_id=user_id).first()
        if _is_uuid(user_id)
        else None
    )
    if member is None:
        raise not_found("Member not found.")
    return member


@transaction.atomic
def change_member_role(actor: User, ws: Workspace, user_id: Any, role_id: Any) -> WorkspaceMember:
    member = get_member(ws, user_id)
    role = _workspace_role(ws, role_id)
    if role.pk == member.role_id:
        return member
    _ensure_can_grant(actor, ws, member.role)
    _ensure_can_grant(actor, ws, role)
    holds_owner = OWNER_PERMISSION in _role_codes(member.role)
    if (
        holds_owner
        and OWNER_PERMISSION not in _role_codes(role)
        and _owner_count(ws, excluding_user=member.user_id) == 0
    ):
        raise conflict("last_owner", "A workspace needs at least one owner. Make someone else an owner first.")
    before = member.role.name
    member.role = role
    member.save(update_fields=["role", "updated_at"])
    record(
        workspace=ws,
        actor=actor,
        action="member.role_changed",
        target=member.user.name,
        entity_id=member.user_id,
        changes=[change("Role", before, role.name)],
    )
    return member


@transaction.atomic
def remove_member(actor: User, ws: Workspace, user_id: Any) -> None:
    member = get_member(ws, user_id)
    if member.user_id == actor.pk:
        raise forbidden("You can’t remove yourself.")
    _ensure_can_grant(actor, ws, member.role)
    if OWNER_PERMISSION in _role_codes(member.role) and _owner_count(ws, excluding_user=member.user_id) == 0:
        raise conflict("last_owner", "A workspace needs at least one owner.")
    _remove_project_memberships(ws, member.user_id)
    WorkspaceAccessRequest.objects.filter(workspace=ws, user_id=member.user_id).delete()
    name = member.user.name
    member.delete()
    record(workspace=ws, actor=actor, action="member.removed", target=name, entity_id=user_id)


def _remove_project_memberships(ws: Workspace, user_id: Any) -> None:
    from apps.projects.models import AccessRequest, ProjectMember

    ProjectMember.objects.filter(project__workspace=ws, user_id=user_id).delete()
    AccessRequest.objects.filter(project__workspace=ws, user_id=user_id, status="pending").update(status="withdrawn")


def touch_last_active(user: User) -> None:
    WorkspaceMember.objects.filter(user=user, status="active").update(last_active_at=timezone.now())


# ───────────────────────── invitations ─────────────────────────


def _send_invitation(inv: Invitation, raw_token: str) -> None:
    from apps.notifications.emails import base_context, queue_email

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
            "role": inv.role.name,
            "workspace_name": inv.workspace.name,
        },
    )


@transaction.atomic
def create_invitations(actor: User, ws: Workspace, emails: Any, role_id: Any) -> list[Invitation]:
    if not isinstance(emails, list) or not emails:
        raise invalid({"emails": "Add at least one email"})
    role = _workspace_role(ws, role_id)
    cleaned = [normalize_email(e) for e in emails if isinstance(e, str)]
    bad = [e for e in cleaned if not EMAIL_RE.match(e)]
    if bad or len(cleaned) != len(emails):
        raise invalid({"emails": f"“{bad[0]}” isn’t an email" if len(bad) == 1 else "Some emails need fixing"})
    if len(cleaned) > MAX_INVITES_PER_REQUEST:
        raise invalid({"emails": f"Invite up to {MAX_INVITES_PER_REQUEST} people at a time"})
    _ensure_can_grant(actor, ws, role)
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
            workspace=ws, email=email, role=role, invited_by=actor, token_hash=digest, expires_at=expires
        )
        _send_invitation(inv, raw)
        record(
            workspace=ws,
            actor=actor,
            action="member.invited",
            target=email,
            entity_id=inv.pk,
            changes=[change("Email", None, email), change("Role", None, role.name)],
        )
        _emit_invitation_event(actor, inv)
        created.append(inv)
    return created


def _emit_invitation_event(actor: User, inv: Invitation) -> None:
    from apps.notifications.events import emit

    emit("invitation", workspace=inv.workspace, actor=actor, payload={"invitationId": str(inv.pk), "email": inv.email})


def get_invitation(ws: Workspace, invite_id: Any) -> Invitation:
    inv = (
        Invitation.objects.select_related("role", "invited_by", "workspace").filter(pk=invite_id, workspace=ws).first()
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
        record(workspace=ws, actor=actor, action="member.invite_revoked", target=inv.email, entity_id=inv.pk)


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
    record(workspace=ws, actor=actor, action="member.invite_resent", target=inv.email, entity_id=inv.pk)
    return inv


def invitation_by_token(raw: str) -> Invitation:
    inv = (
        Invitation.objects.select_related("workspace", "role", "invited_by")
        .filter(token_hash=hash_token(raw or ""), workspace__deleted_at__isnull=True)
        .first()
    )
    if inv is None or not token_matches(raw or "", inv.token_hash):
        raise not_found("This invite link isn’t valid.")
    return inv


@transaction.atomic
def accept_invitation(raw: str, *, request_user: Any, name: str, password: str) -> tuple[User, Workspace]:
    inv = invitation_by_token(raw)
    inv = Invitation.objects.select_for_update().select_related("workspace", "role").get(pk=inv.pk)
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
    member = WorkspaceMember.objects.filter(workspace=inv.workspace, user=user).first()
    if member is None:
        WorkspaceMember.objects.create(workspace=inv.workspace, user=user, role=inv.role, last_active_at=timezone.now())
    inv.status = "accepted"
    inv.accepted_by = user
    inv.accepted_at = timezone.now()
    inv.save(update_fields=["status", "accepted_by", "accepted_at", "updated_at"])
    record(workspace=inv.workspace, actor=user, action="member.joined", target=user.name, entity_id=user.pk)
    return user, inv.workspace


# ───────────────────────── workspace access requests (board 24) ─────────────────────────


@transaction.atomic
def request_workspace_access(user: User, ws: Workspace) -> WorkspaceAccessRequest:
    if access.can(user, "project.create", ws):
        raise conflict("conflict", "You can create projects yourself.")
    req, _ = WorkspaceAccessRequest.objects.get_or_create(workspace=ws, user=user)
    return req


def withdraw_workspace_access(user: User, ws: Workspace) -> None:
    WorkspaceAccessRequest.objects.filter(workspace=ws, user=user).delete()
