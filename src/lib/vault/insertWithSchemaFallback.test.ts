import test from "node:test";
import assert from "node:assert/strict";

import {
  insertWithSchemaFallback,
  isMissingColumnError,
  missingColumnFrom,
} from "@/lib/vault/insertWithSchemaFallback";

const REQUIRED = ["user_id", "title", "content"] as const;

/** A row shaped like the ones the save paths build. */
function generatedImageRow() {
  return {
    user_id: "u1",
    title: "A cabin at dusk",
    content: 'AI-generated image: "a cabin at dusk"',
    source: "studio_imagine",
    folder: "Generated",
    tags: ["image", "ai-generated", "generated"],
    att_type: "image",
  } as Record<string, unknown>;
}

/**
 * Stands in for a database that only knows certain columns, recording what it
 * was asked for so a test can assert on what survived.
 */
function fakeTable(known: string[], { nameTheColumn = true } = {}) {
  const attempts: Record<string, unknown>[] = [];
  const insert = async (row: Record<string, unknown>) => {
    attempts.push({ ...row });
    const unknownColumn = Object.keys(row).find((c) => !known.includes(c));
    if (!unknownColumn) return { data: { id: "row-1", ...row }, error: null };
    return {
      data: null,
      error: {
        code: "PGRST204",
        message: nameTheColumn
          ? `Could not find the '${unknownColumn}' column of 'vault_items' in the schema cache`
          : "Could not find a column in the schema cache",
      },
    };
  };
  return { attempts, insert };
}

test("a database with every column is written to exactly once, in full", async () => {
  const table = fakeTable([...REQUIRED, "source", "folder", "tags", "att_type"]);
  const { data, error } = await insertWithSchemaFallback(
    table.insert,
    generatedImageRow(),
    REQUIRED,
  );

  assert.equal(error, null);
  assert.equal((data as { id: string }).id, "row-1");
  assert.equal(table.attempts.length, 1);
  assert.equal(table.attempts[0].folder, "Generated");
});

/**
 * The regression this file exists for. A vault missing one newer column used to
 * cost the row `source`, `folder` AND `tags` — the three things AI Drive reads
 * to decide it made something — so a saved image went in filed as nothing and
 * never showed up in Image Gen.
 */
test("one missing column costs that column and nothing else", async () => {
  const table = fakeTable([...REQUIRED, "source", "folder", "tags"]);
  const { data, error } = await insertWithSchemaFallback(
    table.insert,
    generatedImageRow(),
    REQUIRED,
  );

  assert.equal(error, null);
  const saved = data as Record<string, unknown>;
  assert.equal(saved.att_type, undefined, "the column the database rejected is gone");
  assert.equal(saved.source, "studio_imagine");
  assert.equal(saved.folder, "Generated");
  assert.deepEqual(saved.tags, ["image", "ai-generated", "generated"]);
});

test("several missing columns are dropped one at a time, keeping the rest", async () => {
  const table = fakeTable([...REQUIRED, "source", "tags"]);
  const { data, error } = await insertWithSchemaFallback(
    table.insert,
    generatedImageRow(),
    REQUIRED,
  );

  assert.equal(error, null);
  const saved = data as Record<string, unknown>;
  assert.equal(saved.folder, undefined);
  assert.equal(saved.att_type, undefined);
  assert.equal(saved.source, "studio_imagine", "still filed as AI output");
  assert.equal(table.attempts.length, 3);
});

test("an error that names no column falls back to the columns always present", async () => {
  const table = fakeTable([...REQUIRED], { nameTheColumn: false });
  const { data, error } = await insertWithSchemaFallback(
    table.insert,
    generatedImageRow(),
    REQUIRED,
  );

  assert.equal(error, null);
  const saved = data as Record<string, unknown>;
  assert.equal(saved.title, "A cabin at dusk");
  assert.equal(saved.source, undefined);
  assert.equal(table.attempts.length, 2, "the full row, then the bare one");
});

/**
 * A vault cap and an upload rate limit are raised by triggers and have to reach
 * the user. Retrying around them would turn a message they need to see into a
 * silent partial save.
 */
test("a failure that isn't about schema is returned untouched, without retrying", async () => {
  const attempts: Record<string, unknown>[] = [];
  const capped = async (row: Record<string, unknown>) => {
    attempts.push(row);
    return { data: null, error: { message: "vault_cap_reached" } };
  };

  const { error } = await insertWithSchemaFallback(capped, generatedImageRow(), REQUIRED);

  assert.equal(error?.message, "vault_cap_reached");
  assert.equal(attempts.length, 1);
});

test("a required column is never dropped, even when the database blames it", async () => {
  let calls = 0;
  const refusesContent = async () => {
    calls += 1;
    return {
      data: null,
      error: {
        code: "PGRST204",
        message: "Could not find the 'content' column of 'vault_items' in the schema cache",
      },
    };
  };

  const { error } = await insertWithSchemaFallback(
    refusesContent,
    generatedImageRow(),
    REQUIRED,
  );

  assert.ok(error, "an unwinnable insert still reports failure");
  assert.equal(calls, 2, "the full row, then the bare one — no unbounded retrying");
});

test("both error dialects name their column", () => {
  assert.equal(
    missingColumnFrom({
      code: "PGRST204",
      message: "Could not find the 'folder' column of 'vault_items' in the schema cache",
    }),
    "folder",
  );
  assert.equal(
    missingColumnFrom({
      message: 'column "folder" of relation "vault_items" does not exist',
    }),
    "folder",
  );
});

test("a trigger failure is not mistaken for an old schema", () => {
  assert.equal(isMissingColumnError({ message: "vault_cap_reached" }), false);
  assert.equal(missingColumnFrom({ message: "vault_cap_reached" }), null);
});
