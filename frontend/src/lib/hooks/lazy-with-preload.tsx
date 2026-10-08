"use client";

import dynamic, { type DynamicOptionsLoadingProps } from "next/dynamic";
import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { createStore } from "@/lib/utils/store";

/*
 * next/dynamic always suspends on a component's first render, even when its chunk is already
 * downloaded, and React then holds the reveal for up to 300ms (its Suspense fallback throttle).
 * For open-on-demand surfaces (task panel, palette, dialogs) that is a visible delay on first open.
 *
 * lazyWithPreload keeps the code split, but once `preload()` has resolved (call it at idle)
 * `Component` renders the real module synchronously, so the next open skips the fallback.
 */
export function lazyWithPreload<P extends object>(
  load: () => Promise<ComponentType<P>>,
  options: { loading?: (props: DynamicOptionsLoadingProps) => ReactNode } = {},
) {
  const store = createStore<ComponentType<P> | null>(null);
  const loadOnce = () =>
    load().then((c) => {
      // createStore treats a function argument as an updater, and a component is a function.
      if (!store.get()) store.set(() => c);
      return c;
    });
  const Lazy = dynamic(loadOnce, { ssr: false, ...options });
  const none = () => null;
  function Component(props: P) {
    const Loaded = useSyncExternalStore(store.subscribe, store.get, none);
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  }
  return { Component, preload: () => void loadOnce() };
}

/**
 * Runs `fn` when the browser is idle; returns a cancel function. With `deadlineMs` the browser runs
 * it by then even if never idle (use for work the next click will almost certainly need). Without
 * it, a busy device simply never pays for the warm-up and the lazy path takes over.
 */
export function whenIdle(fn: () => void, deadlineMs?: number) {
  if (typeof window === "undefined") return () => {};
  if ("requestIdleCallback" in window) {
    const id = window.requestIdleCallback(fn, deadlineMs ? { timeout: deadlineMs } : undefined);
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(fn, deadlineMs ?? 4000);
  return () => clearTimeout(id);
}
