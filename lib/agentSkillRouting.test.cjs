const SRC = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "../electron/agentRuntime.cjs"),
  "utf8",
);
const {
  classifyAgentSkill,
  looksLikePasteReportIntoSheets,
  looksLikeCreateInGoogleSheetsAsk,
} = require("../electron/agentRuntime.cjs");
const {
  matchCreateInToolVenue,
} = require("./agentToolVenues.cjs");
const {
  extractUrlFromText,
  extractSearchQuery,
  resolveBrowseTargetUrl,
  extractStockTicker,
  looksLikeCurrentTabTask,
  looksLikePageQuestionAsk,
  looksLikeCasualConversation,
  looksLikeBrowseActAsk,
  looksLikeInPageAction,
  looksLikeMailComposeTask,
  looksLikePasteIntoCompose,
  looksLikeMailDraftRevision,
  parseMailDraftFromText,
  synthesizeMailDraft,
  toPlainEmailText,
  resolveGmailComposeUrl,
  resolveInPageTargetUrl,
  resolveSiteClarificationUrl,
  looksLikeBrowseSiteClarification,
  priorAskedForSiteClarification,
  searchDeepLinkForUrl,
  looksLikeSameTabSearch,
  looksLikeRetargetSearchToSite,
  looksLikeOpenSearchResult,
  extractQuotedTitle,
  looksLikeSignedInMailUrl,
  looksLikeGmailPublicPage,
  looksLikeGmailPublicContent,
  looksLikeGmailNeedsSignIn,
  looksLikeMailInboxReview,
  looksLikeOpenMailItem,
  extractMailOpenIndex,
  looksLikeMailReplyTask,
  looksLikeMailDraftsReview,
  looksLikeGmailOpenOrReview,
  looksLikeSignInNavigation,
  gmailInboxUrl,
  gmailDraftsUrl,
  gmailSignInUrl,
  resolveSignInUrl,
  looksLikeSignInPageText,
  looksLikeSignInWall,
  looksLikeVideoBrowseIntent,
  wantsLatestVideo,
  extractVideoSearchQuery,
  youtubeSearchUrl,
} = require("../electron/ownedBrowserAct.cjs");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

