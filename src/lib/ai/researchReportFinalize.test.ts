import { describe, expect, it } from "vitest";
import {
  finalizeResearchReport,
  tryRepairJsonText,
} from "./researchReportFinalize";

describe("tryRepairJsonText", () => {
  it("returns valid JSON unchanged", () => {
    const raw = '{"type":"bar","labels":["A"],"data":[1]}';
    expect(tryRepairJsonText(raw)).toBe(raw);
  });

  it("closes truncated chart JSON", () => {
    const raw = '{"type":"bar","title":"Revenue","labels":["Q1","Q2"],"data":[10,20';
    const repaired = tryRepairJsonText(raw);
    expect(repaired).toBeTruthy();
    expect(JSON.parse(repaired!)).toEqual({
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
    expect(out).toContain("```chart");
    expect(out.trimEnd().endsWith("```")).toBe(true);
    expect(out).toContain('"type":"bar"');
  });

  it("drops an unsalvageable incomplete fence instead of leaving raw JSON", () => {
    const input = "## Findings\n\n```chart\n{not-json";
    const out = finalizeResearchReport(input);
    expect(out).not.toContain("```chart");
    expect(out).not.toContain("{not-json");
    expect(out).toContain("## Findings");
  });

  it("leaves complete fences alone", () => {
    const input =
      "Intro\n\n```stock\nTSLA\n```\n\n## Sources\n- [a](https://example.com)";
    expect(finalizeResearchReport(input)).toBe(input);
  });
});
