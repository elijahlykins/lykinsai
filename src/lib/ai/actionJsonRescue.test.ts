// Characterization tests for the action-JSON rescue machinery extracted from
// chatSendOrchestrator.ts (Wave 1). These lock CURRENT behavior — including
// quirks — so the extraction and future refactors can be verified against a
// fixed baseline. Do not "fix" behavior here without a deliberate decision.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRescuedAction,
  repairUnescapedQuotes,
  tryParseJsonLoose,
  findActionJsonSpans,
  tryExtractEnvelope,
  convertAddBlockToAction,
  convertAddWireToAction,
  rescueXmlTagActions,
  rescueInlineBlockMarkup,
  stripStreamingActionJson,
} from "./actionJsonRescue";

describe("repairUnescapedQuotes / tryParseJsonLoose", () => {
  it("parses valid JSON directly", () => {
    assert.deepEqual(tryParseJsonLoose('{"type":"create_text","content":"hi"}'), {
      type: "create_text",
      content: "hi",
    });
  });

  it("repairs unescaped double quotes inside string values", () => {
    const raw = '{"type":"create_text","content":"say "hello" to them"}';
    const parsed = tryParseJsonLoose(raw);
    assert.ok(parsed);
    assert.equal(parsed.content, 'say "hello" to them');
  });

  it("recovers single-quoted JSON when no double quotes present", () => {
    const parsed = tryParseJsonLoose("{'type':'create_text','content':'hi'}");
    assert.deepEqual(parsed, { type: "create_text", content: "hi" });
  });

  it("returns null for unparseable garbage", () => {
    assert.equal(tryParseJsonLoose("not json at all"), null);
  });

  it("repairUnescapedQuotes leaves structurally-closing quotes alone", () => {
    const raw = '{"a":"x","b":"y"}';
    assert.equal(repairUnescapedQuotes(raw), raw);
  });
});

describe("normalizeRescuedAction", () => {
  it("passes through canonical create_* actions", () => {
    assert.deepEqual(normalizeRescuedAction({ type: "create_text", content: "hi" }), {
      type: "create_text",
      content: "hi",
    });
  });

  it("adds level=1 to create_heading when missing", () => {
    assert.deepEqual(normalizeRescuedAction({ type: "create_heading", content: "T" }), {
      type: "create_heading",
      content: "T",
      level: 1,
    });
  });

  it("hoists nested position objects into x/y", () => {
    assert.deepEqual(
      normalizeRescuedAction({ type: "create_text", content: "hi", position: { x: 3, y: 4 } }),
      { type: "create_text", content: "hi", x: 3, y: 4 },
    );
  });

  it("rejects non-action objects", () => {
    assert.equal(normalizeRescuedAction({ foo: 1 }), null);
    assert.equal(normalizeRescuedAction(null), null);
  });

  it("CURRENT QUIRK: shorthand types like 'heading' fail the isActionLike gate and return null", () => {
    // The shorthand-mapping branch inside normalizeRescuedAction is
    // unreachable for these inputs because isActionLike requires an action
    // prefix (create_/update_/...). Locked as-is; do not fix silently.
    assert.equal(normalizeRescuedAction({ type: "heading", content: "T" }), null);
    assert.equal(normalizeRescuedAction({ type: "text", content: "hi" }), null);
  });
});

describe("findActionJsonSpans", () => {
  it("finds bare action objects embedded in prose", () => {
    const text = 'before {"type":"create_text","content":"hi"} after';
    const spans = findActionJsonSpans(text);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].start, 7);
    assert.equal(text.slice(spans[0].start, spans[0].end), '{"type":"create_text","content":"hi"}');
    assert.deepEqual(spans[0].actions, [{ type: "create_text", content: "hi" }]);
  });

  it("finds {actions:[...]} envelopes and action arrays", () => {
    const env = '{"actions":[{"type":"create_heading","content":"T"}]}';
    assert.deepEqual(findActionJsonSpans(env)[0].actions, [
      { type: "create_heading", content: "T", level: 1 },
    ]);
    const arr = '[{"type":"create_text","content":"a"},{"type":"create_text","content":"b"}]';
    assert.equal(findActionJsonSpans(arr)[0].actions.length, 2);
  });

  it("ignores non-action JSON", () => {
    assert.deepEqual(findActionJsonSpans('config is {"foo":1} ok'), []);
  });
});