describe("classifyAgentSkill", () => {
  it("routes research goals", () => {
    assert.equal(
      classifyAgentSkill("Deep research the state of AI agents in 2026"),
      "research",
    );
    assert.equal(
      classifyAgentSkill("create a report on the top open source models in the world today."),
      "research",
    );
    assert.equal(
      classifyAgentSkill("Write a brief comparing leading open-source LLMs"),
      "research",
    );
  });

  it("routes putting an existing research report into Sheets (not new research)", () => {
    const phrases = [
      "put that research report into the blank sheet",
      "I need the info of that research report in the blank sheet",
      "paste the research into google sheets",
      "fill the sheet with the research report",
      "enter the research report into the open sheet",
    ];
    for (const p of phrases) {
      assert.equal(looksLikePasteReportIntoSheets(p), true, p);
      assert.equal(classifyAgentSkill(p), "sheets-fill", p);
    }
    assert.equal(
      classifyAgentSkill("create a research report on climate change"),
      "research",
    );
  });

  it("detects organize-sheet asks", () => {
    const { looksLikeOrganizeSheetAsk } = require("../electron/ownedBrowserAct.cjs");
    assert.equal(looksLikeOrganizeSheetAsk("organize the sheet"), true);
    assert.equal(looksLikeOrganizeSheetAsk("can you format this spreadsheet"), true);
    assert.equal(looksLikeOrganizeSheetAsk("clean up the data in the sheet"), true);
    assert.equal(looksLikeOrganizeSheetAsk("open google sheets"), false);
  });

  it("creates a new file where you are; edit-current stays on the open file", () => {
    const {
      standingInAppHome,
      looksLikeEditCurrentInToolAsk,
      looksLikeWorkInApp,
    } = require("../lib/agentWorkDestination.cjs");
    // A file list and one open file, told apart by the shape of the URL rather
    // than by recognising the product. Any app's URLs have this shape.
    const appHome = "https://docs.google.com/spreadsheets/u/0/";
    const openFile = "https://docs.google.com/spreadsheets/d/abc123/edit";

    assert.equal(standingInAppHome(appHome), true);
    assert.equal(standingInAppHome(openFile), false);
    assert.equal(standingInAppHome("https://docs.google.com/document/d/xyz/edit"), false);
    // The same two shapes in an app that was never in any table.
    assert.equal(standingInAppHome("https://linear.app/acme/team"), true);
    assert.equal(standingInAppHome("https://www.notion.so/My-Page-3f2b91ac4d"), false);

    // Standing in an app and asking to create means create here.
    assert.equal(looksLikeWorkInApp("create a budget", { liveUrl: appHome }), true);
    assert.equal(
      classifyAgentSkill("create a budget", { liveUrl: appHome, hasLiveTab: true }),
      "tool-create",
    );

    // Edit the open thing → not a fresh file.
    assert.equal(looksLikeEditCurrentInToolAsk("add a column for notes"), true);
    assert.equal(looksLikeEditCurrentInToolAsk("edit this budget"), true);
    assert.equal(looksLikeEditCurrentInToolAsk("organize the sheet"), true);
    assert.equal(looksLikeEditCurrentInToolAsk("make this table clearer"), true);
    // Parts of the open document — including a typoed "the".
    assert.equal(looksLikeEditCurrentInToolAsk("rewrite the opening paragraph"), true);
    assert.equal(looksLikeEditCurrentInToolAsk("ok now rewrite hte opening paragraph"), true);
    assert.equal(looksLikeEditCurrentInToolAsk("fix the intro"), true);
    assert.equal(looksLikeEditCurrentInToolAsk("change the last sentence"), true);
    // Bare part-nouns in a create ask must NOT read as edits.
    assert.equal(looksLikeEditCurrentInToolAsk("write a 5 paragraph essay"), false);
    assert.equal(looksLikeWorkInApp("edit this budget", { liveUrl: openFile }), false);
    assert.equal(looksLikeWorkInApp("add a column for notes", { liveUrl: openFile }), false);
  });

  it("offers custom artifact vs stop for complex software like Canva", () => {
    const {
      matchComplexSoftwareOffer,
      buildComplexSoftwareOfferMessage,
      stripToolVenueForArtifactAsk,
      isComplexUiToolVenue,
      getToolVenueById,
      complexSoftwareChoiceButtons,
    } = require("./agentToolVenues.cjs");
    const canva = getToolVenueById("canva");
    assert.equal(isComplexUiToolVenue(canva), true);
    assert.equal(isComplexUiToolVenue(getToolVenueById("notion")), false);
    assert.equal(isComplexUiToolVenue(getToolVenueById("google-docs")), false);

    const offer = matchComplexSoftwareOffer(
      "go into canva and write me a resume",
    );
    assert.ok(offer);
    assert.equal(offer.softwareName, "Canva");
    assert.match(offer.deliverableLabel, /resume/i);
    assert.match(offer.artifactAsk, /resume/i);
    assert.doesNotMatch(offer.artifactAsk, /canva/i);
    assert.equal(
      stripToolVenueForArtifactAsk("create a poster in canva", canva)
        .toLowerCase()
        .includes("canva"),
      false,
    );

    const msg = buildComplexSoftwareOfferMessage(offer);
    assert.match(msg, /doesn't perform well/i);
    assert.match(msg, /Canva/);
    assert.match(msg, /custom LYKN artifact/i);
    const buttons = complexSoftwareChoiceButtons();
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].id, "use-artifact");
    assert.equal(buttons[1].id, "stop");

    // Sheets/Docs stay on the paste path — no complex-software offer.
    assert.equal(
      matchComplexSoftwareOffer("go to google docs and write me an essay"),
      null,
    );
    // Blender-style create ask still offers even without a TOOL_VENUES entry.
    const blender = matchComplexSoftwareOffer(
      "can you open blender and build me a 3d model",
    );
    assert.ok(blender);
    assert.match(blender.softwareName, /blender/i);
    assert.match(blender.deliverableLabel, /3d\s*model/i);
    assert.match(blender.artifactAsk, /3d\s*model/i);
    assert.doesNotMatch(blender.artifactAsk, /blender/i);
    // Naming an app is naming a destination, whatever the app is — there is no
    // longer a list saying Blender is not a real place to work. What protects
    // the user is the gate itself: runWorkInNamedApp offers the artifact before
    // it drives anything, so the classification below never reaches Blender.
    assert.equal(
      classifyAgentSkill("can you open blender and build me a 3d model"),
      "tool-create",
    );
    assert.match(
      SRC.slice(SRC.indexOf("async function runWorkInNamedApp")).slice(0, 1600),
      /matchComplexSoftwareOffer[\s\S]{0,240}offerComplexSoftwareChoice/,
      "the offer is made before the agent is sent in",
    );

    // Mentioning the software as the thing to build / discuss ≠ work inside it.
    assert.equal(
      matchComplexSoftwareOffer(
        "how hard would it be for you to build me a full blender replica software?",
      ),
      null,
    );
    assert.equal(
      matchComplexSoftwareOffer("build me a figma-like design tool"),
      null,
    );
    assert.equal(
      matchComplexSoftwareOffer("create a canva alternative as an artifact"),
      null,
    );
    assert.equal(
      matchComplexSoftwareOffer("how hard would it be to make a figma like tool?"),
      null,
    );
    // Must not route to tool-create / "Opening Figma…" either.
    assert.equal(
      matchCreateInToolVenue("how hard would it be to make a figma like tool?"),
      null,
    );
    assert.notEqual(
      classifyAgentSkill("how hard would it be to make a figma like tool?"),
      "tool-create",
    );
    // Still offer when they clearly want to work inside the app.
    assert.ok(matchComplexSoftwareOffer("create a logo in canva"));
    assert.ok(matchComplexSoftwareOffer("make a character model using blender"));
    assert.equal(matchCreateInToolVenue("create a logo in canva")?.id, "canva");
  });

  it("tool creates prefer known create deep links; hunt create/blank not templates", () => {
    const {
      resolveToolCreateStartUrl,
      venueLooksLikeWorkingSurface,
      buildToolDeepLinkSearchQuery,
      extractToolCreateTopic,
      toolStartUrlIsSpecific,
      shouldOpenFreshVenueFile,
      buildToolActAdaptiveGoal,
      getToolVenueById,
    } = require("./agentToolVenues.cjs");
    const canva = getToolVenueById("canva");
    const figma = getToolVenueById("figma");
    // Write/create → create hub (not templates gallery). Templates only if asked.
    assert.match(
      resolveToolCreateStartUrl(canva, "go into canva and write me a resume"),
      /canva\.com\/create\/resumes/i,
    );
    assert.match(
      resolveToolCreateStartUrl(canva, "open canva resume templates"),
      /canva\.com\/resumes\/templates/i,
    );
    assert.equal(
      toolStartUrlIsSpecific("https://www.canva.com/create/resumes/", canva),
      true,
    );
    assert.equal(toolStartUrlIsSpecific("https://www.canva.com/", canva), false);
    assert.equal(
      extractToolCreateTopic("go into canva and create me a resume", canva),
      "resume",
    );
    const deepQ = buildToolDeepLinkSearchQuery(
      canva,
      "go into canva and write me a resume",
    );
    assert.match(deepQ, /canva.*resume.*site:canva\.com/i);
    assert.match(deepQ, /\bcreate\b/i);
    assert.doesNotMatch(deepQ, /\btemplates\b/i);
    assert.match(
      buildToolDeepLinkSearchQuery(canva, "canva resume templates"),
      /\btemplates\b/i,
    );
    assert.equal(
      venueLooksLikeWorkingSurface(canva, "https://www.canva.com/create/resumes/"),
      false,
    );
    assert.equal(
      venueLooksLikeWorkingSurface(
        canva,
        "https://www.canva.com/design/DAGabc123/xyz/edit",
      ),
      true,
    );
    // Create/write verbs open a fresh file; short continuations stay in the editor.
    assert.equal(
      shouldOpenFreshVenueFile(
        "write me a resume",
        canva,
        "https://www.canva.com/design/DAGabc123/xyz/edit",
      ),
      true,
    );
    assert.equal(
      shouldOpenFreshVenueFile(
        "keep going",
        canva,
        "https://www.canva.com/design/DAGabc123/xyz/edit",
      ),
      false,
    );
    const goal = buildToolActAdaptiveGoal(figma, "go into figma and make a login mockup", {
      draft: "Login screen with email + password",
    });
    assert.match(goal, /FINISH|deep link|click through|DO THE WORK/i);
    assert.match(goal, /figma/i);
    assert.match(goal, /Login screen/i);
    assert.equal(
      classifyAgentSkill("go into canva and create me a resume"),
      "tool-create",
    );
  });

  it("detects paywalls separately from sign-in walls", () => {
    const { looksLikePaywall, looksLikeSignInWall } = require("../electron/ownedBrowserAct.cjs");
    assert.equal(
      looksLikePaywall({
        url: "https://www.canva.com/design/abc/edit",
        text: "Upgrade to Canva Pro to unlock this premium feature. Start your free trial.",
        title: "Upgrade",
      }),
      true,
    );
    assert.equal(
      looksLikeSignInWall({
        url: "https://www.canva.com/design/abc/edit",
        text: "Upgrade to Canva Pro to unlock this premium feature.",
        title: "Upgrade",
      }),
      false,
    );
  });

  it("routes named-tool creates to tool-create; plain asks to artifact build", () => {
    assert.equal(looksLikeCreateInGoogleSheetsAsk("go to google sheets and create a budget"), true);
    assert.equal(
      classifyAgentSkill("go to google sheets and create a budget"),
      "tool-create",
    );
    assert.equal(classifyAgentSkill("create a budget in google sheets"), "tool-create");
    assert.equal(
      classifyAgentSkill("open sheets and make me an expense tracker"),
      "tool-create",
    );
    assert.equal(
      classifyAgentSkill("create me a presentation in powerpoint"),
      "tool-create",
    );
    assert.equal(
      classifyAgentSkill("go to canva and make a poster for our launch"),
      "tool-create",
    );
    assert.equal(
      matchCreateInToolVenue("create a deck in google slides")?.id,
      "google-slides",
    );
    // Named tool + write/open → real Docs/Sheets/…, never a lookalike artifact.
    assert.equal(
      classifyAgentSkill("go to google docs and write an essay on the purpose of life"),
      "tool-create",
    );
    assert.equal(
      classifyAgentSkill("open google docs and write an essay about the purpose of life"),
      "tool-create",
    );
    assert.equal(
      classifyAgentSkill("write an essay on the purpose of life in google docs"),
      "tool-create",
    );
    assert.equal(
      matchCreateInToolVenue("go to google doc and write an essay on the purpose of life")?.id,
      "google-docs",
    );
    assert.equal(
      classifyAgentSkill("open figma and design a login screen"),
      "tool-create",
    );
    // Already on a Sheets tab — create in-grid, not artifact.
    assert.equal(
      classifyAgentSkill("create a budget", {
        liveUrl: "https://docs.google.com/spreadsheets/d/abc/edit",
        hasLiveTab: true,
      }),
      "tool-create",
    );
    // No app named → LYKN artifact / build.
    const { looksLikeWorkInApp } = require("../lib/agentWorkDestination.cjs");
    assert.equal(looksLikeWorkInApp("create for me a budget"), false);
    assert.equal(looksLikeWorkInApp("create me a presentation"), false);
    assert.equal(classifyAgentSkill("create for me a budget"), "build");
    assert.equal(classifyAgentSkill("create me a presentation"), "build");
    assert.equal(classifyAgentSkill("make me a spreadsheet for my trip budget"), "build");
    assert.equal(classifyAgentSkill("write an essay on the purpose of life"), "build");
  });

  it("plain deck builds stay artifacts even with a Slides/PowerPoint tab open", () => {
    const slidesTab = {
      liveUrl: "https://docs.google.com/presentation/d/abc123/edit",
      hasLiveTab: true,
    };
    // No tool named → LYKN artifact, never hijacked by the live tab.
    assert.equal(
      matchCreateInToolVenue(
        "can you build me a slide deck on material sience make it 11 slides and only use neutral colors",
        slidesTab,
      ),
      null,
    );
    assert.equal(
      classifyAgentSkill(
        "can you build me a slide deck on material sience make it 11 slides and only use neutral colors",
        slidesTab,
      ),
      "build",
    );
    assert.equal(
      classifyAgentSkill("make me a presentation about volcanoes", slidesTab),
      "build",
    );
    // Naming the tool still routes into it.
    assert.equal(
      matchCreateInToolVenue("build me a slide deck in google slides", slidesTab)?.id,
      "google-slides",
    );
    // Non-deck creates on a live venue tab keep working in that tool.
    assert.equal(
      matchCreateInToolVenue("create a budget", {
        liveUrl: "https://docs.google.com/spreadsheets/d/abc/edit",
      })?.id,
      "google-sheets",
    );
  });

  it("routes build goals", () => {
    assert.equal(classifyAgentSkill("Build me a landing page for a coffee brand"), "build");
    assert.equal(classifyAgentSkill("make me a presentation about climate change"), "build");
    assert.equal(classifyAgentSkill("create a slide deck for our Q3 review"), "build");
    assert.equal(classifyAgentSkill("build me a habit tracker app"), "build");
    assert.equal(classifyAgentSkill("make a quiz for studying Spanish verbs"), "build");
    assert.equal(classifyAgentSkill("design a calculator for tip splitting"), "build");
    assert.equal(classifyAgentSkill("I want a dashboard for my freelance invoices"), "build");
  });

  it("routes image generation goals", () => {
    assert.equal(classifyAgentSkill("generate an image of a fox in the snow"), "image");
    assert.equal(classifyAgentSkill("create a logo for a coffee brand"), "image");
    assert.equal(classifyAgentSkill("image of the northern lights over a cabin"), "image");
    assert.equal(classifyAgentSkill("draw me a picture of a robot barista"), "image");
    assert.equal(classifyAgentSkill("make me an ad like this one"), "image");
    assert.equal(classifyAgentSkill("ok make me an ad like this one"), "image");
    assert.equal(
      classifyAgentSkill("make me something like this", { hasAttachedImage: true }),
      "image",
    );
    assert.equal(classifyAgentSkill("design a flyer based on this"), "image");
  });

  it("routes spreadsheet / budget asks to build, not image", () => {
    assert.equal(
      classifyAgentSkill(
        "ok can you make me a price estimation spread sheet for building a playset for my kids I don't want to go over 5 grand",
      ),
      "build",
    );
    assert.equal(classifyAgentSkill("make me a spreadsheet for my trip budget"), "build");
  });

  it("keeps plain Q&A as general (not build/image)", () => {
    assert.equal(classifyAgentSkill("What's a good way to organize my week?"), "general");
    assert.equal(classifyAgentSkill("how do presentations usually structure an intro?"), "general");
    assert.equal(classifyAgentSkill("what makes a good logo?"), "general");
  });

  it("scrapes + answers page questions on a live tab (no browse plan)", () => {
    const adsTab = {
      hasLiveTab: true,
      liveUrl: "https://ads.reddit.com/advertiser/t2_xxx/dashboard",
    };
    const pageQs = [
      "what's my spend?",
      "how much did I spend this week?",
      "summarize this page",
      "check my ads metrics",
      "what are my campaign impressions?",
      "tell me based on this page how the ads are doing",
      "what do you think about this page?",
      "thoughts on this?",
      "is this dashboard confusing?",
      "this looks weird",
      "help me understand this page",
    ];
    for (const q of pageQs) {
      assert.equal(looksLikePageQuestionAsk(q), true, `pageQ: ${q}`);
      assert.equal(looksLikeBrowseActAsk(q), false, `notAct: ${q}`);
      assert.equal(looksLikeCurrentTabTask(q), false, `notCurrentTabTask: ${q}`);
      assert.equal(classifyAgentSkill(q, adsTab), "general", `skill: ${q}`);
    }
    // Still navigate when there's no live tab and a destination is named.
    assert.equal(
      classifyAgentSkill("check my reddit ads"),
      "browse",
    );
    // Real UI work on a live tab still browses.
    assert.equal(classifyAgentSkill("click the first campaign", adsTab), "browse");
    assert.equal(classifyAgentSkill("open my reddit ads dashboard", adsTab), "browse");
  });

  it("keeps casual conversation as general (no browse / agent plan)", () => {
    const tab = {
      hasLiveTab: true,
      liveUrl: "https://example.com/article",
    };
    const chats = [
      "what do you think?",
      "any advice?",
      "yeah that makes sense",
      "tell me more",
      "curious what you'd change",
      "should I worry about this?",
    ];
    for (const q of chats) {
      assert.equal(looksLikeCasualConversation(q), true, `casual: ${q}`);
      assert.equal(looksLikeBrowseActAsk(q), false, `notAct: ${q}`);
      assert.equal(classifyAgentSkill(q, tab), "general", `skill: ${q}`);
      assert.equal(classifyAgentSkill(q), "general", `skill-no-tab: ${q}`);
    }
    // Action still browses.
    assert.equal(classifyAgentSkill("click the subscribe button", tab), "browse");
    assert.equal(classifyAgentSkill("keep going from here", tab), "browse");
  });

  it("routes turning a research report into an artifact as build", () => {
    assert.equal(
      classifyAgentSkill("turn that research report into an artifact"),
      "build",
    );
    assert.equal(
      classifyAgentSkill("convert this report into an interactive artifact"),
      "build",
    );
    assert.equal(
      classifyAgentSkill("turn this into a neutral colored presentation"),
      "build",
    );
    assert.equal(
      classifyAgentSkill("make this report into a slide deck"),
      "build",
    );
    assert.equal(
      classifyAgentSkill(
        "based off of one of those inspos build me a presentation on the research report",
      ),
      "build",
    );
    assert.equal(
      classifyAgentSkill(
        "user it as the base for turning that report into an actual presentation",
      ),
      "build",
    );
    assert.equal(
      classifyAgentSkill(
        "use it as the base for turning that report into an actual presentation",
      ),
      "build",
    );
  });

  it("routes edits of the open deliverable to build / report-edit / image", () => {
    assert.equal(
      classifyAgentSkill("make it darker and add a pricing section", {
        hasArtifact: true,
        deliverableKind: "artifact",
      }),
      "build",
    );
    assert.equal(
      classifyAgentSkill("add dark mode", {
        hasArtifact: true,
        deliverableKind: "artifact",
      }),
      "build",
    );
    assert.equal(
      classifyAgentSkill("make the report shorter and punchier", {
        hasReport: true,
        deliverableKind: "report",
      }),
      "report-edit",
    );
    assert.equal(
      classifyAgentSkill("tighten the intro", {
        hasReport: true,
        deliverableKind: "report",
      }),
      "report-edit",
    );
    assert.equal(
      classifyAgentSkill("make it more colorful", {
        hasImage: true,
        deliverableKind: "image",
      }),
      "image",
    );
  });

  it("routes browse goals", () => {
    assert.equal(
      classifyAgentSkill("Open https://example.com and click Sign in"),
      "browse",
    );
  });

  it("routes open browser to bare domain", () => {
    assert.equal(classifyAgentSkill("open up a browser to lykn.io"), "browse");
    assert.equal(classifyAgentSkill("Open LYKN.io"), "browse");
  });

  it("routes site clarifications to browse (not chat-only)", () => {
    assert.equal(resolveSiteClarificationUrl("youtube.com"), "https://youtube.com");
    assert.equal(resolveSiteClarificationUrl("i meant youtube"), "https://www.youtube.com");
    assert.equal(resolveSiteClarificationUrl("trading view"), "https://www.tradingview.com");
    assert.equal(classifyAgentSkill("youtube.com"), "browse");
    assert.equal(classifyAgentSkill("i meant youtube"), "browse");
    assert.equal(
      classifyAgentSkill("youtube.com", { pendingBrowseClarify: true }),
      "browse",
    );
    assert.equal(
      priorAskedForSiteClarification(
        "I couldn't tell which site you meant — did you mean YouTube?",
      ),
      true,
    );
    assert.equal(looksLikeBrowseSiteClarification("try gmail"), true);
  });

  it("routes monitor goals", () => {
    assert.equal(
      classifyAgentSkill("Monitor https://example.com and alert me when price drops"),
      "monitor",
    );
  });

  it("defaults to general", () => {
    assert.equal(classifyAgentSkill("What's a good way to organize my week?"), "general");
  });

  it("routes inbox follow-ups on a live tab as browse", () => {
    const goal = "go through my top ten emails here and lmk if there is anything I need to respond to";
    assert.equal(looksLikeCurrentTabTask(goal), true);
    assert.equal(classifyAgentSkill(goal), "general");
    assert.equal(classifyAgentSkill(goal, { hasLiveTab: true }), "browse");
  });

  it("routes 'see my top ten emails' on a live mail tab as browse", () => {
    const goal = "ok now can you see my top ten emails?";
    assert.equal(looksLikeCurrentTabTask(goal), true);
    assert.equal(
      classifyAgentSkill(goal, {
        hasLiveTab: true,
        liveUrl: "https://mail.google.com/mail/u/0/#inbox",
      }),
      "browse",
    );
  });
});

