const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  looksBrowseGoalSatisfied,
  looksLikeMultiStepBrowseGoal,
  looksLikeBareOpenBrowseGoal,
  askStillNeedsAdaptiveWork,
  looksLikeInspectOrReviewAsk,
  unmetBrowseAskRequirements,
  userAskSatisfiedOnPage,
  looksLikeShareCurrentPageAsk,
  isShareInviteGoal,
  stripShareSendInstructions,
  sanitizeDraftedDocBody,
  pageShowsSubstantialDocBody,
  remainingAskGoal,
  planStepAlreadySatisfied,
  extractBrowseGoalPhases,
  browseGoalPhasesEvidence,
  taskPlanBlocksDone,
  seedProgressiveTaskPlan,
  progressivePlanNowLine,
  pageShowsExerciseComplete,
  pageShowsShareInviteComplete,
  pageShowsDiscardChangesDialog,
  pageShowsShareDialogOpen,
  pageShowsShareEmailEntered,
  historyShowsShareSendDone,
  resolveBrowseTargetUrl,
  resolveOpenDestinationUrl,
  resolveAccountDashboardUrl,
  extractOpenDestinationName,
} = require("../electron/ownedBrowserAct.cjs");

describe("looksLikeMultiStepBrowseGoal", () => {
  it("flags complete / quiz / then workflows", () => {
    assert.equal(looksLikeMultiStepBrowseGoal("find a physics quiz and complete it"), true);
    assert.equal(looksLikeMultiStepBrowseGoal("open gmail then reply to the first email"), true);
    assert.equal(looksLikeMultiStepBrowseGoal("work through the entire lesson"), true);
    assert.equal(looksLikeMultiStepBrowseGoal("keep going through the rest"), true);
    assert.equal(looksLikeMultiStepBrowseGoal("do the rest of the form"), true);
    assert.equal(looksLikeMultiStepBrowseGoal("open youtube"), false);
  });
});

describe("vague ads / account destinations", () => {
  it("maps reddit ads thing/stuff to ads.reddit.com — not Google", () => {
    for (const q of [
      "open up my reddit ads thing and check my ads",
      "pull up my reddit ads stuff",
      "open reddit ads thing",
      "open up my reddit advertising and check my ads",
    ]) {
      assert.equal(resolveBrowseTargetUrl(q), "https://ads.reddit.com", q);
      assert.equal(resolveOpenDestinationUrl(q), "https://ads.reddit.com", q);
      assert.equal(resolveAccountDashboardUrl(q), "https://ads.reddit.com", q);
    }
    assert.equal(extractOpenDestinationName("open up my reddit ads thing"), "reddit ads");
  });
});

describe("userAskSatisfiedOnPage / inspect asks", () => {
  it("treats open+check ads as done once on ads.reddit.com", () => {
    const goal = "open up my reddit ads thing and check my ads";
    assert.equal(looksLikeInspectOrReviewAsk(goal), true);
    assert.equal(
      userAskSatisfiedOnPage(goal, {
        url: "https://ads.reddit.com/campaigns",
        pageText: "Campaigns Delivery Spend Impressions last 7 days",
        title: "Reddit Ads",
        history: [],
      }),
      true,
    );
    // Still on Google SERP — not done.
    assert.equal(
      userAskSatisfiedOnPage(goal, {
        url: "https://www.google.com/search?q=reddit+ads+thing",
        pageText: "Search results reddit ads",
        title: "Google Search",
        history: [],
      }),
      false,
    );
  });

  it("does not treat quiz/complete asks as inspect-only", () => {
    assert.equal(
      looksLikeInspectOrReviewAsk("find a quiz and complete it"),
      false,
    );
    assert.equal(
      looksLikeInspectOrReviewAsk("open docs and write then share it"),
      false,
    );
  });
});

