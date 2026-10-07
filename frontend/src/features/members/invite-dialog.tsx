"use client";

import * as D from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { DialogClose, Modal, Sheet } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Role } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { cn } from "@/lib/utils/cn";
import {
  addChips,
  classifyChips,
  consumeTyping,
  inviteHint,
  inviteMessage,
  sendLabel,
  splitEmails,
} from "./lib";

/** Invite dialog (board 18 A.6). Modal on desktop, bottom sheet ≤ 760px. */
export function InviteDialog({
  open,
  onOpenChange,
  slug,
  workspaceName,
  roles,
  defaultRoleId,
  knownEmails,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  workspaceName: string;
  /** Assignable roles (Owner excluded). */
  roles: Role[];
  defaultRoleId: string | undefined;
  /** Members and pending invites: chips matching these are skipped. */
  knownEmails: string[];
}) {
  const mobile = useIsMobile();
  const title = `Invite to ${workspaceName}`;
  const body = open ? (
    <InviteForm
      slug={slug}
      workspaceName={workspaceName}
      roles={roles}
      defaultRoleId={defaultRoleId}
      knownEmails={knownEmails}
      onDone={() => onOpenChange(false)}
    />
  ) : null;

  if (mobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} title={title} height="auto" className="max-h-[92dvh]">
        <div className="flex flex-col gap-2.5 overflow-y-auto px-4 pb-5 pt-2">
          <h2 className="m-0 text-[16px] font-semibold leading-[22px] tracking-[-0.01em]">{title}</h2>
          {body}
        </div>
      </Sheet>
    );
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} width={460} className="gap-2.5 px-5 pb-4 pt-[18px]">
      <DialogClose label="Close (Esc)" className="absolute right-3.5 top-3.5" />
      {body}
    </Modal>
  );
}

