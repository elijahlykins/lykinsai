import test from "node:test";
import assert from "node:assert/strict";

import { botDeliverableToolCalls } from "./botDeliverableCards";
import { extractChatArtifacts, sortArtifactsForDisplay } from "@/lib/ai/chatArtifacts";
import type { BotDeliverable } from "./botStore";

const DELIVERABLES: BotDeliverable[] = [
  {
    kind: "html",
    title: "Coffee market report",
    tool: "research_report",
    html: "<!doctype html><html><head><title>Coffee market report</title></head><body>findings</body></html>",
    filename: "coffee-market-report.html",
  },
  { kind: "artifact", title: "Coffee deck", url: "http://stage/deck", code: "export default X" },
  { kind: "image", title: "Logo", url: "http://img/logo.png" },
];

test("deliverables dress as completed tool calls the artifact extractor understands", () => {
  const calls = botDeliverableToolCalls("row1", DELIVERABLES);
  assert.deepEqual(
    calls.map((c) => [c.name, c.status]),
    [
      ["lykn_write_document", "done"],
      ["lykn_build_react_artifact", "done"],
      ["lykn_generate_image", "done"],
    ],
  );
  // Ids are stable per row so a re-render patches the same cards in place.
  assert.deepEqual(
    calls.map((c) => c.id),
    ["bot-deliverable-row1-0", "bot-deliverable-row1-1", "bot-deliverable-row1-2"],
  );

  // The whole point: the chat's existing extractor turns these into cards.
  const artifacts = sortArtifactsForDisplay(extractChatArtifacts(calls));
  assert.equal(artifacts.length, 3);
  const report = artifacts.find((a) => a.title === "Coffee market report");
  assert.ok(report, "report renders as a card");
  assert.equal(report!.kind, "html");
  assert.match(report!.srcDoc || "", /findings/);
  const deck = artifacts.find((a) => a.title === "Coffee deck");
  assert.ok(deck, "built artifact renders as a card");
  assert.equal(deck!.previewUrl, "http://stage/deck");
  const image = artifacts.find((a) => a.kind === "image");
  assert.ok(image, "image renders as a card");
  assert.equal(image!.previewUrl, "http://img/logo.png");
});

test("unrenderable deliverables are skipped rather than producing empty cards", () => {
  const calls = botDeliverableToolCalls("row2", [
    { kind: "html", title: "no html" } as BotDeliverable,
    { kind: "image", title: "no url" } as BotDeliverable,
  ]);
  assert.deepEqual(calls, []);
  assert.deepEqual(botDeliverableToolCalls("row3", undefined), []);
});