describe("unmetBrowseAskRequirements / full-ask recheck", () => {
  it("keeps write+share unfinished after open-only", () => {
    const goal = "open docs and write a short essay then share it with bob@gmail.com";
    const gaps = unmetBrowseAskRequirements(goal, {
      url: "https://docs.google.com/document/d/abc/edit",
      pageText: "Untitled document File Edit View",
      history: [],
    });
    assert.ok(gaps.some((g) => /write|type/i.test(g)), String(gaps));
    assert.ok(gaps.some((g) => /share|invite/i.test(g)), String(gaps));
    assert.equal(
      userAskSatisfiedOnPage(goal, {
        url: "https://docs.google.com/document/d/abc/edit",
        pageText: "Untitled document File Edit View",
        history: [],
      }),
      false,
    );
  });

  it("keeps share unfinished after write-only", () => {
    const goal = "open docs and write a short essay then share it with bob@gmail.com";
    const gaps = unmetBrowseAskRequirements(goal, {
      url: "https://docs.google.com/document/d/abc/edit",
      pageText: "Dogs are great companions.",
      history: [
        { action: { type: "click", label: "Document body" }, result: { ok: true } },
        {
          action: { type: "write", text: "Dogs are great companions." },
          result: { ok: true },
        },
      ],
    });
    assert.ok(gaps.some((g) => /share|invite/i.test(g)), String(gaps));
    assert.equal(
      gaps.some((g) => /write|type/i.test(g)),
      false,
      String(gaps),
    );
  });

  it("clears when share invite is confirmed", () => {
    const goal = "share this doc with bob@gmail.com";
    const gaps = unmetBrowseAskRequirements(goal, {
      url: "https://docs.google.com/document/d/abc/edit",
      pageText: "Invitation sent to bob@gmail.com Access updated",
      history: [
        { action: { type: "click", label: "Share" }, result: { ok: true } },
        { action: { type: "type", value: "bob@gmail.com" }, result: { ok: true } },
        { action: { type: "click", label: "Send" }, result: { ok: true } },
      ],
    });
    assert.deepEqual(gaps, []);
  });

  it("keeps quiz incomplete until completion copy", () => {
    const goal = "find a physics quiz and complete it";
    const gaps = unmetBrowseAskRequirements(goal, {
      url: "https://www.khanacademy.org/quiz/1",
      pageText: "Question 1 of 8 — pick an answer",
      history: [
        { action: { type: "click", label: "Start quiz" }, result: { ok: true } },
        { action: { type: "click", label: "Answer A" }, result: { ok: true } },
      ],
      sawScreenChange: true,
    });
    assert.ok(gaps.some((g) => /quiz|exercise|finish/i.test(g)), String(gaps));
  });

  it("treats 'send it to email' as share, not more essay text", () => {
    const goal =
      "Go to google doc write out a 100 word paper on the purpose of life then send it to elijah@lykn.io";
    assert.equal(looksLikeShareCurrentPageAsk(goal), true);
    assert.equal(isShareInviteGoal(goal), true);
    assert.match(
      stripShareSendInstructions(goal),
      /purpose of life/i,
    );
    assert.doesNotMatch(stripShareSendInstructions(goal), /elijah@lykn\.io/i);
    assert.doesNotMatch(
      sanitizeDraftedDocBody(
        "A meaningful life.\n\nthe purpose of life then send it to elijah@lykn.io",
      ),
      /send it to/i,
    );
    const gaps = unmetBrowseAskRequirements(goal, {
      url: "https://docs.google.com/document/d/abc/edit",
      pageText: "The Purpose of Life … leave people better than we found them.",
      history: [
        { action: { type: "click", label: "Document body" }, result: { ok: true } },
        {
          action: { type: "write", text: "The Purpose of Life …" },
          result: { ok: true },
        },
      ],
    });
    assert.ok(gaps.some((g) => /share|send/i.test(g)), String(gaps));
  });

  it("does not ask to rewrite when the doc body is already filled", () => {
    const goal =
      "Go to google doc write out a 100 word paper on the purpose of life then send it to elijah@lykn.io";
    const essay =
      "The purpose of life may not be a single answer waiting to be discovered, but a meaning created through experience. " +
      "It lives in the relationships that teach us love, the challenges that build resilience, and the moments of curiosity that expand our understanding. " +
      "Purpose can be found in helping others, making something worthwhile, and becoming more honest about who we are.";
    const url = "https://docs.google.com/document/d/abc/edit";
    assert.equal(pageShowsSubstantialDocBody(essay, url), true);
    const gaps = unmetBrowseAskRequirements(goal, {
      url,
      pageText: `File Edit View Share Untitled document ${essay}`,
      history: [],
    });
    assert.equal(
      gaps.some((g) => /write|type/i.test(g)),
      false,
      String(gaps),
    );
    assert.ok(gaps.some((g) => /share|send/i.test(g)), String(gaps));
    const remain = remainingAskGoal(goal, {
      url,
      pageText: `File Edit View Share Untitled document ${essay}`,
      history: [],
    });
    assert.match(remain, /STILL TODO/i);
    assert.match(remain, /ALREADY DONE/i);
    assert.match(remain, /do NOT rewrite/i);
    assert.doesNotMatch(remain, /write\/type the requested content/i);
    assert.equal(
      planStepAlreadySatisfied(
        "Go to google doc write out a 100 word paper on the purpose of life",
        goal,
        { url, pageText: `File Edit View Share ${essay}`, history: [] },
      ),
      true,
    );
    assert.equal(
      planStepAlreadySatisfied("send it to elijah@lykn.io", goal, {
        url,
        pageText: `File Edit View Share ${essay}`,
        history: [],
      }),
      false,
    );
  });
});

