import { mockConfig } from "@/lib/env";
import { createStore } from "@/lib/utils/store";

/** Runtime knobs for the mock backend, changed from the dev tools panel. */
export type MockControls = {
  errorRate: number;
  latencyMin: number;
  latencyMax: number;
  offline: boolean;
  /** Simulated teammates occasionally edit tasks (drives polling + version conflicts) and, board 33, show presence. */
  teammates: boolean;
  /** Board 33: "polling" makes the simulated stream answer "unavailable" (exercises the v1 fallback). */
  realtime: "live" | "polling";
};

const STORAGE_KEY = "lightex-mock-controls";

/** Dev-panel choices survive reloads; e2e tests use the same key to turn off injected errors. */
function saved(): Partial<MockControls> {
  try {
    if (typeof window === "undefined") return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<MockControls>) : {};
  } catch {
    return {};
  }
}

export const mockControls = createStore<MockControls>({
  errorRate: mockConfig.errorRate,
  latencyMin: mockConfig.latencyMin,
  latencyMax: mockConfig.latencyMax,
  offline: false,
  teammates: true,
  realtime: "live",
  ...saved(),
});

if (typeof window !== "undefined") {
  mockControls.subscribe(() => {
    try {
      const { offline: _offline, ...rest } = mockControls.get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch {
      /* storage unavailable: settings last for this tab only */
    }
  });
}
