import { existsSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = pathResolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function isFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveAlias(specifier) {
  const base = pathResolve(root, "src", specifier.slice(2));
  if (isFile(base)) return base;
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (isFile(candidate)) return candidate;
  }
  // "@/lib/vault/repository" is a folder with an index — resolved by Vite, but
  // a bare directory import is a hard error in Node.
  for (const ext of EXTENSIONS) {
    const candidate = pathResolve(base, `index${ext}`);
    if (isFile(candidate)) return candidate;
  }
  return base;
}

/**
 * Relative imports in src/ are written without an extension, because Vite
 * resolves them ("moduleResolution": "bundler"). Node will not, so a module
 * that imports a sibling was previously untestable without writing imports
 * that look wrong to the rest of the codebase. Fill the extension in here
 * instead, and only when the bare specifier genuinely does not resolve.
 */
function resolveRelative(specifier, parentURL) {
  if (!parentURL?.startsWith("file:")) return null;
  const base = pathResolve(fileURLToPath(new URL(".", parentURL)), specifier);
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = pathResolve(base, `index${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const filePath = resolveAlias(specifier);
    return nextResolve(pathToFileURL(filePath).href, context);
  }

  if (specifier.startsWith(".")) {
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      const filePath = resolveRelative(specifier, context.parentURL);
      if (!filePath) throw err;
      return nextResolve(pathToFileURL(filePath).href, context);
    }
  }

  return nextResolve(specifier, context);
}
