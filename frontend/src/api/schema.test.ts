// @vitest-environment node
import { readFileSync } from "node:fs";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import { describe, expect, it } from "vitest";

/*
 * Staleness check (platform Stage 5): `schema.d.ts` must be exactly what `npm run gen:api` writes from the backend's
 * `docs/openapi.yaml`. When this fails, the spec changed: run `npm run gen:api`, then fix what typecheck reports.
 * Also runnable alone as `npm run check:api`.
 */

const spec = new URL("../../../docs/openapi.yaml", import.meta.url);
const generated = new URL("./schema.d.ts", import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n");

describe("src/api/schema.d.ts", () => {
  it("matches a fresh generation from docs/openapi.yaml (run `npm run gen:api` if not)", async () => {
    const fresh = COMMENT_HEADER + astToString(await openapiTS(spec));
    const current = readFileSync(generated, "utf8");
    // A plain boolean keeps a 300 kB diff out of the failure message.
    expect(lf(current) === lf(fresh), "schema.d.ts is stale: run `npm run gen:api`").toBe(true);
  }, 60_000);
});