describe("askStillNeedsAdaptiveWork", () => {
  it("is false for bare open, true when follow-on work remains", () => {
    assert.equal(askStillNeedsAdaptiveWork("open gmail"), false);
    assert.equal(askStillNeedsAdaptiveWork("open youtube"), false);
    assert.equal(askStillNeedsAdaptiveWork("open khan academy and find a physics quiz"), true);
    assert.equal(
      askStillNeedsAdaptiveWork("open docs and write a short essay then share it"),
      true,
    );
    assert.equal(askStillNeedsAdaptiveWork("find a quiz and complete it"), true);
  });

  it("keeps bare-open detection aligned", () => {
    assert.equal(looksLikeBareOpenBrowseGoal("open gmail"), true);
    assert.equal(
      looksLikeBareOpenBrowseGoal("open khan academy and find a physics quiz"),
      false,
    );
  });
});

describe("browseGoalPhasesEvidence / taskPlanBlocksDone", () => {
  it("extracts open→find→finish phases", () => {
    const phases = extractBrowseGoalPhases(
      "open khan academy find a physics quiz and complete it",
    );
    assert.ok(phases.includes("open"));
    assert.ok(phases.includes("find"));
    assert.ok(phases.includes("finish"));
  });

  it("rejects done while finish phase lacks evidence", () => {
    const goal = "find a physics quiz and complete it";
    const ev = browseGoalPhasesEvidence(goal, {
      url: "https://www.khanacademy.org/",
      pageText: "Welcome to Khan Academy",
      history: [{ action: { type: "click", label: "Search" }, result: { ok: true } }],
      sawScreenChange: true,
    });
    assert.equal(ev.ok, false);
    assert.ok(ev.missing.includes("finish"));
  });

  it("accepts quiz finish when completion copy is visible", () => {
    const goal = "complete the quiz";
    const ev = browseGoalPhasesEvidence(goal, {
      url: "https://www.khanacademy.org/quiz/done",
      pageText: "Great work! Lesson complete.",
      history: [
        { action: { type: "click" }, result: { ok: true } },
        { action: { type: "click" }, result: { ok: true } },
        { action: { type: "click" }, result: { ok: true } },
      ],
      sawScreenChange: true,
    });
    assert.equal(ev.ok, true);
  });

  it("blocks done while LATER / Final CHECK still open", () => {
    const plan = seedProgressiveTaskPlan("find a quiz and complete it");
    assert.equal(taskPlanBlocksDone(plan, "find a quiz and complete it"), true);
    const cleared =
      "WORKING PLAN\nDONE: opened site\nNOW: none\nLATER:\n- answer questions — done\nFinal CHECK: success confirmation visible on screen — done";
    assert.equal(taskPlanBlocksDone(cleared, "find a quiz and complete it"), false);
  });

  it("does not satisfy multi-step goals from empty pageText", () => {
    assert.equal(
      looksBrowseGoalSatisfied("open khan academy and complete a quiz", {
        url: "https://www.khanacademy.org/",
        pageText: "",
        history: [],
      }),
      false,
    );
  });
});

describe("looksBrowseGoalSatisfied", () => {
  it("does not treat one click as done for multi-step click goals", () => {
    const history = [
      { action: { type: "click", label: "Start quiz" }, result: { ok: true } },
    ];
    assert.equal(
      looksBrowseGoalSatisfied("click start and complete the quiz", {
        url: "https://example.com/quiz",
        pageText: "Question 1 of 10",
        history,
      }),
      false,
    );
  });

  it("requires completion evidence for quiz goals", () => {
    const history = [
      { action: { type: "click" }, result: { ok: true } },
      { action: { type: "click" }, result: { ok: true } },
      { action: { type: "click" }, result: { ok: true } },
    ];
    assert.equal(
      looksBrowseGoalSatisfied("complete the quiz", {
        url: "https://khanacademy.org/quiz",
        pageText: "Question 3 of 8 — pick an answer",
        history,
      }),
      false,
    );
    assert.equal(
      looksBrowseGoalSatisfied("complete the quiz", {
        url: "https://khanacademy.org/quiz",
        pageText: "Great work! Lesson complete. You got 8/8.",
        history,
      }),
      true,
    );
  });

  it("still allows simple single-click goals", () => {
    assert.equal(
      looksBrowseGoalSatisfied("click the login button", {
        url: "https://example.com/app",
        pageText: "Welcome",
        history: [{ action: { type: "click", label: "Log in" }, result: { ok: true } }],
      }),
      true,
    );
  });
});