describe("current-tab / mail helpers", () => {
  it("detects signed-in Gmail URLs vs sign-in chrome text", () => {
    assert.equal(looksLikeSignedInMailUrl("https://mail.google.com/mail/u/0/#inbox"), true);
    assert.equal(looksLikeSignedInMailUrl("https://mail.google.com/"), false);
    assert.equal(looksLikeGmailPublicPage("https://www.google.com/gmail/about/"), true);
    assert.equal(looksLikeGmailPublicPage("https://mail.google.com/mail/u/0/#inbox"), false);
    assert.equal(
      looksLikeSignInWall({
        url: "https://www.google.com/gmail/about/",
        text: "Gmail Secure, smart, and easy to use email",
        title: "Gmail - Google",
      }),
      true,
    );
    assert.equal(
      looksLikeSignInPageText("Sign in\nUse your Google Account\nEmail or phone\nForgot email?"),
      true,
    );
    assert.equal(looksLikeSignInPageText("From: Alice — Please sign in to the portal by Friday"), false);
  });

  it("routes go-to-gmail inbox review to Gmail sign-in→inbox (not marketing page)", () => {
    const goal = "go to my gmail and look to see if I have any unanswered emails";
    assert.equal(looksLikeCurrentTabTask(goal), false);
    assert.equal(looksLikeMailInboxReview(goal), true);
    assert.equal(looksLikeGmailOpenOrReview(goal), true);
    assert.equal(classifyAgentSkill(goal), "browse");
    const target = resolveBrowseTargetUrl(goal);
    assert.equal(target, gmailSignInUrl());
    assert.match(target, /accounts\.google\.com\/ServiceLogin/i);
    assert.match(target, /mail\.google\.com/i);
    assert.doesNotMatch(target, /gmail\/about/i);
  });

  it("routes 'un opened emails' checks through Gmail sign-in, not the public landing page", () => {
    const goal = "open up gmail and see if I have any un opened emails";
    assert.equal(looksLikeMailInboxReview(goal), true);
    assert.equal(resolveBrowseTargetUrl(goal), gmailSignInUrl());
    assert.equal(
      looksLikeGmailPublicContent(
        "Gmail Secure, smart, and easy to use email Create an account For work Get Gmail",
        "Gmail - Google",
      ),
      true,
    );
    assert.equal(
      looksLikeGmailNeedsSignIn({
        url: "https://mail.google.com/mail/u/0/#inbox",
        text: "Create an account For work Get Gmail See Gmail in action",
        title: "Gmail",
      }),
      true,
    );
  });

  it("still treats follow-ups on an open inbox as current-tab tasks", () => {
    const goal = "go through my top ten emails here and lmk if there is anything I need to respond to";
    assert.equal(looksLikeCurrentTabTask(goal), true);
    assert.equal(looksLikeMailInboxReview(goal), true);
  });

  it("detects sign-in walls that should pause the agent", () => {
    assert.equal(
      looksLikeSignInWall({
        url: "https://accounts.google.com/v3/signin/identifier",
        text: "Sign in\nUse your Google Account",
        title: "Sign in - Google Accounts",
      }),
      true,
    );
    assert.equal(
      looksLikeSignInWall({
        url: "https://www.pinterest.com/login/",
        text: "Log in to continue\nEmail\nPassword\nContinue with Google\nCreate account",
        title: "Pinterest",
      }),
      true,
    );
    assert.equal(
      looksLikeSignInWall({
        url: "https://www.pinterest.com/search/pins/?q=blue",
        text: "Blue presentation ideas Related pins Board ideas",
        title: "Pinterest",
      }),
      false,
    );
  });

  it("routes in-page sign-in on the live YouTube tab", () => {
    const goal = "go to the sign in page for me";
    assert.equal(looksLikeInPageAction(goal), true);
    assert.equal(classifyAgentSkill(goal), "browse");
    const target = resolveInPageTargetUrl(goal, "https://www.youtube.com/");
    assert.match(target, /accounts\.google\.com/);
    assert.match(target, /youtube/i);
  });

  it("routes 'check my drafts' to Gmail drafts (and does not throw)", () => {
    const goal = "ok can you check my drafts";
    assert.equal(looksLikeMailDraftsReview(goal), true);
    assert.equal(looksLikeInPageAction(goal), true);
    assert.equal(resolveBrowseTargetUrl(goal), gmailDraftsUrl());
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.equal(
      resolveInPageTargetUrl(goal, "https://mail.google.com/mail/u/0/#inbox"),
      gmailDraftsUrl(),
    );
  });

  it("detects open-first-email asks as in-page mail actions", () => {
    const goal = "go to me gmail and open up the first email";
    assert.equal(looksLikeOpenMailItem(goal), true);
    assert.equal(looksLikeInPageAction(goal), true);
    assert.equal(extractMailOpenIndex(goal), 0);
    assert.equal(extractMailOpenIndex("open the second email"), 1);
    assert.equal(looksLikeOpenMailItem("open the first email"), true);
  });

  it("does not mark open-first-email done while still on Gmail inbox", () => {
    const {
      looksLikeInspectOrReviewAsk,
      unmetBrowseAskRequirements,
      userAskSatisfiedOnPage,
      askStillNeedsAdaptiveWork,
    } = require("../electron/ownedBrowserAct.cjs");
    const inbox = "https://mail.google.com/mail/u/0/#inbox";
    const thread = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQabc123";
    const pageText =
      "Primary Social Promotions Updates Forums Reddit for Business Your weekly ads summary Inbox Compose";
    const goals = [
      "open the first email",
      "can you open up the first email",
      "go to gmail and open the first email",
      "Click on the email to open it",
      "Identify the first email from Reddit for Business and open it",
    ];
    for (const goal of goals) {
      assert.equal(looksLikeInspectOrReviewAsk(goal), false, `notInspect: ${goal}`);
      assert.equal(askStillNeedsAdaptiveWork(goal), true, `needsWork: ${goal}`);
      const unmet = unmetBrowseAskRequirements(goal, {
        url: inbox,
        pageText,
        title: "Inbox",
      });
      assert.ok(
        unmet.some((u) => /open the email/i.test(u)),
        `unmet on inbox for: ${goal} → ${JSON.stringify(unmet)}`,
      );
      assert.equal(
        userAskSatisfiedOnPage(goal, { url: inbox, pageText, title: "Inbox" }),
        false,
        `notSatisfied inbox: ${goal}`,
      );
      assert.equal(
        userAskSatisfiedOnPage(goal, { url: thread, pageText: pageText + " message body", title: "Email" }),
        true,
        `satisfied thread: ${goal}`,
      );
    }
  });

  it("detects draft-a-response as a reply (not blank compose)", () => {
    const goal = "draft a response for that email";
    assert.equal(looksLikeMailReplyTask(goal), true);
    assert.equal(looksLikeMailComposeTask(goal), true);
    assert.equal(looksLikeMailReplyTask("reply to this message"), true);
    assert.equal(looksLikeMailReplyTask("compose a new email to bob@x.com"), false);
    // Reply asks must not deep-link to blank compose=new while on a thread.
    const thread = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQabc";
    assert.equal(resolveInPageTargetUrl(goal, thread), "");
  });

  it("routes 'have it go to the sign in page' to Gmail login — not a Google search", () => {
    const goal = "ok can you have it go to the sign in page";
    assert.equal(looksLikeSignInNavigation(goal), true);
    assert.equal(looksLikeInPageAction(goal), true);
    const cold = resolveBrowseTargetUrl(goal);
    assert.match(cold, /accounts\.google\.com\/ServiceLogin/i);
    assert.match(cold, /service=mail/i);
    assert.match(cold, /mail\.google\.com/i);
    assert.doesNotMatch(cold, /google\.com\/search/i);
    assert.equal(cold, gmailSignInUrl());

    const fromAbout = resolveSignInUrl(goal, "https://www.google.com/gmail/about/");
    assert.equal(fromAbout, gmailSignInUrl());
    assert.equal(
      resolveInPageTargetUrl(goal, "https://www.google.com/gmail/about/"),
      gmailSignInUrl(),
    );
  });
});

