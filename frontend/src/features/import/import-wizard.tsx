"use client";

import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Avatar, ProjectBadge } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { DialogShell } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { useProjectMembers } from "@/features/projects/queries";
import { isAdminRole } from "@/features/settings/project-lib";
import { useProjects, useRoles } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { ImportJob, ImportSource, Project } from "@/lib/api/types";
import { uploadImportFile } from "@/lib/api/uploads";
import { apiMode } from "@/lib/env";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { replaceUrl, routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { analysisErrorMeta, canImport, canImportInto, footerReason, isActiveStatus, isTerminalStatus, precheckImportFile, stepOf, type WizardStep } from "./import-lib";
import { CheckGlyph, ImportIcon, LockGlyph, WarnGlyph } from "./parts";
import { unwatchImport, useCancelImport, useImportFinished, useImportJob, useSaveMapping, useStartImport, watchImport } from "./queries";
import { StepMap } from "./step-map";
import { StepResult, StepRunning, StepSummary } from "./step-run";
import { StepSource } from "./step-source";
import { StepUpload, type UploadState } from "./step-upload";

/*
 * Board 40 import wizard (docs/v2/40-import-wizard.md §1.4, §6.5). A modal hosted by the project
 * shell and opened with ?import=new; once a job exists the URL becomes ?import=<jobId> (replaceUrl),
 * so a reload or a notification reopens the same job. The step is derived from the job status:
 * draft / no job → 1–2, ready → 3–4 (summary), queued / running → 4 running, finished → 4 result.
 */

const STEP_LABELS = ["Source", "Upload", "Map", "Import"] as const;

function urlWithImport(value: string | null) {
  const sp = new URLSearchParams(window.location.search);
  if (value) sp.set("import", value);
  else sp.delete("import");
  const qs = sp.toString();
  return qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
}

function uploadError(name: string, e: unknown): UploadState {
  if (isApiError(e) && (e.status === 422 || e.status === 403 || e.status === 429)) {
    const title = e.fieldErrors.file ?? e.fieldErrors.source ?? e.message;
    return { phase: "error", title, meta: analysisErrorMeta(name, e.details?.file as Record<string, unknown> | undefined) };
  }
  return { phase: "error", title: "Couldn’t read file", meta: `${name} · Upload interrupted. Try again.` };
}

export function ImportWizard({ param, project: current, onClose }: { param: string; project: Project; onClose: () => void }) {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const wideViewport = useMediaQuery("(min-width: 1280px)");
  const projectsQ = useProjects(ws.slug);

  const [jobId, setJobId] = useState<string | null>(param === "new" ? null : param);
  const [seenParam, setSeenParam] = useState(param);
  const [adopted, setAdopted] = useState<string | null>(param === "new" ? "new" : null);
  const [targetId, setTargetId] = useState(current.id);
  const [source, setSource] = useState<ImportSource | null>(null);
  const [step, setStep] = useState<WizardStep>(1);
  const [file, setFile] = useState<File | null>(null);
  const [up, setUp] = useState<UploadState>({ phase: "idle" });
  const [shake, setShake] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Another ?import=<id> while open (inbox row, history "Open"): load that job.
  if (param !== seenParam) {
    setSeenParam(param);
    if (param !== "new" && param !== jobId) {
      setJobId(param);
      setAdopted(null);
    }
  }

  const jobQ = useImportJob(jobId);
  const job = jobQ.data && jobQ.data.id === jobId ? jobQ.data : undefined;
  // A job opened from the URL decides the source, target and step once.
  if (job && adopted !== job.id) {
    setAdopted(job.id);
    setSource(job.source);
    setTargetId(job.projectId);
    setStep(stepOf(job).step);
  }

  const projects = projectsQ.data ?? [];
  const importable = projects.filter(canImportInto);
  const target = projects.find((p) => p.id === targetId) ?? (targetId === current.id ? current : undefined);

  const running = Boolean(job && isActiveStatus(job.status));
  const finished = Boolean(job?.startedAt && isTerminalStatus(job.status));
  const phase = running ? "running" : finished ? "result" : "setup";
  const ready = job?.status === "ready" ? job : null;
  const lostFile = job && !job.startedAt && (job.status === "failed" || job.status === "canceled") ? job : null;
  const curStep: WizardStep = phase !== "setup" ? 4 : step >= 3 && !ready ? 2 : step;

  // Finishing: the §6.3 invalidation once; the wizard is open, so no toast (the watcher stands down).
  useImportFinished(job, ws.slug, (j) => unwatchImport(j.id));
  useEffect(() => {
    if (job && isActiveStatus(job.status)) watchImport(job.id);
  }, [job]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const discard = (j: ImportJob | null | undefined) => {
    if (j && (j.status === "draft" || j.status === "ready")) void api.imports.cancel(j.id).catch(() => undefined);
  };

  const begin = async (f: File, projectId = targetId, src: ImportSource = source ?? "csv") => {
    const problem = precheckImportFile(f);
    if (problem) {
      setUp({ phase: "error", ...problem });
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    discard(job);
    setJobId(null);
    setAdopted("new");
    replaceUrl(urlWithImport("new"));
    setFile(f);
    setUp({ phase: "uploading", name: f.name, pct: 0 });
    let draftId: string | null = null;
    try {
      const analysed = await uploadImportFile(
        projectId,
        src,
        f,
        (pct) => {
          if (!ac.signal.aborted) setUp(pct >= 100 ? { phase: "analyzing", name: f.name } : { phase: "uploading", name: f.name, pct });
        },
        ac.signal,
        (d) => {
          draftId = d.id;
        },
      );
      if (ac.signal.aborted) {
        discard(analysed);
        return;
      }
      qc.setQueryData(qk.importJob(analysed.id), analysed);
      setAdopted(analysed.id);
      setJobId(analysed.id);
      setUp({ phase: "idle" });
      replaceUrl(urlWithImport(analysed.id));
    } catch (e) {
      if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      // A failed analysis leaves a draft: discard it now (Replace starts a new job anyway).
      if (draftId) void api.imports.cancel(draftId).catch(() => undefined);
      setUp(uploadError(f.name, e));
    }
  };

  const remove = () => {
    abortRef.current?.abort();
    discard(job);
    setJobId(null);
    setAdopted("new");
    setFile(null);
    setUp({ phase: "idle" });
    replaceUrl(urlWithImport("new"));
  };

  // §1.4: changing the project (or the source) after a file was chosen discards the draft and
  // silently re-uploads the same File, so mapping restarts from the new suggestions.
  const changeTarget = (id: string) => {
    if (id === targetId) return;
    setTargetId(id);
    if (file && (job || up.phase !== "idle")) void begin(file, id);
    else if (job) remove();
  };
  const changeSource = (s: ImportSource) => {
    if (s === source) return;
    setSource(s);
    if (file && job && job.source !== s) void begin(file, targetId, s);
  };

  const importMore = () => {
    setJobId(null);
    setAdopted("new");
    setFile(null);
    setSource(null);
    setStep(1);
    setUp({ phase: "idle" });
    replaceUrl(urlWithImport("new"));
  };

  const sample =
    apiMode === "mock"
      ? () =>
          void import("@/lib/mock/import/fixtures/sample").then((m) => {
            if (!source) setSource("csv");
            void begin(m.sampleFile(), targetId, source ?? "csv");
          })
      : null;

  /* ───────── lock, loading, errors ───────── */

  const locked = (param === "new" && !canImport(current.my_permissions)) || (jobQ.isError && isApiError(jobQ.error) && jobQ.error.status === 403);
  const closeLabel = running ? "Close · the import keeps running" : "Close";

  let content: ReactNode;
  if (locked) {
    content = <LockPanel project={current} />;
  } else if (jobId && jobQ.isError) {
    content = (
      <Body>
        <ErrorState
          title={isApiError(jobQ.error) && jobQ.error.status === 404 ? "Import not found" : "Couldn’t load this import"}
          body={isApiError(jobQ.error) && jobQ.error.status === 404 ? "It may have expired. Imports are kept for 30 days." : errorMessage(jobQ.error)}
          onRetry={isApiError(jobQ.error) && jobQ.error.status === 404 ? undefined : () => void jobQ.refetch()}
        />
      </Body>
    );
  } else if ((jobId && !job) || !target) {
    content = (
      <Body>
        <div aria-busy="true" aria-label="Loading import" className="flex flex-col gap-3">
          <Skeleton className="h-[118px] w-full rounded-[10px]" />
          <Skeleton className="h-8 w-60" />
        </div>
      </Body>
    );
  } else if (phase === "running" && job) {
    content = <RunningPanel job={job} canStop={job.createdById === me.id || target.my_permissions.includes("project.update")} />;
  } else if (phase === "result" && job) {
    content = (
      <ResultPanel
        job={job}
        project={target}
        onMore={importMore}
        onOpen={() => router.push(routes.project(ws.slug, target.key, "list"))}
        onClose={onClose}
        canRetry={job.createdById === me.id}
      />
    );
  } else if (ready && curStep >= 3) {
    content = (
      <ReadyPanel
        key={ready.id}
        job={ready}
        project={target}
        step={curStep as 3 | 4}
        wide={wideViewport}
        onStep={setStep}
        shake={shake}
        onShake={() => setShake((s) => (s === 1 ? 2 : 1))}
      />
    );
  } else {
    const busy = up.phase === "uploading" || up.phase === "analyzing";
    const failedUpload: UploadState =
      up.phase === "idle" && lostFile ? { phase: "error", title: "Couldn’t read file", meta: lostFile.error?.message ?? `${lostFile.file.name} · Upload the file again.` } : up;
    const reason = footerReason(curStep, { source, uploading: busy, fileError: failedUpload.phase === "error", job: ready });
    content = (
      <>
        <Body>
          {curStep === 1 ? (
            <StepSource source={source} onSource={changeSource} projects={importable.length ? importable : [target]} target={target} onTarget={changeTarget} />
          ) : (
            <StepUpload source={source ?? "csv"} job={ready} upload={failedUpload} onFile={(f) => void begin(f)} onRemove={remove} sample={sample} />
          )}
        </Body>
        <Footer
          reason={reason}
          shake={shake}
          back={curStep > 1 ? () => setStep((curStep - 1) as WizardStep) : undefined}
          next={{
            label: "Next",
            blocked: Boolean(reason),
            onClick: () => (reason ? setShake((s) => (s === 1 ? 2 : 1)) : setStep((curStep + 1) as WizardStep)),
          }}
        />
      </>
    );
  }

  const intoProject = target ?? current;
  const wide = curStep === 3 && phase === "setup" && wideViewport && !locked;
  return (
    <DialogShell
      open
      onOpenChange={(o) => !o && onClose()}
      title="Import tasks"
      description={`Import tasks into ${intoProject.name}`}
      width={wide ? 1180 : locked ? 620 : 760}
      height={wide ? 860 : locked ? 420 : 640}
    >
      <div className="flex h-[54px] flex-none items-center gap-2.5 border-b border-line pl-5 pr-2.5 max-[760px]:pl-3.5">
        <span className="text-fg-2">
          <ImportIcon />
        </span>
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Import</h2>
        <span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] text-fg-3 max-[760px]:hidden">
          into
          <ProjectBadge code={intoProject.key} hue={intoProject.hue} />
          <span className="truncate">{intoProject.name}</span>
        </span>
        <span className="flex-1" />
        <Button variant="ghost" icon aria-label={closeLabel} tooltip={running ? closeLabel : undefined} onClick={onClose} className="max-[760px]:size-10">
          <X size={14} aria-hidden />
        </Button>
      </div>
      {!locked && <Stepper step={curStep} phase={phase} onGo={(n) => setStep(n)} />}
      {content}
    </DialogShell>
  );
}

/* ───────── frame pieces ───────── */

function Body({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 animate-[fade-in_200ms_var(--ease)] flex-col gap-[18px] overflow-auto px-[22px] pb-6 pt-5 max-[760px]:p-4">{children}</div>;
}

function Stepper({ step, phase, onGo }: { step: WizardStep; phase: "setup" | "running" | "result"; onGo: (n: WizardStep) => void }) {
  const fill = phase !== "setup" ? 1 : (step - 1) / 3;
  return (
    <ol aria-label="Import steps" className="relative m-0 grid flex-none list-none grid-cols-4 border-b border-line px-3 pb-3 pt-3.5">
      <span aria-hidden className="absolute left-[calc(12.5%+12px)] right-[calc(12.5%+12px)] top-[27px] h-0.5 overflow-hidden rounded-[1px] bg-line-2">
        <span className={cn("iw-fill absolute inset-0 rounded-[1px] bg-accent", phase === "running" && "iw-run")} style={{ transform: `scaleX(${fill})` }} />
      </span>
      {STEP_LABELS.map((label, i) => {
        const n = (i + 1) as WizardStep;
        const done = n < step || (n === 4 && phase === "result");
        const cur = n === step && !done;
        const spin = n === 4 && phase === "running";
        const canGo = done && phase === "setup" && n < step;
        const dot = (
          <>
            <span
              className={cn(
                "relative inline-flex size-[26px] items-center justify-center rounded-full border-[1.5px] border-line-2 bg-surface font-mono text-[11.5px] font-semibold text-fg-3",
                "transition-transform duration-[250ms] ease-[var(--spring)]",
                cur && "scale-[1.06] border-accent text-fg shadow-[0_0_0_4px_var(--accent-s)]",
                done && "border-accent bg-accent text-white",
              )}
            >
              {done ? <CheckGlyph /> : spin ? <span className="inline-block size-3 animate-[spin_.7s_linear_infinite] rounded-full border-2 border-line-2 border-t-fg-2" /> : n}
            </span>
            <span className={cn("max-w-full truncate text-[12px] font-medium text-fg-3 max-[760px]:text-[11px]", (cur || done) && "text-fg")}>{label}</span>
          </>
        );
        return (
          <li key={n} aria-current={cur ? "step" : undefined} className="relative flex min-w-0 flex-col items-center">
            {canGo ? (
              <button
                type="button"
                aria-label={`Back to step ${n}: ${label}`}
                onClick={() => onGo(n)}
                className="flex flex-col items-center gap-[7px] rounded-[8px] px-1 outline-none focus-visible:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--ring)] [&:hover>span:first-child]:border-accent-t"
              >
                {dot}
              </button>
            ) : (
              <span className="flex flex-col items-center gap-[7px] px-1">{dot}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

type NextBtn = { label: string; blocked: boolean; onClick: () => void };

function Footer({
  reason,
  muted,
  shake = 0,
  back,
  next,
  children,
}: {
  reason: string | null;
  muted?: boolean;
  shake?: number;
  back?: () => void;
  next?: NextBtn;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-h-[60px] flex-none items-center gap-2 border-t border-line bg-surface py-2 pl-5 pr-4 max-[760px]:gap-1.5 max-[760px]:px-3">
      <span
        key={shake}
        id={id}
        role="status"
        className={cn(
          "inline-flex min-w-0 items-center gap-[7px] overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] max-[760px]:whitespace-normal max-[760px]:text-[12px] max-[760px]:leading-[15px]",
          muted ? "text-fg-3" : "text-warn",
          shake === 1 && "iw-shake",
          shake === 2 && "iw-shake2",
        )}
      >
        {reason && !muted && <WarnGlyph />}
        {reason}
      </span>
      <span className="flex-1" />
      {back && (
        <Button variant="ghost" onClick={back} className="max-[760px]:h-10">
          Back
        </Button>
      )}
      {next && (
        <Button
          variant="primary"
          aria-disabled={next.blocked || undefined}
          aria-describedby={reason ? id : undefined}
          onClick={next.onClick}
          className={cn("max-[760px]:h-10", next.blocked && "cursor-not-allowed opacity-50 hover:bg-accent hover:shadow-none")}
        >
          {next.label}
          {next.label === "Next" && (
            <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6.5 4.5L10 8l-3.5 3.5" />
            </svg>
          )}
        </Button>
      )}
      {children}
    </div>
  );
}

/* ───────── step 3–4 (a ready job): the mapping saver lives here ───────── */

function ReadyPanel({
  job,
  project,
  step,
  wide,
  onStep,
  shake,
  onShake,
}: {
  job: ImportJob;
  project: Project;
  step: 3 | 4;
  wide: boolean;
  onStep: (s: WizardStep) => void;
  shake: number;
  onShake: () => void;
}) {
  const me = useMe();
  const { local, update, saving } = useSaveMapping(job);
  const start = useStartImport();
  const reason = step === 3 ? footerReason(3, { source: job.source, uploading: false, fileError: false, job }) : null;

  const onStart = () =>
    start.mutate(job.id, {
      onError: (e) => {
        toast.error("Couldn’t start the import", { body: errorMessage(e) });
        if (isApiError(e) && e.status === 422) onStep(3);
      },
    });

  return (
    <>
      <Body>{step === 3 ? <StepMap job={job} project={project} me={me} local={local} update={update} wide={wide} /> : <StepSummary job={job} project={project} />}</Body>
      <Footer
        reason={step === 3 ? reason : saving ? "Saving the mapping…" : null}
        muted={step === 4}
        shake={shake}
        back={() => onStep((step - 1) as WizardStep)}
        next={
          step === 3
            ? { label: "Next", blocked: Boolean(reason), onClick: () => (reason ? onShake() : onStep(4)) }
            : undefined
        }
      >
        {step === 4 && (
          <Button variant="primary" loading={start.isPending} disabledReason={saving ? "Saving the mapping…" : !job.validation?.ready ? (job.validation?.blockers[0]?.message ?? "Fix the mapping first") : undefined} onClick={onStart} className="max-[760px]:h-10">
            Start import
          </Button>
        )}
      </Footer>
    </>
  );
}

function RunningPanel({ job, canStop }: { job: ImportJob; canStop: boolean }) {
  const cancel = useCancelImport();
  return (
    <>
      <Body>
        <StepRunning job={job} />
      </Body>
      <Footer reason="Runs in the background" muted>
        {canStop && (
          <Button
            variant="ghost"
            loading={cancel.isPending}
            disabledReason={job.cancelRequested ? "Stopping after the current batch" : undefined}
            onClick={() => cancel.mutate(job.id, { onError: (e) => toast.error("Couldn’t stop the import", { body: errorMessage(e) }) })}
            className="max-[760px]:h-10"
          >
            Stop import
          </Button>
        )}
      </Footer>
    </>
  );
}

function ResultPanel({ job, project, onMore, onOpen, onClose, canRetry }: { job: ImportJob; project: Project; onMore: () => void; onOpen: () => void; onClose: () => void; canRetry: boolean }) {
  const start = useStartImport();
  return (
    <>
      <Body>
        <StepResult job={job} project={project} />
      </Body>
      <Footer reason={null}>
        {job.status === "failed" ? (
          <>
            <Button variant="ghost" onClick={onClose} className="max-[760px]:h-10">
              Close
            </Button>
            {canRetry && job.error?.code !== "file_missing" && (
              <Button
                variant="primary"
                loading={start.isPending}
                onClick={() => start.mutate(job.id, { onError: (e) => toast.error("Couldn’t retry the import", { body: errorMessage(e) }) })}
                className="max-[760px]:h-10"
              >
                Retry
              </Button>
            )}
            {job.error?.code === "file_missing" && (
              <Button variant="primary" onClick={onMore} className="max-[760px]:h-10">
                Import again
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onMore} className="max-[760px]:h-10">
              Import more
            </Button>
            <Button variant="primary" onClick={onOpen} className="max-[760px]:h-10">
              Open project
            </Button>
          </>
        )}
      </Footer>
    </>
  );
}

/** Direct URL without permission (§1.4 "Lock state"): the design's lock layout with v1 ReadOnlyNote text. */
function LockPanel({ project }: { project: Project }) {
  const ws = useCurrentWorkspace()!;
  const roles = useRoles(ws.slug);
  const members = useProjectMembers(project.id);
  const roleName = roles.data?.find((r) => r.id === project.myRoleId)?.name ?? "Member";
  const admins = (members.data ?? []).filter((m) => isAdminRole(roles.data?.find((r) => r.id === m.roleId))).map((m) => m.user);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
      <span className="inline-flex size-10 items-center justify-center rounded-[10px] border border-line-2 bg-raised text-fg-2">
        <LockGlyph />
      </span>
      <b className="text-[15px] font-semibold">
        Your role ({roleName}) can’t import tasks into {project.name}
      </b>
      <span className="font-mono text-[11px] text-fg-3">View only · {roleName}</span>
      {admins.length > 0 && (
        <span className="mt-1 inline-flex flex-wrap items-center justify-center gap-2 text-[12.5px] text-fg-2">
          <span className="font-mono text-[11px] text-fg-3">Admins</span>
          {admins.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1.5">
              <Avatar name={a.name} hue={a.hue} size={20} ring={false} decorative />
              {a.name}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
