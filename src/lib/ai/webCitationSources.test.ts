import test from "node:test";
import assert from "node:assert/strict";
import {
  citationSourcesFromMessage,
  extractSourcesFromWebToolResult,
  uniqueHostSources,
} from "./webCitationSources";

test("citationSourcesFromMessage prefers stored sources and fills from web tools", () => {
  assert.deepEqual(
    citationSourcesFromMessage({
      sources: [{ title: "NYT", url: "https://nytimes.com/a" }],
      toolCalls: [
        {
          name: "lykn_web_search",
          status: "done",
          result: {
            ok: true,
            results: [{ title: "NYT", url: "https://nytimes.com/a" }, { title: "BBC", url: "https://bbc.com/b" }],
          },
        },
      ],
    }),
    [
      { title: "NYT", url: "https://nytimes.com/a" },
      { title: "BBC", url: "https://bbc.com/b" },
    ],
  );
  assert.equal(extractSourcesFromWebToolResult("lykn_calculate", { ok: true, url: "https://x" }).length, 0);
});

test("uniqueHostSources stacks one favicon per hostname", () => {
  const stacked = uniqueHostSources(
    [
      { title: "A", url: "https://www.nytimes.com/1" },
      { title: "B", url: "https://nytimes.com/2" },
      { title: "C", url: "https://bbc.com/3" },
    ],
    3,
  );
  assert.equal(stacked.length, 2);
  assert.equal(stacked[0].url, "https://www.nytimes.com/1");
  assert.equal(stacked[1].url, "https://bbc.com/3");
});