describe("tryExtractEnvelope", () => {
  it("extracts actions + assistant text from a full envelope", () => {
    const res = tryExtractEnvelope(
      '{"assistant":"Done!","actions":[{"type":"create_text","content":"hi"}]}',
    );
    assert.equal(res.isEnvelope, true);
    assert.equal(res.assistant, "Done!");
    assert.deepEqual(res.actions, [{ type: "create_text", content: "hi" }]);
    assert.deepEqual(res.consumed, { start: 0, end: 71 });
  });

  it("recognizes assistant-only envelopes with no actions", () => {
    const res = tryExtractEnvelope('{"assistant":"Hello there","follow_up_questions":["a"]}');
    assert.equal(res.isEnvelope, true);
    assert.equal(res.assistant, "Hello there");
    assert.deepEqual(res.actions, []);
  });

  it("accepts 'response' in place of 'assistant'", () => {
    const res = tryExtractEnvelope('{"response":"Hi!"}');
    assert.equal(res.isEnvelope, true);
    assert.equal(res.assistant, "Hi!");
  });

  it("returns isEnvelope=false for plain prose", () => {
    const res = tryExtractEnvelope("just a normal chat reply");
    assert.equal(res.isEnvelope, false);
    assert.equal(res.consumed, null);
  });
});

describe("convertAddBlockToAction / convertAddWireToAction", () => {
  it("maps invented add_blocks entries to canonical create_* actions", () => {
    assert.deepEqual(
      convertAddBlockToAction({ id: "b1", type: "h2", content: "Title", x: 1, y: 2, w: 3, h: 4 }),
      {
        placeholderId: "b1",
        content: "Title",
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        type: "create_h2",
        level: 2,
      },
    );
  });

  it("differentiates text variants into headings", () => {
    const a = convertAddBlockToAction({ id: "b2", type: "text", variant: "h1", content: "Big" });
    assert.equal((a as any).type, "create_heading");
    assert.equal((a as any).level, 1);
  });

  it("maps wires to connect_blocks with anchors", () => {
    assert.deepEqual(
      convertAddWireToAction({ from: "b1", to: "b2", fromAnchor: "bottom", toAnchor: "top" }),
      { type: "connect_blocks", fromId: "b1", toId: "b2", fromSide: "bottom", toSide: "top" },
    );
    assert.equal(convertAddWireToAction({ from: "b1" }), null);
  });
});

describe("rescueXmlTagActions", () => {
  it("translates <add_blocks> arrays and strips the tags", () => {
    const text = 'Intro <add_blocks>[{"id":"b1","type":"quote","content":"Q"}]</add_blocks> outro';
    const { actions, cleaned } = rescueXmlTagActions(text);
    assert.deepEqual(actions, [
      {
        placeholderId: "b1",
        content: "Q",
        x: undefined,
        y: undefined,
        width: undefined,
        height: undefined,
        type: "create_quote",
      },
    ]);
    assert.equal(cleaned, "Intro  outro");
  });

  it("translates <add_wires> entries", () => {
    const { actions, cleaned } = rescueXmlTagActions(
      '<add_wires>{"from":"b1","to":"b2"}</add_wires>',
    );
    assert.deepEqual(actions, [
      { type: "connect_blocks", fromId: "b1", toId: "b2", fromSide: undefined, toSide: undefined },
    ]);
    assert.equal(cleaned, "");
  });
});