describe("extractUrlFromText", () => {
  it("parses full and bare domains", () => {
    assert.equal(extractUrlFromText("see https://LYKN.io/now"), "https://LYKN.io/now");
    assert.equal(extractUrlFromText("open up a browser to lykn.io"), "https://lykn.io");
    assert.equal(extractUrlFromText("no url here"), "");
  });

  it("does not treat email addresses or brand mentions as navigate targets", () => {
    const goal =
      "go to compose and compose an email to david@lykn.io explaining how this is a test email for the new LYKN agent feature but just make a draft don't send it";
    assert.equal(extractUrlFromText(goal), "");
    assert.equal(resolveBrowseTargetUrl(goal), "");
    assert.equal(looksLikeMailComposeTask(goal), true);
    assert.equal(looksLikeInPageAction(goal), true);
    assert.match(
      resolveGmailComposeUrl(goal),
      /mail\.google\.com.*to=david%40lykn\.io/i,
    );
    assert.match(
      resolveInPageTargetUrl(goal, "https://mail.google.com/mail/u/0/#inbox"),
      /mail\.google\.com/,
    );
  });

  it("normalizes curly quotes and dashes for Gmail plain text", () => {
    const raw =
      "I\u2019m writing \u2014 miraculously \u2014 just to say hello\u2026";
    assert.equal(
      toPlainEmailText(raw),
      "I'm writing - miraculously - just to say hello...",
    );
    const url = resolveGmailComposeUrl("x", {
      to: "david@lykn.io",
      subject: "Test\u2019s",
      body: raw,
    });
    assert.match(url, /I%27m/);
    assert.match(url, /Test%27s/);
    assert.equal(url.includes("%E2%80%99"), false);
    assert.equal(url.includes("%E2%80%94"), false);
  });

  it("builds a Gmail compose URL with subject/body and recovers paste drafts", () => {
    const goal =
      "can you compose an email to David@lykn.io just a draft explaining how this is a test email from the new LYKN agent feature and put the name of sender as Eli";
    const draft = synthesizeMailDraft(goal);
    assert.equal(draft.to.toLowerCase(), "david@lykn.io");
    assert.match(draft.subject, /test email/i);
    assert.match(draft.body, /Eli/);
    assert.match(draft.body, /LYKN agent/i);
    const url = resolveGmailComposeUrl(goal, draft);
    assert.match(url, /su=/i);
    assert.match(url, /body=/i);

    const assistant =
      "Draft ready:\n\nTo: David@LYKN.io Subject: Test Email — New LYKN Agent Feature\n\nHi David,\n\nThis is a test email sent using the new LYKN agent feature.\n\nBest, Eli";
    const parsed = parseMailDraftFromText(assistant);
    assert.ok(parsed);
    assert.match(parsed.to, /david@lykn\.io/i);
    assert.match(parsed.subject, /Test Email/i);
    assert.match(parsed.body, /Hi David/);
    assert.equal(looksLikePasteIntoCompose("ok paste that into the email"), true);
  });

  it("regenerates humorous / less-serious drafts instead of reusing the old body", () => {
    const prior = synthesizeMailDraft(
      "compose an email to david@lykn.io explaining how this is a test email from the new LYKN agent feature",
    );
    // Tone-only follow-ups need mail context — bare "make it shorter" is not Gmail.
    assert.equal(looksLikeMailDraftRevision("make it less serious"), false);
    assert.equal(
      looksLikeMailDraftRevision("make it less serious", { hasMailDraft: true }),
      true,
    );
    assert.equal(looksLikeMailDraftRevision("make the email less serious"), true);
    assert.equal(looksLikeMailDraftRevision("edit that"), false);
    assert.equal(looksLikeMailDraftRevision("edit the doc"), false);
    assert.equal(looksLikeMailDraftRevision("make the email draft shorter"), true);
    assert.equal(
      looksLikeMailDraftRevision("write one that is humorous", { hasMailDraft: true }),
      true,
    );
    const funny = synthesizeMailDraft("write a humorous version to david@lykn.io", prior);
    assert.match(funny.body, /robot|smile|friendly|did the robot|🙂|ping/i);
    assert.notEqual(funny.body, prior.body);
    assert.equal(
      classifyAgentSkill("make it humorous", {
        hasMailDraft: true,
        liveUrl: "https://mail.google.com/mail/?view=cm&fs=1",
      }),
      "browse",
    );
  });
});

