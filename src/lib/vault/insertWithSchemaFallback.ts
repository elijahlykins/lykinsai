/**
 * Insert a vault row, giving up only the columns the database actually refuses.
 *
 * Three columns decide where an item is filed: `source`, `folder` and `tags`.
 * AI Drive lists an item only when one of them marks it as LYKN's own output
 * (see isAiGeneratedVaultRow), so losing them doesn't lose the row — it loses
 * the row's address. The item still appears in a listing of everything and is
 * missing from Image Gen, which reads like a save that half worked.
 *
 * Every save path used to guard against older databases the same way: if the
 * insert failed with a missing-column error, retry with title and content
 * alone. That drops all three filing columns to work around one absent one,
 * and Vault.jsx already carries tag- and URL-sniffing heuristics to recover
 * connector rows it happened to. AI output has no such fingerprint left.
 *
 * Both PostgREST and Postgres name the offending column in the error, so a
 * rejected insert can drop that one and keep the rest. The bare retry stays as
 * a last resort for errors that don't name anything, where saving a row with a
 * vague address still beats not saving it.
 */

export interface SchemaInsertError {
  code?: string;
  message?: string;
}

export interface InsertOutcome<T> {
  data: T | null;
  error: SchemaInsertError | null;
}

/** Retries are bounded — a database rejecting this many columns is broken. */
const MAX_DROPPED_COLUMNS = 8;

// PostgREST: "Could not find the 'folder' column of 'vault_items' in the schema cache"
const POSTGREST_COLUMN = /'([^']+)' column/i;
// Postgres: `column "folder" of relation "vault_items" does not exist`
const POSTGRES_COLUMN = /column "([^"]+)"/i;

/**
 * Whether the database refused the row over its shape rather than its content.
 * This is the line that must not blur: a vault cap or an upload rate limit is
 * raised by a trigger and has to reach the user, where an absent column is ours
 * to work around silently.
 */
export function isMissingColumnError(error: SchemaInsertError | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST204" ||
    /could not find|does not exist/i.test(String(error.message || ""))
  );
}

/**
 * The column a missing-column error blames, or null when it names none — some
 * drivers report only that something was unrecognized. Null means "degrade
 * wholesale", not "this error is fine".
 */
export function missingColumnFrom(error: SchemaInsertError | null | undefined): string | null {
  if (!isMissingColumnError(error)) return null;
  const message = String(error?.message || "");
  const named = POSTGREST_COLUMN.exec(message) || POSTGRES_COLUMN.exec(message);
  return named ? named[1] : null;
}

/**
 * @param insert   Runs one attempt. Supabase and the local-store writes layer
 *                 both already return `{ data, error }`, so either can be
 *                 passed straight through.
 * @param row      The full row, filing columns included.
 * @param required Columns to keep no matter what, and the row the last-resort
 *                 retry is built from. Anything outside this set is fair game
 *                 to drop, but only when the database names it.
 */
export async function insertWithSchemaFallback<T>(
  insert: (row: Record<string, unknown>) => Promise<InsertOutcome<T>>,
  row: Record<string, unknown>,
  required: readonly string[],
): Promise<InsertOutcome<T>> {
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
    const bare: Record<string, unknown> = {};
    for (const column of required) {
      if (column in row) bare[column] = row[column];
    }
    outcome = await insert(bare);
  }

  return outcome;
}
