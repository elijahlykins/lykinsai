import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  finalizeResearchReport,
  tryRepairJsonText,
} from "./researchReportFinalize";

describe("tryRepairJsonText", () => {
  it("returns valid JSON unchanged", () => {
    const raw = '{"type":"bar","labels":["A"],"data":[1]}';
    assert.equal(tryRepairJsonText(raw), raw);
  });

  it("closes truncated chart JSON", () => {
    const raw = '{"type":"bar","title":"Revenue","labels":["Q1","Q2"],"data":[10,20';
    const repaired = tryRepairJsonText(raw);
    assert.ok(repaired);
    assert.deepEqual(JSON.parse(repaired!), {
      type: "bar",
      title: "Revenue",
      labels: ["Q1", "Q2"],
      data: [10, 20],
    });
  });
});

describe("finalizeResearchReport", () => {
  it("repairs an unclosed chart fence", () => {
    const input =
      "## Findings\n\nSome prose.\n\n```chart\n{\"type\":\"bar\",\"labels\":[\"A\"],\"data\":[1]";
    const out = finalizeResearchReport(input);
    assert.ok(out.includes("```chart"));
    assert.equal(out.trimEnd().endsWith("```"), true);
    assert.ok(out.includes('"type":"bar"'));
  });

  it("drops an unsalvageable incomplete fence instead of leaving raw JSON", () => {
    const input = "## Findings\n\n```chart\n{not-json";
    const out = finalizeResearchReport(input);
    assert.ok(!out.includes("```chart"));
    assert.ok(!out.includes("{not-json"));
    assert.ok(out.includes("## Findings"));
  });

  it("leaves complete fences alone", () => {
    const input =
      "Intro\n\n```stock\nTSLA\n```\n\n## Sources\n- [a](https://example.com)";
    assert.equal(finalizeResearchReport(input), input);
  });
});
