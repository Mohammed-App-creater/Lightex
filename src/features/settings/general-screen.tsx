"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Copy, Eye, Link2, TriangleAlert, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, AvatarStack, ProjectBadge } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { isOwnerRole, projectAdminRole } from "@/features/members/lib";
import { Tag } from "@/features/members/parts";
import { useRoles, useWsMembers } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import { useCan, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { confirmState, slugError, slugSegments, URL_HOST, workspaceIcon, workspaceNameError } from "./lib";
import { SaveBar, type SaveState } from "./save-bar";
import { SettingsPage, SettingsSection } from "./settings-shell";
import { useLeaveGuard } from "./use-leave-guard";

type SlugCheck = { slug: string; status: "checking" | "available" | "taken" } | null;

/** Workspace general settings (board 20 B.4–B.6) + project directory for assigning project admins. */
export function GeneralScreen() {
  const canEdit = useCan("workspace.update");
  const canDelete = useCan("workspace.delete");
  return (
    <SettingsPage title="Workspace">
      {canEdit ? <WorkspaceForm /> : <WorkspaceReadOnly />}
      <ProjectsSection />
      {canDelete && <DangerZone />}
    </SettingsPage>
  );
}

function WorkspaceBadge({ name, hue }: { name: string; hue: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-10 flex-none items-center justify-center rounded-[10px] font-mono text-[14px] font-semibold"
      style={{ background: `oklch(var(--pk-l) var(--pk-c) ${hue})`, color: `oklch(var(--pkt-l) var(--pkt-c) ${hue})` }}
    >
      {workspaceIcon(name)}
    </span>
  );
}

function WorkspaceForm() {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState(ws.name);
  const [slug, setSlug] = useState(ws.slug);
  const [check, setCheck] = useState<SlugCheck>(null);
  const [phase, setPhase] = useState<"edit" | "saving" | "error" | "saved">("edit");
  const [shake, setShake] = useState(0);

  const nameErr = workspaceNameError(name);
  const localSlugErr = slugError(slug);
  const slugChanged = slug !== ws.slug;
  const taken = slugChanged && check?.slug === slug && check.status === "taken";
  const checking = slugChanged && !localSlugErr && (check?.slug !== slug || check.status === "checking");
  const slugErr = localSlugErr ?? (taken ? "Already taken" : null);
  const dirty = name !== ws.name || slugChanged;

  useEffect(() => {
    if (!slugChanged || localSlugErr) return;
    let alive = true;
    const t = setTimeout(async () => {
      setCheck({ slug, status: "checking" });
      try {
        const r = await api.workspaces.slugAvailability(ws.slug, slug);
        if (alive) setCheck({ slug, status: r.available && r.slug === slug ? "available" : "taken" });
      } catch {
        if (alive) setCheck(null);
      }
    }, 450);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [slug, slugChanged, localSlugErr, ws.slug]);

  useEffect(() => {
    if (phase !== "saved") return;
    const t = setTimeout(() => setPhase("edit"), 2200);
    return () => clearTimeout(t);
  }, [phase]);

  useLeaveGuard(dirty && phase !== "saving", () => setShake((s) => s + 1));

  const discard = () => {
    setName(ws.name);
    setSlug(ws.slug);
    setCheck(null);
    setPhase("edit");
  };

  const save = async () => {
    if (!dirty || nameErr || slugErr || checking) return;
    setPhase("saving");
    try {
      const body: { name?: string; slug?: string } = {};
      if (name !== ws.name) body.name = name.trim();
      if (slugChanged) body.slug = slug;
      const next = await api.workspaces.update(ws.slug, body);
      qc.setQueryData(qk.workspace(next.slug), next);
      void qc.invalidateQueries({ queryKey: qk.workspaces() });
      setPhase("saved");
      if (next.slug !== ws.slug) router.replace(routes.settings(next.slug, "general"));
      setName(next.name);
      setSlug(next.slug);
    } catch (e) {
      setPhase("error");
      if (isApiError(e) && e.fieldErrors.slug) setCheck({ slug, status: "taken" });
    }
  };

  let state: SaveState = "idle";
  if (phase === "saving") state = "saving";
  else if (phase === "error") state = "error";
  else if (phase === "saved") state = "saved";
  else if (dirty) state = nameErr || slugErr ? "invalid" : checking ? "pending" : "dirty";

  let help: { text: string; tone?: "err" | "ok" } = { text: "a–z, 0–9, hyphens" };
  if (slugErr) help = { text: slugErr, tone: "err" };
  else if (checking) help = { text: "Checking…" };
  else if (slugChanged && check?.status === "available") help = { text: "Available · old URL redirects", tone: "ok" };

  return (
    <>
      <SettingsSection title="General">
        <div className="flex items-center gap-3">
          <WorkspaceBadge name={name || ws.name} hue={ws.hue} />
          <span className="text-[12px] text-fg-3">Icon from name</span>
        </div>
        <Field label="Workspace name" error={nameErr}>
          <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoComplete="organization" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ws-slug" className="text-meta font-medium text-fg-2">
            URL
          </label>
          <div
            className={cn(
              "flex h-8 items-center rounded-sm border border-control bg-surface transition-[border-color,box-shadow] max-[1023px]:h-11",
              "focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]",
              slugErr && "border-danger focus-within:border-danger",
            )}
          >
            <span className="pl-2.5 font-mono text-[12.5px] text-fg-3">{URL_HOST}</span>
            <input
              id="ws-slug"
              value={slug}
              maxLength={40}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={slugErr ? true : undefined}
              aria-describedby="ws-slug-help"
              onChange={(e) => setSlug(e.target.value)}
              className="h-full min-w-0 flex-1 border-0 bg-transparent font-mono focus-visible:shadow-none text-[12.5px] font-medium text-fg outline-none"
            />
            <span className="flex w-[30px] justify-center" aria-hidden>
              {checking ? (
                <Spinner />
              ) : slugErr ? (
                <AlertCircle size={14} className="text-danger" />
              ) : slugChanged && check?.status === "available" ? (
                <Check size={14} className="text-ok" />
              ) : null}
            </span>
          </div>
          <span className="flex items-center gap-1.5 font-mono text-[12px] leading-4 text-fg-3">
            <Link2 size={12} aria-hidden />
            <span>
              {URL_HOST}
              <b className="font-semibold text-accent-t">
              {slug
                ? slugSegments(slug).map((s, i) =>
                    s.bad ? (
                      <span key={i} className="rounded-[2px] bg-danger-s text-danger">
                        {s.text}
                      </span>
                    ) : (
                      <span key={i}>{s.text}</span>
                    ),
                  )
                : "…"}
              </b>
            </span>
          </span>
          <span
            id="ws-slug-help"
            role={help.tone === "err" ? "alert" : "status"}
            className={cn("min-h-4 text-[12px] leading-4", help.tone === "err" ? "text-danger" : help.tone === "ok" ? "text-ok" : "text-fg-3")}
          >
            {help.text}
          </span>
        </div>
      </SettingsSection>
      <SaveBar state={state} shake={shake} onSave={() => void save()} onDiscard={discard} className="order-last" />
    </>
  );
}

function WorkspaceReadOnly() {
  const ws = useCurrentWorkspace()!;
  const members = useWsMembers(ws.slug);
  const roles = useRoles(ws.slug);
  const [copied, setCopied] = useState(false);
  const owner = useMemo(() => {
    const ownerIds = new Set((roles.data ?? []).filter(isOwnerRole).map((r) => r.id));
    return members.data?.find((m) => ownerIds.has(m.roleId))?.user;
  }, [members.data, roles.data]);
  const url = `https://${URL_HOST}${ws.slug}`;
  return (
    <>
      <div className="mb-5 flex items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2.5 text-[12.5px] text-fg-2">
        <Eye size={14} aria-hidden />
        <span className="flex-1">View only</span>
        {owner && (
          <span className="flex items-center gap-1.5">
            Owner
            <Avatar name={owner.name} hue={owner.hue} size={20} ring={false} decorative />
            <span className="text-fg">{owner.name}</span>
          </span>
        )}
      </div>
      <SettingsSection title="General">
        <div className="flex items-center gap-3">
          <WorkspaceBadge name={ws.name} hue={ws.hue} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[12px] text-fg-3">Workspace name</span>
            <span className="text-[14px] font-semibold">{ws.name}</span>
          </div>
        </div>
        <div className="flex items-end gap-3 pt-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[12px] text-fg-3">URL</span>
            <span className="truncate font-mono text-[12.5px] text-fg-3">
              {URL_HOST}
              <span className="text-accent-t">{ws.slug}</span>
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(url).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <Check size={13} className="text-ok" aria-hidden /> : <Copy size={13} aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </SettingsSection>
    </>
  );
}

function ProjectsSection() {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const qc = useQueryClient();
  const canAssign = useCan("project.assign_admin");
  const dir = useQuery({ queryKey: qk.directory(ws.slug), queryFn: () => api.workspaces.projectDirectory(ws.slug) });
  const members = useWsMembers(ws.slug);
  const roles = useRoles(ws.slug);
  const adminRole = projectAdminRole(roles.data ?? []);

  const assign = async (project: { id: string; key: string; name: string }, user: { id: string; name: string }) => {
    if (!adminRole) return;
    try {
      await api.projects.addMember(project.id, user.id, adminRole.id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.directory(ws.slug) }),
        qc.invalidateQueries({ queryKey: qk.projects(ws.slug) }),
        qc.invalidateQueries({ queryKey: qk.members(project.id) }),
        qc.invalidateQueries({ queryKey: ["project", ws.slug, project.key.toUpperCase()] }),
      ]);
      toast.success(`${user.id === me.id ? "You are" : `${user.name} is`} now ${adminRole.name} on ${project.name}`);
    } catch (e) {
      toast.error("Couldn’t assign admin", { body: errorMessage(e) });
    }
  };

  return (
    <SettingsSection
      title="Projects"
      description={canAssign ? "Make any member a Project Admin. Workspace roles don’t grant project access." : "Every project in this workspace."}
    >
      {dir.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading projects" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[52px] w-full rounded-[10px]" />
          ))}
        </div>
      ) : dir.isError ? (
        <ErrorState title="Couldn’t load projects" body={errorMessage(dir.error)} onRetry={() => void dir.refetch()} retrying={dir.isFetching} />
      ) : dir.data.length === 0 ? (
        <p className="m-0 rounded-[10px] border border-dashed border-line-2 px-4 py-5 text-center text-[13px] text-fg-3">No projects yet</p>
      ) : (
        <ul className="m-0 list-none rounded-[10px] border border-line bg-surface p-0">
          {dir.data.map((p) => {
            const adminIds = new Set(p.admins.map((a) => a.id));
            const candidates = (members.data ?? []).filter((m) => m.status === "active" && !adminIds.has(m.userId));
            return (
              <li key={p.id} className="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-2 last:border-b-0">
                <ProjectBadge code={p.key.slice(0, 2)} hue={p.hue} size={22} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="font-mono text-[11px] text-fg-3">{p.key}</span>
                    {p.status === "archived" && <Tag>Archived</Tag>}
                  </span>
                  <span className="truncate text-[12px] text-fg-3">
                    {p.admins.length ? `Admins: ${p.admins.map((a) => a.name).join(", ")}` : "No project admin"}
                    {p.isMember ? " · You’re a member" : ""}
                  </span>
                </span>
                {p.admins.length > 0 && <AvatarStack people={p.admins} max={3} size={20} />}
                {canAssign && adminRole && (
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="secondary" size="sm" className="max-[760px]:h-11">
                        <UserPlus size={13} aria-hidden /> Assign admin
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="end" width={240} className="max-h-[320px] overflow-y-auto">
                      <MenuLabel>Make {adminRole.name}</MenuLabel>
                      {candidates.length === 0 && (
                        <MenuItem disabled>Everyone is already an admin</MenuItem>
                      )}
                      {candidates.map((m) => (
                        <MenuItem
                          key={m.userId}
                          icon={<Avatar name={m.user.name} hue={m.user.hue} size={18} ring={false} decorative />}
                          onSelect={() => void assign(p, m.user)}
                        >
                          {m.user.name}
                          {m.userId === me.id ? " (you)" : ""}
                        </MenuItem>
                      ))}
                    </MenuContent>
                  </Menu>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
}

function DangerZone() {
  const ws = useCurrentWorkspace()!;
  const dir = useQuery({ queryKey: qk.directory(ws.slug), queryFn: () => api.workspaces.projectDirectory(ws.slug) });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.location.hash === "#danger-zone") ref.current?.scrollIntoView({ block: "start" });
  }, []);
  const counts = `${dir.data ? `${dir.data.length} ${dir.data.length === 1 ? "project" : "projects"} · ` : ""}${ws.memberCount} ${ws.memberCount === 1 ? "member" : "members"}`;
  return (
    <section ref={ref} id="danger-zone" aria-labelledby="danger-zone-h" className="mt-8 scroll-mt-6">
      <h2 id="danger-zone-h" className="m-0 mb-3 text-[16px] font-semibold">
        Danger zone
      </h2>
      <div className="rounded-lg border border-danger bg-surface">
        <div className="flex items-center gap-4 px-[18px] py-4 max-[760px]:flex-col max-[760px]:items-start">
          <div className="min-w-0 flex-1">
            <h3 className="m-0 mb-1 text-[13px] font-semibold">Delete workspace</h3>
            <p className="m-0 font-mono text-[12px] text-fg-3">{counts}</p>
            <p className="m-0 mt-1 text-[12px] text-fg-3">Soft delete: restorable for 30 days.</p>
          </div>
          <Button variant="danger" onClick={() => setOpen(true)} className="max-[760px]:h-11">
            Delete workspace
          </Button>
        </div>
      </div>
      {open && <DeleteWorkspaceDialog counts={counts} onClose={() => setOpen(false)} />}
    </section>
  );
}

function DeleteWorkspaceDialog({ counts, onClose }: { counts: string; onClose: () => void }) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const st = confirmState(text, ws.slug);
  const msg =
    st === "empty" ? "Type the URL slug to enable delete" : st === "prefix" ? "Keep typing" : st === "match" ? "Matches" : "Doesn’t match";

  const confirm = async () => {
    if (st !== "match" || busy) return;
    setBusy(true);
    try {
      await api.workspaces.remove(ws.slug, text);
      toast.success(`${ws.name} scheduled for deletion`, { body: "Restorable for 30 days." });
      qc.removeQueries({ queryKey: qk.workspace(ws.slug) });
      await qc.invalidateQueries({ queryKey: qk.workspaces() });
      router.replace("/");
    } catch (e) {
      toast.error("Couldn’t delete workspace", { body: errorMessage(e) });
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      role="alertdialog"
      width={420}
      title={`Delete ${ws.name}?`}
      description="Everyone loses access right away. The workspace and its projects are restorable for 30 days, then removed for good."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabledReason={st === "match" ? undefined : "Type the URL slug to enable delete"}
            onClick={confirm}
          >
            Delete workspace
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {counts.split(" · ").map((c) => (
          <span key={c} className="inline-flex h-[22px] items-center rounded-sm border border-line bg-raised px-2 font-mono text-[11.5px] text-fg-2">
            {c}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="ws-confirm" className="text-[12px] font-medium text-fg-2">
          Type <code className="rounded-xs border border-line bg-raised px-[5px] py-px font-mono text-[12px]">{ws.slug}</code> to confirm
        </label>
        <Input
          id="ws-confirm"
          mono
          autoFocus
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
          value={text}
          aria-invalid={st === "mismatch" ? true : undefined}
          aria-describedby="ws-confirm-status"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void confirm();
          }}
        />
        <span
          id="ws-confirm-status"
          role="status"
          className={cn("flex items-center gap-1.5 text-[12px]", st === "match" ? "text-ok" : st === "mismatch" ? "text-danger" : "text-fg-3")}
        >
          {st === "mismatch" && <TriangleAlert size={12} aria-hidden />}
          {msg}
        </span>
      </div>
    </Modal>
  );
}
