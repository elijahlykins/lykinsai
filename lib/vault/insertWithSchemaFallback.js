/**
 * Insert a vault row, giving up only the columns the database actually refuses.
 *
 * Server-side twin of src/lib/vault/insertWithSchemaFallback.ts — the same
 * reasoning applies to rows written by the API as to rows written by the app,
 * and the two trees don't share modules (see attachmentType.js, which is
 * likewise duplicated).
 *
 * Three columns decide where an item is filed: `source`, `folder` and `tags`.
 * AI Drive lists an item only when one of them marks it as LYKN's own output,
 * so losing them doesn't lose the row — it loses the row's address. The item
 * still appears in a listing of everything and is missing from Image Gen,
 * which reads like a save that half worked.
 *
 * The retry this replaces dropped all three filing columns to work around one
 * absent one. Both PostgREST and Postgres name the offending column, so a
 * rejected insert can drop that one and keep the rest.
 */

/** Retries are bounded — a database rejecting this many columns is broken. */
const MAX_DROPPED_COLUMNS = 8;

// PostgREST: "Could not find the 'folder' column of 'vault_items' in the schema cache"
const POSTGREST_COLUMN = /'([^']+)' column/i;
// Postgres: `column "folder" of relation "vault_items" does not exist`
const POSTGRES_COLUMN = /column "([^"]+)"/i;

/**
 * Whether the database refused the row over its shape rather than its content.
 * This is the line that must not blur: a vault cap is raised by a trigger and
 * has to reach the caller, where an absent column is ours to work around.
 */
export function isMissingColumnError(error) {
  if (!error) return false;
  return (
    error.code === 'PGRST204' ||
    /could not find|does not exist/i.test(String(error.message || ''))
  );
}

/**
 * The column a missing-column error blames, or null when it names none. Null
 * means "degrade wholesale", not "this error is fine".
 */
export function missingColumnFrom(error) {
  if (!isMissingColumnError(error)) return null;
  const message = String(error?.message || '');
  const named = POSTGREST_COLUMN.exec(message) || POSTGRES_COLUMN.exec(message);
  return named ? named[1] : null;
}

/**
 * @param {(row: Record<string, unknown>) => Promise<{ data: any, error: any }>} insert
 *   Runs one attempt. A Supabase insert chain already returns this shape.
 * @param {Record<string, unknown>} row The full row, filing columns included.
 * @param {readonly string[]} required Columns to keep no matter what, and the
 *   row the last-resort retry is built from.
 */
export async function insertWithSchemaFallback(insert, row, required) {
  const keep = new Set(required);
  const attempt = { ...row };
  let outcome = await insert(attempt);

  for (let dropped = 0; dropped < MAX_DROPPED_COLUMNS && outcome.error; dropped += 1) {
    const column = missingColumnFrom(outcome.error);
    if (!column || keep.has(column) || !(column in attempt)) break;
    delete attempt[column];
    outcome = await insert(attempt);
  }

  // Still refused, and still on schema grounds — the error named a column we
  // can't drop, or named none at all. Fall back to the columns every version
  // of the table has had.
  if (isMissingColumnError(outcome.error)) {
    const bare = {};
    for (const column of required) {
      if (column in row) bare[column] = row[column];
    }
    outcome = await insert(bare);
  }

  return outcome;
}
