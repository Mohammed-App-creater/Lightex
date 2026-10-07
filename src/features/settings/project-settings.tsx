"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, TriangleAlert, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { StatusGlyph } from "@/components/ui/glyphs";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { assignableRoles, defaultRole } from "@/features/members/lib";
import { RolePicker } from "@/features/members/parts";
import { useProjectMembers, useStatuses } from "@/features/projects/queries";
import { useRoles, useWsMembers } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Project, ProjectMember, Status, StatusCategory } from "@/lib/api/types";
import { useCan, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { confirmState, moveItem, PROJECT_KEY_RE } from "./lib";
import { SettingsPage, SettingsSection } from "./settings-shell";

/** Project settings: each section renders only when the user holds its permission. */
export function ProjectSettingsScreen() {
  const project = useCurrentProject()!;
  const canUpdate = useCan("project.update");
  const canStatuses = useCan("status.manage");
  const canMembers = useCan("project.manage_members");
  const canArchive = useCan("project.archive");
  const canDelete = useCan("project.delete");
  const none = !canUpdate && !canStatuses && !canMembers && !canArchive && !canDelete;
  return (
    <SettingsPage title="Project settings">
      {none && (
        <p className="m-0 rounded-[10px] border border-dashed border-line-2 px-4 py-6 text-center text-[13px] text-fg-3">
          You don’t have permission to change {project.name}’s settings.
        </p>
      )}
      {canUpdate && <GeneralSection key={`${project.id}-${project.key}`} project={project} />}
      {canStatuses && <StatusesSection project={project} />}
      {canMembers && <MembersSection project={project} />}
      {(canArchive || canDelete) && <LifecycleSection project={project} canArchive={canArchive} canDelete={canDelete} />}
    </SettingsPage>
  );
}

function useInvalidateProject(project: Project) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  return (key = project.key) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.project(ws.slug, key) }),
      qc.invalidateQueries({ queryKey: qk.projects(ws.slug) }),
      qc.invalidateQueries({ queryKey: qk.directory(ws.slug) }),
    ]);
}

/* ───────────────────────── General ───────────────────────── */

function GeneralSection({ project }: { project: Project }) {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const invalidate = useInvalidateProject(project);
  const [name, setName] = useState(project.name);
  const [key, setKey] = useState(project.key);
  const [description, setDescription] = useState(project.description);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const nameErr = name.trim().length < 2 ? "Name the project (2+ characters)" : null;
  const keyErr = !PROJECT_KEY_RE.test(key) ? "Key: 2–5 letters" : null;
  const dirty = name !== project.name || key !== project.key || description !== project.description;

  const save = async () => {
    if (!dirty || nameErr || keyErr) return;
    setBusy(true);
    setErrors({});
    try {
      const body: Partial<Pick<Project, "name" | "key" | "description">> = {};
      if (name !== project.name) body.name = name.trim();
      if (key !== project.key) body.key = key;
      if (description !== project.description) body.description = description;
      const next = await api.projects.update(project.id, body);
      await invalidate(next.key);
      toast.success("Project saved");
      if (next.key !== project.key) router.replace(routes.project(ws.slug, next.key, "settings"));
    } catch (e) {
      if (isApiError(e) && Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors);
      else toast.error("Couldn’t save project", { body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="General">
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3.5 max-[760px]:grid-cols-1">
          <Field label="Name" error={errors.name ?? nameErr}>
            <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Key" error={errors.key ?? keyErr}>
            <Input mono value={key} maxLength={5} onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
          </Field>
        </div>
        {key !== project.key && !keyErr && (
          <p className="m-0 -mt-1.5 text-[12px] text-fg-3">
            Task keys change to <span className="font-mono">{key}-123</span>. Old links stop working.
          </p>
        )}
        <Field label="Description" error={errors.description}>
          <Textarea value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {dirty && (
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy} disabledReason={nameErr || keyErr ? "Fix errors to save" : undefined}>
              Save changes
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setName(project.name);
                setKey(project.key);
                setDescription(project.description);
                setErrors({});
              }}
            >
              Discard
            </Button>
          </div>
        )}
      </form>
    </SettingsSection>
  );
}

