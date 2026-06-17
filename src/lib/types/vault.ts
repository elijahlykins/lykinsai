/**
 * Phase 5 (Vault Normalization Program) — canonical TypeScript names.
 *
 * The physical DB rename `notes` -> `vault_items` is gated behind its own
 * approval and ships via migration `106_rename_notes_to_vault_items.sql` (which
 * also installs a backward-compatible `notes` view so existing code and the iOS
 * app keep working). These types let new code speak the target vocabulary
 * — `VaultItem`, `ChatSession`, `ChatHistory` — regardless of when that DB
 * rename lands.
 *
 * `ChatSession` / `ChatHistory` are TS aliases ONLY — there is no DB rename of
 * `lykn_chats` (renamed recently in migration 101); aliasing avoids a second
 * high-churn rename for cosmetic gain.
 */

/**
 * One row in the vault (`notes` today, `vault_items` after the Phase 5 rename).
 * Mirrors the normalized columns added in migrations 104 (attachment columns)
 * and 105 (the `why` field). Fields are optional because older rows predate the
 * columns and the dual-write transition keeps the `[ATTACHMENTS_JSON:…]` marker
 * inside `content` as the fallback source of truth.
 */
export interface VaultItem {
  id: string;
  user_id: string;
  title: string | null;
  /** User prose only (post-normalization); legacy rows still embed the marker. */
  content: string | null;
  /** The single "why" field (Phase 4) — distinct from the comments thread. */
  why?: string | null;
  tags?: string[] | null;
  source?: string | null;
  folder?: string | null;

  // --- Normalized attachment columns (Phase 1) ---
  att_type?: VaultAttachmentType | null;
  platform?: VaultSocialPlatform | null;
  url?: string | null;
  storage_path?: string | null;
  storage_bucket?: string | null;
  mime_type?: string | null;
  byte_size?: number | null;
  duration_seconds?: number | null;
  page_count?: number | null;
  host_name?: string | null;
  media_width?: number | null;
  media_height?: number | null;

  // --- Multi-size variants (Phase 3) ---
  variant_medium_path?: string | null;
  variant_thumb_path?: string | null;

  /** Tail metadata for the primary attachment (oembed, preview, extractedText…). */
  attachment_preview?: Record<string, unknown> | null;
  /** Timestamped comment thread (migration 041) — NOT the scalar `why`. */
  comments?: VaultItemComment[] | null;

  created_at: string;
  updated_at?: string | null;
}

export interface VaultItemComment {
  id: string;
  text: string;
  created_at: string;
}

/** Canonical attachment type enum (see attachmentType.ts `classifyAttachment`). */
export type VaultAttachmentType =
  | "note"
  | "link"
  | "social"
  | "youtube"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "file";

/** Social platform enum (only meaningful when `att_type === "social"`). */
export type VaultSocialPlatform =
  | "x"
  | "instagram"
  | "tiktok"
  | "facebook"
  | "linkedin"
  | "reddit"
  | "bluesky";

/**
 * A chat session = one `lykn_chats` row. TS alias only; no DB rename.
 * The conversation payload lives in the sibling `lykn_chat_states.state`.
 */
export interface ChatSession {
  id: string;
  user_id: string;
  title: string | null;
  thread_id?: string | null;
  chat_model_key?: string | null;
  created_at: string;
  updated_at: string;
}

/** A single turn in a chat session's history. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * The conversation history for a `ChatSession`, as persisted in
 * `lykn_chat_states.state`. `chatMessages` is the rich UI block stream;
 * `aiThread` is the flattened role/content transcript sent to the model.
 */
export interface ChatHistory {
  chatMessages: unknown[];
  aiThread: ChatTurn[];
}
