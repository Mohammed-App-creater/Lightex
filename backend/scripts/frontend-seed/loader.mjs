import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../frontend/src") + "/";
function withExt(base) {
  for (const ext of ["", ".ts", ".tsx", "/index.ts"]) if (existsSync(base + ext) && !base.endsWith("/") && (ext || /\.\w+$/.test(base))) return base + ext;
  return null;
}
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const hit = withExt(SRC + specifier.slice(2));
    if (hit) return next(pathToFileURL(hit).href, context);
  }
  if (specifier.startsWith(".") && context.parentURL && !/\.(m?[jt]sx?|json)$/.test(specifier)) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    const hit = withExt(base);
    if (hit) return next(pathToFileURL(hit).href, context);
  }
  return next(specifier, context);
}
