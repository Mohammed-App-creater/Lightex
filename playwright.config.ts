import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

/** One smoke suite against the mock API. Reuses a running `next dev` on the same port. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: true,
    timeout: 240_000,
    env: { NEXT_PUBLIC_API_MODE: "mock", NEXT_PUBLIC_MOCK_ERROR_RATE: "0" },
  },
});
