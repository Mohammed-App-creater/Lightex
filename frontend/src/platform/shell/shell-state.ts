"use client";

import { useSyncExternalStore } from "react";
import { createStore } from "@/lib/utils/store";

export type PaletteScope = "cmd" | "proj" | "people" | null;

export type CreateTaskDefaults = {
  projectId?: string;
  statusId?: string;
  sprintId?: string | null;
  parentId?: string;
  title?: string;
  /** Board 32: the agenda FAB pre-fills the selected day. */
  dueDate?: string;
};

type ShellState = {
  /** Sidebar collapsed to the 64px rail (persisted per viewer). */
  collapsed: boolean;
  drawer: boolean;
  palette: boolean;
  paletteScope: PaletteScope;
  shortcuts: boolean;
  createTask: CreateTaskDefaults | null;
};

const COLLAPSE_KEY = "lightex-sidebar-collapsed";

function initialCollapsed() {
  try {
    return typeof window !== "undefined" && localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

const store = createStore<ShellState>({
  collapsed: false,
  drawer: false,
  palette: false,
  paletteScope: null,
  shortcuts: false,
  createTask: null,
});

let hydrated = false;
function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  store.set((s) => ({ ...s, collapsed: initialCollapsed() }));
}

const SERVER: ShellState = store.get();

export function useShell() {
  return useSyncExternalStore(store.subscribe, store.get, () => SERVER);
}

export const shell = {
  hydrate,
  get: store.get,
  setCollapsed(collapsed: boolean) {
    store.set((s) => ({ ...s, collapsed }));
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* private mode */
    }
  },
  toggleCollapsed() {
    shell.setCollapsed(!store.get().collapsed);
  },
  setDrawer: (drawer: boolean) => store.set((s) => ({ ...s, drawer })),
  openPalette: (scope: PaletteScope = null) => store.set((s) => ({ ...s, palette: true, paletteScope: scope, drawer: false })),
  closePalette: () => store.set((s) => ({ ...s, palette: false, paletteScope: null })),
  setShortcuts: (shortcuts: boolean) => store.set((s) => ({ ...s, shortcuts })),
  openCreateTask: (defaults: CreateTaskDefaults = {}) => store.set((s) => ({ ...s, createTask: defaults, palette: false })),
  closeCreateTask: () => store.set((s) => ({ ...s, createTask: null })),
};
