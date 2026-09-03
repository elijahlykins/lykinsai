/**
 * What LYKN has made for this user, as a list small enough to put in a prompt.
 *
 * AI Drive is the drive for the AI's own output and nothing else — artifacts,
 * written documents, and generated images (see DRIVE_FOLDERS in Vault.jsx).
 * To the person asking, those are the things they built: "pull up the dashboard
 * I made", "open that chart". The model has no way to know they exist, so the
 * client sends their names with the turn, the same way it sends the apps they
 * installed.
 *
 * Names and ids only. The vault listing in [WORKSPACE_CONTEXT] already carries
 * the contents of anything worth reading; this is a directory, not a copy.
 */

import type { VaultItem } from "@/lib/types/vault";
import { parseAttachmentsFromNote } from "@/lib/vault/attachmentsMarker";
import { resolveRenderType } from "@/lib/vault/attachmentType";

/**
 * What a row's `folder` says when it lives in AI Drive. Filing something under
 * any other name is how it leaves — see `isAiGeneratedVaultRow`.
 */
export const AI_DRIVE_FOLDER = "Generated";

/** The folders AI Drive has, and what they are called on screen. */
export const AI_DRIVE_FOLDERS = [
  { id: "docs", name: "Docs" },
  { id: "artifacts", name: "Artifacts" },
  { id: "images", name: "Image Gen" },
] as const;

export type AiDriveFolder = (typeof AI_DRIVE_FOLDERS)[number]["id"];

export interface AiDriveItem {
  /** The vault row it came from — what a deep link needs. */
  id: string;
  name: string;
  folder: AiDriveFolder;
}

// How a saved row says it came from the AI. The save paths file it under
// `folder: "Generated"` and stamp `source` (saveGeneratedImageToVault, and the
// chat's saveArtifactToVault), but one artifact-save path writes only the
// source and a "generated" tag, and rows predating the folder column have
// neither — so any of the three counts.
const AI_GENERATED_SOURCES = new Set(["ai_artifact", "studio_imagine"]);

// Last resort, for rows that reached the vault with none of the above.
//
// Saves used to answer a missing column by retrying with title and content
// alone, which dropped all three signals at once (insertWithSchemaFallback now
// drops only the column the database names). Images filed that way are in the
// vault and invisible to AI Drive — saved, but with no address. `content`
// always survived that retry, and every image saved through
// saveGeneratedImageToVault opens with this caption, so it reclaims them the
// way Vault.jsx reclaims connector rows by tag.
const GENERATED_IMAGE_CAPTION = /^ai-generated image\b/i;

export function isAiGeneratedVaultRow(
  row: { folder?: unknown; content?: unknown } | null | undefined,
  source: unknown,
  tags: unknown,
): boolean {
  const folder = String(row?.folder || "").trim();
  if (folder === AI_DRIVE_FOLDER) return true;
  // Filed somewhere by hand. That's the user overruling every signal below —
  // otherwise "move this out of the drive" would do nothing to a row the drive
  // claims by its source or its tags, and the item would never leave.
  if (folder) return false;
  if (AI_GENERATED_SOURCES.has(String(source || ""))) return true;
  const lower = (Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase());
  if (lower.includes("ai-generated") || lower.includes("generated")) return true;
  return GENERATED_IMAGE_CAPTION.test(String(row?.content || "").trimStart());
}

/** What the drive holds, and how much of it we managed to look at. */
export interface AiDriveListing {
  /** The most recent items, capped for the prompt. Never the whole drive. */
  items: AiDriveItem[];
  /** How many of each kind the scan actually found — not how many are named. */
  artifacts: number;
  docs: number;
  images: number;
  /** False when the scan hit its page budget before the vault ran out. */
  complete: boolean;
}

/** Letters, memos, and other write-outs filed with the document tag. */
export function isWrittenDocument(tags: unknown): boolean {
  return (Array.isArray(tags) ? tags : []).some(
    (t) => String(t).toLowerCase() === "document",
  );
}

// Names to carry into the prompt. Everything found is counted, but only the
// newest handful is named — a listing long enough to be exhaustive would
// crowd out the conversation it is supposed to help with.
const MAX_NAMES = 40;

