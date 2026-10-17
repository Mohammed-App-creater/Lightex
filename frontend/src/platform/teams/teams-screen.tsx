"use client";

import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Avatar, AvatarStack } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/choice";
import { EmptyState, ErrorState, Skeleton } from "@/ui/feedback";
import { Field, Input, Textarea } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { ConfirmDialog, Modal } from "@/ui/modal";
import { toast } from "@/ui/toast";
import { errorMessage } from "@/api/errors";
import type { Team, TeamDetail, WorkspaceMember } from "@/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { cn } from "@/lib/utils/cn";
import { useCan, useCurrentWorkspace } from "@/platform/roles/can";
import { SettingsPage } from "@/platform/settings/settings-shell";
import { useWsMembers } from "@/platform/workspace/queries";
import { TEAM_DESCRIPTION_MAX, TEAM_NAME_MAX, addableMembers, countLabel, memberErrorText, teamFieldError, teamNameError } from "./lib";
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useRemoveTeamMember,
  useSetTeamLead,
  useTeam,
  useTeams,
  useUpdateTeam,
} from "./queries";

/*
 * Settings → Teams (docs/platform/stage4-contract.md §4): flat teams with members and leads. Every workspace member can
 * read the page; writes need core.teams.manage. Without it the main write controls stay visible with a
 * disabledReason, and per-member controls (remove, lead switch) are not rendered (leads show as a badge).
 */

export const NO_TEAMS_PERMISSION = "You need the Manage teams permission";

