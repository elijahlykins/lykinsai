/**
 * Tier 0 share-link helpers.
 *
 * A share is a URL-safe token that grants anonymous read access to a single
 * board and its most recent state snapshot. Row-level-security policies in
 * `omnia_shared_boards` take care of access control; see
 * `supabase-migrations/034_omnia_shared_boards.sql`.
 */

import { supabase } from "@/lib/supabase";
import { toUserFacingError } from "@/lib/ai/userFacingErrors";

export type SharedBoardRow = {
  id: string;
  token: string;
  board_id: string;
  owner_id: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
};

export type SharedBoardSnapshot = {
  token: string;
  boardId: string;
  title: string;
  snapshot: any;
  createdAt: string;
  updatedAt: string;
};

/** Generate a 12-char URL-safe token using the Web Crypto API. */
export function generateShareToken(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Build the public share URL for a given token, using the current origin.
 * Works in both browser and SSR (falls back to a relative path when no origin).
 */
export function buildShareUrl(token: string): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/s/${token}`;
  }
  return `/s/${token}`;
}

/** Turn a raw supabase / postgres error into a user-friendly message. */
function explainShareError(error: { code?: string; message?: string; details?: string } | null | undefined): string {
  if (!error) return "Unknown error.";
  const code = String(error.code || "").toUpperCase();
  const msg = String(error.message || "").toLowerCase();
  const details = String(error.details || "").toLowerCase();

  // Table or function doesn't exist → migration not applied.
  if (code === "42P01" || msg.includes("does not exist") || msg.includes("could not find the table")) {
    return "Sharing isn't set up on your Supabase project yet. Apply supabase-migrations/034_omnia_shared_boards.sql and try again.";
  }
  // RLS violation / insufficient privilege.
  if (code === "42501" || msg.includes("permission denied") || msg.includes("violates row-level security")) {
    return "You don't have permission to share this grid. Make sure you're signed in as the owner and that the migration's RLS policies are installed.";
  }
  // Foreign key: boardId doesn't exist in omnia_boards.
  if (code === "23503" || msg.includes("violates foreign key") || details.includes("foreign key")) {
    return "This grid isn't saved to your account yet. Make a small edit to save it, then try sharing again.";
  }
  // Unique constraint on token — caller should retry.
  if (code === "23505" || msg.includes("duplicate key")) {
    return "Token collision (extremely rare). Please try again.";
  }
  return toUserFacingError(error);
}

/**
 * Fetch the existing active share for a board (if any). Useful for making the
 * UI idempotent: users clicking "Share" twice should see the same link.
 * Throws a useful error if the schema is missing so callers can surface it.
 */
export async function getActiveShareForBoard(boardId: string): Promise<SharedBoardRow | null> {
  const { data, error } = await supabase
    .from("omnia_shared_boards")
    .select("*")
    .eq("board_id", boardId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (import.meta.env.DEV) console.warn("[LYKN] getActiveShareForBoard:", error);
    // Surface schema-missing errors so the dialog can explain them, rather
    // than silently swallowing them and then failing on insert with the
    // same cause but a worse message.
    const code = String(error.code || "").toUpperCase();
    const msg = String(error.message || "").toLowerCase();
    if (code === "42P01" || msg.includes("does not exist")) {
      throw new Error(explainShareError(error));
    }
    return null;
  }
  return (data as SharedBoardRow) || null;
}

/**
 * Create a new share row, or return the existing active share. Collisions on
 * the random token are extremely unlikely (56^12 ≈ 2·10^20) but we retry once
 * just in case.
 */
export async function createShareForBoard(
  boardId: string,
  userId: string,
  opts?: { expiresAt?: string | null }
): Promise<SharedBoardRow> {
  const existing = await getActiveShareForBoard(boardId);
  if (existing) return existing;

  let lastError: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = generateShareToken();
    const { data, error } = await supabase
      .from("omnia_shared_boards")
      .insert({
        token,
        board_id: boardId,
        owner_id: userId,
        expires_at: opts?.expiresAt ?? null,
      })
      .select("*")
      .maybeSingle();

    if (!error && data) return data as SharedBoardRow;
    lastError = error || new Error("Insert succeeded but no row was returned — RLS may be blocking the SELECT half of the insert.");

    if (import.meta.env.DEV) {
      console.warn("[LYKN] createShareForBoard attempt", attempt + 1, "failed:", lastError);
    }

    // Only retry on a true duplicate-token collision.
    const code = String(error?.code || "").toUpperCase();
    const msg = String(error?.message || "").toLowerCase();
    const isTokenCollision = code === "23505" || msg.includes("duplicate key");
    if (!isTokenCollision) break;
  }

  throw new Error(explainShareError(lastError));
}

/** Mark a share as revoked so anon reads stop resolving. */
export async function revokeShare(shareId: string): Promise<void> {
  const { error } = await supabase
    .from("omnia_shared_boards")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", shareId);
  if (error) throw new Error(error.message || "Failed to revoke share");
}

/**
 * Public viewer entry point: resolve a token to a board + latest snapshot.
 * Anonymous-safe — works even when the viewer isn't logged in, because the
 * migration opens up SELECT on the relevant tables when a live share exists.
 */
export async function resolveShareToken(token: string): Promise<SharedBoardSnapshot | null> {
  const safeToken = String(token || "").trim();
  if (!safeToken) return null;

  const { data: shareRow, error: shareErr } = await supabase
    .from("omnia_shared_boards")
    .select("board_id, created_at")
    .eq("token", safeToken)
    .is("revoked_at", null)
    .maybeSingle();
  if (shareErr || !shareRow?.board_id) return null;

  const boardId = shareRow.board_id as string;

  const [boardRes, stateRes] = await Promise.all([
    supabase.from("omnia_boards").select("title").eq("id", boardId).maybeSingle(),
    supabase
      .from("omnia_board_states")
      .select("state, updated_at")
      .eq("board_id", boardId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (boardRes.error || !boardRes.data) return null;

  // Fire-and-forget view counter; failure is non-fatal.
  supabase.rpc("omnia_shared_board_record_view", { p_token: safeToken }).then(() => {}, () => {});

  return {
    token: safeToken,
    boardId,
    title: String(boardRes.data?.title || "Untitled grid"),
    snapshot: stateRes.data?.state || null,
    createdAt: String(shareRow.created_at || ""),
    updatedAt: String(stateRes.data?.updated_at || ""),
  };
}
