"use client";

import * as Popover from "@radix-ui/react-popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, X } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { assignableRoles, defaultRole } from "@/features/members/lib";
import { RoleRadioItems } from "@/features/members/parts";
import { useProjectMembers } from "@/features/projects/queries";
import { useRoles, useWsMembers } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Project, ProjectMember, User } from "@/lib/api/types";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";
import { PanelHeader } from "./project-parts";
import { isOnlyAdmin } from "./project-lib";

const GRID = "grid grid-cols-[minmax(0,1fr)_172px_40px] items-center gap-2 pl-3.5 pr-1.5 max-[760px]:grid-cols-[minmax(0,1fr)_124px_40px] max-[760px]:pl-2.5";

/** Members tab (board 28): project roles, add picker, access requests. */
export function MembersPanel({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const qc = useQueryClient();
  const members = useProjectMembers(project.id);
  const roles = useRoles(ws.slug);
  const wsMembers = useWsMembers(ws.slug);
  const requests = useQuery({
    queryKey: qk.accessRequests(project.id),
    queryFn: () => api.projects.accessRequests(project.id),
    enabled: canEdit,
  });
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const [declined, setDeclined] = useState<string[]>([]);
  /** Access request id → the action in flight on it. */
  const [deciding, setDeciding] = useState<Record<string, "approve" | "decline">>({});
  const decide = (id: string, action: "approve" | "decline" | null) =>
    setDeciding((d) => {
      const next = { ...d };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });
  const [fresh, setFresh] = useState<string | null>(null);
  const projectRoles = assignableRoles(roles.data ?? [], "project");
  const newRole = defaultRole(roles.data ?? [], "project");
  const roleName = (id: string) => projectRoles.find((r) => r.id === id)?.name ?? "—";
  const list = members.data ?? [];

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.members(project.id) }),
      qc.invalidateQueries({ queryKey: qk.accessRequests(project.id) }),
      qc.invalidateQueries({ queryKey: qk.roles(ws.slug) }),
      qc.invalidateQueries({ queryKey: qk.directory(ws.slug) }),
      qc.invalidateQueries({ queryKey: qk.project(ws.slug, project.key) }),
    ]);

  const add = async (user: Pick<User, "id" | "name">, rid: string, verb = "Added") => {
    try {
      await api.projects.addMember(project.id, user.id, rid);
      setFresh(user.id);
      await refresh();
      toast.success(`${verb} ${user.name}`, verb === "Added" ? { body: `as ${roleName(rid)}` } : undefined);
    } catch (e) {
      toast.error("Couldn’t add member", { body: errorMessage(e) });
    }
  };

  const change = async (m: ProjectMember, rid: string, undo = false) => {
    const prev = m.roleId;
    const key = qk.members(project.id);
    const before = qc.getQueryData<ProjectMember[]>(key);
    qc.setQueryData<ProjectMember[]>(key, (old) => old?.map((x) => (x.userId === m.userId ? { ...x, roleId: rid } : x)));
    try {
      await api.projects.updateMember(project.id, m.userId, rid);
      if (!undo)
        toast.success(`${m.user.name.split(" ")[0]} → ${roleName(rid)}`, {
          action: { label: "Undo", key: "Z", onClick: () => void change({ ...m, roleId: rid }, prev, true) },
        });
    } catch (e) {
      if (before) qc.setQueryData(key, before);
      toast.error("Couldn’t change role", { body: errorMessage(e) });
    } finally {
      void refresh();
    }
  };

  const remove = async (m: ProjectMember) => {
    try {
      await api.projects.removeMember(project.id, m.userId);
      await refresh();
      toast.success(`Removed ${m.user.name}`, {
        action: { label: "Undo", key: "Z", onClick: () => void add(m.user, m.roleId, "Re-added") },
      });
    } catch (e) {
      toast.error("Couldn’t remove member", { body: errorMessage(e) });
    }
  };

  const inProject = new Set(list.map((m) => m.userId));
  const candidates = (wsMembers.data ?? []).filter((m) => m.status === "active" && !inProject.has(m.userId)).map((m) => m.user);
  const pending = canEdit ? (requests.data ?? []).filter((r) => !declined.includes(r.id)) : [];

  return (
    <div className="flex flex-col">
      <PanelHeader title="Members" count={members.data ? list.length : undefined}>
        {canEdit && members.isSuccess && newRole && (
          <AddMemberPicker candidates={candidates} loading={wsMembers.isPending} onAdd={(u) => void add(u, newRole.id)} />
        )}
      </PanelHeader>

      {pending.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          <h3 className="m-0 flex items-center gap-2 text-[13px] font-semibold">
            Access requests <span className="font-mono text-[11px] font-medium text-fg-3">{pending.length}</span>
          </h3>
          <ul className="m-0 list-none rounded-lg border border-line bg-surface p-0">
            {pending.map((r) => (
              <li key={r.id} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 last:border-b-0">
                <Avatar name={r.user.name} hue={r.user.hue} size={28} ring={false} decorative />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{r.user.name}</span>
                  <span className="truncate text-[12px] text-fg-3">{r.message ? `“${r.message}”` : r.user.email}</span>
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  loading={deciding[r.id] === "approve"}
                  disabledReason={!newRole ? "No project Member role" : deciding[r.id] ? "Declining this request" : undefined}
                  onClick={async () => {
                    if (!newRole) return;
                    decide(r.id, "approve");
                    await add(r.user, newRole.id, "Approved");
                    decide(r.id, null);
                  }}
                >
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={deciding[r.id] === "decline"}
                  disabledReason={deciding[r.id] === "approve" ? "Approving this request" : undefined}
                  onClick={async () => {
                    decide(r.id, "decline");
                    try {
                      await api.projects.denyAccessRequest(project.id, r.id);
                      setDeclined((d) => [...d, r.id]);
                      toast.info(`Declined ${r.user.name}’s request`);
                      void qc.invalidateQueries({ queryKey: qk.accessRequests(project.id) });
                    } catch (e) {
                      toast.error("Couldn’t decline the request", { body: errorMessage(e) });
                    } finally {
                      decide(r.id, null);
                    }
                  }}
                >
                  Decline
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {members.isPending || roles.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading members" className="rounded-lg border border-line bg-surface">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn(GRID, "h-[54px] border-b border-line last:border-b-0")}>
              <span className="flex items-center gap-2.5">
                <Skeleton className="size-[30px] rounded-full" />
                <span className="flex flex-col gap-1.5">
                  <Skeleton className="h-2.5 w-28" />
                  <Skeleton className="h-2 w-36" />
                </span>
              </span>
              <Skeleton className="h-[30px] w-full rounded-[7px]" />
            </div>
          ))}
        </div>
      ) : members.isError || roles.isError ? (
        <ErrorState
          title="Couldn’t load members"
          body={errorMessage(members.error ?? roles.error)}
          onRetry={() => void (members.isError ? members.refetch() : roles.refetch())}
        />
      ) : (
        <div role="table" aria-label="Project members" className="rounded-lg border border-line bg-surface">
          <div role="row" className={cn(GRID, "h-[34px] border-b border-line font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3 max-[760px]:hidden")}>
            <span role="columnheader">Member</span>
            <span role="columnheader">Project role</span>
            <span role="columnheader">
              <span className="sr-only">Actions</span>
            </span>
          </div>
          {list.map((m) => {
            const self = m.userId === me.id;
            const only = isOnlyAdmin(m, list, roles.data ?? []);
            return (
              <div
                key={m.userId}
                role="row"
                className={cn(
                  GRID,
                  "h-[54px] border-b border-line transition-colors duration-[var(--dur-fast)] last:border-b-0 hover:bg-hover max-[760px]:h-[60px]",
                  fresh === m.userId && "animate-[fade-in_400ms_var(--ease)] bg-accent-s",
                )}
              >
                <span role="cell" className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={m.user.name} hue={m.user.hue} size={30} ring={false} decorative />
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <b className="flex items-center truncate font-semibold">
                      <span className="truncate">{m.user.name}</span>
                      {self && (
                        <span className="ml-1.5 rounded-xs border border-line-2 px-[5px] py-0.5 font-mono text-[10.5px] font-medium leading-none text-fg-3">you</span>
                      )}
                    </b>
                    <span className="truncate text-[12px] text-fg-3 max-[760px]:hidden">{m.user.email}</span>
                  </span>
                </span>
                <span role="cell" className="flex min-w-0">
                  {canEdit && !only ? (
                    <Menu>
                      <MenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Role for ${m.user.name}: ${roleName(m.roleId)}`}
                          className="flex h-[30px] w-full items-center gap-2 rounded-[7px] border border-line-2 bg-raised pl-2.5 pr-2 text-left text-[12.5px] font-medium text-fg transition-colors hover:border-control hover:bg-hover data-[state=open]:border-control data-[state=open]:bg-hover max-[760px]:h-10"
                        >
                          <span className="min-w-0 flex-1 truncate">{roleName(m.roleId)}</span>
                          <ChevronDown size={12} aria-hidden className="flex-none text-fg-3" />
                        </button>
                      </MenuTrigger>
                      <MenuContent align="end" width={240}>
                        <RoleRadioItems roles={projectRoles} value={m.roleId} onChange={(rid) => void change(m, rid)} />
                      </MenuContent>
                    </Menu>
                  ) : (
                    <span className="flex min-w-0 flex-col gap-[3px] pl-0.5 text-[12.5px] font-medium">
                      <span className="truncate">{roleName(m.roleId)}</span>
                      {canEdit && only && <i className="font-mono text-[10.5px] not-italic text-fg-3">only admin</i>}
                    </span>
                  )}
                </span>
                <span role="cell" className="flex justify-center">
                  {canEdit && !self && !only && (
                    <Button
                      variant="ghost"
                      icon
                      size="sm"
                      aria-label={`Remove ${m.user.name} from project`}
                      tooltip="Remove from project"
                      className="hover:text-danger max-[760px]:size-10"
                      onClick={() => setRemoving(m)}
                    >
                      <X size={13} aria-hidden />
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? `Remove ${removing.user.name} from ${project.name}?` : ""}
        description="They lose access to this project. Their tasks stay assigned."
        confirmLabel="Remove from project"
        confirmVariant="danger"
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </div>
  );
}

/** "Add member" picker (board 28 .ps-menu): search workspace members, Enter adds the first match. */
function AddMemberPicker({ candidates, loading, onAdd }: { candidates: User[]; loading: boolean; onAdd: (u: User) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const shown = candidates.filter((u) => !ql || u.name.toLowerCase().includes(ql) || u.email.toLowerCase().includes(ql));
  const pick = (u: User) => {
    setOpen(false);
    setQ("");
    onAdd(u);
  };
  return (
    <Popover.Root open={open} onOpenChange={(o) => (setOpen(o), o || setQ(""))}>
      <Popover.Trigger asChild>
        <Button variant="primary" size="sm" aria-haspopup="dialog">
          <Plus size={12} aria-hidden /> Add member
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="Add member"
          className="z-[70] w-[272px] max-w-[calc(100vw-24px)] rounded-[10px] border border-line-2 bg-raised p-1 shadow-pop data-[state=open]:animate-[fade-in_150ms_var(--ease)]"
        >
          <input
            type="search"
            autoFocus
            value={q}
            placeholder="Workspace members…"
            aria-label="Search workspace members"
            onChange={(e) => setQ(e.target.value.slice(0, 40))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) {
                e.preventDefault();
                pick(shown[0]);
              }
            }}
            className="mb-1 h-8 w-full rounded-[7px] border border-line-2 bg-bg px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-s)] max-[760px]:h-11 max-[760px]:text-[15px]"
          />
          <div className="max-h-[264px] overflow-y-auto">
            {loading ? (
              <div className="px-2 py-3 text-[12.5px] text-fg-3">Loading…</div>
            ) : shown.length === 0 ? (
              <div className="px-2 py-3 text-[12.5px] text-fg-3">{candidates.length ? "No matches" : "Everyone’s already in"}</div>
            ) : (
              shown.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => pick(u)}
                  className="flex h-11 w-full items-center gap-2.5 rounded-[6px] px-2 text-left text-[13px] font-medium hover:bg-hover focus-visible:bg-hover"
                >
                  <Avatar name={u.name} hue={u.hue} size={24} ring={false} decorative />
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate">{u.name}</span>
                    <span className="truncate text-[11.5px] font-normal text-fg-3">{u.email}</span>
                  </span>
                  <span aria-hidden className="ml-auto font-mono text-[11px] text-fg-3">
                    +
                  </span>
                </button>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
