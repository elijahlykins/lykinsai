// electron-builder afterSign hook: notarize the signed .app with Apple.
//
// Uses `xcrun notarytool` directly (not `@electron/notarize`). The npm helper
// runs `notarytool submit --wait --output-format json` and throws
// "Failed with unexpected result" with an empty body whenever Apple's queue
// takes longer than its spawn/parse path can handle — which is exactly what
// we hit when notarization sits In Progress for a long time. Direct CLI wait
// with a long timeout is reliable.
//
// NO-OPS (with a clear log line) unless credentials are present:
//
//   1) App Store Connect API key (recommended for CI):
//        APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
//
//   2) Apple ID + app-specific password:
//        APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...opts,
  });
  return res;
}

/**
 * Submit the zip once and return the submission id.
 *
 * notarytool 1.1.2 on macOS 26 dies with SIGBUS during `submit` — usually
 * AFTER the upload has landed in Apple's queue (observed 2026-09-03: `submit`
 * crashes, yet `history` shows the submission In Progress seconds later).
 * Recover the id from history instead of failing the whole release: find the
 * newest submission for this zip name created after we started the upload.
 */
function submitForNotarization(zipPath, authArgs) {
  const submittedAt = Date.now();
  console.log(`[notarize] Submitting ${zipPath} …`);
  // Submit without --wait so we get a clean JSON id even if the queue is slow.
  const submit = run("xcrun", [
    "notarytool",
    "submit",
    zipPath,
    ...authArgs,
    "--output-format",
    "json",
  ]);
  const submitOut = String(submit.stdout || "").trim();
  try {
    const submitted = JSON.parse(submitOut);
    if (!submitted?.id) {
      throw new Error(`[notarize] submit missing id:\n${submitOut}`);
    }
    return submitted.id;
  } catch {
    console.warn(
      `[notarize] submit crashed (code ${submit.status}, signal ${submit.signal}) — recovering id from history …`,
    );
  }
  const zipName = path.basename(zipPath);
  const history = run("xcrun", [
    "notarytool",
    "history",
    ...authArgs,
    "--output-format",
    "json",
  ]);
  let recovered = null;
  try {
    const parsed = JSON.parse(String(history.stdout || "").trim());
    // Allow a small clock skew between this machine and Apple.
    const cutoff = submittedAt - 5 * 60 * 1000;
    recovered = (parsed.history || [])
      .filter((h) => h.name === zipName && Date.parse(h.createdDate) >= cutoff)
      .sort((a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate))[0];
  } catch {
    recovered = null;
  }
  if (!recovered?.id) {
    throw new Error(
      `[notarize] submit returned non-JSON (code ${submit.status}) and no matching ` +
        `submission found in history:\n${submitOut}\n${submit.stderr || ""}`,
    );
  }
  console.log(`[notarize] Recovered submission id ${recovered.id} from history.`);
  return recovered.id;
}

/**
 * Wait for a submission to reach a terminal state; null when it is still
 * In Progress after `minutes`. Uses `notarytool wait`, falling back to
 * 30-second `info` polling when wait crashes (same SIGBUS family as submit).
 */
