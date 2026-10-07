// Regenerates apps/common/fixtures/demo_seed.json from the web client's mock seed, so the live demo
// data matches mock mode. Run from backend/ with Node 22.6+:
//   node --import ./scripts/frontend-seed/register.mjs ./scripts/frontend-seed/dump-seed.mts > apps/common/fixtures/demo_seed.json
// Run it on 2026-10-07 (the seed's anchor date) or the dates will already be shifted; seed_demo shifts them itself.
import { pathToFileURL } from "node:url";
import path from "node:path";

const seed = path.resolve(import.meta.dirname, "../../../frontend/src/lib/mock/seed.ts");
const { createSeed } = await import(pathToFileURL(seed).href);
process.stdout.write(JSON.stringify(createSeed(), null, 1));