describe("rescueInlineBlockMarkup", () => {
  const collect = () => {
    const applied: any[] = [];
    return { applied, apply: (actions: any[]) => applied.push(...actions) };
  };

  it("leaves plain prose untouched (modulo trim)", () => {
    const { applied, apply } = collect();
    assert.equal(rescueInlineBlockMarkup("Hello there.\n\nAll good.", apply), "Hello there.\n\nAll good.");
    assert.equal(applied.length, 0);
  });

  it("unwraps a whole-text envelope, applying its actions", () => {
    const { applied, apply } = collect();
    const out = rescueInlineBlockMarkup(
      '{"assistant":"Done! Added it.","actions":[{"type":"create_text","content":"hi"}]}',
      apply,
    );
    assert.equal(out, "Done! Added it.");
    assert.deepEqual(applied, [{ type: "create_text", content: "hi" }]);
  });

  it("unwraps assistant-only envelopes without calling applyActions", () => {
    const { applied, apply } = collect();
    const out = rescueInlineBlockMarkup('{"assistant":"Just chatting."}', apply);
    assert.equal(out, "Just chatting.");
    assert.equal(applied.length, 0);
  });

  it("rescues action JSON out of ```json fences", () => {
    const { applied, apply } = collect();
    const out = rescueInlineBlockMarkup(
      'Here you go\n```json\n{"type":"create_text","content":"hi"}\n```\nEnjoy',
      apply,
    );
    assert.equal(out, "Here you go\n\nEnjoy");
    assert.deepEqual(applied, [{ type: "create_text", content: "hi" }]);
  });

  it("CURRENT QUIRK: bare action JSON mid-prose drops the prose BEFORE the JSON", () => {
    // The whole-text envelope pass splices from the buffer start rather than
    // from consumed.start, so "Adding now " is lost. Locked as-is.
    const { applied, apply } = collect();
    const out = rescueInlineBlockMarkup(
      'Adding now {"type":"create_text","content":"hi"} done',
      apply,
    );
    assert.equal(out, "done");
    assert.deepEqual(applied, [{ type: "create_text", content: "hi" }]);
  });

  it("CURRENT QUIRK: [CREATE_BLOCK:{...}] markup with shorthand types is stripped but NOT rescued", () => {
    // normalizeRescuedAction rejects shorthand types (see its quirk test), so
    // the legacy markup path strips the markup without recovering an action.
    const { applied, apply } = collect();
    const out = rescueInlineBlockMarkup('[CREATE_BLOCK:{"type":"text","content":"hi"}]', apply);
    assert.equal(out, "");
    assert.equal(applied.length, 0);
  });

  it("rescues canonical actions from [CREATE_BLOCK:{...}] markup", () => {
    const { applied, apply } = collect();
    const out = rescueInlineBlockMarkup(
      'Sure. [CREATE_BLOCK:{"type":"create_text","content":"hi"}]',
      apply,
    );
    assert.equal(out, "Sure.");
    assert.deepEqual(applied, [{ type: "create_text", content: "hi" }]);
  });

  it("translates <add_blocks>/<add_wires> wrappers and applies both", () => {
    const { applied, apply } = collect();
    const out = rescueInlineBlockMarkup(
      'Building.\n<add_blocks>[{"id":"b1","type":"h3","content":"S"}]</add_blocks>\n<add_wires>[{"from":"b1","to":"b2"}]</add_wires>',
      apply,
    );
    assert.equal(out, "Building.");
    assert.equal(applied.length, 2);
    assert.equal(applied[0].type, "create_h3");
    assert.equal(applied[1].type, "connect_blocks");
  });
});

describe("stripStreamingActionJson", () => {
  it("strips complete and partial [PULL_MEDIA:...] markers", () => {
    assert.equal(
      stripStreamingActionJson("text [PULL_MEDIA:abc|1] more [PULL_MEDIA:def"),
      "text more",
    );
  });

  it("hides a complete whole-buffer envelope, surfacing assistant text", () => {
    assert.equal(stripStreamingActionJson('{"assistant":"Hi!","actions":[]}'), "Hi!");
  });

  it("truncates a partial trailing envelope at its opening brace", () => {
    assert.equal(
      stripStreamingActionJson('Sure thing!\n{"assistant":"work in prog'),
      "Sure thing!\n",
    );
  });

  it("removes complete bare action spans mid-prose", () => {
    assert.equal(
      stripStreamingActionJson('Adding now {"type":"create_text","content":"hi"} done'),
      "Adding now  done",
    );
  });

  it("truncates an unclosed code fence", () => {
    assert.equal(stripStreamingActionJson("text\n```json\n{"), "text\n");
  });

  it("strips complete <add_blocks> wrappers while streaming", () => {
    assert.equal(
      stripStreamingActionJson('ok <add_blocks>[{"id":"b1","type":"text"}]</add_blocks> done'),
      "ok  done",
    );
  });

  it("leaves ordinary prose and non-action JSON alone", () => {
    assert.equal(stripStreamingActionJson("plain text stays"), "plain text stays");
    assert.equal(stripStreamingActionJson('config {"foo":1} here'), 'config {"foo":1} here');
  });
});
