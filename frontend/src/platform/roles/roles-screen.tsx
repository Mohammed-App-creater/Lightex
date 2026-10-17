"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Copy, Lock, Plus, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AvatarStack } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/choice";
import { Skeleton } from "@/ui/feedback";
import { Modal } from "@/ui/modal";
import { Select } from "@/ui/select";
import { Segmented } from "@/ui/choice";
import { toast } from "@/ui/toast";
import { SaveBar } from "@/platform/settings/save-bar";
import { SettingsPage } from "@/platform/settings/settings-shell";
import { useLeaveGuard } from "@/platform/settings/use-leave-guard";
import { useRoles, useWsMembers } from "@/platform/workspace/queries";
import { api } from "@/api/endpoints";
import { errorMessage, isApiError } from "@/api/errors";
import { qk } from "@/api/query-keys";
import type { DataScope, DataScopeMap, Permission, PermissionInfo, Role, RoleScope } from "@/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { useCan, useCurrentWorkspace } from "@/platform/roles/can";
import { routes } from "@/platform/routes";
import { cn } from "@/lib/utils/cn";
import {
  changeCount,
  changedKeys,
  copyName,
  DATA_SCOPE_LABELS,
  dropScope,
  enabledCatalogue,
  groupCatalogueByModule,
  grantedCount,
  isOwnerRole,
  missingScopes,
  requestScopes,
  rescoped,
  roleNameError,
  rolesFor,
  withScope,
  togglePermission,
  uniqueName,
  type RoleDraft,
} from "@/platform/members/lib";
import { StateBox, Tag } from "@/platform/members/parts";
import { MODULES } from "@/registry";

/** Module headings in the permission matrix (registry names; core is the platform). */
const MODULE_NAMES: Record<string, string> = { core: "Core", ...Object.fromEntries(MODULES.map((m) => [m.key, m.name])) };
const MODULE_ORDER = MODULES.map((m) => m.key);

const toDraft = (r: Role): RoleDraft => ({ name: r.name, description: r.description, permissions: [...r.permissions], dataScopes: { ...r.dataScopes } });

