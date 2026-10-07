"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Lock, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { LogoMark, Wordmark } from "@/components/brand/logo";
import { Avatar, ProjectBadge } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CopyRef } from "@/components/ui/feedback";
import { StatusGlyph } from "@/components/ui/glyphs";
import { Kbd } from "@/components/ui/kbd";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { ProjectAccessInfo } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { shell } from "./shell-state";

/* Edge screens (board 23 §2): 404, 403 with request access, 500 with retry + reference. */

export function EdgeLayout({ path, children, bare }: { path?: string; children: ReactNode; bare?: boolean }) {
  return (
    <div className={cn("flex flex-col bg-bg", bare ? "h-full min-h-[420px]" : "min-h-dvh")}>
      {!bare && (
        <div className="flex h-12 items-center gap-3 border-b border-line bg-surface px-[18px]">
          <Wordmark size={16} />
          {path && <span className="ml-1.5 font-mono text-[12px] font-medium text-fg-3">{path}</span>}
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3.5 p-6 text-center">{children}</div>
    </div>
  );
}

function IconTile({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return (
    <span
      className={cn(
        "flex size-12 items-center justify-center rounded-lg",
        danger ? "bg-danger-s text-danger" : "border border-line-2 bg-raised text-fg-2",
      )}
    >
      {children}
    </span>
  );
}

const h2 = "m-0 max-w-[420px] text-[20px] font-semibold leading-7 tracking-[-0.015em]";

export function NotFoundScreen({ path, home = "/", bare, title = "Page not found" }: { path?: string; home?: string; bare?: boolean; title?: string }) {
  return (
    <EdgeLayout bare={bare}>
      <div aria-hidden className="flex items-center text-[64px] font-semibold leading-none tracking-[-0.05em] text-fg-3">
        4
        <LogoMark className="mx-1.5 h-[46px] w-[54px] opacity-90" bar="var(--text-3)" />4
      </div>
      <h2 className={h2}>{title}</h2>
      {path && <p className="m-0 font-mono text-[12px] text-fg-3">{path}</p>}
      <div className="mt-1.5 flex flex-wrap justify-center gap-2">
        <Button variant="primary" asChild>
          <Link href={home}>Go to My work</Link>
        </Button>
        <Button onClick={() => shell.openPalette()}>
          Search <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </Button>
      </div>
    </EdgeLayout>
  );
}

export function ErrorScreen({ error, onRetry, bare }: { error: unknown; onRetry: () => Promise<unknown> | void; bare?: boolean }) {
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const ref = isApiError(error) ? error.ref : undefined;
  const request = isApiError(error) ? error.request : undefined;
  const status = isApiError(error) ? error.status : 500;
  return (
    <EdgeLayout bare={bare}>
      <IconTile danger>
        <TriangleAlert size={22} aria-hidden />
      </IconTile>
      <h2 className={h2}>Something went wrong</h2>
      <p className="m-0 font-mono text-[12px] text-fg-3">
        {request ?? "request"} · {status || "offline"}
      </p>
      <p className="m-0 max-w-[420px] text-[13px] text-fg-2">{errorMessage(error)}</p>
      <div className="mt-1.5 flex flex-wrap justify-center gap-2">
        <Button
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRetry();
            } finally {
              setBusy(false);
              setAttempts((a) => a + 1);
            }
          }}
        >
          {busy ? "Retrying" : attempts ? "Retry again" : "Retry"}
        </Button>
      </div>
      {attempts > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-center gap-2">
          <span className="inline-flex h-[30px] animate-[rise-in_220ms_var(--ease)] items-center gap-2 rounded-full bg-danger-s px-3 font-medium text-danger">
            <CircleAlert size={14} aria-hidden /> Still failing · attempt {attempts}
          </span>
          {ref && (
            <span className="inline-flex h-[30px] items-center rounded-[7px] border border-line-2 bg-raised pl-2.5 pr-1">
              <CopyRef value={ref} />
            </span>
          )}
        </div>
      )}
    </EdgeLayout>
  );
}

/** 403 for a project the user is not a member of (no workspace override). */
export function ProjectForbidden({ info, homeHref }: { info: ProjectAccessInfo | null; homeHref: string }) {
  const qc = useQueryClient();
  const [requestId, setRequestId] = useState<string | null>(info?.myRequest?.id ?? null);
  const [at, setAt] = useState<string | null>(info?.myRequest?.createdAt ?? null);
  const request = useMutation({
    mutationFn: () => api.projects.requestAccess(info!.id),
    onSuccess: (r) => {
      setRequestId(r.id);
      setAt(r.createdAt);
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const withdraw = useMutation({
    mutationFn: () => api.projects.withdrawAccessRequest(info!.id),
    onSuccess: () => {
      setRequestId(null);
      setAt(null);
    },
  });
  const admin = info?.admins[0];
  return (
    <EdgeLayout bare>
      <IconTile>
        <Lock size={20} aria-hidden />
      </IconTile>
      <h2 className={h2}>You’re not a member of this project</h2>
      {info && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-[13px]">
          <ProjectBadge code={info.key.slice(0, 2)} hue={info.hue} size={22} />
          <span className="font-medium">{info.name}</span>
          {admin && (
            <>
              <span className="font-mono text-[12px] text-fg-3">· admin</span>
              <Avatar name={admin.name} hue={admin.hue} size={20} decorative />
              <span className="text-fg-2">{admin.name}</span>
            </>
          )}
        </div>
      )}
      <p className="m-0 max-w-[420px] text-[13px] text-fg-2">
        Workspace roles don’t grant project access. A project admin can add you.
      </p>
      <div aria-live="polite" className="flex min-h-8 flex-col items-center gap-2">
        {requestId ? (
          <>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-[30px] animate-[rise-in_220ms_var(--ease)] items-center gap-2 rounded-full bg-ok-s px-3 font-medium text-ok">
                <StatusGlyph kind="done" /> Request sent
              </span>
              <Button size="sm" variant="ghost" loading={withdraw.isPending} onClick={() => withdraw.mutate()}>
                Withdraw
              </Button>
            </div>
            <span className="font-mono text-[11px] text-fg-3">
              {admin ? `${admin.name} notified` : "Project admins notified"} · {at ? relative(at) : "just now"}
            </span>
          </>
        ) : (
          <div className="flex flex-wrap justify-center gap-2">
            {info && (
              <Button variant="primary" loading={request.isPending} onClick={() => request.mutate()}>
                {request.isPending ? "Sending" : "Request access"}
              </Button>
            )}
            <Button variant="ghost" asChild>
              <Link href={homeHref}>Back to My work</Link>
            </Button>
          </div>
        )}
        {request.isError && <span className="text-meta text-danger">{errorMessage(request.error)}</span>}
      </div>
    </EdgeLayout>
  );
}

function relative(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
