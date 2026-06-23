// electron-builder afterSign hook: notarize the signed .app with Apple.
//
// This runs automatically during `npm run electron:build`. It NO-OPS (with a
// clear log line) unless the required credentials are present in the env, so
// local/unsigned builds still succeed. Supports two credential styles:
//
//   1) App Store Connect API key (recommended for CI):
//        APPLE_API_KEY        = /abs/path/to/AuthKey_XXXX.p8
//        APPLE_API_KEY_ID     = XXXXXXXXXX
//        APPLE_API_ISSUER     = xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
//
//   2) Apple ID + app-specific password:
//        APPLE_ID             = you@example.com
//        APPLE_APP_SPECIFIC_PASSWORD = xxxx-xxxx-xxxx-xxxx
//        APPLE_TEAM_ID        = XXXXXXXXXX
//
// Create an app-specific password at https://appleid.apple.com → Sign-In and
// Security → App-Specific Passwords. Find your Team ID in the Apple Developer
// account (Membership details).

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
    console.log(
      "[notarize] Skipping — no Apple credentials in env. Set APPLE_API_KEY/" +
        "APPLE_API_KEY_ID/APPLE_API_ISSUER, or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/" +
        "APPLE_TEAM_ID to enable notarization.",
    );
    return;
  }

  const { notarize } = require("@electron/notarize");
  console.log(`[notarize] Notarizing ${appBundleId} at ${appPath} …`);

  const opts = { appPath, appBundleId };
  if (hasApiKey) {
    opts.appleApiKey = process.env.APPLE_API_KEY;
    opts.appleApiKeyId = process.env.APPLE_API_KEY_ID;
    opts.appleApiIssuer = process.env.APPLE_API_ISSUER;
  } else {
    opts.appleId = process.env.APPLE_ID;
    opts.appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
    opts.teamId = process.env.APPLE_TEAM_ID;
  }

  await notarize(opts);
  console.log("[notarize] Done.");
};
