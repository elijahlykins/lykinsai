import test from "node:test";
import assert from "node:assert/strict";
import { railShowsWaitingIndicator } from "@/lib/lyknChat/railThreadView";

test("waiting row stays up until the reply starts typing", () => {
  assert.equal(
    railShowsWaitingIndicator({ loading: true, lastAiResponse: "" }),
    true,
  );
  assert.equal(
    railShowsWaitingIndicator({ loading: true, lastAiResponse: "Hello" }),
    false,
  );
  assert.equal(
    railShowsWaitingIndicator({ loading: false, lastAiResponse: "" }),
    false,
  );
});
