"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isAiDriveItem, formatListing, parseInstruction } = require("./aiDrive.cjs");

test("AI Drive membership matches Generated folder, source, and tags", () => {
  assert.equal(isAiDriveItem({ folder: "Generated", title: "Dashboard" }), true);
  assert.equal(isAiDriveItem({ source: "ai_artifact", title: "App" }), true);
  assert.equal(isAiDriveItem({ source: "studio_imagine", title: "Cabin" }), true);
  assert.equal(isAiDriveItem({ tags: ["ai-generated"], title: "Poster" }), true);
  assert.equal(isAiDriveItem({ content: "AI-generated image: a cabin" }), true);
  assert.equal(isAiDriveItem({ folder: "Recipes", source: "ai_artifact" }), false);
  assert.equal(isAiDriveItem({ folder: "Notes", title: "Shopping" }), false);
  assert.equal(isAiDriveItem({ deleted_at: "2026-01-01", folder: "Generated" }), false);
});

test("parseInstruction picks scan vs open vs search", () => {
  assert.deepEqual(parseInstruction("scan AI Drive").open, false);
  assert.equal(parseInstruction("search AI Drive for dashboard").query, "dashboard");
  assert.equal(parseInstruction("open AI Drive").open, true);
  assert.equal(parseInstruction("open the sales dashboard from AI Drive").name, "sales dashboard");
  assert.equal(parseInstruction("open id: 123e4567-e89b-12d3-a456-426614174000").id, "123e4567-e89b-12d3-a456-426614174000");
  assert.equal(parseInstruction("open Image Gen").folder, "images");
  assert.equal(parseInstruction("open Docs").folder, "docs");
});

test("formatListing groups artifacts and images", () => {
  const text = formatListing(
    {
      items: [
        { id: "d1", name: "Cover letter", folder: "docs" },
        { id: "a1", name: "Sales dashboard", folder: "artifacts" },
        { id: "i1", name: "Cabin at dusk", folder: "images" },
      ],
      artifacts: 1,
      docs: 1,
      images: 1,
      complete: true,
    },
    "",
  );
  assert.match(text, /Docs:/);
  assert.match(text, /Cover letter \(id: d1\)/);
  assert.match(text, /Artifacts:/);
  assert.match(text, /Sales dashboard \(id: a1\)/);
  assert.match(text, /Image Gen:/);
  assert.match(text, /Cabin at dusk \(id: i1\)/);
});
