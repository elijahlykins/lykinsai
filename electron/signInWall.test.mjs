/**
 * Recognizing a login page.
 *
 * These tests come from a run that stalled on Mailchimp. The agent clicked
 * "Log In" five times, then asked the user to "Click New page / Create / Blank"
 * — a control that does not exist on a login form — and then sat there after
 * they had signed in.
 *
 * All three symptoms had one cause. login.mailchimp.com serves its form from
 * "/", and the form says "log in" and "sign up", which is also what a product
 * landing page says. The landing-page test therefore claimed it, and once a page
 * is considered marketing chrome three things follow: the sign-in wall detector
 * declines it, the advance loop keeps clicking CTAs to "get past the marketing
 * page", and the handover is written by the generic stuck path — which never
 * arms the watcher that resumes the task once the user is through.
 *
 * The address is what separates the two. Nobody puts their product pitch on
 * login.example.com.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const o = require("./ownedBrowserAct.cjs");

const SIGN_IN_TEXT =
  "Log in to your Mailchimp account. Username or Email Password Log in " +
  "Forgot username? Forgot password? Sign up for free Create an account";

const MARKETING_TEXT =
  "Mailchimp Turn emails into revenue. Get started free. Log in. Sign up. " +
  "Pricing Features Templates Learn more Watch demo for business";

test("a login page served from the site root is a sign-in wall", () => {
  // The exact page the stalled run was sitting on.
  assert.equal(
    o.looksLikeSignInWall({
      url: "https://login.mailchimp.com/",
      text: SIGN_IN_TEXT,
      title: "Login | Mailchimp",
    }),
    true,
  );
});

test("login subdomains are recognized wherever the product puts them", () => {
  for (const url of [
    "https://login.mailchimp.com/",
    "https://signin.aws.amazon.com/",
    "https://login.constantcontact.com/",
    "https://accounts.shopify.com/",
    "https://auth.example.com/",
    "https://sso.example.com/",
  ]) {
    assert.equal(
      o.looksLikeSignInWall({ url, text: SIGN_IN_TEXT, title: "Log in" }),
      true,
      url,
    );
  }
});

test("a sign-in page is never mistaken for the product's landing page", () => {
  // This is the specific confusion that caused the stall: both pages say
  // "log in" and "sign up", so only the address can tell them apart.
  const blocker = o.detectBrowseBlocker({
    url: "https://login.mailchimp.com/",
    pageText: SIGN_IN_TEXT,
    title: "Login | Mailchimp",
  });
  assert.equal(blocker?.kind, "signin", "it must be reported as sign-in, not stuck");
  // Only a "signin" blocker arms the watcher that resumes the task on its own,
  // which is why the run sat there after the user had already logged in. The
  // ask should say so: sign in, and it picks up from there by itself.
  assert.match(blocker?.userAction || "", /sign(?:ing)?\s*in/i);
  assert.doesNotMatch(
    blocker?.userAction || "",
    /new page|blank/i,
    "it must not ask for a control that does not exist on a login form",
  );
});

test("real marketing pages are still marketing pages", () => {
  for (const url of ["https://mailchimp.com/", "https://www.canva.com/"]) {
    assert.equal(
      o.looksLikeSignInWall({ url, text: MARKETING_TEXT, title: "Mailchimp" }),
      false,
      url,
    );
  }
});

test("a signed-in workspace is not a wall", () => {
  assert.equal(
    o.looksLikeSignInWall({
      url: "https://admin.mailchimp.com/campaigns/",
      text: "Campaigns Create Audience Reports Automations Website",
      title: "Campaigns | Mailchimp",
    }),
    false,
  );
});

test("the walls that already worked keep working", () => {
  assert.equal(
    o.looksLikeSignInWall({
      url: "https://accounts.google.com/v3/signin/identifier",
      text: "Sign in\nUse your Google Account",
      title: "Sign in - Google Accounts",
    }),
    true,
  );
  assert.equal(
    o.looksLikeSignInWall({
      url: "https://www.pinterest.com/login/",
      text: "Log in to continue\nEmail\nPassword\nContinue with Google\nCreate account",
      title: "Pinterest",
    }),
    true,
  );
  assert.equal(
    o.looksLikeSignInWall({
      url: "https://www.pinterest.com/search/pins/?q=blue",
      text: "Blue presentation ideas Related pins Board ideas",
      title: "Pinterest",
    }),
    false,
  );
});

test("a named product picks the site without discarding where to land in it", () => {
  // Naming a product settles which product, so email wording must not drag a
  // Mailchimp task into Gmail.
  assert.match(
    o.resolveBrowseTargetUrl("draft an email in mailchimp about the launch"),
    /mailchimp/i,
  );
  // But it does not settle where inside the product. Answering "open reddit and
  // search for mechanical keyboards" with the Reddit homepage throws away the
  // actual request, which is what happened while the venue check ran first.
  assert.match(
    o.resolveBrowseTargetUrl("open reddit and search for mechanical keyboards"),
    /reddit\.com\/search/i,
  );
  assert.match(
    o.resolveBrowseTargetUrl("open youtube and search for LYKNmedia"),
    /youtube\.com\/results/i,
  );
});

/**
 * A second Mailchimp run, the opposite failure. The user was already signed in.
 * The homepage threw a modal over itself, nothing closed it, and its copy ("log
 * in to continue") outranked the landing-page test — so a popup was promoted to
 * a hard wall and an authenticated user was told to sign in, on a marketing page,
 * with a link to the tab they were already looking at.
 */