function InviteForm({
  slug,
  workspaceName,
  roles,
  defaultRoleId,
  knownEmails,
  onDone,
}: {
  slug: string;
  workspaceName: string;
  roles: Role[];
  defaultRoleId: string | undefined;
  knownEmails: string[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [emails, setEmails] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(true);
  const [roleId, setRoleId] = useState(defaultRoleId ?? roles[0]?.id ?? "");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const chips = useMemo(() => classifyChips(emails, knownEmails), [emails, knownEmails]);
  const valid = chips.filter((c) => c.state === "ok").map((c) => c.email);
  const anyBad = chips.some((c) => c.state === "bad");
  const msg = inviteMessage(chips, workspaceName);
  const hint = inviteHint(chips);
  const role = roles.find((r) => r.id === roleId);
  const canSend = valid.length > 0 && !anyBad && Boolean(roleId);

  const commit = (raw: string) => {
    const parts = splitEmails(raw);
    if (parts.length) setEmails((list) => addChips(list, parts));
  };

  const send = async () => {
    if (!canSend || sending) return;
    setSending(true);
    try {
      const created = await api.workspaces.invite(slug, valid, roleId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.invites(slug) }),
        qc.invalidateQueries({ queryKey: qk.wsMembers(slug) }),
      ]);
      const n = created.length;
      if (n === 0) toast.info("Everyone is already in the workspace");
      else toast.success(n === 1 ? `Invite sent to ${created[0]!.email}` : `${n} invitations sent`);
      onDone();
    } catch (e) {
      toast.error("Couldn’t send invites", { body: errorMessage(e) });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (text.trim()) {
        commit(text);
        setText("");
      } else void send();
    } else if (e.key === "Tab" && text.trim()) {
      e.preventDefault();
      commit(text);
      setText("");
    } else if (e.key === "Backspace" && !text && emails.length) {
      setEmails((list) => list.slice(0, -1));
    }
  };

  return (
    <>
      <label htmlFor="invite-emails" className="mt-1 text-[12px] font-medium text-fg-2">
        Emails
      </label>
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          "flex min-h-[42px] cursor-text flex-wrap gap-1.5 rounded-md border border-line-2 bg-bg p-1.5",
          "transition-[border-color,box-shadow] duration-[var(--dur-fast)] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-s)]",
          anyBad && !focused && "border-danger",
        )}
      >
        {chips.map((c) => (
          <span
            key={c.email}
            title={c.state === "bad" ? "Invalid email" : c.state === "dup" ? "Already a member" : undefined}
            className={cn(
              "inline-flex h-[26px] max-w-full animate-[menu-in_140ms_var(--ease)] items-center gap-1 rounded-sm border pl-2 pr-[3px] text-[12.5px] font-medium",
              c.state === "ok" && "border-line-2 bg-raised",
              c.state === "bad" && "border-danger bg-transparent text-danger",
              c.state === "dup" && "border-dashed border-line-2 text-fg-3 line-through",
            )}
          >
            <span className="truncate">{c.email}</span>
            {c.state !== "ok" && <span className="sr-only">{c.state === "bad" ? "(invalid)" : "(already a member)"}</span>}
            <button
              type="button"
              aria-label={`Remove ${c.email}`}
              onClick={(e) => {
                e.stopPropagation();
                setEmails((list) => list.filter((x) => x !== c.email));
                inputRef.current?.focus();
              }}
              className="inline-flex size-5 flex-none items-center justify-center rounded-xs opacity-75 hover:bg-hover hover:opacity-100"
            >
              <X size={9} strokeWidth={2.2} aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id="invite-emails"
          autoFocus
          value={text}
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="invite-msg"
          placeholder={emails.length ? undefined : "name@team.dev, …"}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (text.trim()) {
              commit(text);
              setText("");
            }
          }}
          onChange={(e) => {
            const { chips: done, rest } = consumeTyping(e.target.value);
            if (done.length) setEmails((list) => addChips(list, done));
            setText(rest);
          }}
          onKeyDown={onKeyDown}
          className="h-7 min-w-[140px] flex-1 border-0 bg-transparent px-1 focus-visible:shadow-none text-[13px] text-fg outline-none placeholder:text-fg-3 max-[760px]:text-[15px]"
        />
      </div>
      <p
        id="invite-msg"
        role="alert"
        className={cn("m-0 min-h-4 text-[12px] leading-4", msg?.tone === "error" ? "text-danger" : "text-fg-3")}
      >
        {msg?.text}
      </p>

      <span className="text-[12px] font-medium text-fg-2" id="invite-role-label">
        Role
      </span>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-labelledby="invite-role-label invite-role-value"
            className="flex h-[38px] w-full items-center gap-2.5 rounded-md border border-line-2 bg-bg pl-3 pr-2.5 text-left text-[13px] font-medium transition-[border-color] hover:border-control data-[state=open]:border-accent max-[760px]:h-11"
          >
            <span id="invite-role-value">{role?.name ?? "Choose a role"}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-normal text-fg-3">{role?.description}</span>
            <ChevronDown size={14} className="text-fg-3" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          <MenuRadioGroup value={roleId} onValueChange={setRoleId}>
            {roles.map((r) => (
              <MenuRadioItem key={r.id} value={r.id} className="h-auto min-h-[30px] py-1.5">
                <span className="flex min-w-0 items-baseline gap-2.5">
                  <span>{r.name}</span>
                  <span className="truncate text-[12px] font-normal text-fg-3">{r.description}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>

      <div className="mt-2 flex items-center gap-2 border-t border-line pt-3 max-[760px]:[&>button]:h-11 max-[760px]:[&>button]:flex-1">
        <span className="flex-1 text-[12px] text-fg-3 max-[760px]:hidden">{hint}</span>
        <D.Close asChild>
          <Button variant="ghost">Cancel</Button>
        </D.Close>
        <Button
          variant="primary"
          onClick={send}
          loading={sending}
          disabledReason={canSend ? undefined : hint || "Add an email to send"}
        >
          {sendLabel(valid.length)}
        </Button>
      </div>
    </>
  );
}
