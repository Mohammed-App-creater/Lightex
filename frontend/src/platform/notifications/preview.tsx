"use client";

import type { ReactNode } from "react";
import { Button } from "@/ui/button";
import { StatusGlyph, glyphColor } from "@/ui/glyphs";
import { Kbd } from "@/ui/kbd";
import { isForbidden, isNotFound } from "@/api/errors";
import type { Notification, User } from "@/api/types";
import { cn } from "@/lib/utils/cn";
import { agoLong, shortDate } from "@/lib/utils/dates";
import { useCurrentWorkspace } from "@/platform/roles/can";
import { targetPreviewsFor } from "@/registry";
import { notificationText } from "@/registry/services";
import { dueLabel, glyphForStatusName, isSystem } from "./events";
import { ArrowRightIcon, CheckIcon, CloseIcon, HollowCircleIcon } from "./icons";
import { WhoTile } from "./notification-row";
import { usePreviewTask } from "./preview-task";

/** Access requests are reviewed on the project's Members settings tab. */
export const accessHref = (ws: string, n: Pick<Notification, "type" | "payload">) =>
  n.type === "access" && n.payload.projectKey ? `/${ws}/projects/${n.payload.projectKey.toUpperCase()}/settings?tab=members` : null;

/** Board 40: a finished import reopens its result step on the project board. */
export const importHref = (ws: string, n: Pick<Notification, "type" | "payload">) =>
  n.type === "import" && n.payload.projectKey && n.payload.importId
    ? `/${ws}/projects/${n.payload.projectKey.toUpperCase()}/board?import=${encodeURIComponent(n.payload.importId)}`
    : null;

export const taskHref = (ws: string, taskKey: string, projectKey?: string) =>
  `/${ws}/projects/${(projectKey ?? taskKey.split("-")[0] ?? "").toUpperCase()}/board?task=${encodeURIComponent(taskKey)}`;

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[26px] items-center gap-[7px] whitespace-nowrap rounded-[7px] border border-line-2 bg-raised px-[9px] text-[12px] font-medium text-fg",
        className,
      )}
    >
      {children}
    </span>
  );
}

function StatusChip({ name }: { name: string }) {
  const kind = glyphForStatusName(name);
  return (
    <Chip>
      <StatusGlyph kind={kind} className="size-3" color={glyphColor[kind]} />
      {name}
    </Chip>
  );
}

