"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const chromeSync = require("../chromeSync.cjs");
const {
  googleAuthHost,
  isGoogleAuthPlumbing,
  looksLikeInteractiveGoogleSignIn,
  isGoogleAuthBlockedPage,
  isWaitingPage,
  shouldHandoff,
  returnUrlFor,
  cdpCookieToElectron,
  waitingPageDataUrl,
  findSystemChromium,
  createHandoffRuntime,
  WAITING_MARK,
} = require("./googleAuthHandoff.cjs");

const OAUTH =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=https://slack.com/auth&scope=email";
const SIGNIN =
  "https://accounts.google.com/v3/signin/identifier?continue=https://mail.google.com/mail/";
const CHECK =
  "https://accounts.google.com/CheckCookie?continue=https://mail.google.com/mail/";
const ROTATE = "https://accounts.google.com/RotateCookies";
const REJECTED = "https://accounts.google.com/v3/signin/rejected?eml=0";

test("interactive Google sign-in URLs are handed off; cookie plumbing is not", () => {
  assert.equal(googleAuthHost(OAUTH), true);
  assert.equal(looksLikeInteractiveGoogleSignIn(OAUTH), true);
  assert.equal(looksLikeInteractiveGoogleSignIn(SIGNIN), true);
  assert.equal(isGoogleAuthPlumbing(CHECK), true);
  assert.equal(looksLikeInteractiveGoogleSignIn(CHECK), false);
  assert.equal(looksLikeInteractiveGoogleSignIn(ROTATE), false);
  assert.equal(shouldHandoff(OAUTH, { isMainFrame: true }), true);
  assert.equal(shouldHandoff(SIGNIN, { isMainFrame: true }), true);
  assert.equal(shouldHandoff(CHECK, { isMainFrame: true }), false);
  assert.equal(shouldHandoff(OAUTH, { isMainFrame: false, isPopup: false }), false);
  assert.equal(shouldHandoff(OAUTH, { isMainFrame: false, isPopup: true }), true);
});

test("Google's insecure-browser wall is always handed off", () => {
  assert.equal(isGoogleAuthBlockedPage({ url: REJECTED }), true);
  assert.equal(
    isGoogleAuthBlockedPage({
      title: "Couldn't sign you in",
      url: "https://accounts.google.com/",
    }),
    true,
  );
  assert.equal(shouldHandoff(REJECTED, { isMainFrame: true }), true);
  assert.equal(shouldHandoff("https://mail.google.com/"), false);
  assert.equal(shouldHandoff("about:blank"), false);
});

test("continue= from the Google URL is the tab to restore", () => {
  assert.equal(returnUrlFor({ authUrl: SIGNIN }), "https://mail.google.com/mail/");
  assert.equal(
    returnUrlFor({
      authUrl: OAUTH,
      currentUrl: "https://slack.com/signin",
    }),
    "https://slack.com/signin",
  );
  assert.equal(
    returnUrlFor({
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
      currentUrl: "https://notion.so/login",
    }),
    "https://notion.so/login",
  );
});

test("CDP cookies map to Electron session.cookies.set shape", () => {
  const mapped = cdpCookieToElectron({
    name: "SID",
    value: "secret",
    domain: ".google.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "None",
    expires: 2_000_000_000,
  });
  assert.equal(mapped.url, "https://google.com/");
  assert.equal(mapped.domain, ".google.com");
  assert.equal(mapped.sameSite, "no_restriction");
  assert.equal(mapped.httpOnly, true);
  assert.equal(mapped.expirationDate, 2_000_000_000);
  assert.equal(cdpCookieToElectron({ name: "", value: "x", domain: "x.com" }), null);
});

test("waiting page is marked so it cannot retrigger a handoff", () => {
  const page = waitingPageDataUrl();
  assert.equal(isWaitingPage(page), true);
  assert.equal(shouldHandoff(page), false);
  assert.match(decodeURIComponent(page), new RegExp(WAITING_MARK));
  assert.match(decodeURIComponent(waitingPageDataUrl({ missingBrowser: true })), /Chrome or Edge/);
});