describe("youtube search browse target", () => {
  it("builds a YouTube results URL", () => {
    const goal = "go to youtube.com search up lyknmedia";
    assert.equal(extractSearchQuery(goal), "lyknmedia");
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://www.youtube.com/results?search_query=lyknmedia",
    );
  });

  it("resolves bare 'youtube' without .com", () => {
    const goal = "open up youtube and search for LYKNmedia";
    assert.equal(extractUrlFromText(goal), "https://www.youtube.com");
    assert.equal(extractSearchQuery(goal), "LYKNmedia");
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://www.youtube.com/results?search_query=LYKNmedia",
    );
  });
});

describe("open site then search on-site (not Google the whole phrase)", () => {
  it("deep-links Pinterest search instead of Googling 'pinterest and food recipes'", () => {
    const goal = "open up pinterest and search for food recipes";
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.equal(extractUrlFromText(goal), "https://www.pinterest.com");
    assert.equal(extractSearchQuery(goal), "food recipes");
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://www.pinterest.com/search/pins/?q=food%20recipes",
    );
    assert.equal(
      searchDeepLinkForUrl("https://www.pinterest.com/", "food recipes"),
      "https://www.pinterest.com/search/pins/?q=food%20recipes",
    );
  });

  it("deep-links Reddit search", () => {
    const goal = "go to reddit and search for mechanical keyboards";
    assert.equal(extractUrlFromText(goal), "https://www.reddit.com");
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://www.reddit.com/search/?q=mechanical%20keyboards",
    );
  });

  it("deep-links Spotify for 'go into spotify and search for the song …'", () => {
    const goal = "go into spotify and search for the song thunderstruck";
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.equal(extractUrlFromText(goal), "https://open.spotify.com");
    assert.equal(extractSearchQuery(goal), "thunderstruck");
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://open.spotify.com/search/thunderstruck",
    );
    assert.equal(
      searchDeepLinkForUrl("https://open.spotify.com/", "thunderstruck"),
      "https://open.spotify.com/search/thunderstruck",
    );
  });

  it("searches Spotify for play asks (not bare open) and resolves play-it follow-ups", () => {
    const {
      looksLikePlayMediaAsk,
      looksLikePlayMediaFollowUp,
      looksLikeOpenDestinationAsk,
      resolveContextualBrowseUrl,
      isWeakPickQuery,
    } = require("../electron/ownedBrowserAct.cjs");
    const playGoal = "go into spotify and play thunderstruck";
    assert.equal(looksLikeOpenDestinationAsk(playGoal), false);
    assert.equal(looksLikePlayMediaAsk(playGoal), true);
    assert.equal(
      resolveBrowseTargetUrl(playGoal),
      "https://open.spotify.com/search/thunderstruck",
    );
    assert.equal(looksLikePlayMediaFollowUp("ok play it"), true);
    assert.equal(isWeakPickQuery("it"), true);
    assert.equal(extractSearchQuery("ok play it"), "");
    assert.equal(
      resolveContextualBrowseUrl("ok play it", {
        lastBrowseQuery: "thunderstruck",
        priorGoal: "go into spotify and search for thunderstruck",
        currentUrl: "https://open.spotify.com/search/thunderstruck",
      }),
      "https://open.spotify.com/search/thunderstruck",
    );
    assert.equal(
      classifyAgentSkill("ok play it", { hasLiveTab: true }),
      "browse",
    );
  });

  it("resolves short follow-ups from chat + open app (any software, not just Spotify)", () => {
    const {
      looksLikeDeicticFollowUp,
      expandDeicticFollowUp,
      composeAdaptiveBrowseGoal,
      resolveContextualBrowseUrl,
      looksLikeInPageAction,
    } = require("../electron/ownedBrowserAct.cjs");

    assert.equal(looksLikeDeicticFollowUp("do it"), true);
    assert.equal(looksLikeDeicticFollowUp("go ahead"), true);
    assert.equal(looksLikeDeicticFollowUp("open that"), true);
    assert.equal(looksLikeDeicticFollowUp("ok play it"), true);
    assert.equal(extractSearchQuery("do it"), "");
    assert.equal(extractSearchQuery("go ahead"), "");
    assert.equal(looksLikeInPageAction("do it"), true);
    assert.equal(classifyAgentSkill("do it", { hasLiveTab: true }), "browse");
    assert.equal(classifyAgentSkill("go ahead", { hasLiveTab: true }), "browse");

    // Pinterest: "open that" resumes the prior on-site search, not Google for "that".
    assert.equal(
      resolveContextualBrowseUrl("open that", {
        lastBrowseQuery: "blue presentation ideas",
        priorGoal: "pull up pinterest look for blue presentation ideas",
        currentUrl: "https://www.pinterest.com/",
      }),
      "https://www.pinterest.com/search/pins/?q=blue%20presentation%20ideas",
    );

    // Canva (or any open app): expand "do it" using prior goal + host.
    const canvaExpand = expandDeicticFollowUp("do it", {
      priorGoal: "create a resume in canva",
      currentUrl: "https://www.canva.com/",
      lastBrowseQuery: "",
    });
    assert.match(canvaExpand, /canva/i);
    assert.match(canvaExpand, /resume|finish|do it/i);
    assert.equal(resolveBrowseTargetUrl("do it"), "");

    const adaptive = composeAdaptiveBrowseGoal("finish it", {
      priorGoal: "fill out the signup form",
      currentUrl: "https://example.com/signup",
    });
    assert.match(adaptive, /example\.com|signup|finish/i);
  });

  it("composes look-for + find-one-that-is into one on-site query and pick intent", () => {
    const {
      composeBrowseSearchQuery,
      looksLikePickOneBrowseIntent,
    } = require("../electron/ownedBrowserAct.cjs");
    const goal =
      "pull up pinterest, look for presentation ideas find one that is blue for me";
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.equal(extractUrlFromText(goal), "https://www.pinterest.com");
    assert.equal(composeBrowseSearchQuery(goal), "blue presentation ideas");
    assert.equal(extractSearchQuery(goal), "blue presentation ideas");
    assert.equal(looksLikePickOneBrowseIntent(goal), true);
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://www.pinterest.com/search/pins/?q=blue%20presentation%20ideas",
    );
  });

  it("does not search Pinterest for 'one you like'", () => {
    const {
      composeBrowseSearchQuery,
      looksLikePickOneBrowseIntent,
    } = require("../electron/ownedBrowserAct.cjs");
    const goal =
      "go to pinterest find me blue presentation ideas look for one you like";
    assert.equal(composeBrowseSearchQuery(goal), "blue presentation ideas");
    assert.equal(extractSearchQuery(goal), "blue presentation ideas");
    assert.equal(looksLikePickOneBrowseIntent(goal), true);
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://www.pinterest.com/search/pins/?q=blue%20presentation%20ideas",
    );
  });

  it("routes 'search pinterest for …' to on-site browse (not chat links)", () => {
    const goal = "search pinterest for good incognito icons";
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.equal(extractUrlFromText(goal), "https://www.pinterest.com");
    assert.equal(extractSearchQuery(goal), "good incognito icons");
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://www.pinterest.com/search/pins/?q=good%20incognito%20icons",
    );
  });
});

