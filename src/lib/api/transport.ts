/**
 * The seam between the typed endpoint functions and the backend.
 * Live mode: HttpTransport (fetch). Mock mode: MockTransport (in-browser router + DB).
 * Swapping backends only means providing a different Transport.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type QueryValue = string | number | boolean | null | undefined | (string | number)[];

export interface ListQuery {
  cursor?: string | null;
  limit?: number;
  q?: string;
  sort?: string;
  /** filter[key]=value; arrays repeat the parameter (OR). */
  filter?: Record<string, QueryValue>;
  [extra: string]: QueryValue | Record<string, QueryValue> | undefined;
}

export interface RequestOptions {
  method: HttpMethod;
  /** Path under /api/v1, starting with "/". */
  path: string;
  query?: ListQuery;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip auth + refresh handling (login, refresh, public invite lookups). */
  anonymous?: boolean;
}

export interface Transport {
  request<T>(options: RequestOptions): Promise<T>;
}

/** Serialises filter[...], sort, q and cursor params exactly as the contract describes. */
export function buildQueryString(query?: ListQuery): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  const add = (k: string, v: QueryValue) => {
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.append(k, String(v));
  };
  for (const [k, v] of Object.entries(query)) {
    if (k === "filter" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [fk, fv] of Object.entries(v as Record<string, QueryValue>)) add(`filter[${fk}]`, fv);
    } else {
      add(k, v as QueryValue);
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Parses a query string back into ListQuery (used by the mock router). */
export function parseQueryString(search: string): ListQuery {
  const sp = new URLSearchParams(search);
  const out: ListQuery = {};
  const filter: Record<string, (string | number)[]> = {};
  sp.forEach((value, key) => {
    const m = /^filter\[(.+)\]$/.exec(key);
    if (m) (filter[m[1]!] ??= []).push(value);
    else if (key === "limit") out.limit = Number(value);
    else out[key] = value;
  });
  if (Object.keys(filter).length) {
    out.filter = Object.fromEntries(
      Object.entries(filter).map(([k, v]) => [k, v.length === 1 ? v[0] : v]),
    ) as Record<string, QueryValue>;
  }
  return out;
}