describe("pageShowsExerciseComplete", () => {
  it("detects common completion copy", () => {
    assert.equal(pageShowsExerciseComplete("Congratulations — unit complete"), true);
    assert.equal(pageShowsExerciseComplete("Question 2 of 5"), false);
  });
});

describe("pageShowsShareInviteComplete", () => {
  it("does not treat Share dialog chrome as done", () => {
    assert.equal(
      pageShowsShareInviteComplete(
        "Share Add people People with access Restricted Anyone with the link",
        "bob@gmail.com",
      ),
      false,
    );
  });

  it("requires invite-sent confirmation with the email", () => {
    assert.equal(
      pageShowsShareInviteComplete(
        "Invitation sent to bob@gmail.com. People with access",
        "bob@gmail.com",
      ),
      true,
    );
    assert.equal(
      pageShowsShareInviteComplete("Invitation sent to other@x.com", "bob@gmail.com"),
      false,
    );
  });
});

describe("pageShowsDiscardChangesDialog", () => {
  it("detects discard confirmation copy", () => {
    assert.equal(pageShowsDiscardChangesDialog("Discard changes? Cancel Discard"), true);
    assert.equal(pageShowsDiscardChangesDialog("Share Add people Send"), false);
  });
});

describe("pageShowsShareDialogOpen / email entered", () => {
  it("does not treat doc-body email as share chip", () => {
    assert.equal(pageShowsShareDialogOpen("Share Add people People with access"), true);
    assert.equal(
      pageShowsShareEmailEntered("Essay about cats. Contact bob@gmail.com someday.", "bob@gmail.com"),
      false,
    );
    assert.equal(
      pageShowsShareEmailEntered(
        "Add people bob@gmail.com People with access Editor",
        "bob@gmail.com",
      ),
      true,
    );
  });
});

describe("seedProgressiveTaskPlan", () => {
  it("seeds DONE/NOW/CHECK/LATER without inventing off-screen clicks", () => {
    const plan = seedProgressiveTaskPlan(
      "write a short essay about cats then share it to bob@gmail.com",
    );
    assert.match(plan, /DONE:/i);
    assert.match(plan, /NOW:/i);
    assert.match(plan, /CHECK:/i);
    assert.match(plan, /LATER:/i);
    assert.match(plan, /recipient email/i);
    assert.match(plan, /Send/i);
    assert.equal(progressivePlanNowLine(plan).length > 10, true);
  });
});

describe("looksBrowseGoalSatisfied share", () => {
  it("does not mark share done after opening dialog", () => {
    assert.equal(
      looksBrowseGoalSatisfied("share it to bob@gmail.com", {
        url: "https://docs.google.com/document/d/abc/edit",
        pageText: "Share Add people People with access Editor Viewer",
        history: [{ action: { type: "click", label: "Share" }, result: { ok: true } }],
      }),
      false,
    );
  });

  it("marks share done only with invite confirmation", () => {
    assert.equal(
      looksBrowseGoalSatisfied("share it to bob@gmail.com", {
        url: "https://docs.google.com/document/d/abc/edit",
        pageText: "Access updated. bob@gmail.com added as an editor",
        history: [
          { action: { type: "click", label: "Share" }, result: { ok: true } },
          { action: { type: "type", value: "bob@gmail.com" }, result: { ok: true } },
          { action: { type: "click", label: "Send" }, result: { ok: true } },
        ],
      }),
      true,
    );
  });

  it("marks share done after typed+Send even if a follow-up screen appears", () => {
    const history = [
      { action: { type: "click", label: "Share" }, result: { ok: true } },
      { action: { type: "type", value: "bob@gmail.com" }, result: { ok: true } },
      {
        action: { type: "click", label: "Send" },
        result: { ok: true, via: "share_dialog_send" },
      },
    ];
    assert.equal(historyShowsShareSendDone(history, ["bob@gmail.com"]), true);
    assert.equal(
      pageShowsShareInviteComplete("Message (optional) Notify people Cancel Send", "bob@gmail.com"),
      true,
    );
    assert.equal(
      looksBrowseGoalSatisfied("share it to bob@gmail.com", {
        url: "https://docs.google.com/document/d/abc/edit",
        pageText: "Message (optional) Notify people Cancel Send",
        history,
      }),
      true,
    );
    assert.equal(
      looksBrowseGoalSatisfied("share it to bob@gmail.com", {
        url: "https://docs.google.com/document/d/abc/edit",
        pageText: "Document title — editing",
        history,
      }),
      true,
    );
  });
});