export function TeamsScreen() {
  const ws = useCurrentWorkspace()!;
  const canManage = useCan("core.teams.manage");
  const mobile = useIsMobile();
  const teams = useTeams(ws.slug);
  const members = useWsMembers(ws.slug);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editing, setEditing] = useState<Team | "new" | null>(null);

  const list = teams.data ?? [];
  const current = list.find((t) => t.id === selected) ?? list[0] ?? null;
  const reason = canManage ? undefined : NO_TEAMS_PERMISSION;

  const newButton = (
    <Button variant="primary" disabledReason={reason} onClick={() => setEditing("new")}>
      <Plus size={14} aria-hidden /> New team
    </Button>
  );

  let body;
  if (teams.isPending) {
    body = <TeamsSkeleton />;
  } else if (teams.isError) {
    body = <ErrorState title="Couldn’t load teams" onRetry={() => void teams.refetch()} retrying={teams.isFetching} />;
  } else if (!current) {
    body = (
      <EmptyState
        icon={<UsersRound size={20} strokeWidth={1.5} aria-hidden />}
        title="No teams yet"
        body={canManage ? "Group people into teams, like Frontend or Support, and pick their leads." : "Workspace admins haven’t created any teams."}
        actions={canManage ? newButton : undefined}
      />
    );
  } else {
    const showList = !mobile || !detailOpen;
    const showDetail = !mobile || detailOpen;
    body = (
      <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-5 max-[1023px]:grid-cols-[190px_minmax(0,1fr)] max-[1023px]:gap-3.5 max-[760px]:grid-cols-1">
        {showList && (
          <nav aria-label="Teams">
            <ul className="m-0 flex list-none flex-col gap-px p-0">
              {list.map((t) => {
                const on = t.id === current.id && !mobile;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      aria-current={on ? "true" : undefined}
                      onClick={() => {
                        setSelected(t.id);
                        setDetailOpen(true);
                      }}
                      className={cn(
                        "flex h-[38px] w-full items-center gap-2.5 rounded-[7px] px-2 text-left text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg",
                        on && "bg-accent-s text-fg hover:bg-accent-s",
                        "max-[760px]:h-12 max-[760px]:rounded-none max-[760px]:border-b max-[760px]:border-line",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      <span className="font-mono text-[11px] text-fg-3" aria-label={countLabel(t.memberCount)}>
                        {t.memberCount}
                      </span>
                      {mobile && <ChevronRight size={14} className="text-fg-3" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
        {showDetail && (
          <TeamPanel
            key={current.id}
            team={current}
            members={members.data ?? []}
            canManage={canManage}
            mobile={mobile}
            onBack={() => setDetailOpen(false)}
            onEdit={() => setEditing(current)}
            onDeleted={() => {
              setSelected(null);
              setDetailOpen(false);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <SettingsPage wide title="Teams" actions={newButton}>
      <p className="m-0 -mt-2 mb-5 max-w-[620px] text-[13px] leading-5 text-fg-2">
        Teams are flat groups of people in {ws.name}; anyone can be in several. A role whose permission is scoped to
        Team reaches the records of everyone in the holder’s teams.
      </p>
      {body}
      {editing && (
        <TeamDialog
          key={editing === "new" ? "new" : editing.id}
          team={editing === "new" ? null : editing}
          others={list.filter((t) => editing === "new" || t.id !== editing.id).map((t) => t.name)}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setSelected(t.id);
            setEditing(null);
          }}
        />
      )}
    </SettingsPage>
  );
}

function TeamPanel({
  team,
  members,
  canManage,
  mobile,
  onBack,
  onEdit,
  onDeleted,
}: {
  team: Team;
  members: WorkspaceMember[];
  canManage: boolean;
  mobile: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const ws = useCurrentWorkspace()!;
  const detail = useTeam(ws.slug, team.id);
  const remove = useDeleteTeam(ws.slug);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reason = canManage ? undefined : NO_TEAMS_PERMISSION;
  const hueOf = (userId: string) => members.find((m) => m.userId === userId)?.user.hue;
  const leads = (detail.data?.members ?? []).filter((m) => m.isLead);

  return (
    <section
      aria-label={`${team.name} team`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface px-[18px] pb-3 pt-[18px] max-[760px]:border-0 max-[760px]:bg-transparent max-[760px]:p-0"
    >
      <div className="flex items-center gap-2">
        {mobile && (
          <Button variant="ghost" icon aria-label="Back to teams" className="-ml-2.5 size-11" onClick={onBack}>
            <ChevronLeft size={16} aria-hidden />
          </Button>
        )}
        <h2 className="m-0 min-w-0 flex-1 truncate text-[17px] font-semibold leading-6 tracking-[-0.01em]">{team.name}</h2>
        <Button variant="secondary" disabledReason={reason} onClick={onEdit} aria-label="Edit team">
          <Pencil size={13} aria-hidden />
          <span className="max-[760px]:hidden">Edit</span>
        </Button>
        <Button variant="ghost" icon aria-label="Delete team" disabledReason={reason} className="hover:text-danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={15} aria-hidden />
        </Button>
      </div>
      {team.description ? <p className="m-0 leading-5 text-fg-2">{team.description}</p> : <p className="m-0 text-[12.5px] text-fg-3">No description</p>}
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-2">
        <span className="font-medium">{countLabel(team.memberCount)}</span>
        {leads.length > 0 && (
          <>
            <span className="text-fg-3">·</span>
            <AvatarStack people={leads.map((l) => ({ id: l.userId, name: l.name, hue: hueOf(l.userId) }))} max={3} size={20} />
            <span>Led by {leads.map((l) => l.name).join(", ")}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line pt-3">
        <h3 className="m-0 flex-1 text-[13px] font-semibold">Members</h3>
        <AddMember team={detail.data} members={members} canManage={canManage} />
      </div>
      {detail.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading members" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 py-1.5">
              <Skeleton className="size-7 rounded-full" />
              <span className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-2.5 w-40" />
              </span>
            </div>
          ))}
        </div>
      ) : detail.isError ? (
        <ErrorState title="Couldn’t load members" onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
      ) : detail.data.members.length === 0 ? (
        <p className="m-0 py-3 text-[12.5px] text-fg-3">{canManage ? "No members yet. Add people from the workspace." : "No members yet."}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {detail.data.members.map((m) => (
            <MemberRow key={m.userId} team={detail.data} member={m} hue={hueOf(m.userId)} canManage={canManage} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${team.name}”?`}
        description="Its members stay in the workspace. Permissions scoped to Team stop counting this team."
        confirmLabel="Delete team"
        confirmVariant="danger"
        onConfirm={() =>
          remove.mutateAsync(team.id).then(
            () => {
              toast.success(`Deleted ${team.name}`);
              onDeleted();
            },
            (e) => toast.error("Couldn’t delete team", { body: errorMessage(e) }),
          )
        }
      />
    </section>
  );
}

function AddMember({ team, members, canManage }: { team: TeamDetail | undefined; members: WorkspaceMember[]; canManage: boolean }) {
  const ws = useCurrentWorkspace()!;
  const add = useAddTeamMember(ws.slug);
  const options = addableMembers(members, team);
  const reason = !canManage ? NO_TEAMS_PERMISSION : team && options.length === 0 ? "Everyone in the workspace is already in this team" : undefined;
  const trigger = (
    <Button variant="secondary" size="sm" disabledReason={reason} loading={add.isPending}>
      <UserPlus size={13} aria-hidden /> Add member
    </Button>
  );
  if (reason || !team) return trigger;
  return (
    <Menu>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent align="end" width={260} className="max-h-[320px] overflow-y-auto">
        {options.map((m) => (
          <MenuItem
            key={m.userId}
            icon={<Avatar name={m.user.name} hue={m.user.hue} size={18} decorative ring={false} />}
            onSelect={() =>
              add.mutate(
                { id: team.id, userId: m.userId },
                {
                  onSuccess: () => toast.success(`Added ${m.user.name} to ${team.name}`),
                  onError: (e) => toast.error("Couldn’t add member", { body: memberErrorText(e) ?? errorMessage(e) }),
                },
              )
            }
          >
            {m.user.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function MemberRow({ team, member, hue, canManage }: { team: TeamDetail; member: TeamDetail["members"][number]; hue: number | undefined; canManage: boolean }) {
  const ws = useCurrentWorkspace()!;
  const setLead = useSetTeamLead(ws.slug);
  const remove = useRemoveTeamMember(ws.slug);
  return (
    <li className="flex min-h-12 items-center gap-3 border-b border-line py-1.5 last:border-b-0">
      <Avatar name={member.name} hue={hue} size={28} decorative ring={false} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 truncate text-[13px] font-medium">
          {member.name}
          {!canManage && member.isLead && <Badge>Lead</Badge>}
        </span>
        <span className="truncate text-[12px] text-fg-3">{member.email}</span>
      </span>
      {canManage && (
        <>
          <label className="flex min-h-11 items-center gap-2 text-[12.5px] text-fg-2">
            Lead
            <Switch
              checked={member.isLead}
              aria-label={`Lead: ${member.name}`}
              onChange={(e) =>
                setLead.mutate(
                  { id: team.id, userId: member.userId, isLead: e.target.checked },
                  { onError: (err) => toast.error("Couldn’t change the lead", { body: errorMessage(err) }) },
                )
              }
            />
          </label>
          <Button
            variant="ghost"
            icon
            aria-label={`Remove ${member.name}`}
            tooltip="Remove from team"
            className="hover:text-danger max-[760px]:size-11"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(
                { id: team.id, userId: member.userId },
                {
                  onSuccess: () => toast.success(`Removed ${member.name} from ${team.name}`),
                  onError: (e) => toast.error("Couldn’t remove member", { body: errorMessage(e) }),
                },
              )
            }
          >
            <X size={15} aria-hidden />
          </Button>
        </>
      )}
    </li>
  );
}

function TeamDialog({
  team,
  others,
  onClose,
  onSaved,
}: {
  team: Team | null;
  others: string[];
  onClose: () => void;
  onSaved: (t: Team) => void;
}) {
  const ws = useCurrentWorkspace()!;
  const create = useCreateTeam(ws.slug);
  const update = useUpdateTeam(ws.slug);
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [errors, setErrors] = useState<{ name?: string; description?: string }>({});
  const busy = create.isPending || update.isPending;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const nameError = teamNameError(name, others);
    if (nameError) return setErrors({ name: nameError });
    const body = { name: name.trim(), description: description.trim() };
    try {
      const saved = team ? await update.mutateAsync({ id: team.id, ...body }) : await create.mutateAsync(body);
      toast.success(team ? `Saved ${saved.name}` : `Created ${saved.name}`);
      onSaved(saved);
    } catch (err) {
      const field = teamFieldError(err);
      if (field) setErrors({ [field.field]: field.message });
      else toast.error(team ? "Couldn’t save team" : "Couldn’t create team", { body: errorMessage(err) });
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={team ? "Edit team" : "New team"}
      width={460}
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field label="Name" error={errors.name}>
          <Input
            autoFocus
            maxLength={TEAM_NAME_MAX}
            value={name}
            placeholder="e.g. Frontend"
            onChange={(e) => {
              setName(e.target.value);
              setErrors((x) => ({ ...x, name: undefined }));
            }}
          />
        </Field>
        <Field label="Description" hint="Optional" error={errors.description}>
          <Textarea
            maxLength={TEAM_DESCRIPTION_MAX}
            value={description}
            placeholder="What the team works on"
            onChange={(e) => {
              setDescription(e.target.value);
              setErrors((x) => ({ ...x, description: undefined }));
            }}
          />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy}>
            {team ? "Save" : "Create team"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TeamsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading teams" className="grid grid-cols-[240px_minmax(0,1fr)] gap-5 max-[760px]:grid-cols-1">
      <div className="flex flex-col gap-2">
        {[80, 64, 90].map((w, i) => (
          <Skeleton key={i} className="h-[38px] rounded-[7px]" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px] max-[760px]:hidden">
        <Skeleton className="h-6 w-[160px]" />
        <Skeleton className="h-3 w-[260px]" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 py-1.5">
            <Skeleton className="size-7 rounded-full" />
            <span className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-2.5 w-40" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