test("Chrome is preferred over Edge when both exist", () => {
  const found = findSystemChromium({
    platform: "darwin",
    exists: (p) =>
      p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ||
      p === "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  });
  assert.equal(found.name, "Google Chrome");
});

test("replaceGoogle overwrites an existing Google login", async () => {
  const sets = [];
  const session = {
    cookies: {
      get: async () => [
        { name: "SID", domain: "google.com", expirationDate: Date.now() / 1000 + 9999 },
      ],
      set: async (c) => {
        sets.push(c);
      },
    },
  };
  const cookie = {
    url: "https://google.com/",
    name: "SID",
    value: "new",
    path: "/",
    secure: true,
    httpOnly: true,
    domain: ".google.com",
    expirationDate: Date.now() / 1000 + 9999,
  };
  const skipped = await chromeSync.importCookiesToSession(session, [cookie]);
  assert.equal(skipped.skipped, 1);
  assert.equal(sets.length, 0);
  const replaced = await chromeSync.importCookiesToSession(session, [cookie], {
    replaceGoogle: true,
  });
  assert.equal(replaced.imported, 1);
  assert.equal(sets[0].value, "new");
});

test("missing Chrome loads the fallback page instead of the Google wall", async () => {
  const loads = [];
  const runtime = createHandoffRuntime({ findBinary: () => null });
  const wc = {
    isDestroyed: () => false,
    loadURL: (u) => loads.push(u),
    reload() {},
  };
  assert.equal(
    runtime.start({
      authUrl: OAUTH,
      currentUrl: "https://slack.com/signin",
      waiter: {
        wc,
        returnUrl: "https://slack.com/signin",
        currentUrl: "https://slack.com/signin",
      },
    }),
    true,
  );
  await runtime.waitForIdle();
  assert.equal(loads.length, 1);
  assert.match(decodeURIComponent(loads[0]), /Chrome or Edge/);
});

test("successful handoff imports cookies and restores the opener URL", async () => {
  const loads = [];
  const imported = [];
  const killed = [];
  const child = {
    exitCode: null,
    killed: false,
    pid: 4242,
    kill() {
      this.killed = true;
      this.exitCode = 0;
      killed.push("term");
    },
  };
  let lists = 0;
  const runtime = createHandoffRuntime({
    findBinary: () => ({ name: "Google Chrome", binary: "/chrome" }),
    spawn: () => child,
    getFreePort: async () => 9222,
    fetchJson: async (url) => {
      if (String(url).includes("/json/version")) return { Browser: "Chrome" };
      lists += 1;
      if (lists < 2) {
        return [
          {
            type: "page",
            url: SIGNIN,
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
          },
        ];
      }
      return [
        {
          type: "page",
          url: "https://mail.google.com/mail/",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
        },
      ];
    },
    readCookies: async () => [
      {
        name: "SID",
        value: "abc",
        domain: ".google.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expires: Date.now() / 1000 + 9999,
      },
    ],
    importCookies: async (_session, cookies) => {
      imported.push(...cookies);
      return { imported: cookies.length, failed: 0, skipped: 0 };
    },
    sleep: async () => {},
  });
  const wc = {
    isDestroyed: () => false,
    loadURL: (u) => loads.push(u),
    reload() {},
    session: {},
  };
  runtime.start({
    authUrl: SIGNIN,
    currentUrl: "https://mail.google.com/",
    session: wc.session,
    userDataPath: "/tmp/lykn-google-auth-test",
    waiter: {
      wc,
      returnUrl: "https://mail.google.com/",
      currentUrl: "https://mail.google.com/",
    },
  });
  await runtime.waitForIdle();
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, "SID");
  assert.ok(loads.includes("https://mail.google.com/"));
  assert.ok(killed.length > 0);
  assert.equal(
    runtime.start({
      authUrl: SIGNIN,
      waiter: { wc, returnUrl: "https://mail.google.com/" },
    }),
    false,
    "cooldown lets imported cookies take effect",
  );
});
