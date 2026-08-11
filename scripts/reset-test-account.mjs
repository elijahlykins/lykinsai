// Delete a test account so the welcome-walkthrough signup can be retried
// with the same email. Dev tool only — uses the service-role key from .env.
//
//   node scripts/reset-test-account.mjs                  → resets admin+test@lykn.io
//   node scripts/reset-test-account.mjs you+foo@bar.com  → resets that address
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const DEFAULT_EMAIL = "admin+test@lykn.io";
const email = String(process.argv[2] || DEFAULT_EMAIL).trim().toLowerCase();

// Minimal .env reader (avoid depending on dotenv being configured).
const env = { ...process.env };
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* .env optional if vars are exported */
}

const url = env.VITE_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env)");
  process.exit(1);
}

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// auth.admin has no get-by-email — page through users to find it.
let user = null;
for (let page = 1; page <= 20 && !user; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) {
    console.error("listUsers failed:", error.message);
    process.exit(1);
  }
  user = (data?.users || []).find((u) => String(u.email || "").toLowerCase() === email) || null;
  if ((data?.users || []).length < 1000) break;
}

// Rows in app tables that reference auth.users block deleteUser with
// "Database error deleting user" — clear the account's rows first.
// Best-effort: unknown tables/columns just error quietly and are skipped.
const USER_TABLES = [
  "vault_items", "lykn_chats", "lykn_chat_states", "lykn_chat_threads",
  "lykn_chat_projects", "lykn_todos", "lykn_projects", "lykn_project_state",
  "lykn_project_neurons", "lykn_project_members", "lykn_events",
  "lykn_reminders", "lykn_concepts", "lykn_beliefs", "lykn_steward_items",
  "lykn_user_synthesis_profile", "lykn_synthesis_chunks",
  "lykn_user_preferences", "lykn_user_model_facts", "lykn_user_model_revisions",
  "lykn_user_links", "lykn_load_in_user_sections", "lykn_sub_model_tasks",
  "lykn_apple_tokens", "lykn_mcp_tokens", "lykn_custom_models",
  "lykn_custom_connections", "lykn_client_metrics", "lykn_security_audit",
  "lykn_result_attributions", "user_billing", "social_connections",
  "rss_feeds", "rss_seen_entries", "notes", "message_feedback",
  "ai_conversation_memory", "ai_description_cache", "ai_transcription_cache",
  "ai_usage_logs", "voice_screen_context", "profiles", "user_profiles",
];
const USER_COLUMNS = ["user_id", "created_by", "owner_id", "id"];

async function clearUserRows(userId) {
  let cleared = 0;
  for (const table of USER_TABLES) {
    for (const col of USER_COLUMNS) {
      const { error, count } = await admin
        .from(table)
        .delete({ count: "exact" })
        .eq(col, userId);
      if (!error && count) {
        cleared += count;
        console.log(`  cleared ${count} row${count === 1 ? "" : "s"} from ${table}.${col}`);
      }
    }
  }
  return cleared;
}

if (user) {
  let { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    console.log(`deleteUser blocked (${error.message}) — clearing the account's rows first`);
    await clearUserRows(user.id);
    ({ error } = await admin.auth.admin.deleteUser(user.id));
  }
  if (error) {
    console.error("deleteUser failed:", error.message);
    process.exit(1);
  }
  console.log(`Deleted auth user ${email} (${user.id})`);
} else {
  console.log(`No auth user found for ${email} — already clean`);
}

// Clear any open verification codes so old codes can't collide.
const { error: codeErr } = await admin.from("email_verification_codes").delete().eq("email", email);
if (codeErr) console.warn("could not clear verification codes:", codeErr.message);
else console.log("Cleared verification codes");

console.log(`\nReady — sign up with ${email} again.`);