const POPUP_OVER_MARKETING = `${MARKETING_TEXT} Log in to continue Email Password Continue with Google`;
const CAMPAIGN_GOAL =
  "Navigate to Mailchimp, create a new email campaign, and set up its content to focus on promoting LYKN OS.";

test("a modal over a landing page is not a wall — it is a popup to close", () => {
  for (const modal of [
    "Log in to continue Email Password",
    "you need to sign in to view this",
    "create a free account to get started",
  ]) {
    assert.equal(
      o.looksLikeSignInWall({
        url: "https://mailchimp.com/",
        text: `${MARKETING_TEXT} ${modal}`,
        title: "Mailchimp",
      }),
      false,
      modal,
    );
  }
});

test("a landing page never produces a demand to sign in", () => {
  const gaps = o.unmetBrowseAskRequirements(CAMPAIGN_GOAL, {
    url: "https://mailchimp.com/",
    pageText: POPUP_OVER_MARKETING,
    title: "Mailchimp",
    history: [],
  });
  // The honest gap is "you are on the front page", not "you are logged out".
  assert.deepEqual(gaps, ["get past the home/marketing page into the real workspace"]);
  const ask = o.describeStuckUserAction({
    goal: CAMPAIGN_GOAL,
    gaps,
    url: "https://mailchimp.com/",
    pageText: POPUP_OVER_MARKETING,
  });
  assert.doesNotMatch(ask, /^Sign in to/i);
  assert.match(ask, /mailchimp\.com/);
});

test("a real login form still asks for a password", () => {
  // The fix above must not buy itself silence on an actual wall.
  const gaps = o.unmetBrowseAskRequirements(CAMPAIGN_GOAL, {
    url: "https://login.mailchimp.com/",
    pageText: SIGN_IN_TEXT,
    title: "Login | Mailchimp",
    history: [],
  });
  assert.deepEqual(gaps, ["sign in so the page is usable"]);
  assert.match(
    o.describeStuckUserAction({
      goal: CAMPAIGN_GOAL,
      gaps,
      url: "https://login.mailchimp.com/",
      pageText: SIGN_IN_TEXT,
    }),
    /^Sign in to/i,
  );
});

test("a paywall is still told apart from a login", () => {
  assert.equal(
    o.looksLikeSignInWall({
      url: "https://www.canva.com/design/abc/edit",
      text: "Upgrade to Canva Pro to unlock this premium feature.",
      title: "Upgrade",
    }),
    false,
  );
  assert.equal(
    o.looksLikePaywall({
      url: "https://www.canva.com/design/abc/edit",
      text: "Upgrade to Canva Pro to unlock this premium feature.",
      title: "Upgrade",
    }),
    true,
  );
});