describe("stock browse targets", () => {
  it("resolves yahoo stocks + tesla to Yahoo quote", () => {
    const goal = "go to yahoo stocks and find the current value of tesla stock";
    assert.equal(extractStockTicker(goal), "TSLA");
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.equal(resolveBrowseTargetUrl(goal), "https://finance.yahoo.com/quote/TSLA");
  });

  it("resolves vague live chart requests without a domain", () => {
    const goal =
      "i need you to open some sort of stock diagram showing the livetime feed of tesla stock";
    assert.equal(extractStockTicker(goal), "TSLA");
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://www.tradingview.com/symbols/NASDAQ-TSLA/",
    );
  });

  it("assumes a Google search when the user names no website", () => {
    const goal = "can you look up the best espresso machines under $200";
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.match(resolveBrowseTargetUrl(goal), /google\.com\/search\?q=/i);
    assert.equal(resolveBrowseTargetUrl(goal).includes("espresso"), true);
  });

  it("strips filler words from search queries", () => {
    assert.equal(extractSearchQuery("search up cats now"), "cats");
    assert.equal(extractSearchQuery("can you search for dogs for me"), "dogs");
    assert.equal(extractSearchQuery("search for espresso machines please"), "espresso machines");
    assert.match(resolveBrowseTargetUrl("search up cats now"), /q=cats(?:&|$)/i);
    assert.doesNotMatch(resolveBrowseTargetUrl("search up cats now"), /cats(\+|%20)now/i);
  });

  it("routes vague inspo asks to Pinterest with a cleaned topic", () => {
    const {
      looksLikeInspoBrowseIntent,
      extractInspoSearchQuery,
    } = require("../electron/ownedBrowserAct.cjs");
    const goal = "I'm looking for inspo ideas for a landing page";
    assert.equal(looksLikeInspoBrowseIntent(goal), true);
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.match(extractInspoSearchQuery(goal), /landing\s+page/i);
    assert.doesNotMatch(extractInspoSearchQuery(goal), /looking for/i);
    const url = resolveBrowseTargetUrl(goal);
    assert.match(url, /pinterest\.com\/search/i);
    assert.match(url, /landing/i);
    assert.doesNotMatch(url, /looking(\+|%20)for/i);
  });

  it("routes chatty 'look at UI ideas on pinterest' to browse, not a moodboard artifact", () => {
    const {
      looksLikeInspoBrowseIntent,
      extractInspoSearchQuery,
    } = require("../electron/ownedBrowserAct.cjs");
    const goal =
      "I'm going to be looking into how I want the LYKN browser with glass and the normal software to look so let's look at some UI design ideas for that on pinterest";
    assert.equal(looksLikeInspoBrowseIntent(goal), true);
    assert.equal(classifyAgentSkill(goal), "browse");
    const q = extractInspoSearchQuery(goal);
    assert.match(q, /ui\s+design/i);
    assert.doesNotMatch(q, /looking into/i);
    assert.doesNotMatch(q, /that on pinterest/i);
    const url = resolveBrowseTargetUrl(goal);
    assert.match(url, /pinterest\.com\/search/i);
    assert.match(url, /UI|design/i);
    assert.doesNotMatch(url, /looking(\+|%20)into/i);
  });

  it("searches YouTube for follow-ups instead of Googling the whole sentence", () => {
    const goal = "find me a mr beast video the latest one";
    assert.equal(looksLikeSameTabSearch(goal), true);
    assert.match(extractSearchQuery(goal), /mr beast/i);
    assert.match(
      searchDeepLinkForUrl("https://www.youtube.com/", extractSearchQuery(goal)),
      /youtube\.com\/results\?search_query=/i,
    );
    assert.equal(looksLikeRetargetSearchToSite("no pull it up in youtube"), true);
    assert.equal(
      resolveBrowseTargetUrl(
        `https://www.youtube.com ${goal}`,
      ).startsWith("https://www.youtube.com/results?search_query="),
      true,
    );
  });

  it("keeps video play intent after plan cleaning", () => {
    const { buildAgentPlan } = require("./agentMultiStep.cjs");
    const plan = buildAgentPlan("find me a mr beast video");
    assert.equal(plan.texts.length, 1);
    assert.match(plan.texts[0], /^find\b/i);
    assert.match(plan.texts[0], /mr beast/i);
    assert.equal(looksLikeVideoBrowseIntent(plan.texts[0]), true);
    assert.match(resolveBrowseTargetUrl(plan.texts[0]), /youtube\.com\/results/i);
    assert.equal(extractVideoSearchQuery("find me a mr beast video and play it"), "mr beast");
  });

  it("does not search YouTube for 'youtube' on bare open, and cleans nba runns asks", () => {
    assert.equal(looksLikeVideoBrowseIntent("open youtube"), false);
    assert.equal(extractVideoSearchQuery("open youtube"), "");
    const goal = "can you go to youtube for me and search up like an nba runns video";
    assert.equal(looksLikeVideoBrowseIntent(goal), true);
    assert.equal(extractVideoSearchQuery(goal), "nba runns");
    assert.match(resolveBrowseTargetUrl(goal), /search_query=nba(\+|%20)*runns/i);
    assert.doesNotMatch(resolveBrowseTargetUrl(goal), /search_query=youtube/i);

    const { buildAgentPlan } = require("./agentMultiStep.cjs");
    const vidAsk = "open up youtube and find me an nba runns vid";
    const plan = buildAgentPlan(vidAsk);
    assert.equal(plan.texts.length, 1);
    assert.match(resolveBrowseTargetUrl(plan.texts[0]), /youtube\.com\/results/i);
    assert.match(resolveBrowseTargetUrl(plan.texts[0]), /search_query=nba(\+|%20)*runns/i);
    assert.doesNotMatch(resolveBrowseTargetUrl(plan.texts[0]), /google\.com\/search/i);
    assert.equal(looksLikeVideoBrowseIntent("find nba runns vid"), true);
    assert.equal(looksLikeVideoBrowseIntent("search for nba runns vid"), true);
  });

  it("routes vague latest-video asks to YouTube (not Google / not chat)", () => {
    const goal = "find me a mr beast video the latest one";
    assert.equal(looksLikeVideoBrowseIntent(goal), true);
    assert.equal(wantsLatestVideo(goal), true);
    assert.equal(classifyAgentSkill(goal), "browse");
    assert.match(extractVideoSearchQuery(goal), /^mr\.?\s*beast$/i);
    const url = resolveBrowseTargetUrl(goal);
    assert.match(url, /youtube\.com\/results\?search_query=/i);
    assert.match(url, /mr(\+|%20)*beast/i);
    assert.match(url, /sp=CAI/i);
    assert.equal(looksLikeVideoBrowseIntent("latest mr beast video"), true);
    assert.equal(classifyAgentSkill("latest mr beast video"), "browse");
    assert.match(youtubeSearchUrl("mr beast", { sortByDate: true }), /sp=CAI/);
  });

  it("routes click / pull-up video follow-ups as in-page browse actions", () => {
    assert.equal(looksLikeInPageAction("click on one of these videos now for me"), true);
    assert.equal(looksLikeOpenSearchResult("click on one of these videos now for me"), true);
    assert.equal(looksLikeOpenSearchResult("can you pull that video up"), true);
    assert.equal(
      extractQuotedTitle('The newest is “I Granted 100 Kids Their Biggest Wish!”'),
      "I Granted 100 Kids Their Biggest Wish!",
    );
    assert.equal(
      classifyAgentSkill("click on one of these videos now for me", {
        hasLiveTab: true,
        liveUrl: "https://www.youtube.com/results?search_query=mr+beast",
      }),
      "browse",
    );
    assert.equal(
      classifyAgentSkill("can you pull that video up", {
        hasLiveTab: true,
        liveUrl: "https://www.youtube.com/results?search_query=mr+beast",
      }),
      "browse",
    );
  });
});

