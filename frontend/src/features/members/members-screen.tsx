"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Filter, MoreHorizontal, Plus, Search, TriangleAlert, UserPlus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
import { ConfirmDialog } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { SettingsPage } from "@/features/settings/settings-shell";
import { useRoles, useWsMembers } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Invite, Role, WorkspaceMember } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { useCan, useCurrentWorkspace } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";
import { InviteDialog } from "./invite-dialog";
import { assignableRoles, defaultRole, filterMembers, isOwnerRole, lastActiveLabel, monthDay, rolesFor } from "./lib";
import { InviteAvatar, RolePicker, RoleRadioItems, StateBox, StatusPill, Tag } from "./parts";

const ROW =
  "grid items-center gap-x-3 border-b border-line pl-3.5 pr-2.5 last:border-b-0 " +
  "grid-cols-[minmax(0,1fr)_124px_84px_32px] @min-[720px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_150px_92px_92px_32px]";

/** Members (board 18 A.4), workspace scope. Managers edit; everyone else gets a read-only list. */
export function MembersScreen() {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const qc = useQueryClient();
  const canManage = useCan("workspace.manage_members");
  const mobile = useIsMobile();
  const members = useWsMembers(ws.slug);
  const roles = useRoles(ws.slug);
  const invites = useQuery({
    queryKey: qk.invites(ws.slug),
    queryFn: () => api.workspaces.invites(ws.slug),
    enabled: canManage,
  });

  const [q, setQ] = useState("");
  // Deep link from the role editor: /settings/members?role=<id>
  const params = useSearchParams();
  const [roleFilter, setRoleFilter] = useState<string | null>(() => params.get("role"));
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  /** Invite actions in flight, by invite id: blocks a second click (two resend emails) and shows a spinner. */
  const [busyInvites, setBusyInvites] = useState<Record<string, "resend" | "revoke">>({});
  const setBusy = (id: string, kind: "resend" | "revoke" | null) =>
    setBusyInvites((b) => {
      const next = { ...b };
      if (kind) next[id] = kind;
      else delete next[id];
      return next;
    });

  const wsRoles = useMemo(() => rolesFor(roles.data ?? [], "workspace"), [roles.data]);
  const pickable = useMemo(() => assignableRoles(roles.data ?? [], "workspace"), [roles.data]);
  const roleName = (id: string) => wsRoles.find((r) => r.id === id)?.name ?? "—";
  const isOwnerId = (id: string) => {
    const r = wsRoles.find((x) => x.id === id);
    return r ? isOwnerRole(r) : false;
  };

  const all = members.data ?? [];
  const pending = canManage ? (invites.data ?? []) : [];
  const shown = filterMembers(all, q, roleFilter);
  const needle = q.trim().toLowerCase();
  const shownInvites = pending.filter((i) => (!roleFilter || i.roleId === roleFilter) && (!needle || i.email.includes(needle)));
  const filtering = Boolean(needle || roleFilter);
  const counts = (id: string) => all.filter((m) => m.roleId === id).length + pending.filter((i) => i.roleId === id).length;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.wsMembers(ws.slug) }),
      qc.invalidateQueries({ queryKey: qk.roles(ws.slug) }),
    ]);

  // Optimistic: the picker shows the new role at once and rolls back if the server refuses.
  const changeRole = async (m: WorkspaceMember, roleId: string, undo = false) => {
    const prev = m.roleId;
    if (roleId === prev) return;
    const key = qk.wsMembers(ws.slug);
    await qc.cancelQueries({ queryKey: key });
    const snapshot = qc.getQueryData<WorkspaceMember[]>(key);
    qc.setQueryData<WorkspaceMember[]>(key, (list) => list?.map((x) => (x.userId === m.userId ? { ...x, roleId } : x)));
    try {
      await api.workspaces.updateMember(ws.slug, m.userId, roleId);
      await refresh();
      if (undo) return;
      toast.success(`${m.user.name} is now ${roleName(roleId)}`, {
        action: { label: "Undo", key: "Z", onClick: () => void changeRole({ ...m, roleId }, prev, true) },
      });
    } catch (e) {
      if (snapshot) qc.setQueryData(key, snapshot);
      void refresh();
      toast.error("Couldn’t change role", { body: errorMessage(e) });
    }
  };

  const remove = async (m: WorkspaceMember) => {
    try {
      await api.workspaces.removeMember(ws.slug, m.userId);
      await refresh();
      toast.success(`Removed ${m.user.name}`);
    } catch (e) {
      toast.error("Couldn’t remove member", { body: errorMessage(e) });
    }
  };

  const resend = async (inv: Invite) => {
    if (busyInvites[inv.id]) return;
    setBusy(inv.id, "resend");
    try {
      await api.workspaces.resendInvite(ws.slug, inv.id);
      setSent((s) => ({ ...s, [inv.id]: true }));
      setTimeout(() => setSent((s) => ({ ...s, [inv.id]: false })), 2200);
    } catch (e) {
      toast.error("Couldn’t resend invite", { body: errorMessage(e) });
    } finally {
      setBusy(inv.id, null);
    }
  };

  const revoke = async (inv: Invite) => {
    if (busyInvites[inv.id]) return;
    setBusy(inv.id, "revoke");
    try {
      await api.workspaces.revokeInvite(ws.slug, inv.id);
      await qc.invalidateQueries({ queryKey: qk.invites(ws.slug) });
      toast.success(`Invite to ${inv.email} revoked`, {
        action: {
          label: "Undo",
          key: "Z",
          onClick: async () => {
            try {
              await api.workspaces.invite(ws.slug, [inv.email], inv.roleId);
              await qc.invalidateQueries({ queryKey: qk.invites(ws.slug) });
            } catch (e) {
              toast.error("Couldn’t restore invite", { body: errorMessage(e) });
            }
          },
        },
      });
    } catch (e) {
      toast.error("Couldn’t revoke invite", { body: errorMessage(e) });
    } finally {
      setBusy(inv.id, null);
    }
  };

  const loading = members.isPending || roles.isPending || (canManage && invites.isPending);
  const error = members.error ?? roles.error;

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        value={q}
        maxLength={80}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search members"
        aria-label="Search members"
        leading={<Search size={14} aria-hidden />}
        className="w-[240px] max-[760px]:w-full"
      />
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={`Filter by role: ${roleFilter ? roleName(roleFilter) : "All roles"}`}
            className="inline-flex h-8 items-center gap-[7px] rounded-md border border-line-2 bg-surface px-2.5 text-[12.5px] font-medium transition-colors hover:border-control hover:bg-hover data-[state=open]:border-control data-[state=open]:bg-hover max-[1023px]:h-11"
          >
            <Filter size={13} className="text-fg-3" aria-hidden />
            {roleFilter ? roleName(roleFilter) : "All roles"}
          </button>
        </MenuTrigger>
        <MenuContent align="start" width={220}>
          <MenuRadioGroup value={roleFilter ?? ""} onValueChange={(v) => setRoleFilter(v || null)}>
            <MenuRadioItem value="" meta={all.length + pending.length}>
              All roles
            </MenuRadioItem>
            {wsRoles.map((r) => (
              <MenuRadioItem key={r.id} value={r.id} meta={counts(r.id)}>
                {r.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <span className="flex-1" />
      {canManage ? (
        <Button variant="primary" onClick={() => setInviteOpen(true)} className="max-[1023px]:h-11">
          <Plus size={12} strokeWidth={1.8} aria-hidden />
          Invite
        </Button>
      ) : (
        <Tag>Read-only</Tag>
      )}
    </div>
  );

  let content;
  if (error) {
    content = (
      <StateBox
        role="alert"
        tone="danger"
        icon={<TriangleAlert size={18} aria-hidden />}
        title="Couldn’t load members"
        meta={
          <span className="font-mono">
            {isApiError(error) ? `${error.status} · ` : ""}retrying won’t lose changes
          </span>
        }
      >
        <Button
          variant="secondary"
          className="mt-1.5"
          loading={members.isFetching || roles.isFetching}
          onClick={() => {
            void members.refetch();
            void roles.refetch();
          }}
        >
          Retry
        </Button>
      </StateBox>
    );
  } else if (loading) {
    content = <MembersSkeleton />;
  } else {
    const rows = (
      <>
        {shown.map((m) => {
          const isMe = m.userId === me.id;
          const editable = canManage && !isMe && !isOwnerId(m.roleId);
          return (
            <MemberRow
              key={m.userId}
              member={m}
              isMe={isMe}
              roleName={roleName(m.roleId)}
              editable={editable}
              roles={pickable}
              mobile={mobile}
              onChangeRole={(rid) => void changeRole(m, rid)}
              onRemove={() => setRemoving(m)}
            />
          );
        })}
        {shownInvites.map((inv) => (
          <InviteRow
            key={inv.id}
            invite={inv}
            mobile={mobile}
            busy={busyInvites[inv.id] ?? null}
            onResend={() => void resend(inv)}
            onRevoke={() => void revoke(inv)}
          />
        ))}
      </>
    );
    const empty = shown.length + shownInvites.length === 0;
    content = (
      <>
        {!empty &&
          (mobile ? (
            <div className="flex flex-col gap-2" role="list" aria-label="Members">
              {rows}
            </div>
          ) : (
            <div className="@container">
              <div role="table" aria-label="Members" className="rounded-[10px] border border-line bg-surface">
                <div role="rowgroup">
                  <div
                    role="row"
                    className={cn(ROW, "min-h-[34px] font-mono text-[11px] font-medium uppercase tracking-[0.05em] text-fg-3")}
                  >
                    <span role="columnheader">Name</span>
                    <span role="columnheader" className="hidden @min-[720px]:block">
                      Email
                    </span>
                    <span role="columnheader">Role</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader" className="hidden @min-[720px]:block">
                      Last active
                    </span>
                    <span role="columnheader">
                      <span className="sr-only">Actions</span>
                    </span>
                  </div>
                </div>
                <div role="rowgroup">{rows}</div>
              </div>
            </div>
          ))}
        {empty && filtering && (
          <StateBox small title="No members match">
            <Button
              variant="secondary"
              onClick={() => {
                setQ("");
                setRoleFilter(null);
              }}
            >
              Clear filters
            </Button>
          </StateBox>
        )}
        {!filtering && all.length <= 1 && pending.length === 0 && (
          <StateBox icon={<UserPlus size={18} strokeWidth={1.6} aria-hidden />} title="Just you so far" meta={`Invite teammates to ${ws.name}`}>
            {canManage && (
              <Button variant="primary" className="mt-1.5" onClick={() => setInviteOpen(true)}>
                Invite teammates
              </Button>
            )}
          </StateBox>
        )}

        {canManage && pending.length > 0 && (
          <section aria-labelledby="pending-h" className="mt-2.5 flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <h2 id="pending-h" className="m-0 text-[14px] font-semibold">
                Pending invitations
              </h2>
              <span className="font-mono text-[11px] text-fg-3">{pending.length}</span>
            </div>
            <ul className="m-0 list-none rounded-[10px] border border-line bg-surface p-0">
              {pending.map((inv) => (
                <li
                  key={inv.id}
                  className="flex min-h-12 items-center gap-3 border-b border-line pl-3.5 pr-2.5 last:border-b-0 max-[760px]:flex-wrap max-[760px]:gap-y-1 max-[760px]:px-3 max-[760px]:py-2.5"
                >
                  <InviteAvatar email={inv.email} />
                  <span className="min-w-0 flex-1 truncate max-[760px]:basis-[calc(100%-44px)]">{inv.email}</span>
                  <span className="text-fg-2">{roleName(inv.roleId) === "—" ? inv.roleName : roleName(inv.roleId)}</span>
                  <span className="w-[76px] font-mono text-[12px] text-fg-3">{monthDay(inv.createdAt)}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {sent[inv.id] ? (
                      <span role="status" className="inline-flex h-[30px] animate-[fade-in_160ms_var(--ease)] items-center gap-1 px-[11px] text-[12px] font-medium text-ok">
                        <Check size={12} aria-hidden /> Sent
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        loading={busyInvites[inv.id] === "resend"}
                        onClick={() => void resend(inv)}
                        aria-label={`Resend invite to ${inv.email}`}
                      >
                        Resend
                      </Button>
                    )}
                    <Button
                      variant="danger-ghost"
                      loading={busyInvites[inv.id] === "revoke"}
                      onClick={() => void revoke(inv)}
                      aria-label={`Revoke invite to ${inv.email}`}
                    >
                      Revoke
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }

  return (
    <SettingsPage
      wide
      title={
        <>
          Members
          {members.data && (
            <span className="ml-2 align-middle font-mono text-[12px] font-medium text-fg-3">{all.length + pending.length}</span>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!error && !loading && toolbar}
        {content}
      </div>
      {canManage && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          slug={ws.slug}
          workspaceName={ws.name}
          roles={pickable}
          defaultRoleId={defaultRole(roles.data ?? [], "workspace")?.id}
          knownEmails={[...all.map((m) => m.user.email), ...pending.map((i) => i.email)]}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? `Remove ${removing.user.name}?` : ""}
        description={`They lose access to ${ws.name} and every project in it. Their tasks and comments stay.`}
        confirmLabel="Remove from workspace"
        confirmVariant="danger"
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </SettingsPage>
  );
}

function MemberRow({
  member: m,
  isMe,
  roleName,
  editable,
  roles,
  mobile,
  onChangeRole,
  onRemove,
}: {
  member: WorkspaceMember;
  isMe: boolean;
  roleName: string;
  editable: boolean;
  roles: Role[];
  mobile: boolean;
  onChangeRole: (roleId: string) => void;
  onRemove: () => void;
}) {
  const role = editable ? (
    <RolePicker roles={roles} value={m.roleId} onChange={onChangeRole} label={`Role for ${m.user.name}`} />
  ) : (
    <span className="truncate text-fg-2">{roleName}</span>
  );
  const menu = editable ? (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" icon size="sm" aria-label={`Actions for ${m.user.name}`} className="max-[760px]:size-10">
          <MoreHorizontal size={15} aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent align="end" width={220}>
        <MenuSub>
          <MenuSubTrigger>Change role</MenuSubTrigger>
          <MenuSubContent className="w-[220px]">
            <RoleRadioItems roles={roles} value={m.roleId} onChange={onChangeRole} />
          </MenuSubContent>
        </MenuSub>
        <MenuSeparator />
        <MenuItem danger onSelect={onRemove}>
          Remove from workspace
        </MenuItem>
      </MenuContent>
    </Menu>
  ) : null;
  const who = (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar name={m.user.name} hue={m.user.hue} size={28} ring={false} decorative />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{m.user.name}</span>
          {isMe && <span className="rounded-xs bg-raised px-[5px] py-[3px] font-mono text-[10.5px] font-medium leading-none text-fg-3">You</span>}
        </span>
        <span className={cn("truncate text-[12px] text-fg-3", !mobile && "@min-[720px]:hidden")}>{m.user.email}</span>
      </span>
    </span>
  );
  const status = <StatusPill kind={m.status === "active" ? "active" : "deactivated"} />;
  const last = lastActiveLabel(m.lastActiveAt);

  if (mobile) {
    return (
      <div
        role="listitem"
        className="grid grid-cols-[minmax(0,1fr)_40px] items-center gap-x-2 gap-y-2.5 rounded-lg border border-line bg-surface py-3 pl-3 pr-2"
      >
        <div className="min-w-0">{who}</div>
        <div className="flex justify-end">{menu}</div>
        <div className="col-span-2 flex items-center gap-2 pl-[38px]">
          <span className="flex-none">{role}</span>
          {status}
          <span className="ml-auto text-[12px] text-fg-3">{last}</span>
        </div>
      </div>
    );
  }
  return (
    <div role="row" className={cn(ROW, "min-h-[52px] transition-colors hover:bg-hover")}>
      <span role="cell" className="min-w-0">
        {who}
      </span>
      <span role="cell" className="hidden truncate text-fg-2 @min-[720px]:block">
        {m.user.email}
      </span>
      <span role="cell" className="min-w-0">
        {role}
      </span>
      <span role="cell">{status}</span>
      <span role="cell" className="hidden whitespace-nowrap text-[12px] text-fg-3 @min-[720px]:block">
        {last}
      </span>
      <span role="cell" className="flex justify-end">
        {menu}
      </span>
    </div>
  );
}

function InviteRow({
  invite,
  mobile,
  busy,
  onResend,
  onRevoke,
}: {
  invite: Invite;
  mobile: boolean;
  /** The action in flight for this invite, if any. */
  busy: "resend" | "revoke" | null;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const menu = (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" icon size="sm" aria-label={`Actions for invite to ${invite.email}`} className="max-[760px]:size-10">
          <MoreHorizontal size={15} aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent align="end" width={200}>
        <MenuItem disabled={busy !== null} onSelect={onResend}>
          {busy === "resend" ? "Resending…" : "Resend invite"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger disabled={busy !== null} onSelect={onRevoke}>
          {busy === "revoke" ? "Revoking…" : "Revoke invite"}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
  const who = (
    <span className="flex min-w-0 items-center gap-2.5">
      <InviteAvatar email={invite.email} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-fg-2">{invite.email}</span>
        <span className={cn("truncate text-[12px] text-fg-3", !mobile && "@min-[720px]:hidden")}>
          Invited {monthDay(invite.createdAt)}
        </span>
      </span>
    </span>
  );
  if (mobile) {
    return (
      <div
        role="listitem"
        className="grid grid-cols-[minmax(0,1fr)_40px] items-center gap-x-2 gap-y-2.5 rounded-lg border border-line bg-surface py-3 pl-3 pr-2"
      >
        <div className="min-w-0">{who}</div>
        <div className="flex justify-end">{menu}</div>
        <div className="col-span-2 flex items-center gap-2 pl-[38px]">
          <span className="text-fg-2">{invite.roleName}</span>
          <StatusPill kind="invited" />
          <span className="ml-auto text-[12px] text-fg-3">—</span>
        </div>
      </div>
    );
  }
  return (
    <div role="row" className={cn(ROW, "min-h-[52px] transition-colors hover:bg-hover")}>
      <span role="cell" className="min-w-0">
        {who}
      </span>
      <span role="cell" className="hidden truncate text-fg-2 @min-[720px]:block">
        Invited {monthDay(invite.createdAt)}
      </span>
      <span role="cell" className="truncate text-fg-2">
        {invite.roleName}
      </span>
      <span role="cell">
        <StatusPill kind="invited" />
      </span>
      <span role="cell" className="hidden text-[12px] text-fg-3 @min-[720px]:block">
        —
      </span>
      <span role="cell" className="flex justify-end">
        {menu}
      </span>
    </div>
  );
}

function MembersSkeleton() {
  const name = [120, 96, 132, 104, 118, 90];
  const email = [150, 170, 140, 160, 130, 150];
  return (
    <div role="status" aria-busy="true" aria-label="Loading members" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-[220px]" />
        <Skeleton className="h-8 w-[104px]" />
        <span className="flex-1" />
        <Skeleton className="h-[30px] w-[84px]" />
      </div>
      <div className="@container">
        <div className="rounded-[10px] border border-line bg-surface">
          <div className={cn(ROW, "min-h-[34px] font-mono text-[11px] font-medium uppercase tracking-[0.05em] text-fg-3")}>
            <span>Name</span>
            <span className="hidden @min-[720px]:block">Email</span>
            <span>Role</span>
            <span>Status</span>
            <span className="hidden @min-[720px]:block">Last active</span>
            <span />
          </div>
          {name.map((w, i) => (
            <div key={i} className={cn(ROW, "min-h-[52px]")}>
              <span className="flex items-center gap-2.5">
                <Skeleton className="size-7 rounded-full" />
                <Skeleton className="h-3" style={{ width: w }} />
              </span>
              <span className="hidden @min-[720px]:block">
                <Skeleton className="h-3" style={{ width: email[i] }} />
              </span>
              <Skeleton className="h-3 w-[76px]" />
              <Skeleton className="h-5 w-[58px] rounded-[10px]" />
              <span className="hidden @min-[720px]:block">
                <Skeleton className="h-3 w-[52px]" />
              </span>
              <span />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
