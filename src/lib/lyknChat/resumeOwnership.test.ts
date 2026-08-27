import test from "node:test";
import assert from "node:assert/strict";
import { shouldReplaceProvisionalChat, provisionalChatHasUserMessages } from "@/lib/lyknChat/resumeOwnership";

test("resume does not replace a provisional chat that already has a user send", () => {
  assert.equal(
    shouldReplaceProvisionalChat({
      targetId: "older-remote",
      provisionalId: "fresh-local",
      hasUserMessages: true,
    }),
    false,
  );
  assert.equal(
    shouldReplaceProvisionalChat({
      targetId: "older-remote",
      provisionalId: "fresh-local",
      isChatLoading: true,
    }),
    false,
  );
  assert.equal(
    shouldReplaceProvisionalChat({
      targetId: "older-remote",
      provisionalId: "fresh-local",
      isSending: true,
    }),
    false,
  );
});

test("idle empty provisional can adopt the remote resume target", () => {
  assert.equal(
    shouldReplaceProvisionalChat({
      targetId: "older-remote",
      provisionalId: "fresh-local",
    }),
    true,
  );
});

test("user messages on the provisional snapshot are detected", () => {
  assert.equal(provisionalChatHasUserMessages([{ role: "user", content: "hello" }]), true);
  assert.equal(provisionalChatHasUserMessages([{ role: "assistant", content: "hi" }]), false);
});
