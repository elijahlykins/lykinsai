/**
 * Dead ends.
 *
 * A run walked into a 404 and stopped: "I'm stuck on this step — take it forward
 * one step in the browser and I'll pick it back up." Nothing was actually broken.
 * The navigation had succeeded, the URL had changed, and a changed URL is what
 * the verifier reads as progress — so the retry ladder never fired. The agent
 * spent six recoveries looking for controls on a page that has none, then handed
 * the dead link back.
 *
 * A dead end is an address problem. These tests pin telling one apart from a
 * page that merely found nothing, and the order in which the agent backs out.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const deadEnd = require("./runtime/deadEnd.cjs");

test("a page that announces itself as missing is a dead end", () => {
  for (const [title, text] of [
    ["Page not found · GitHub", "404 This is not the web page you are looking for."],
    ["404 Not Found", "nginx"],
    ["404", ""],
    ["Error 500", ""],
    ["Sorry, that page doesn't exist", ""],
    ["Mailchimp", "The page you requested could not be found."],
    ["Shop", "We can't find that page. Check the URL and try again."],
    ["Blog", "This page has been removed."],
  ]) {
    const got = deadEnd.looksLikeDeadEnd({ title, visibleText: text });
    assert.equal(got.deadEnd, true, `${title} / ${text}`);
    assert.ok(got.reason, "a dead end has to explain itself to the user");
  }
});

/**
 * Mailchimp's real 404, which is where the second report came from. Its copy is
 * written by marketing and never says "not found" anywhere a reader can see, and
 * every apostrophe is curly — so a detector built from the obvious phrases walks
 * straight past it.
 */
const MAILCHIMP_404_TITLE = "Page Not Found | Mailchimp";
const MAILCHIMP_404_TEXT =
  "We lost this page. We searched high and low but couldn\u2019t find what you\u2019re looking " +
  "for. Let\u2019s find a better place for you to go. Maybe you want to learn about our email " +
  "marketing or our SMS marketing solutions? Mailchimp Home";

test("the real Mailchimp 404 is recognised by its title and by its copy alone", () => {
  assert.equal(
    deadEnd.looksLikeDeadEnd({
      title: MAILCHIMP_404_TITLE,
      visibleText: MAILCHIMP_404_TEXT,
    }).deadEnd,
    true,
  );
  // The title is the strong signal, so the copy has to stand on its own for the
  // sites that do not set one.
  assert.equal(
    deadEnd.looksLikeDeadEnd({ title: "Mailchimp", visibleText: MAILCHIMP_404_TEXT }).deadEnd,
    true,
  );
});

test("the legacy stuck ask never names a control on a dead page", () => {
  const owned = require("../ownedBrowserAct.cjs");
  const goal =
    "Create a new email campaign about LYKN OS in Mailchimp, following the style of " +
    "previous campaigns, and save it as a draft.";
  // The reported message asked the user to "Get into a blank page/editor (New
  // page / Create / Blank)" while sitting on this 404. The gap list is empty for
  // this goal — anything reading as an email task short-circuits it — so the ask
  // has to notice the dead page by itself.
  const ask = owned.describeStuckUserAction({
    goal,
    gaps: [],
    url: "https://mailchimp.com/campaigns",
    pageText: MAILCHIMP_404_TEXT,
    title: MAILCHIMP_404_TITLE,
  });
  assert.match(ask, /dead end/i);
  assert.doesNotMatch(ask, /New page|Blank|blank page\/editor/i);

  // On a page that really does have those controls, it must still say so.
  assert.match(
    owned.describeStuckUserAction({
      goal,
      gaps: [],
      url: "https://admin.mailchimp.com/campaigns",
      pageText: "Campaigns Create Audience Reports. Create a new campaign. New page",
      title: "Campaigns | Mailchimp",
    }),
    /Create/,
  );
});

test("backing out never routes to an address of its own invention", () => {
  // Where to go next is the loaded page's business — its nav, its search, its
  // "Log in" link. A table of known app entry points is a hardcoded route into
  // one application, and it is wrong the moment that application moves. So the
  // backout is purely structural: it only ever walks the address it was given,
  // and never leaves the host it was given.
  for (const url of [
    "https://mailchimp.com/campaigns/new?x=1",
    "https://some-tool.example.co.uk/a/b/c",
    "https://app.whatever.io/deep/link",
  ]) {
    const host = new URL(url).host;
    const seen = [];
    for (let i = 0; i < 8; i += 1) {
      const next = deadEnd.backoutTarget(url, { avoid: seen });
      if (!next) break;
      assert.equal(new URL(next.url).host, host, `${next.url} left ${host}`);
      seen.push(next.url);
    }
    assert.ok(seen.length > 0, `${url} should have somewhere to back out to`);
  }
});

test("a search that found nothing is a working page, not a dead end", () => {
  // Fleeing this page is how the agent loses a result it was asked to read.
  for (const [title, text] of [
    ["Search results", "No results for \"lykn os\". Try different keywords."],
    ["Campaigns", "0 results. Create your first campaign."],
    ["Inbox", "Nothing matched your filter."],
  ]) {
    assert.equal(
      deadEnd.looksLikeDeadEnd({ title, visibleText: text }).deadEnd,
      false,
      `${title} / ${text}`,
    );
  }
});

test("an ordinary page is left alone", () => {
  assert.equal(
    deadEnd.looksLikeDeadEnd({
      title: "Campaigns | Mailchimp",
      visibleText: "Campaigns Create Audience Reports Automations Website",
    }).deadEnd,
    false,
  );
  // An article about broken links is not a broken link. The giveaway is that a
  // real 404 says so at the very top.
  assert.equal(
    deadEnd.looksLikeDeadEnd({
      title: "How we cut our error rate",
      visibleText: `${"Engineering blog. ".repeat(60)} We found the page not found rate was too high.`,
    }).deadEnd,
    false,
  );
});

test("backing out drops the query, then walks up, then lands on the root", () => {
  const seen = [];
  let url = "https://example.com/a/b/c?ref=xyz#frag";
  for (let i = 0; i < 5; i += 1) {
    const next = deadEnd.backoutTarget(url, { avoid: seen });
    if (!next) break;
    seen.push(next.url);
    url = "https://example.com/a/b/c?ref=xyz#frag";
  }
  assert.deepEqual(seen, [
    "https://example.com/a/b/c",
    "https://example.com/a/b/",
    "https://example.com/a/",
    "https://example.com/",
  ]);
});

test("a URL already known to be dead is never offered again", () => {
  const next = deadEnd.backoutTarget("https://example.com/a/b", {
    avoid: ["https://example.com/a/", "https://example.com/a"],
  });
  assert.equal(next.url, "https://example.com/");
});

test("when everything up the tree is dead, there is nothing to navigate to", () => {
  // The caller has to replan rather than keep editing the address.
  assert.equal(
    deadEnd.backoutTarget("https://example.com/a", {
      avoid: ["https://example.com/"],
    }),
    null,
  );
  assert.equal(deadEnd.backoutTarget("not a url"), null);
  assert.equal(deadEnd.backoutTarget(""), null);
});
