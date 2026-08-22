#!/usr/bin/env node
/**
 * Download the on-device embedding model into ./models so it can be packaged
 * into the app.
 *
 * The model is not committed — it is 33 MB of binary that would bloat every
 * clone and every diff — but it is also not downloaded at runtime in a shipped
 * build. A local-first vault that needs the network before it can search is not
 * local-first, so the file is fetched here, at build time, and packaged as an
 * app resource. `npm run model:fetch` before an electron build.
 *
 * Every file is checked against a pinned SHA-256. The hub could serve different
 * bytes at the same path — a re-quantization, a compromised account — and those
 * bytes end up signed and notarized inside our application. Verify them.
 *
 * Usage:
 *   node scripts/fetch-embedding-model.mjs            # download if missing
 *   node scripts/fetch-embedding-model.mjs --force    # re-download
 *   node scripts/fetch-embedding-model.mjs --check    # verify only, exit 1 if bad
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Xenova/bge-small-en-v1.5";
const REVISION = "main";
const MODEL_NAME = "bge-small-en-v1.5";

/** Pinned contents. Update deliberately, never to make a failing build pass. */
const FILES = [
  {
    name: "config.json",
    bytes: 683,
    sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
  },
  {
    name: "tokenizer.json",
    bytes: 711396,
    sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
  },
  {
    name: "tokenizer_config.json",
    bytes: 366,
    sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  },
  {
    name: "onnx/model_quantized.onnx",
    bytes: 34014426,
    sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
  },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const targetDir = path.join(here, "..", "models", MODEL_NAME);

const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function verify(file, spec) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (stat.size !== spec.bytes) {
    return { ok: false, reason: `size ${stat.size}, expected ${spec.bytes}` };
  }
  const digest = await sha256(file);
  if (digest !== spec.sha256) {
    return { ok: false, reason: `sha256 ${digest.slice(0, 16)}…, expected ${spec.sha256.slice(0, 16)}…` };
  }
  return { ok: true };
}

async function download(spec) {
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${spec.name}?download=true`;
  const dest = path.join(targetDir, spec.name);
  const tmp = `${dest}.part`;

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  process.stdout.write(`  ${spec.name} … `);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  // Stream to a temp file: a half-written model that happens to be the right
  // size is worse than no model, and a partial file must never be left behind
  // under the real name where the loader would pick it up.
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  const result = await verify(tmp, spec);
  if (!result.ok) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`${spec.name}: ${result.reason}`);
  }
  await fsp.rename(tmp, dest);
  console.log(`ok (${(spec.bytes / 1e6).toFixed(1)} MB)`);
}

async function main() {
  console.log(`Embedding model: ${REPO} → models/${MODEL_NAME}`);

  let missing = 0;
  for (const spec of FILES) {
    const dest = path.join(targetDir, spec.name);
    const result = await verify(dest, spec);

    if (result.ok && !force) {
      console.log(`  ${spec.name} … already present`);
      continue;
    }
    if (checkOnly) {
      console.error(`  ${spec.name} … FAILED (${result.reason})`);
      missing += 1;
      continue;
    }
    if (!result.ok && result.reason !== "missing") {
      console.warn(`  ${spec.name} … re-downloading (${result.reason})`);
    }
    await download(spec);
  }

  if (checkOnly && missing) {
    console.error(`\n${missing} file(s) missing or corrupt. Run: npm run model:fetch`);
    process.exit(1);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(`\nFailed: ${err?.message || err}`);
  process.exit(1);
});
