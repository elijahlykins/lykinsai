import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = pathResolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function resolveAlias(specifier) {
  const base = pathResolve(root, "src", specifier.slice(2));
  if (existsSync(base)) return base;
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return base;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const filePath = resolveAlias(specifier);
    return nextResolve(pathToFileURL(filePath).href, context);
  }
  return nextResolve(specifier, context);
}
