/** The one error shape every API call rejects with: { code, message, details } (+ status, ref). */

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "version_conflict"
  | "role_in_use"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | (string & {});

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error implements ApiErrorBody {
  code: ApiErrorCode;
  details?: Record<string, unknown>;
  status: number;
  /** Request reference id for support ("Ref 7F3A-91C2"). */
  ref?: string;
  /** "GET /projects/x/board" for the 500 screen. */
  request?: string;

  constructor(body: ApiErrorBody & { status: number; ref?: string; request?: string }) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.details = body.details;
    this.status = body.status;
    this.ref = body.ref;
    this.request = body.request;
  }

  /** Field errors from a 422 `validation_failed`. */
  get fieldErrors(): Record<string, string> {
    const f = this.details?.fields;
    return f && typeof f === "object" ? (f as Record<string, string>) : {};
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (isApiError(e)) return e.message || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

export function isConflict(e: unknown) {
  return isApiError(e) && e.code === "version_conflict";
}
export function isForbidden(e: unknown) {
  return isApiError(e) && (e.status === 403 || e.code === "forbidden");
}
export function isNotFound(e: unknown) {
  return isApiError(e) && (e.status === 404 || e.code === "not_found");
}
