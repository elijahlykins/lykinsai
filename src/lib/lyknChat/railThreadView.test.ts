import test from "node:test";
import assert from "node:assert/strict";
import { railShowsWaitingIndicator } from "@/lib/lyknChat/railThreadView";

test("waiting row stays up until the reply starts typing", () => {
  assert.equal(
    railShowsWaitingIndicator({ loading: true, botAlreadyWorking: false, lastAiResponse: "" }),
    true,
  );
  assert.equal(
    railShowsWaitingIndicator({ loading: true, botAlreadyWorking: false, lastAiResponse: "Hello" }),
    false,
  );
  assert.equal(
    railShowsWaitingIndicator({ loading: true, botAlreadyWorking: true, lastAiResponse: "" }),
    false,
  );
  assert.equal(
    railShowsWaitingIndicator({ loading: false, botAlreadyWorking: false, lastAiResponse: "" }),
    false,
  );
});