describe("open destination (deep link or search→auto-open)", () => {
  const {
    looksLikeOpenDestinationAsk,
    extractOpenDestinationName,
    resolveOpenDestinationUrl,
    setUserSiteAliases,
  } = require("../electron/ownedBrowserAct.cjs");

  it("deep-links Google Sheets instead of bare google.com", () => {
    const goal = "open google sheets";
    assert.equal(looksLikeOpenDestinationAsk(goal), true);
    assert.equal(extractOpenDestinationName(goal), "google sheets");
    assert.match(resolveBrowseTargetUrl(goal), /docs\.google\.com\/spreadsheets/i);
    assert.doesNotMatch(resolveBrowseTargetUrl(goal), /^https:\/\/www\.google\.com\/?$/i);
    assert.equal(
      resolveOpenDestinationUrl(goal),
      "https://docs.google.com/spreadsheets/u/0/",
    );
  });

  it("deep-links other Google Workspace apps", () => {
    assert.match(resolveBrowseTargetUrl("open google docs"), /docs\.google\.com\/document/i);
    assert.match(resolveBrowseTargetUrl("go to google drive"), /drive\.google\.com/i);
    assert.match(resolveBrowseTargetUrl("pull up google calendar"), /calendar\.google\.com/i);
  });

  it("deep-links known apps (figma, notion)", () => {
    assert.match(resolveBrowseTargetUrl("open figma"), /figma\.com/i);
    assert.match(resolveBrowseTargetUrl("pull up notion"), /notion\.so/i);
  });

  it("falls back to Google search for unknown products (runtime auto-opens top result)", () => {
    const goal = "open acme project dashboard";
    assert.equal(looksLikeOpenDestinationAsk(goal), true);
    assert.equal(extractOpenDestinationName(goal), "acme project dashboard");
    const url = resolveBrowseTargetUrl(goal);
    assert.match(url, /google\.com\/search\?q=/i);
    assert.match(url, /acme/i);
    assert.match(url, /dashboard/i);
  });

  it("keeps domains intact and detects wrong-open corrections", () => {
    const {
      looksLikeWrongOpenDestinationAsk,
    } = require("../electron/ownedBrowserAct.cjs");
    assert.equal(extractOpenDestinationName("go to nike.com"), "nike.com");
    assert.equal(extractOpenDestinationName("open adobe"), "adobe");
    assert.match(resolveBrowseTargetUrl("go to nike.com"), /nike\.com/i);
    assert.doesNotMatch(resolveBrowseTargetUrl("go to nike.com"), /google\.com\/search/i);
    assert.equal(looksLikeWrongOpenDestinationAsk("that's not right"), true);
    assert.equal(looksLikeWrongOpenDestinationAsk("wrong site"), true);
    assert.equal(looksLikeWrongOpenDestinationAsk("not that one"), true);
    assert.equal(looksLikeWrongOpenDestinationAsk("open adobe"), false);
  });

  it("opens well-known brands directly; unknowns still Google-search", () => {
    const {
      resolveWellKnownBrandUrl,
    } = require("../electron/ownedBrowserAct.cjs");
    assert.equal(resolveWellKnownBrandUrl("nike"), "https://www.nike.com");
    assert.equal(resolveBrowseTargetUrl("open nike"), "https://www.nike.com");
    assert.equal(resolveBrowseTargetUrl("open adobe"), "https://www.adobe.com");
    assert.equal(resolveBrowseTargetUrl("pull up spotify"), "https://open.spotify.com");
    assert.equal(resolveBrowseTargetUrl("go to target"), "https://www.target.com");
    assert.doesNotMatch(resolveBrowseTargetUrl("open nike"), /google\.com\/search/i);
    // Unfamiliar name → search (runtime will click the top result).
    assert.match(
      resolveBrowseTargetUrl("open acme project dashboard"),
      /google\.com\/search\?q=/i,
    );
  });

  it("does not steal open+search flows (still on-site deep link)", () => {
    const goal = "open up pinterest and search for food recipes";
    assert.equal(looksLikeOpenDestinationAsk(goal), false);
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://www.pinterest.com/search/pins/?q=food%20recipes",
    );
  });

  it("prefers user-starred aliases over built-in sites", () => {
    setUserSiteAliases({
      "budget sheet": "https://docs.google.com/spreadsheets/d/abc123/edit",
      "my board": "https://www.notion.so/my-board-xyz",
    });
    try {
      assert.equal(
        resolveBrowseTargetUrl("open my budget sheet"),
        "https://docs.google.com/spreadsheets/d/abc123/edit",
      );
      assert.equal(
        resolveBrowseTargetUrl("pull up my board"),
        "https://www.notion.so/my-board-xyz",
      );
      assert.equal(looksLikeOpenDestinationAsk("open my budget sheet"), true);
    } finally {
      setUserSiteAliases({});
    }
  });

  it("opens a blank Google Sheet instead of searching for 'blank sheet'", () => {
    const {
      looksLikeNewBlankWorkspaceAsk,
    } = require("../electron/ownedBrowserAct.cjs");
    const goal = "open up a blank sheet";
    assert.equal(looksLikeNewBlankWorkspaceAsk(goal), true);
    assert.equal(
      resolveBrowseTargetUrl(goal),
      "https://docs.google.com/spreadsheets/create",
    );
    assert.doesNotMatch(resolveBrowseTargetUrl(goal), /google\.com\/search/i);
  });

  it("uses prior Sheets chat context for 'a blank one'", () => {
    const ctx = {
      priorGoal: "open google sheets",
      recentUserGoals: ["open google sheets"],
      currentUrl: "https://docs.google.com/spreadsheets/u/0/",
    };
    assert.equal(
      resolveBrowseTargetUrl("open up a blank one", ctx),
      "https://docs.google.com/spreadsheets/create",
    );
    assert.equal(
      resolveBrowseTargetUrl("open google sheets"),
      "https://docs.google.com/spreadsheets/u/0/",
    );
  });

  it("opens a blank Google Doc instead of searching for 'doc'", () => {
    const {
      looksLikeNewBlankWorkspaceAsk,
    } = require("../electron/ownedBrowserAct.cjs");
    const docsCtx = {
      priorGoal: "open google doc",
      recentUserGoals: ["open google doc"],
      currentUrl: "https://docs.google.com/document/u/0/",
    };
    for (const goal of [
      "open a blank doc",
      "open blank doc",
      "open a blank document",
      "click the blank doc",
      "open a blank one",
      "open a blank",
    ]) {
      assert.equal(looksLikeNewBlankWorkspaceAsk(goal, docsCtx), true, goal);
      assert.equal(
        resolveBrowseTargetUrl(goal, docsCtx),
        "https://docs.google.com/document/create",
        goal,
      );
      assert.doesNotMatch(resolveBrowseTargetUrl(goal, docsCtx), /google\.com\/search/i);
    }
    // Bare "open doc" is Docs home — never a Google search for the word "doc".
    assert.equal(
      resolveBrowseTargetUrl("open doc"),
      "https://docs.google.com/document/u/0/",
    );
    assert.doesNotMatch(resolveBrowseTargetUrl("open doc"), /google\.com\/search/i);
  });
});