export function PreviewContent({
  n,
  actor,
  me,
  members,
  slug,
  onClose,
  onToggleRead,
  onOpenTask,
  phone,
}: {
  n: Notification;
  actor: User | null;
  me: User;
  members: Map<string, User>;
  slug: string;
  onClose: () => void;
  onToggleRead: () => void;
  onOpenTask: (href: string) => void;
  phone?: boolean;
}) {
  const ws = useCurrentWorkspace();
  const taskQ = usePreviewTask(slug, n.taskKey);
  const task = taskQ.data;
  // The target's detail chips come from the module that owns it (registry slot), e.g. tracking's task chips.
  const targetPreviews = ws ? targetPreviewsFor(ws, n) : [];
  const gone = taskQ.isError && (isNotFound(taskQ.error) || isForbidden(taskQ.error));
  const read = Boolean(n.readAt);
  const toggleLabel = read ? "Mark unread" : "Mark read";
  const href = n.taskKey && !gone ? taskHref(slug, n.taskKey, task?.project.key) : null;
  const review = accessHref(slug, n);
  const importLink = importHref(slug, n);
  const title = task?.title ?? n.taskTitle ?? n.payload.sprintName ?? n.projectName ?? n.title ?? "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[52px] flex-none items-center gap-2 border-b border-line pl-[18px] pr-2.5">
        {n.taskKey && <span className="font-mono text-[12px] text-fg-2">{n.taskKey}</span>}
        <span className="truncate text-[12px] text-fg-3">{n.projectName}</span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          icon
          aria-label={toggleLabel}
          title={`${toggleLabel} (E)`}
          onClick={onToggleRead}
          className={phone ? "size-11" : undefined}
        >
          {read ? <HollowCircleIcon /> : <CheckIcon />}
        </Button>
        <Button variant="ghost" size="sm" icon aria-label="Close preview" title="Close (Esc)" onClick={onClose} className={phone ? "size-11" : undefined}>
          <CloseIcon />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-[18px]">
        <h3 id="nb-preview-title" className="m-0 text-[17px] font-semibold leading-6 tracking-[-0.01em]">
          {title}
        </h3>

        {targetPreviews.map(({ targetType, Component }) => (
          <Component key={targetType} n={n} slug={slug} members={members} />
        ))}

        <EventCard n={n} actor={actor} me={me} />
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-line px-[18px] pb-4 pt-3">
        {importLink ? (
          <Button variant="primary" data-open-task onClick={() => onOpenTask(importLink)} className={phone ? "h-11 flex-1" : undefined}>
            Open import
            {!phone && <Kbd>↵</Kbd>}
          </Button>
        ) : review ? (
          <Button variant="primary" data-open-task onClick={() => onOpenTask(review)} className={phone ? "h-11 flex-1" : undefined}>
            Review request
            {!phone && <Kbd>↵</Kbd>}
          </Button>
        ) : href ? (
          <Button variant="primary" data-open-task onClick={() => onOpenTask(href)} className={phone ? "h-11 flex-1" : undefined}>
            Open task
            {!phone && <Kbd>↵</Kbd>}
          </Button>
        ) : (
          n.taskKey && (
            <Button variant="primary" disabledReason="This task was deleted or you no longer have access" className={phone ? "h-11 flex-1" : undefined}>
              Open task
            </Button>
          )
        )}
        <Button variant="ghost" onClick={onToggleRead} className={phone ? "h-11" : undefined}>
          {toggleLabel}
        </Button>
      </div>
    </div>
  );
}

function importVerb(n: Notification) {
  const t = notificationText(n);
  return t ? `· ${t.lead} · ${t.rest}` : "";
}

function EventCard({ n, actor, me }: { n: Notification; actor: User | null; me: User }) {
  const system = isSystem(n) || !actor;
  const verb = n.type === "status" ? "changed status" : n.type === "sprint" ? `started ${n.payload.sprintName ?? "a sprint"}` : n.type === "due" ? "" : n.type === "mention" ? "mentioned you" : n.type === "assigned" ? "assigned you" : n.type === "access" ? `requested access to ${n.projectName ?? "a project"}` : n.type === "import" ? importVerb(n) : "commented";
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-bg p-3">
      <div className="flex items-center gap-2 text-[12.5px] text-fg-2">
        <WhoTile n={n} actor={actor} size={24} />
        <span className="min-w-0 truncate">
          {system ? (
            <>
              <b className="font-semibold text-fg">{n.type === "due" ? dueLabel(n.payload.dueDate) : "Lightex"}</b>
              {n.type === "due" && n.payload.dueDate ? ` ${shortDate(n.payload.dueDate)}` : verb ? ` ${verb}` : ""}
            </>
          ) : (
            <>
              <b className="font-semibold text-fg">{actor!.name}</b> {verb}
            </>
          )}
        </span>
        <span className="flex-1" />
        <span className="flex-none font-mono text-[11px] text-fg-3">{agoLong(n.createdAt)}</span>
      </div>
      {n.payload.quote && (
        <p className="m-0 text-[13px] leading-5 text-fg">
          {n.type === "mention" && (
            <span className="mr-1 rounded-[4px] bg-accent-s px-[3px] font-medium text-accent-t">@{me.name}</span>
          )}
          {n.payload.quote}
        </p>
      )}
      {n.type === "status" && n.payload.toStatus && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          {n.payload.fromStatus && <StatusChip name={n.payload.fromStatus} />}
          {n.payload.fromStatus && (
            <span className="text-fg-3">
              <ArrowRightIcon />
              <span className="sr-only">to</span>
            </span>
          )}
          <StatusChip name={n.payload.toStatus} />
        </div>
      )}
    </div>
  );
}
