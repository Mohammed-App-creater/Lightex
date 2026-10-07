import { mockConfig } from "@/lib/env";
import { createStore } from "@/lib/utils/store";

/** Runtime knobs for the mock backend, changed from the dev tools panel. */
export type MockControls = {
  errorRate: number;
  latencyMin: number;
  latencyMax: number;
  offline: boolean;
  /** Simulated teammates occasionally edit tasks (drives polling + version conflicts). */
  teammates: boolean;
};

export const mockControls = createStore<MockControls>({
  errorRate: mockConfig.errorRate,
  latencyMin: mockConfig.latencyMin,
  latencyMax: mockConfig.latencyMax,
  offline: false,
  teammates: true,
});
