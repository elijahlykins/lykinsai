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

  // Submit without --wait so we get a clean JSON id even if the queue is slow.
  console.log(`[notarize] Submitting ${zipPath} …`);
  const submit = run("xcrun", [
    "notarytool",
    "submit",
    zipPath,
    ...authArgs,
    "--output-format",
    "json",
  ]);
  const submitOut = String(submit.stdout || "").trim();
  let submitted;
  try {
    submitted = JSON.parse(submitOut);
  } catch {
    throw new Error(
      `[notarize] submit returned non-JSON (code ${submit.status}):\n${submitOut}\n${submit.stderr || ""}`,
    );
  }
  if (!submitted.id) {
    throw new Error(`[notarize] submit missing id:\n${submitOut}`);
  }
  console.log(`[notarize] Submission id ${submitted.id} — waiting (up to 2h) …`);

  // Long wait — Apple's queue can sit In Progress for a long time.
  const wait = run(
    "xcrun",
    [
      "notarytool",
      "wait",
      submitted.id,
      ...authArgs,
      "--timeout",
      "120m",
      "--output-format",
      "json",
    ],
    // notarytool wait can run for hours; don't let Node's default kill it.
    { timeout: 0 },
  );
  const waitOut = String(wait.stdout || "").trim();
  let waited;
  try {
    // wait may print progress on stderr; stdout should be final JSON
    const jsonLine = waitOut
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    waited = JSON.parse(jsonLine || waitOut);
  } catch {
    // Fall back to info
    const info = run("xcrun", [
      "notarytool",
      "info",
      submitted.id,
      ...authArgs,
      "--output-format",
      "json",
    ]);
    try {
      waited = JSON.parse(String(info.stdout || "").trim());
    } catch {
      throw new Error(
        `[notarize] wait/info failed for ${submitted.id}:\n${waitOut}\n${wait.stderr || ""}\n${info.stdout || ""}\n${info.stderr || ""}`,
      );
    }
  }

  if (waited.status !== "Accepted") {
    const log = run("xcrun", ["notarytool", "log", submitted.id, ...authArgs]);
    throw new Error(
      `[notarize] Notarization status=${waited.status} id=${submitted.id}\n${log.stdout || log.stderr || ""}`,
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
