#!/usr/bin/env node
/**
 * Run the Supabase → local migration from the terminal.
 *
 * The importer is reachable over IPC from the app, but there is no UI for it
 * yet and the migration needs to be rehearsed against real data before anyone
 * trusts it. This is that rehearsal harness.
 *
 * Two safety defaults, both deliberate:
 *
 *   It writes to ./.local-migration, not the installed app's data directory.
 *   A dress rehearsal must not be able to damage the store the real app is
 *   using. Pass --user-data to aim it somewhere else on purpose.
 *
 *   It reads and reports before it writes. Without --yes you get the preflight
 *   plan and nothing else happens.
 *
 * Everything it does against Supabase is a read; see cloudSource.cjs, which
 * refuses any method but GET and HEAD. The one exception is signing in, which
 * happens here rather than there precisely so the data reader stays read-only.
 *
 * Usage:
 *   node scripts/import-from-supabase.mjs --email you@example.com            # plan only
 *   node scripts/import-from-supabase.mjs --email you@example.com --dry-run
 *   node scripts/import-from-supabase.mjs --email you@example.com --yes
 *   LYKN_MIGRATE_TOKEN=... node scripts/import-from-supabase.mjs --yes
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.values[key] = next;
      i += 1;
    } else {
      args.flags.add(key);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const wantsWrite = args.flags.has("yes");
const dryRun = args.flags.has("dry-run");
const skipBlobs = args.flags.has("no-files");
const skipChats = args.flags.has("no-chats");
const restart = args.flags.has("restart");

/** Minimal .env reader — the repo has dotenv but this script predates any app boot. */
function loadEnv() {
  const envPath = path.join(repoRoot, ".env");
  const out = { ...process.env };
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (!(match[1] in out)) out[match[1]] = value;
  }
  return out;
}

const env = loadEnv();
const SUPABASE_URL = args.values.url || env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