/**
 * Sorts rows into the drive's folders, newest first.
 *
 * Two numbers come out of this, and they are deliberately different. Every item
 * found is COUNTED, because "how many images have I made" has one true answer.
 * Only the first of a repeated name is NAMED, because the names are what
 * lykn_open_app matches against and a duplicate there is a coin toss.
 */
export function collectAiDriveItems() {
  const items: AiDriveItem[] = [];
  const seen = new Set<string>();
  let artifacts = 0;
  let docs = 0;
  let images = 0;

  const keep = (id: string, rawName: string, folder: AiDriveFolder) => {
    if (folder === "images") images += 1;
    else if (folder === "docs") docs += 1;
    else artifacts += 1;

    const name = String(rawName || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name || !id) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ id, name, folder });
  };

  return {
    add(rows: VaultItem[]) {
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || (row as { trashed?: unknown }).trashed) continue;
        if (!isAiGeneratedVaultRow(row, row.source, row.tags)) continue;

        const id = String(row.id || "");
        // A row can hold several attachments, and each is its own item in the
        // drive — so this walks attachments, not rows.
        const attachments = parseAttachmentsFromNote(row) as Record<string, unknown>[];
        if (!attachments.length) {
          keep(id, String(row.title || ""), isWrittenDocument(row.tags) ? "docs" : "artifacts");
          continue;
        }
        for (const attachment of attachments) {
          const folder: AiDriveFolder =
            resolveRenderType(attachment) === "image"
              ? "images"
              : isWrittenDocument(row.tags)
                ? "docs"
                : "artifacts";
          keep(id, String(attachment?.name || row.title || ""), folder);
        }
      }
    },
    result(complete: boolean): AiDriveListing {
      return { items: items.slice(0, MAX_NAMES), artifacts, docs, images, complete };
    },
  };
}

/** One page's worth, for callers that already hold the rows. */
export function aiDriveItemsFromRows(rows: VaultItem[]): AiDriveItem[] {
  const collector = collectAiDriveItems();
  collector.add(rows);
  return collector.result(true).items;
}

// How far the scan reads. AI Drive items are scattered through a vault that is
// mostly uploads and connector syncs, so a single page finds only whatever the
// user happens to have made lately — which is how the model ended up reporting
// three images to someone who had generated far more. Pages are the same
// newest-first ones the grid scrolls through; the budget is the ceiling on what
// one chat turn is allowed to cost.
const PAGE_SIZE = 200;
const MAX_PAGES = 15;

// The drive only changes when something is saved to it, and every save clears
// this (see afterVaultNoteSaved). The window is long because the scan above is
// no longer cheap — without it, an active conversation would re-read thousands
// of rows every minute for an answer that has not moved.
const CACHE_MS = 5 * 60_000;
let cache: { key: string; at: number; listing: AiDriveListing } | null = null;

const EMPTY: AiDriveListing = { items: [], artifacts: 0, docs: 0, images: 0, complete: false };

/** Forget the cached listing — call after saving something to the drive. */
export function clearAiDriveCache(): void {
  cache = null;
}

export async function listAiDrive(
  userId: string | null | undefined,
): Promise<AiDriveListing> {
  try {
    // Loaded on use so that everything above — the rule for what belongs in the
    // drive, which both the Vault UI and its tests need — stays free of the
    // vault backends and everything they pull in.
    const { activeVaultBackend, getVaultRepository } = await import("@/lib/vault/repository");
    const key = `${activeVaultBackend()}:${userId || ""}`;
    const now = Date.now();
    if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.listing;

    const repository = getVaultRepository(userId);
    const collector = collectAiDriveItems();
    let cursor = null as Awaited<ReturnType<typeof repository.listPage>>["nextCursor"];
    let complete = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const next = await repository.listPage({ cursor, limit: PAGE_SIZE });
      collector.add(next.rows || []);
      cursor = next.nextCursor;
      if (!cursor) {
        complete = true;
        break;
      }
    }

    const listing = collector.result(complete);
    cache = { key, at: now, listing };
    return listing;
  } catch {
    // A drive we could not read is reported as empty rather than failing the
    // send — the turn has an answer to give either way. `complete: false` keeps
    // the model from telling anyone their drive is empty on the strength of it.
    return EMPTY;
  }
}
