import { errorMessage, isApiError } from "@/api/errors";
import type { WorkspaceModule } from "@/api/types";

/* Settings → Modules (platform Stage 3): pure helpers, unit-tested. */

const nameOf = (modules: readonly WorkspaceModule[], key: string) => modules.find((m) => m.key === key)?.name ?? key;

function list(names: string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The toast for a failed toggle: `module_dependency` and `module_not_toggleable` get their own copy. */
export function moduleToggleError(err: unknown, mod: Pick<WorkspaceModule, "key" | "name">, enabled: boolean, modules: readonly WorkspaceModule[]) {
  if (isApiError(err) && err.code === "module_dependency") {
    const keys = Array.isArray(err.details?.modules) ? (err.details.modules as string[]) : [];
    const names = list(keys.map((k) => nameOf(modules, k)));
    return enabled
      ? { title: `Turn on ${names || "its dependencies"} first`, body: `${mod.name} needs ${names ? (keys.length > 1 ? "them" : "it") : "other modules"} to work.` }
      : {
          title: `${names || "Another module"} ${keys.length > 1 ? "need" : "needs"} ${mod.name}`,
          body: `Turn off ${names || "the modules that depend on it"} first.`,
        };
  }
  if (isApiError(err) && err.code === "module_not_toggleable") {
    return { title: `${mod.name} is always on`, body: "It can’t be turned off for a workspace." };
  }
  return { title: `Couldn’t turn ${mod.name} ${enabled ? "on" : "off"}`, body: errorMessage(err) };
}

/** Core first, then the order the server lists them in. */
export const sortModules = (modules: readonly WorkspaceModule[]) => [...modules].sort((a, b) => Number(b.isCore) - Number(a.isCore));
