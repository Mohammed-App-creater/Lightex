import type { MockDB } from "./db-types";
import { ensureExt39 } from "./handlers/extensions";
import { ensureExt40 } from "./handlers/imports";
import { ensureExt32 } from "./handlers/schedule";
import { SCHEMA, createSeed } from "./seed";

/*
 * Mock database: lives in memory; localStorage is only a seed cache so edits survive reloads.
 * Clearing site data (or Dev tools → Reset mock data) restores the seed.
 */

const DB_KEY = "lightex-mock-db";
const SESSION_KEY = "lightex-mock-session";

let db: MockDB | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function canUseStorage() {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

export function getDB(): MockDB {
  if (db) return db;
  if (canUseStorage()) {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MockDB;
        if (parsed.schema === SCHEMA) {
          db = parsed;
          // Board 39: upgrade a database cached before v2 (roles, seed data, "Blocked" view), once.
          if (!db.ext39) {
            ensureExt39(db);
            persist();
          }
          // Board 32: start dates, epic dates and the extra dependency, once (needs board 39's data first).
          if (!db.ext32) {
            ensureExt32(db);
            persist();
          }
          // Board 40: project.import on cached system roles, once.
          if (!db.ext40) {
            ensureExt40(db);
            persist();
          }
          return db;
        }
      }
    } catch {
      /* corrupt cache: fall through to seed */
    }
  }
  db = createSeed();
  persistNow();
  return db;
}

export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 250);
}

function persistNow() {
  if (!db || !canUseStorage()) return;
  try {
    // Uploaded file bodies are not cached (they can be MBs); only metadata survives a reload.
    const slim = { ...db, attachments: db.attachments.map(({ content, ...a }) => (a.kind === "code" && content && content.length < 20_000 ? { ...a, content } : a)) };
    localStorage.setItem(DB_KEY, JSON.stringify(slim));
  } catch {
    /* quota exceeded: keep working in memory */
  }
}

export function resetDB() {
  db = createSeed();
  persistNow();
}

/** Replace the DB wholesale (tests). */
export function setDB(next: MockDB) {
  db = next;
}

/* Mock session: just the signed-in user id. Not a token; live mode never touches this. */
export const mockSession = {
  get(): string | null {
    if (!canUseStorage()) return memorySession;
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return memorySession;
    }
  },
  set(userId: string | null) {
    memorySession = userId;
    if (!canUseStorage()) return;
    try {
      if (userId) localStorage.setItem(SESSION_KEY, userId);
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  },
};
let memorySession: string | null = null;

let seq = 0;
export function uid(prefix: string) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const nowISO = () => new Date().toISOString();
