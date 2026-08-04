const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  markdownBodyToHtml,
  expandCollapsedTableLines,
  metricTableToChartSvg,
} = require("../electron/markdownToStageHtml.cjs");

describe("markdownToStageHtml tables", () => {
  it("expands collapsed one-line GFM tables", () => {
    const collapsed =
      "| Metric | Result | |---|---:| | Amount spent | $73.50 | | Impressions | 13,589 |";
    const expanded = expandCollapsedTableLines(collapsed);
    assert.match(expanded, /\| Metric \| Result \|/);
    assert.match(expanded, /\|---\|---:\|/);
    assert.match(expanded, /Amount spent/);
    assert.ok(expanded.split("\n").length >= 3);
  });

  it("renders proper HTML tables instead of one paragraph", () => {
    const md = [
      "| Metric | Result |",
      "|---|---:|",
      "| Amount spent | $73.50 |",
      "| Impressions | 13,589 |",
      "| Clicks | 90 |",
    ].join("\n");
    const html = markdownBodyToHtml(md);
    assert.match(html, /<table>/);
    assert.match(html, /<th>Metric<\/th>/);
    assert.match(html, /Amount spent/);
    assert.doesNotMatch(html, /\| Metric \| Result \| \|---/);
  });

  it("renders collapsed campaign tables from model output", () => {
    const md =
      "Campaign status\n\n" +
      "| Campaign | Status | Spend | Clicks | CTR | |---|---|---:|---:|---:| | LYKN Traffic Campaign 2026-07-29 | Active | $73.50 | 90 | 0.662% |";
    const html = markdownBodyToHtml(md);
    assert.match(html, /<table>/);
    assert.match(html, /LYKN Traffic Campaign/);
    assert.match(html, /0\.662%/);
  });

  it("builds a bar chart for 2-column metric tables", () => {
    const chart = metricTableToChartSvg(
      ["Metric", "Result"],
      [
        ["Amount spent", "$73.50"],
        ["Impressions", "13,589"],
        ["Clicks", "90"],
      ],
    );
    assert.match(chart, /<svg/);
    assert.match(chart, /chart-bar/);
    assert.match(chart, /Amount spent/);
  });

  it("includes chart + table for metric markdown", () => {
    const md = [
      "| Metric | Result |",
      "|---|---|",
      "| Amount spent | $73.50 |",
      "| Clicks | 90 |",
      "| CPC | $0.82 |",
    ].join("\n");
    const html = markdownBodyToHtml(md);
    assert.match(html, /chart-wrap/);
    assert.match(html, /<table>/);
  });
});
