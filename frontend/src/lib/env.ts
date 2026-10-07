/** Public runtime configuration. Everything here ships to the browser: no secrets. */

export type ApiMode = "mock" | "live";

export const apiMode: ApiMode = process.env.NEXT_PUBLIC_API_MODE === "live" ? "live" : "mock";

export const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

/**
 * Dev tools (role switcher, /dev/ui, mock controls). On by default in mock mode and in
 * development; off for live production builds unless NEXT_PUBLIC_DEV_TOOLS=true.
 */
export const devToolsEnabled =
  process.env.NEXT_PUBLIC_DEV_TOOLS === "true" ||
  (process.env.NEXT_PUBLIC_DEV_TOOLS !== "false" &&
    (apiMode === "mock" || process.env.NODE_ENV !== "production"));

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const mockConfig = {
  errorRate: num(process.env.NEXT_PUBLIC_MOCK_ERROR_RATE, 0.03),
  latencyMin: num(process.env.NEXT_PUBLIC_MOCK_LATENCY_MIN, 100),
  latencyMax: num(process.env.NEXT_PUBLIC_MOCK_LATENCY_MAX, 400),
};