/* ───────────────────────── Workflow statuses ───────────────────────── */

const CATEGORY_LABEL: Record<StatusCategory, string> = { todo: "To do", in_progress: "In progress", done: "Done" };

function StatusesSection({ project }: { project: Project }) {
  const qc = useQueryClient();
  const statuses = useStatuses(project.id);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState<StatusCategory>("in_progress");
  const [removing, setRemoving] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const list = [...(statuses.data ?? [])].sort((a, b) => a.position - b.position);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.statuses(project.id) }),
      qc.invalidateQueries({ queryKey: ["p", project.id, "board"] }),
    ]);

  const rename = async (s: Status) => {
    const n = editName.trim();
    setEditing(null);
    if (!n || n === s.name) return;
    try {
      await api.projects.updateStatus(project.id, s.id, { name: n });
      await refresh();
    } catch (e) {
      toast.error("Couldn’t rename status", { body: errorMessage(e) });
    }
  };

  const move = async (i: number, dir: -1 | 1) => {
    const s = list[i]!;
    const target = i + dir;
    // Optimistic reorder, then persist.
    qc.setQueryData<Status[]>(qk.statuses(project.id), moveItem(list, i, target).map((x, idx) => ({ ...x, position: idx })));
    try {
      await api.projects.updateStatus(project.id, s.id, { position: target });
    } catch (e) {
      toast.error("Couldn’t reorder", { body: errorMessage(e) });
    } finally {
      await refresh();
    }
  };

  const add = async () => {
    const n = newName.trim();
    if (!n) return;
    setBusy(true);
    try {
      await api.projects.createStatus(project.id, { name: n, category: newCat });
      setNewName("");
      await refresh();
    } catch (e) {
      toast.error("Couldn’t add status", { body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: Status) => {
    try {
      await api.projects.removeStatus(project.id, s.id);
      await refresh();
      toast.success(`Deleted ${s.name}`);
    } catch (e) {
      if (isApiError(e) && e.code === "status_in_use") toast.error(`${s.name} still has tasks`, { body: "Move its tasks to another status, then delete it." });
      else toast.error("Couldn’t delete status", { body: errorMessage(e) });
    }
  };

  return (
    <SettingsSection title="Workflow" description="Statuses are the board’s columns, in this order.">
      {statuses.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading statuses" className="flex flex-col gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-md" />
          ))}
        </div>
      ) : statuses.isError ? (
        <ErrorState title="Couldn’t load statuses" body={errorMessage(statuses.error)} onRetry={() => void statuses.refetch()} />
      ) : (
        <>
          <ol className="m-0 list-none rounded-[10px] border border-line bg-surface p-0">
            {list.map((s, i) => (
              <li key={s.id} className="flex min-h-11 items-center gap-2.5 border-b border-line pl-3 pr-1.5 last:border-b-0">
                <StatusGlyph kind={s.glyph} />
                {editing === s.id ? (
                  <Input
                    autoFocus
                    inputSize="sm"
                    aria-label={`Rename ${s.name}`}
                    value={editName}
                    maxLength={30}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => void rename(s)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void rename(s);
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    className="max-w-[240px]"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                )}
                {editing === s.id && <span className="flex-1" />}
                <span className="text-[12px] text-fg-3 max-[760px]:hidden">{CATEGORY_LABEL[s.category]}</span>
                <span className="flex items-center">
                  <Button variant="ghost" icon size="sm" aria-label={`Rename ${s.name}`} tooltip="Rename" onClick={() => { setEditing(s.id); setEditName(s.name); }}>
                    <Pencil size={13} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    icon
                    size="sm"
                    aria-label={`Move ${s.name} up`}
                    tooltip="Move up"
                    disabledReason={i === 0 ? "Already first" : undefined}
                    className="aria-disabled:border-transparent aria-disabled:bg-transparent aria-disabled:opacity-40"
                    onClick={() => void move(i, -1)}
                  >
                    <ArrowUp size={13} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    icon
                    size="sm"
                    aria-label={`Move ${s.name} down`}
                    tooltip="Move down"
                    disabledReason={i === list.length - 1 ? "Already last" : undefined}
                    className="aria-disabled:border-transparent aria-disabled:bg-transparent aria-disabled:opacity-40"
                    onClick={() => void move(i, 1)}
                  >
                    <ArrowDown size={13} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    icon
                    size="sm"
                    aria-label={`Delete ${s.name}`}
                    tooltip="Delete"
                    className="hover:text-danger"
                    disabledReason={list.length <= 1 ? "A project needs at least one status" : undefined}
                    onClick={() => setRemoving(s)}
                  >
                    <Trash2 size={13} aria-hidden />
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Field label="New status" className="min-w-[180px] flex-1">
              <Input value={newName} maxLength={30} placeholder="e.g. QA" onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <Select
              label="Category"
              className="w-[160px]"
              width={180}
              value={newCat}
              onChange={setNewCat}
              options={(Object.keys(CATEGORY_LABEL) as StatusCategory[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
            />
            <Button type="submit" variant="secondary" loading={busy} disabledReason={newName.trim() ? undefined : "Name the status first"} className="max-[1023px]:h-11">
              <Plus size={13} aria-hidden /> Add
            </Button>
          </form>
        </>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? `Delete “${removing.name}”?` : ""}
        description="Only empty statuses can be deleted. Move its tasks first."
        confirmLabel="Delete status"
        confirmVariant="danger"
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </SettingsSection>
  );
}

/* ───────────────────────── Members ───────────────────────── */

function MembersSection({ project }: { project: Project }) {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const qc = useQueryClient();
  const members = useProjectMembers(project.id);
  const wsMembers = useWsMembers(ws.slug);
  const roles = useRoles(ws.slug);
  const requests = useQuery({ queryKey: qk.accessRequests(project.id), queryFn: () => api.projects.accessRequests(project.id) });
  const projectRoles = assignableRoles(roles.data ?? [], "project");
  const memberRole = defaultRole(roles.data ?? [], "project");
  const [addRole, setAddRole] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const [declined, setDeclined] = useState<string[]>([]);
  const roleId = addRole ?? memberRole?.id ?? null;
  const roleName = (id: string) => projectRoles.find((r) => r.id === id)?.name ?? "—";
  const inProject = new Set((members.data ?? []).map((m) => m.userId));
  const candidates = (wsMembers.data ?? []).filter((m) => m.status === "active" && !inProject.has(m.userId));

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.members(project.id) }),
      qc.invalidateQueries({ queryKey: qk.accessRequests(project.id) }),
      qc.invalidateQueries({ queryKey: qk.roles(ws.slug) }),
      qc.invalidateQueries({ queryKey: qk.directory(ws.slug) }),
      qc.invalidateQueries({ queryKey: qk.project(ws.slug, project.key) }),
    ]);

  const add = async (user: { id: string; name: string }, rid: string, verb = "Added") => {
    try {
      await api.projects.addMember(project.id, user.id, rid);
      await refresh();
      toast.success(`${verb} ${user.name} as ${roleName(rid)}`);
    } catch (e) {
      toast.error("Couldn’t add member", { body: errorMessage(e) });
    }
  };

  const change = async (m: ProjectMember, rid: string, undo = false) => {
    const prev = m.roleId;
    try {
      await api.projects.updateMember(project.id, m.userId, rid);
      await refresh();
      if (!undo)
        toast.success(`${m.user.name} is now ${roleName(rid)}`, {
          action: { label: "Undo", key: "Z", onClick: () => void change({ ...m, roleId: rid }, prev, true) },
        });
    } catch (e) {
      toast.error("Couldn’t change role", { body: errorMessage(e) });
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

  const pending = (requests.data ?? []).filter((r) => !declined.includes(r.id));

  return (
    <SettingsSection title="Members" description="Project roles are separate from workspace roles.">
      {members.isPending || roles.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading members" className="flex flex-col gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </div>
      ) : members.isError ? (
        <ErrorState title="Couldn’t load members" body={errorMessage(members.error)} onRetry={() => void members.refetch()} />
      ) : (
        <>
          {pending.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="m-0 flex items-center gap-2 text-[13px] font-semibold">
                Access requests <span className="font-mono text-[11px] font-medium text-fg-3">{pending.length}</span>
              </h3>
              <ul className="m-0 list-none rounded-[10px] border border-line bg-surface p-0">
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
                      disabledReason={memberRole ? undefined : "No project Member role"}
                      onClick={() => memberRole && void add(r.user, memberRole.id, "Approved")}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDeclined((d) => [...d, r.id]);
                        toast.info(`Declined ${r.user.name}’s request`);
                      }}
                    >
                      Decline
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="m-0 list-none rounded-[10px] border border-line bg-surface p-0" aria-label="Project members">
            {(members.data ?? []).map((m) => {
              const self = m.userId === me.id;
              return (
                <li key={m.userId} className="flex min-h-[52px] items-center gap-3 border-b border-line pl-3 pr-1.5 last:border-b-0">
                  <Avatar name={m.user.name} hue={m.user.hue} size={28} ring={false} decorative />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5 truncate font-medium">
                      {m.user.name}
                      {self && <span className="rounded-xs bg-raised px-[5px] py-[3px] font-mono text-[10.5px] font-medium leading-none text-fg-3">You</span>}
                    </span>
                    <span className="truncate text-[12px] text-fg-3">{m.user.email}</span>
                  </span>
                  {self ? (
                    <span className="w-[140px] truncate text-fg-2">{roleName(m.roleId)}</span>
                  ) : (
                    <span className="w-[140px]">
                      <RolePicker roles={projectRoles} value={m.roleId} onChange={(rid) => void change(m, rid)} label={`Project role for ${m.user.name}`} />
                    </span>
                  )}
                  {self ? (
                    <span className="w-8" />
                  ) : (
                    <Button variant="ghost" icon size="sm" aria-label={`Remove ${m.user.name}`} tooltip="Remove from project" className="hover:text-danger max-[760px]:size-10" onClick={() => setRemoving(m)}>
                      <Trash2 size={13} aria-hidden />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label="Role for new members"
              className="w-[200px]"
              value={roleId}
              onChange={setAddRole}
              options={projectRoles.map((r) => ({ value: r.id, label: r.name }))}
            />
            <Menu>
              <MenuTrigger asChild>
                <Button variant="secondary" className="max-[1023px]:h-11">
                  <UserPlus size={13} aria-hidden /> Add member
                </Button>
              </MenuTrigger>
              <MenuContent align="start" width={260} className="max-h-[320px] overflow-y-auto">
                <MenuLabel>Workspace members</MenuLabel>
                {candidates.length === 0 && <MenuItem disabled>Everyone is already in {project.name}</MenuItem>}
                {candidates.map((m) => (
                  <MenuItem
                    key={m.userId}
                    icon={<Avatar name={m.user.name} hue={m.user.hue} size={18} ring={false} decorative />}
                    onSelect={() => roleId && void add(m.user, roleId)}
                  >
                    {m.user.name}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
        </>
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
    </SettingsSection>
  );
}

/* ───────────────────────── Archive / delete ───────────────────────── */

function LifecycleSection({ project, canArchive, canDelete }: { project: Project; canArchive: boolean; canDelete: boolean }) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const router = useRouter();
  const invalidate = useInvalidateProject(project);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const archived = project.status === "archived";
  const st = confirmState(text, project.key);

  const toggleArchive = async () => {
    try {
      if (archived) await api.projects.unarchive(project.id);
      else await api.projects.archive(project.id);
      await invalidate();
      toast.success(archived ? `${project.name} restored` : `${project.name} archived`);
    } catch (e) {
      toast.error(archived ? "Couldn’t unarchive" : "Couldn’t archive", { body: errorMessage(e) });
    }
  };

  const del = async () => {
    if (st !== "match" || busy) return;
    setBusy(true);
    try {
      await api.projects.remove(project.id, text);
      qc.removeQueries({ queryKey: qk.project(ws.slug, project.key) });
      await qc.invalidateQueries({ queryKey: qk.projects(ws.slug) });
      void qc.invalidateQueries({ queryKey: qk.directory(ws.slug) });
      toast.success(`${project.name} deleted`);
      router.replace(routes.home(ws.slug));
    } catch (e) {
      toast.error("Couldn’t delete project", { body: errorMessage(e) });
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Danger zone">
      <div className="rounded-lg border border-danger bg-surface">
        {canArchive && (
          <div className="flex items-center gap-4 border-b border-line px-[18px] py-4 last:border-b-0 max-[760px]:flex-col max-[760px]:items-start">
            <div className="min-w-0 flex-1">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">{archived ? "Unarchive project" : "Archive project"}</h3>
              <p className="m-0 text-[12px] text-fg-3">
                {archived ? "Make the project editable again." : "Close out a finished project. It becomes read-only and leaves the sidebar."}
              </p>
            </div>
            <Button variant="secondary" onClick={() => (archived ? void toggleArchive() : setArchiveOpen(true))}>
              {archived ? "Unarchive" : "Archive"}
            </Button>
          </div>
        )}
        {canDelete && (
          <div className="flex items-center gap-4 px-[18px] py-4 max-[760px]:flex-col max-[760px]:items-start">
            <div className="min-w-0 flex-1">
              <h3 className="m-0 mb-1 text-[13px] font-semibold">Delete project</h3>
              <p className="m-0 font-mono text-[12px] text-fg-3">
                {project.openTaskCount} open tasks · {project.memberCount} members
              </p>
            </div>
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              Delete project
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${project.name}?`}
        description="Everyone keeps read access. A project admin can unarchive it any time."
        confirmLabel="Archive"
        onConfirm={toggleArchive}
      />
      {deleteOpen && (
        <Modal
          open
          onOpenChange={(o) => !o && !busy && (setDeleteOpen(false), setText(""))}
          role="alertdialog"
          width={420}
          title={`Delete ${project.name}?`}
          description="The project, its tasks, sprints and goals are deleted for everyone."
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={() => (setDeleteOpen(false), setText(""))}>
                Cancel
              </Button>
              <Button variant="danger" loading={busy} disabledReason={st === "match" ? undefined : "Type the project key to enable delete"} onClick={del}>
                Delete project
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="prj-confirm" className="text-[12px] font-medium text-fg-2">
              Type <code className="rounded-xs border border-line bg-raised px-[5px] py-px font-mono text-[12px]">{project.key}</code> to confirm
            </label>
            <Input
              id="prj-confirm"
              mono
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={text}
              maxLength={10}
              aria-invalid={st === "mismatch" ? true : undefined}
              aria-describedby="prj-confirm-status"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void del()}
            />
            <span
              id="prj-confirm-status"
              role="status"
              className={cn("flex items-center gap-1.5 text-[12px]", st === "match" ? "text-ok" : st === "mismatch" ? "text-danger" : "text-fg-3")}
            >
              {st === "mismatch" && <TriangleAlert size={12} aria-hidden />}
              {st === "empty" ? "Type the project key to enable delete" : st === "prefix" ? "Keep typing" : st === "match" ? "Matches" : "Doesn’t match"}
            </span>
          </div>
        </Modal>
      )}
    </SettingsSection>
  );
}
