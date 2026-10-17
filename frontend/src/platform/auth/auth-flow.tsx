"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppLoader } from "@/components/brand/app-loader";
import { Wordmark } from "@/components/brand/logo";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import type { User, Workspace } from "@/lib/api/types";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { AuthStyles, authStylesClasses as s } from "./auth-styles";
import { AuthFrame } from "./auth-ui";
import { useSession } from "./session";

/** Length of the post-sign-in logo animation (board 21 §2.8, ~1.06s + a beat). */
export const TRANSITION_MS = 1100;

type Finish = (
  result: { accessToken: string; user: User },
  opts: { to: string; workspaceName?: string },
) => void;

const FlowCtx = createContext<{ finish: Finish } | null>(null);

export function useAuthFlow() {
  const v = useContext(FlowCtx);
  if (!v) throw new Error("useAuthFlow must be used inside <AuthFlowProvider>");
  return v;
}

/**
 * Wraps every auth page: backdrop frame, "already signed in → /" guard (except invite links,
 * which a signed-in user may still accept), and the post-sign-in logo transition.
 */
export function AuthFlowProvider({ children }: { children: ReactNode }) {
  const { status, signedIn } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [transition, setTransition] = useState<{ workspaceName?: string } | null>(null);
  const finishing = useRef(false);
  const guarded = !pathname.startsWith("/invite");

  useEffect(() => {
    if (guarded && status === "authenticated" && !finishing.current) router.replace("/");
  }, [guarded, status, router]);

  const finish = useCallback<Finish>(
    (result, { to, workspaceName }) => {
      finishing.current = true;
      setTransition({ workspaceName });
      signedIn(result);
      const started = Date.now();
      let target = to;
      const resolveTarget = async () => {
        if (to !== "/") return;
        // "/" → the default workspace: fetch now so the transition can name it.
        try {
          // Direct call: signedIn() may clear the query cache (new user), which would cancel a fetchQuery.
          const list = await api.workspaces.list();
          qc.setQueryData<Workspace[]>(qk.workspaces(), list);
          const first = list[0];
          if (first) {
            setTransition({ workspaceName: first.name });
            target = routes.home(first.slug);
          } else target = routes.onboarding();
        } catch {
          /* "/" will sort it out */
        }
      };
      void resolveTarget().then(() => {
        const wait = Math.max(0, TRANSITION_MS - (Date.now() - started));
        setTimeout(() => router.replace(target), wait);
      });
    },
    [signedIn, qc, router],
  );

  const value = useMemo(() => ({ finish }), [finish]);

  let body: ReactNode;
  if (transition) body = <SignInTransition workspaceName={transition.workspaceName} />;
  else if (status === "loading" || (guarded && status === "authenticated")) body = <AppLoader />;
  else body = <AuthFrame>{children}</AuthFrame>;

  return <FlowCtx.Provider value={value}>{body}</FlowCtx.Provider>;
}

/** Board 21 §2.8: bar wipes, bolt strikes, flash, x settles, "Lighte" slides in, then the workspace. */
export function SignInTransition({ workspaceName }: { workspaceName?: string }) {
  const mobile = useIsMobile();
  return (
    <div
      role="status"
      aria-label="Signing you in"
      className={cn(s.fade, "fixed inset-0 z-50 flex flex-col items-center justify-center gap-7 bg-bg")}
    >
      <AuthStyles />
      <div className="lx-play">
        <Wordmark
          size={mobile ? 44 : 56}
          wordClassName="lx-word"
          markParts={{ bar: "lx-bar", bolt: "lx-bolt", flash: "lx-flash", whole: "lx-x" }}
        />
      </div>
      <span
        className={cn(
          s.ws,
          "h-4 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3",
          !workspaceName && "invisible",
        )}
      >
        {workspaceName ?? "Lightex"}
      </span>
    </div>
  );
}