function waitForSubmission(id, authArgs, minutes) {
  const deadline = Date.now() + minutes * 60 * 1000;
  const wait = run(
    "xcrun",
    [
      "notarytool",
      "wait",
      id,
      ...authArgs,
      "--timeout",
      `${minutes}m`,
      "--output-format",
      "json",
    ],
    // wait blocks for the full timeout; don't let Node's default kill it.
    { timeout: 0 },
  );
  const waitOut = String(wait.stdout || "").trim();
  try {
    // wait may print progress on stderr; stdout should be final JSON
    const jsonLine = waitOut
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    const parsed = JSON.parse(jsonLine || waitOut);
    if (parsed?.status && parsed.status !== "In Progress") return parsed;
    return null;
  } catch {
    console.warn(
      `[notarize] wait crashed (code ${wait.status}, signal ${wait.signal}) — polling info for ${id} …`,
    );
  }
  for (;;) {
    const info = run("xcrun", [
      "notarytool",
      "info",
      id,
      ...authArgs,
      "--output-format",
      "json",
    ]);
    let parsed = null;
    try {
      parsed = JSON.parse(String(info.stdout || "").trim());
    } catch {
      parsed = null;
    }
    if (parsed?.status && parsed.status !== "In Progress") return parsed;
    if (Date.now() > deadline) return null;
    console.log(
      `[notarize] ${id} still ${parsed?.status || "unreadable"} — polling again in 30s …`,
    );
    run("sleep", ["30"]);
  }
}

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const appBundleId =
    (context.packager.config && context.packager.config.appId) || "ai.lykn.desktop";

  const hasApiKey =
    process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  const hasAppleId =
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;

  if (!hasApiKey && !hasAppleId) {
    if (process.env.LYKN_REQUIRE_NOTARIZATION === "1") {
      throw new Error(
        "[notarize] Release requires Apple notarization credentials. " +
          "Set APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, or " +
          "APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID.",
      );
    }
    console.log(
      "[notarize] Skipping — no Apple credentials in env. Set APPLE_API_KEY/" +
        "APPLE_API_KEY_ID/APPLE_API_ISSUER, or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/" +
        "APPLE_TEAM_ID to enable notarization.",
    );
    return;
  }

  if (!fs.existsSync(appPath)) {
    throw new Error(`[notarize] App not found at ${appPath}`);
  }

  const authArgs = hasApiKey
    ? [
        "--key",
        process.env.APPLE_API_KEY,
        "--key-id",
        process.env.APPLE_API_KEY_ID,
        "--issuer",
        process.env.APPLE_API_ISSUER,
      ]
    : [
        "--apple-id",
        process.env.APPLE_ID,
        "--password",
        process.env.APPLE_APP_SPECIFIC_PASSWORD,
        "--team-id",
        process.env.APPLE_TEAM_ID,
      ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-notarize-"));
  const zipPath = path.join(tmpDir, `${appName}.zip`);

  console.log(`[notarize] Zipping ${appBundleId} at ${appPath} …`);
  const zip = run(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", path.basename(appPath), zipPath],
    { cwd: path.dirname(appPath) },
  );
  if (zip.status !== 0) {
    throw new Error(`[notarize] ditto zip failed:\n${zip.stderr || zip.stdout}`);
  }

  // A healthy submission for this app is Accepted within ~10 minutes. When
  // notarytool's SIGBUS crash truncates the upload instead, the submission is
  // a zombie: Apple reports it In Progress forever and eventually deletes it
  // (observed 2026-09-09: c823eb9a polled In Progress for hours, then
  // "does not exist or does not belong to your team"). So never bet the
  // release on a single submission id — cap the wait per submission and
  // resubmit the same bytes fresh.
  const ATTEMPTS = 3;
  const WAIT_MINUTES = 20;
  let waited = null;
  let submissionId = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    submissionId = submitForNotarization(zipPath, authArgs);
    console.log(
      `[notarize] Submission id ${submissionId} (attempt ${attempt}/${ATTEMPTS}) — waiting up to ${WAIT_MINUTES}m …`,
    );
    waited = waitForSubmission(submissionId, authArgs, WAIT_MINUTES);
    if (waited) break;
    console.warn(
      `[notarize] ${submissionId} still In Progress after ${WAIT_MINUTES}m — ` +
        `likely a truncated upload (notarytool SIGBUS)${attempt < ATTEMPTS ? "; submitting fresh …" : ""}`,
    );
  }
  if (!waited) {
    throw new Error(
      `[notarize] no terminal status after ${ATTEMPTS} submissions; last id ${submissionId}`,
    );
  }

  if (waited.status !== "Accepted") {
    const log = run("xcrun", ["notarytool", "log", submissionId, ...authArgs]);
    throw new Error(
      `[notarize] Notarization status=${waited.status} id=${submissionId}\n${log.stdout || log.stderr || ""}`,
    );
  }

  console.log(`[notarize] Accepted — stapling ${appPath} …`);
  const staple = run("xcrun", ["stapler", "staple", "-v", appPath]);
  if (staple.status !== 0) {
    throw new Error(`[notarize] stapler failed:\n${staple.stderr || staple.stdout}`);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log("[notarize] Done.");
};
