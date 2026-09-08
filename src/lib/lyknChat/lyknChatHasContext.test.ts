import test from "node:test";
import assert from "node:assert/strict";
import {
  filterLyknChatsWithContext,
  snapshotHasContext,
} from "@/lib/lyknChat/lyknChatHasContext";

test("empty untitled chats stay out of history, even with no snapshot yet", () => {
  const rows = filterLyknChatsWithContext([
    { id: "empty-new", title: "New Chat" },
    { id: "empty-untitled", title: "Untitled board" },
    { id: "empty-blank", title: "" },
    { id: "empty-snapshot", title: "New Chat", lykn_chat_states: { state: { chatMessages: [], aiThread: [] } } },
  ] as Array<{ id: string; title: string; lykn_chat_states?: unknown }>);
  assert.deepEqual(rows.map((r) => r.id), []);
});

test("chats with messages, notes, or a custom title stay listed", () => {
  const rows = filterLyknChatsWithContext([
    { id: "named", title: "Launch plan" },
    {
      id: "with-messages",
      title: "New Chat",
      lykn_chat_states: { state: { chatMessages: [{ role: "user", content: "hi" }] } },
    },
    {
      id: "with-notes",
      title: "New Chat",
      lykn_chat_states: {
        state: {
          notesPages: [{ id: "p1", title: "Page 1", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "note" }] }] } }],
        },
      },
    },
  ] as Array<{ id: string; title: string; lykn_chat_states?: unknown }>);
  assert.deepEqual(rows.map((r) => r.id), ["named", "with-messages", "with-notes"]);
});

test("snapshotHasContext is false for empty shells", () => {
  assert.equal(snapshotHasContext(null), false);
  assert.equal(snapshotHasContext({ chatMessages: [], aiThread: [] }), false);
  assert.equal(snapshotHasContext({ chatMessages: [{ role: "user", content: "hi" }] }), true);
});