/** Roles (board 18 A.5): scope switch, role list, permission matrix editor. */
export function RolesScreen() {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const canManage = useCan("core.roles.manage");
  const mobile = useIsMobile();
  const roles = useRoles(ws.slug);
  const members = useWsMembers(ws.slug);
  const catalogue = useQuery({ queryKey: qk.catalogue(), queryFn: api.roles.catalogue, staleTime: Infinity });

  const [scope, setScope] = useState<RoleScope>("workspace");
  const [selected, setSelected] = useState<Record<RoleScope, string | null>>({ workspace: null, project: null });
  const [draft, setDraft] = useState<(RoleDraft & { id: string }) | null>(null);
  const [shake, setShake] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  /** Stage 4: granted scopable codes still missing a scope (client check or 400 data_scope_required). */
  const [scopeErrors, setScopeErrors] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);
  /** Which role action is in flight: guards double submits and drives the button spinners. */
  const [pending, setPending] = useState<"create" | "duplicate" | "delete" | null>(null);

  const list = useMemo(() => rolesFor(roles.data ?? [], scope), [roles.data, scope]);
  // Stage 3: permissions of modules turned off for the workspace are hidden (role responses omit them too).
  const cat = enabledCatalogue(catalogue.data ?? [], ws.enabledModules);
  const current = list.find((r) => r.id === selected[scope]) ?? list.find((r) => !isOwnerRole(r)) ?? list[0];
  const editable = canManage && current ? !current.isSystem : false;
  const saved = current ? toDraft(current) : null;
  const working = draft && current && draft.id === current.id ? draft : saved;
  const changes = saved && working && editable ? changeCount(saved, working) : 0;
  const dirty = changes > 0;
  const nudge = () => setShake((s) => s + 1);
  const guard = (fn: () => void) => (dirty ? nudge() : fn());
  useLeaveGuard(dirty, nudge);

  const myRole = roles.data?.find((r) => r.id === ws.myRoleId);
  // People whose role grants role management (from the role's permissions, never its name).
  const roleAdmins = (members.data ?? []).filter(
    (m) => m.status === "active" && m.roleIds.some((id) => roles.data?.find((r) => r.id === id)?.permissions.includes("core.roles.manage")),
  );
  const refresh = () => qc.invalidateQueries({ queryKey: qk.roles(ws.slug) });

  const select = (id: string) =>
    guard(() => {
      setSelected((s) => ({ ...s, [scope]: id }));
      setDraft(null);
      setNameError(null);
      setScopeErrors([]);
      setSaveError(false);
      setEditorOpen(true);
    });

  const update = (patch: Partial<RoleDraft>) => {
    if (!current || !working) return;
    const next = { ...working, ...patch, id: current.id };
    setDraft(next);
    setSaveError(false);
    // A chosen (or removed) grant no longer needs a scope.
    if (scopeErrors.length) setScopeErrors(scopeErrors.filter((c) => next.permissions.includes(c as Permission) && !next.dataScopes?.[c]));
    if (patch.name !== undefined)
      setNameError(roleNameError(patch.name, list.filter((r) => r.id !== current.id).map((r) => r.name)));
  };

  const save = async () => {
    if (!current || !working || !dirty || saving) return;
    const err = roleNameError(working.name, list.filter((r) => r.id !== current.id).map((r) => r.name));
    if (err) {
      setNameError(err);
      nudge();
      return;
    }
    const missing = missingScopes(working, cat);
    if (missing.length) {
      setScopeErrors(missing);
      nudge();
      return;
    }
    const before = toDraft(current);
    const body = {
      name: working.name.trim().slice(0, 40),
      description: working.description.trim().slice(0, 80),
      permissions: working.permissions,
      dataScopes: requestScopes(working, cat),
    };
    setSaving(true);
    try {
      const r = await api.roles.update(current.id, body);
      await refresh();
      setDraft(null);
      toast.success(`Saved ${r.name}`, {
        action: {
          label: "Undo",
          key: "Z",
          onClick: async () => {
            try {
              await api.roles.update(current.id, { ...before, dataScopes: requestScopes(before, cat) });
              await refresh();
            } catch (e) {
              toast.error("Couldn’t undo", { body: errorMessage(e) });
            }
          },
        },
      });
    } catch (e) {
      // Stage 5: a non-owner can't grant a wider data scope than their own (403 data_scope_exceeds_own).
      if (isApiError(e) && e.code === "data_scope_exceeds_own") {
        toast.error("Couldn’t save role", { body: exceedsOwnMessage(e.details, cat) });
        return;
      }
      if (isApiError(e) && e.fieldErrors.name) setNameError(e.fieldErrors.name);
      else if (isApiError(e) && e.code === "data_scope_required") setScopeErrors(scopeCodes(e.details) ?? missingScopes(working, cat));
      else setSaveError(true);
      toast.error("Couldn’t save role", { body: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const create = (base: Pick<Role, "name" | "description" | "permissions" | "dataScopes">, kind: "create" | "duplicate") =>
    guard(async () => {
      if (pending) return;
      setPending(kind);
      try {
        const r = await api.roles.create(ws.slug, { ...base, scope, dataScopes: { ...base.dataScopes } });
        await refresh();
        setSelected((s) => ({ ...s, [scope]: r.id }));
        setDraft(null);
        setEditorOpen(true);
        toast.success(`Created ${r.name}`, {
          action: {
            label: "Undo",
            key: "Z",
            onClick: async () => {
              try {
                await api.roles.remove(r.id);
                await refresh();
              } catch (e) {
                toast.error("Couldn’t undo", { body: errorMessage(e) });
              }
            },
          },
        });
      } catch (e) {
        const exceeds = isApiError(e) && e.code === "data_scope_exceeds_own";
        toast.error("Couldn’t create role", { body: exceeds ? exceedsOwnMessage(e.details, cat) : errorMessage(e) });
      } finally {
        setPending(null);
      }
    });

  const remove = async (role: Role) => {
    if (role.memberCount > 0) return setDeleting(role);
    if (pending) return;
    setPending("delete");
    try {
      await api.roles.remove(role.id);
      await refresh();
      setDraft(null);
      setSelected((s) => ({ ...s, [scope]: null }));
      setEditorOpen(false);
      toast.success(`Deleted ${role.name}`, {
        action: {
          label: "Undo",
          key: "Z",
          onClick: async () => {
            try {
              await api.roles.create(ws.slug, {
                name: role.name,
                description: role.description,
                scope: role.scope,
                permissions: role.permissions,
                dataScopes: { ...role.dataScopes },
              });
              await refresh();
            } catch (e) {
              toast.error("Couldn’t undo", { body: errorMessage(e) });
            }
          },
        },
      });
    } catch (e) {
      // 409 role_in_use: someone holds it (e.g. on a project): ask where to move them.
      if (isApiError(e) && e.code === "role_in_use") setDeleting(role);
      else toast.error("Couldn’t delete role", { body: errorMessage(e) });
    } finally {
      setPending(null);
    }
  };

  const loading = roles.isPending || catalogue.isPending;
  const error = roles.error ?? catalogue.error;
  const total = cat.filter((p) => p.scope === scope).length;

  const header = (
    <Segmented
      label="Scope"
      value={scope}
      size="lg"
      className="w-[380px] max-[760px]:w-full [&>button]:flex-1"
      onChange={(v) =>
        guard(() => {
          setScope(v);
          setDraft(null);
          setNameError(null);
          setScopeErrors([]);
          setEditorOpen(false);
        })
      }
      options={[
        { value: "workspace", label: "Workspace" },
        { value: "project", label: "Project" },
      ]}
    />
  );

  let body;
  if (error) {
    body = (
      <StateBox
        role="alert"
        tone="danger"
        icon={<TriangleAlert size={18} aria-hidden />}
        title="Couldn’t load roles"
        meta={<span className="font-mono">{isApiError(error) ? `${error.status} · ` : ""}retrying won’t lose changes</span>}
      >
        <Button
          variant="secondary"
          className="mt-1.5"
          loading={roles.isFetching || catalogue.isFetching}
          onClick={() => {
            void roles.refetch();
            void catalogue.refetch();
          }}
        >
          Retry
        </Button>
      </StateBox>
    );
  } else if (loading || !current || !working) {
    body = <RolesSkeleton />;
  } else {
    const holders = scope === "workspace" ? (members.data ?? []).filter((m) => m.roleIds.includes(current.id)) : [];
    const changed = new Set([...changedKeys(current.permissions, working.permissions), ...rescoped(toDraft(current), working)]);
    const showList = !mobile || !editorOpen;
    const showEditor = !mobile || editorOpen;
    body = (
      <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-5 max-[1023px]:grid-cols-[176px_minmax(0,1fr)] max-[1023px]:gap-3.5 max-[760px]:grid-cols-1">
        {showList && (
          <nav aria-label="Roles" className="flex flex-col">
            <RoleGroup title="System" roles={list.filter((r) => r.isSystem)} currentId={current.id} onPick={select} mobile={mobile} />
            <RoleGroup title="Custom" roles={list.filter((r) => !r.isSystem)} currentId={current.id} onPick={select} mobile={mobile} />
            {canManage && (
              <Button
                variant="ghost"
                className="mt-2 justify-start max-[760px]:h-11"
                loading={pending === "create"}
                onClick={() => create({ name: uniqueName("New role", list.map((r) => r.name)), description: "", permissions: [], dataScopes: {} }, "create")}
              >
                <Plus size={13} aria-hidden /> New role
              </Button>
            )}
          </nav>
        )}
        {showEditor && (
          <section
            aria-label={`${current.name} role`}
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface px-[18px] pb-2 pt-[18px] max-[760px]:border-0 max-[760px]:bg-transparent max-[760px]:p-0"
          >
            <div className="flex items-center gap-2">
              {mobile && (
                <Button variant="ghost" icon aria-label="Back to roles" className="-ml-2.5 size-11" onClick={() => guard(() => setEditorOpen(false))}>
                  <ChevronLeft size={16} aria-hidden />
                </Button>
              )}
              {editable ? (
                <input
                  aria-label="Role name"
                  maxLength={40}
                  value={working.name}
                  onChange={(e) => update({ name: e.target.value })}
                  aria-invalid={nameError ? true : undefined}
                  className="-ml-[9px] min-w-0 flex-1 rounded-[7px] border border-transparent bg-transparent px-2 py-[3px] text-[17px] font-semibold leading-6 text-fg outline-none transition-colors hover:bg-hover focus:border-accent focus:bg-bg focus:shadow-[0_0_0_3px_var(--accent-s)] aria-[invalid=true]:border-danger"
                />
              ) : (
                <>
                  <h2 className="m-0 min-w-0 truncate text-[17px] font-semibold leading-6 tracking-[-0.01em]">{current.name}</h2>
                  {current.isSystem && (
                    <Tag>
                      <Lock size={11} aria-hidden /> System
                    </Tag>
                  )}
                  <span className="flex-1" />
                </>
              )}
              {canManage && (
                <Button
                  variant="secondary"
                  loading={pending === "duplicate"}
                  onClick={() =>
                    create(
                      {
                        name: copyName(current.name, list.map((r) => r.name)),
                        description: current.description,
                        permissions: current.permissions,
                        dataScopes: current.dataScopes,
                      },
                      "duplicate",
                    )
                  }
                  aria-label="Duplicate role"
                  tooltip={mobile ? "Duplicate role" : undefined}
                >
                  <Copy size={13} aria-hidden />
                  <span className="max-[760px]:hidden">Duplicate</span>
                </Button>
              )}
              {editable && (
                <Button
                  variant="ghost"
                  icon
                  aria-label="Delete role"
                  tooltip="Delete role"
                  className="hover:text-danger"
                  loading={pending === "delete"}
                  onClick={() => void remove(current)}
                >
                  <Trash2 size={15} aria-hidden />
                </Button>
              )}
            </div>
            {nameError && (
              <p role="alert" className="m-0 -mt-1.5 text-[12px] text-danger">
                {nameError}
              </p>
            )}
            {editable ? (
              <input
                aria-label="Role description"
                maxLength={80}
                placeholder="Short description"
                value={working.description}
                onChange={(e) => update({ description: e.target.value })}
                className="-ml-[9px] rounded-[7px] border border-transparent bg-transparent px-2 py-[3px] text-[13px] leading-5 text-fg-2 outline-none transition-colors placeholder:text-fg-3 hover:bg-hover focus:border-accent focus:bg-bg focus:shadow-[0_0_0_3px_var(--accent-s)]"
              />
            ) : (
              <p className="m-0 leading-5 text-fg-2">{current.description}</p>
            )}
            <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-2">
              {scope === "workspace" ? (
                <Link
                  href={`${routes.settings(ws.slug, "members")}?role=${encodeURIComponent(current.id)}`}
                  className="inline-flex h-7 items-center gap-2 rounded-sm px-1 font-medium hover:text-fg"
                >
                  {holders.length > 0 && (
                    <AvatarStack people={holders.map((m) => ({ id: m.userId, name: m.user.name, hue: m.user.hue }))} max={4} size={20} />
                  )}
                  {current.memberCount === 1 ? "1 member" : `${current.memberCount} members`}
                </Link>
              ) : (
                <span className="inline-flex h-7 items-center px-1 font-medium">
                  {current.memberCount === 1 ? "1 member" : `${current.memberCount} members`} across projects
                </span>
              )}
              <span className="font-mono text-[12px] text-fg-3">
                · {grantedCount({ ...current, permissions: working.permissions }, cat)} of {total} permissions
              </span>
            </div>
            {current.isSystem && (
              <div className="flex items-center gap-2 rounded-md border border-line-2 bg-raised py-[9px] pl-3 pr-2.5 text-[12.5px] text-fg-2">
                <Lock size={14} aria-hidden />
                System role · duplicate to customize
              </div>
            )}
            {!canManage && !current.isSystem && (
              <div className="flex items-center gap-2 rounded-md border border-line-2 bg-raised py-[9px] pl-3 pr-2.5 text-[12.5px] text-fg-2">
                <Lock size={14} aria-hidden />
                Read-only · only admins can edit roles
              </div>
            )}
            <PermissionMatrix
              catalogue={cat}
              enabledModules={ws.enabledModules}
              scope={scope}
              granted={working.permissions}
              scopes={working.dataScopes ?? {}}
              scopeErrors={scopeErrors}
              changed={changed}
              locked={!editable}
              onToggle={(key, on) =>
                update({
                  permissions: togglePermission(working.permissions, key, on),
                  dataScopes: on ? working.dataScopes : dropScope(working.dataScopes, key),
                })
              }
              onScope={(key, s) => update({ dataScopes: withScope(working.dataScopes, key, s) })}
            />
          </section>
        )}
      </div>
    );
  }

  return (
    <SettingsPage wide title="Roles" actions={header}>
      <div className="flex flex-col gap-4">
        {!canManage && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface px-4 py-8 text-center">
            <span className="flex size-10 items-center justify-center rounded-[10px] border border-line-2 bg-raised text-fg-2">
              <Lock size={16} aria-hidden />
            </span>
            <h2 className="m-0 text-[16px] font-semibold">You can’t manage roles</h2>
            <span className="text-[12px] text-fg-3">Admins only · you’re {myRole ? `a ${myRole.name.toLowerCase()}` : "not an admin"}</span>
            {/* No "request access" endpoint exists for workspace roles, so point at the people who can help. */}
            <p className="m-0 mt-1.5 max-w-[420px] text-[12.5px] text-fg-2">
              Ask a workspace admin to change your role
              {roleAdmins.length > 0 && <>: {roleAdmins.slice(0, 3).map((m) => m.user.name).join(", ")}{roleAdmins.length > 3 ? ` and ${roleAdmins.length - 3} more` : ""}</>}.
            </p>
          </div>
        )}
        {body}
      </div>
      {canManage && (
        <SaveBar
          state={saving ? "saving" : saveError && dirty ? "error" : (nameError || scopeErrors.length > 0) && dirty ? "invalid" : dirty ? "dirty" : "idle"}
          count={changes}
          shake={shake}
          onSave={() => void save()}
          onDiscard={() => {
            setDraft(null);
            setNameError(null);
            setScopeErrors([]);
            setSaveError(false);
          }}
        />
      )}
      {deleting && (
        <DeleteRoleDialog
          key={deleting.id}
          role={deleting}
          roles={list}
          holders={(members.data ?? []).filter((m) => m.roleIds.includes(deleting.id)).map((m) => m.user)}
          onClose={() => setDeleting(null)}
          onDeleted={async (target, moved) => {
            await refresh();
            await qc.invalidateQueries({ queryKey: qk.wsMembers(ws.slug) });
            setDraft(null);
            setSelected((s) => ({ ...s, [scope]: target.id }));
            toast.success(`${deleting.name} deleted · ${moved} moved to ${target.name}`);
            setDeleting(null);
          }}
        />
      )}
    </SettingsPage>
  );
}

function RoleGroup({
  title,
  roles,
  currentId,
  onPick,
  mobile,
}: {
  title: string;
  roles: Role[];
  currentId: string;
  onPick: (id: string) => void;
  mobile: boolean;
}) {
  if (!roles.length) return null;
  return (
    <>
      <h3 className="m-0 px-2 pb-1.5 pt-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3 first:pt-0.5">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-px p-0">
        {roles.map((r) => {
          const on = r.id === currentId && !mobile;
          return (
            <li key={r.id}>
              <button
                type="button"
                aria-current={on ? "true" : undefined}
                onClick={() => onPick(r.id)}
                className={cn(
                  "flex h-[34px] w-full items-center gap-[9px] rounded-[7px] px-2 text-left text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg",
                  on && "bg-accent-s text-fg hover:bg-accent-s",
                  "max-[760px]:h-12 max-[760px]:rounded-none max-[760px]:border-b max-[760px]:border-line",
                )}
              >
                {r.isSystem ? (
                  <Lock size={12} className="flex-none text-fg-3" aria-label="Locked" />
                ) : (
                  <span aria-hidden className="size-2 flex-none rounded-[3px] border-[1.5px] border-accent-t" />
                )}
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="font-mono text-[11px] text-fg-3" aria-label={`${r.memberCount} members`}>
                  {r.memberCount}
                </span>
                {mobile && <ChevronRight size={14} className="text-fg-3" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

type ScopeProps = {
  scopes: DataScopeMap;
  scopeErrors: string[];
  onScope: (key: Permission, scope: DataScope) => void;
};

function PermissionMatrix({
  catalogue,
  enabledModules,
  scope,
  granted,
  changed,
  locked,
  onToggle,
  ...scopeProps
}: {
  catalogue: PermissionInfo[];
  enabledModules: readonly string[];
  scope: RoleScope;
  granted: Permission[];
  changed: Set<string>;
  locked: boolean;
  onToggle: (key: Permission, on: boolean) => void;
} & ScopeProps) {
  const modules = groupCatalogueByModule(catalogue, scope, enabledModules, MODULE_ORDER);
  return (
    <div className="flex flex-col gap-4">
      {modules.map((m) => (
        <section key={m.module} aria-labelledby={`perm-mod-${m.module}`} className="flex flex-col">
          <h3 id={`perm-mod-${m.module}`} className="m-0 pb-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.07em] text-fg-3">
            {MODULE_NAMES[m.module] ?? m.module}
          </h3>
          <PermissionGroups groups={m.groups} granted={granted} changed={changed} locked={locked} onToggle={onToggle} {...scopeProps} />
        </section>
      ))}
    </div>
  );
}

function PermissionGroups({
  groups,
  granted,
  changed,
  locked,
  onToggle,
  scopes,
  scopeErrors,
  onScope,
}: {
  groups: ReturnType<typeof groupCatalogueByModule>[number]["groups"];
  granted: Permission[];
  changed: Set<string>;
  locked: boolean;
  onToggle: (key: Permission, on: boolean) => void;
} & ScopeProps) {
  return (
    <div className="flex flex-col">
      {groups.map((g) => {
        const on = g.items.filter((p) => granted.includes(p.key)).length;
        return (
          <fieldset key={g.group} className="m-0 flex min-w-0 flex-col border-0 border-t border-line p-0 pb-2 pt-2.5">
            <legend className="contents">
              <span className="flex items-center gap-2 pb-1">
                <span className="text-[12.5px] font-semibold">{g.group}</span>
                <span className="font-mono text-[11px] text-fg-3">
                  {on}/{g.items.length}
                </span>
              </span>
            </legend>
            {g.items.map((p) => {
              const checked = granted.includes(p.key);
              const dot = changed.has(p.key);
              const row = (
                <label
                  key={p.key}
                  className={cn(
                    "-mx-2 grid min-h-11 grid-cols-[1fr_auto_auto] items-center gap-2.5 rounded-md px-2 py-1 max-[760px]:min-h-[52px]",
                    locked ? "cursor-default" : "cursor-pointer hover:bg-hover focus-within:bg-hover",
                  )}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5 font-medium">
                      {p.label}
                      {dot && <span aria-label="changed" className="size-1.5 rounded-full bg-accent-t" />}
                    </span>
                    <span className="truncate text-[12px] text-fg-3">{p.description}</span>
                  </span>
                  {locked ? <Lock size={12} className="text-fg-3" aria-hidden /> : <span />}
                  <Switch
                    checked={checked}
                    disabled={locked}
                    aria-describedby={undefined}
                    onChange={(e) => onToggle(p.key, e.target.checked)}
                  />
                </label>
              );
              if (!p.scopable || !checked) return row;
              // Stage 4: a granted scopable permission picks how much data it reaches. Outside the <label>, so
              // the segment buttons don't toggle the switch.
              return (
                <div key={p.key} className="flex flex-col">
                  {row}
                  <DataScopeRow
                    permission={p}
                    value={scopes[p.key] ?? null}
                    error={scopeErrors.includes(p.key)}
                    locked={locked}
                    onChange={(s) => onScope(p.key, s)}
                  />
                </div>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}

const SCOPE_HINT: Record<DataScope, string> = {
  own: "Only records they own",
  team: "Records owned by anyone in their teams",
  all: "Every record in the workspace",
};

/** Own / Team / All for a granted scopable permission (stage4-contract.md §4). */
function DataScopeRow({
  permission,
  value,
  error,
  locked,
  onChange,
}: {
  permission: PermissionInfo;
  value: DataScope | null;
  error: boolean;
  locked: boolean;
  onChange: (scope: DataScope) => void;
}) {
  const label = `${permission.label} data scope`;
  return (
    <div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pb-1.5 pr-2 max-[760px]:pb-2.5">
      <span className="text-[12px] text-fg-3">Applies to</span>
      {locked ? (
        <span className="text-[12px] font-medium text-fg-2" aria-label={label}>
          {value ? DATA_SCOPE_LABELS[value] : "Not set"}
        </span>
      ) : (
        <Segmented<DataScope | "">
          label={label}
          value={value ?? ""}
          onChange={(v) => v && onChange(v)}
          options={(["own", "team", "all"] as const).map((s) => ({ value: s, label: DATA_SCOPE_LABELS[s] }))}
        />
      )}
      {value && !error && <span className="text-[12px] text-fg-3">{SCOPE_HINT[value]}</span>}
      {error && (
        <span role="alert" className="text-[12px] text-danger">
          Choose Own, Team or All
        </span>
      )}
    </div>
  );
}

const SCOPE_WORD: Record<DataScope, string> = { own: "Own", team: "Team", all: "All" };

/**
 * The toast body for a 403 data_scope_exceeds_own (`details {code, dataScope, yours}`): which permission, the scope
 * asked for and the actor's own (null = they don't hold the permission).
 */
function exceedsOwnMessage(details: Record<string, unknown> | undefined, cat: readonly PermissionInfo[]): string {
  const code = String(details?.code ?? "");
  const label = cat.find((p) => p.key === code)?.label ?? code;
  const asked = SCOPE_WORD[details?.dataScope as DataScope] ?? String(details?.dataScope ?? "");
  const yours = details?.yours ? SCOPE_WORD[details.yours as DataScope] : null;
  return yours
    ? `${label}: you hold ${yours}, so you can’t grant ${asked}. Ask the workspace owner.`
    : `${label}: you don’t hold this permission, so you can’t give it a data scope. Ask the workspace owner.`;
}

/** `details.codes` of a 400 data_scope_required, if present. */
function scopeCodes(details: Record<string, unknown> | undefined): string[] | null {
  const codes = details?.codes;
  return Array.isArray(codes) && codes.length ? codes.map(String) : null;
}

function DeleteRoleDialog({
  role,
  roles,
  holders,
  onClose,
  onDeleted,
}: {
  role: Role;
  roles: Role[];
  holders: { id: string; name: string; hue: number }[];
  onClose: () => void;
  onDeleted: (target: Role, moved: number) => Promise<void>;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = roles.filter((r) => r.id !== role.id && !isOwnerRole(r));
  const chosen = options.find((r) => r.id === target);
  const n = role.memberCount;
  const names = holders.slice(0, 3).map((h) => h.name).join(", ") + (holders.length > 3 ? ` +${holders.length - 3}` : "");

  const confirm = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await api.roles.remove(role.id, chosen.id);
      await onDeleted(chosen, n);
    } catch (e) {
      toast.error("Couldn’t delete role", { body: errorMessage(e) });
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      role="alertdialog"
      width={460}
      title={`Delete “${role.name}”?`}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="flex-1 text-[12px] text-fg-3">{chosen ? `${n} → ${chosen.name}` : "Pick a role to enable Delete"}</span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabledReason={chosen ? undefined : "Pick a role to reassign members to"} onClick={confirm}>
            Delete role
          </Button>
        </div>
      }
    >
      <div
        className="flex items-center gap-2.5 rounded-md px-3 py-[9px] text-[13px]"
        style={{
          background: "color-mix(in srgb, var(--danger) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
        }}
      >
        <TriangleAlert size={15} className="flex-none text-danger" aria-hidden />
        In use by {n === 1 ? "1 member" : `${n} members`}. Reassign before deleting.
      </div>
      {holders.length > 0 && (
        <div className="flex items-center gap-2 text-[12.5px] text-fg-2">
          <AvatarStack people={holders} max={5} size={20} />
          {names}
        </div>
      )}
      <Select
        label="Reassign to"
        placeholder="Choose a role"
        value={target}
        onChange={setTarget}
        width={300}
        options={options.map((r) => ({ value: r.id, label: r.name, meta: String(r.memberCount) }))}
      />
    </Modal>
  );
}

function RolesSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading roles" className="grid grid-cols-[220px_minmax(0,1fr)] gap-5 max-[760px]:grid-cols-1">
      <div className="flex flex-col gap-2">
        {[90, 70, 80, 110, 96].map((w, i) => (
          <Skeleton key={i} className="h-[34px] rounded-[7px]" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px] max-[760px]:hidden">
        <Skeleton className="h-6 w-[160px]" />
        <Skeleton className="h-3 w-[260px]" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 py-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-[140px]" />
              <Skeleton className="h-2.5 w-[220px]" />
            </div>
            <Skeleton className="h-[18px] w-8 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