if (!SUPABASE_URL) fail("No Supabase URL. Set VITE_SUPABASE_URL in .env or pass --url.");
if (!ANON_KEY) fail("No anon key. Set VITE_SUPABASE_ANON_KEY in .env.");

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      // Redraw the prompt without the typed characters.
      if (["\n", "\r", "\u0004"].includes(String(char))) return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(question);
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function signIn() {
  if (env.LYKN_MIGRATE_TOKEN) {
    return { accessToken: env.LYKN_MIGRATE_TOKEN, via: "LYKN_MIGRATE_TOKEN" };
  }

  const email = args.values.email || env.LYKN_MIGRATE_EMAIL;
  if (!email) fail("Pass --email you@example.com, or set LYKN_MIGRATE_TOKEN.");

  const password = env.LYKN_MIGRATE_PASSWORD || (await promptHidden(`Password for ${email}: `));
  if (!password) fail("No password given.");

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    fail(`Sign-in failed (HTTP ${res.status}). ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data?.access_token) fail("Sign-in returned no access token.");
  return { accessToken: data.access_token, userId: data.user?.id, via: email };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const mb = (bytes) => `${(Number(bytes || 0) / 1e6).toFixed(1)} MB`;

function renderProgress(status) {
  const { items, blobs, chats, phase } = status;
  const line =
    `  ${phase.padEnd(6)}  ` +
    `items ${items.imported}/${items.total || "?"}  ` +
    `files ${blobs.downloaded}+${blobs.skipped} (${mb(blobs.bytes)})  ` +
    `chats ${chats.imported}/${chats.total || "?"}  ` +
    `${items.failed + blobs.failed + chats.failed} failed`;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(line);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const userDataPath = path.resolve(
    args.values["user-data"] || path.join(repoRoot, ".local-migration"),
  );
  fs.mkdirSync(userDataPath, { recursive: true });

  const auth = await signIn();

  const localStore = require("../electron/localStore/index.cjs");
  const { importer } = localStore;

  const opened = localStore.configure(userDataPath);
  console.log(`\nLocal store : ${opened.path} (schema v${opened.version})`);
  console.log(`Supabase    : ${SUPABASE_URL}`);
  console.log(`Signed in as: ${auth.via}`);

  // Resolve the user id from the token itself rather than trusting a flag.
  const whoami = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, apikey: ANON_KEY },
  }).then((r) => (r.ok ? r.json() : null));
  const userId = auth.userId || whoami?.id;
  if (!userId) fail("Could not determine the signed-in user id.");

  importer.configure({
    url: SUPABASE_URL,
    accessToken: auth.accessToken,
    apiKey: ANON_KEY,
    userId,
  });

  const plan = await importer.preflight();
  if (!plan.ok) fail(`Preflight failed: ${plan.reason}`);

  console.log("\nIn the cloud");
  console.log(`  vault items : ${plan.cloud.items}`);
  console.log(`  chats       : ${plan.cloud.chats}`);
  console.log("On this device");
  console.log(`  items       : ${plan.local.items} (${plan.local.imported} previously imported)`);
  console.log(`  threads     : ${plan.local.threads}`);
  if (plan.resumable) console.log("  a previous run left a cursor; this run would resume from it");

  if (!wantsWrite && !dryRun) {
    console.log("\nPlan only. Re-run with --dry-run to exercise the reads, or --yes to migrate.");
    localStore.shutdown();
    return;
  }

  console.log(`\n${dryRun ? "Dry run" : "Migrating"} — Ctrl-C is safe, progress is saved per page.\n`);

  const started = Date.now();
  importer.events.on("progress", renderProgress);
  process.on("SIGINT", () => {
    console.log("\n\nCancelling…");
    importer.cancel();
  });

  await importer.start({
    dryRun,
    includeBlobs: !skipBlobs,
    includeChats: !skipChats,
    restart,
    // Embedding is a separate, resumable pass; keep this run about moving data.
    reindex: false,
  });

  while (importer.status().running) {
    await new Promise((r) => setTimeout(r, 250));
  }

  const final = importer.status();
  renderProgress(final);
  console.log("\n");

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${final.cancelled ? "Cancelled" : "Finished"} in ${seconds}s`);
  console.log(`  items   : ${final.items.imported} imported, ${final.items.failed} failed`);
  console.log(
    `  files   : ${final.blobs.downloaded} downloaded (${mb(final.blobs.bytes)}), ` +
      `${final.blobs.skipped} already present, ${final.blobs.missing} missing in the bucket, ` +
      `${final.blobs.failed} failed`,
  );
  console.log(
    `  chats   : ${final.chats.imported} imported with ${final.chats.messages} messages, ` +
      `${final.chats.failed} failed`,
  );
  if (final.error) console.log(`  error   : ${final.error}`);

  if (!dryRun && !final.cancelled) {
    console.log("\nVerifying against the cloud…");
    const report = await importer.verify();
    console.log(`  items : ${report.items.local} local vs ${report.items.cloud} cloud`);
    console.log(`  chats : ${report.chats.local} local vs ${report.chats.cloud} cloud`);
    if (report.ok) {
      console.log("  everything accounted for");
    } else {
      console.log(`  MISSING: ${report.items.missing} rows, ${report.blobs.missing} files`);
      for (const id of report.missingItems.slice(0, 10)) console.log(`    row  ${id}`);
      for (const b of report.missingBlobs.slice(0, 10)) console.log(`    file ${b.path}`);
      if (report.truncated) console.log("    (list truncated)");
    }

    const pending = localStore.indexer.pendingCount();
    console.log(
      `\nEmbeddings: ${pending.items + pending.threads} source(s) waiting. ` +
        "The app builds these in the background on next launch.",
    );
  }

  localStore.shutdown();
}

main().catch((err) => {
  console.error(`\nMigration threw: ${err?.stack || err}`);
  process.exit(1);
});
