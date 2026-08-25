import React, { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  ChevronDown,
  Download,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  Library,
  Loader2,
  MoreHorizontal,
  PenLine,
  Plus,
  RefreshCw,
  X as XIcon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { API_BASE_URL } from "@/lib/api-config";
import ChatSendIcon from "@/lib/chatSendIcon";
import { useAppearance } from "@/lib/useAppearance";
import { CHAT_REHYPE_PLUGINS, CHAT_REMARK_PLUGINS } from "@/lib/chat/chatMarkdown";
import {
  IMAGE_LAYOUT_OPTIONS,
  loadImagineAspect,
  saveImagineAspect,
} from "@/lib/chat/imagineLayout";
import { hasUsedImagine, markImagineUsed } from "@/lib/chat/imagineShowcase";
import { IMAGINE_BATCH_SIZE } from "@/lib/chat/imagineThread";
import LyknMediaPop, { MEDIA_POP_PANEL } from "@/components/lyknChat/LyknMediaPop";
import GeneratedImage from "@/components/lyknChat/GeneratedImage";
import ImagineMaskCanvas, {
  type ImagineMaskCanvasHandle,
} from "@/components/lyknChat/ImagineMaskCanvas";
import { buildEditPrompt } from "@/lib/chat/imagineMask";
import {
  buildImaginePrompt,
  imagineAttachmentFromFolder,
  imagineReferenceUrls,
  ingestImagineFiles,
  IMAGINE_FILE_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS,
  type ImagineAttachment,
} from "@/lib/chat/imagineAttachments";
import {
  fileNameFromPath,
  filesFromMacPaths,
  snapshotMacFolders,
  takePendingHomeChatFiles,
  takePendingHomeChatFolders,
} from "@/lib/homeChatFiles";
import { useDropZone } from "@/lib/drag/dragEngine";
import { barMenuOffset } from "@/lib/chat/barMenuOffset";
import { VAULT_PICK_ITEMS_EVENT, VAULT_PICK_PATHS_EVENT } from "@/lib/vault/vaultPicker";
import { deviceLocalUrlToDataUrl, isDeviceLocalUrl } from "@/lib/chat/deviceLocalImages";
import { isLocalVaultEnabled } from "@/lib/vault/repository";
import { storeLocalGeneration } from "@/lib/vault/repository/localGenerations";
import { toast } from "@/components/ui/use-toast";
import {
  canSaveFileAs,
  downloadToComputer,
  saveFileToChosenFolder,
} from "@/lib/files/downloadToComputer";
import {
  encodeImageToFormat,
  IMAGINE_DOWNLOAD_FORMATS,
  imagineDownloadFilename,
  imagineDownloadFilters,
  loadImagineDownloadFormat,
  saveImagineDownloadFormat,
  type ImagineDownloadFormat,
} from "@/lib/chat/imagineDownload";
// Same AI-generated pool as the landing page Imagine collage.
import imagineSneaker from "@/assets/imagine-sneaker.png";
import imaginePorsche from "@/assets/imagine-porsche-gt3.png";
import imagineMeadow from "@/assets/imagine-meadow.png";
import imagineClouds from "@/assets/imagine-clouds.png";
import imaginePastel from "@/assets/imagine-pastel.png";
import imagineCube from "@/assets/imagine-cube.png";
import imagineHeadphones from "@/assets/imagine-headphones.png";
import imagineHovercraft from "@/assets/imagine-hovercraft.png";
import imagineFigure from "@/assets/imagine-figure.png";

/**
 * LYKN Studio "Imagine" — a Midjourney-style image session. Each prompt
 * renders a centered batch of four variations generated in parallel (each
 * slot pops in as its request finishes). Clicking an image opens a mask
 * editor: outline the area to change, write a prompt, submit. That starts
 * a new batch grounded in the image's pixels plus the mask. All requests
 * hit POST /api/ai/imagine-image — one image per call.
 */

const SHOWCASE_IMAGES: { src: string; name: string }[] = [
  { src: imagineSneaker, name: "sneaker.png" },
  { src: imaginePorsche, name: "porsche-gt3.png" },
  { src: imagineFigure, name: "figure.png" },
  { src: imagineHovercraft, name: "hovercraft.png" },
  { src: imagineMeadow, name: "meadow.png" },
  { src: imagineHeadphones, name: "headphones.png" },
  { src: imagineClouds, name: "clouds.png" },
  { src: imaginePastel, name: "pastel.png" },
  { src: imagineCube, name: "cube.png" },
];

const SHOWCASE_ROTATE_MS = 3400;

/** One of the three bottom slots: every pool image stays mounted and the
 *  active one crossfades in — same trick as the landing Imagine collage. */
function ImagineShowcaseSlot({
  active,
  delayMs = 0,
  onPick,
}: {
  active: number;
  delayMs?: number;
  onPick: (src: string, name: string) => void;
}) {
  const current = SHOWCASE_IMAGES[active] || SHOWCASE_IMAGES[0];
  return (
    <button
      type="button"
      onClick={() => onPick(current.src, current.name)}
      title="Use as reference"
      className="relative aspect-square min-w-0 flex-1 overflow-hidden rounded-[1.35rem] border border-black/10 bg-black/[0.04] shadow-sm transition-transform hover:scale-[1.015] dark:border-white/12 dark:bg-white/[0.05]"
    >
      {SHOWCASE_IMAGES.map((img, i) => (
        <img
          key={img.name}
          src={img.src}
          alt=""
          draggable={false}
          loading="lazy"
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-out ${
            i === active ? "opacity-100" : "opacity-0"
          }`}
          style={{ transitionDelay: i === active ? `${delayMs}ms` : "0ms" }}
        />
      ))}
    </button>
  );
}

export { IMAGINE_BATCH_SIZE };

type SlotStatus = "loading" | "done" | "error";

type ImagineSlot = {
  id: string;
  status: SlotStatus;
  url?: string;
  /** Durable user-files path from /api/ai/imagine-image — required for vault save. */
  storagePath?: string;
  error?: string;
};

type BatchKind = "generate" | "refine" | "variations";

export type ImagineBatch = {
  id: string;
  /** What the user typed for this batch (prompt, or edit remarks). */
  label: string;
  /** Full prompt sent to the model. */
  prompt: string;
  /**
   * Stable creative brief without edit-instruction wrappers. Refine / vary
   * batches keep the prior concept so new notes stay the delta the model sees.
   */
  concept: string;
  kind: BatchKind;
  /** Pixel references: attached images and/or the generation being refined. */
  referenceUrls?: string[];
  /** White-on-black PNG — white is the region to edit. */
  maskImage?: string;
  aspectRatio: string;
  slots: ImagineSlot[];
  createdAt: number;
};

/* Chrome copied from the desktop's HomeChatBar so Imagine reads as the same
 * rounded pill as normal chat — same surface, icon buttons and menu rows. */
const BAR_SURFACE = "lg-desktop-surface";
const ICON_BTN =
  "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-black/60 transition-colors hover:bg-black/10 hover:text-black/85 dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white/90";
const SEND_BTN =
  "lykn-chat-send-btn flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-black/85 text-white shadow transition-all enabled:hover:scale-105 disabled:opacity-35 dark:bg-white dark:text-black";

// Session-scoped batch memory keyed by chat id — survives pill flips
// (component unmounts) within the same Studio session. Not persisted.
const sessionBatches = new Map<string, ImagineBatch[]>();
/** Batch ids already written into the chat, so a remount cannot commit twice. */
const sessionCommitted = new Map<string, Set<string>>();

function markSessionCommitted(key: string, id: string, into?: Set<string>) {
  const set = into || sessionCommitted.get(key) || new Set<string>();
  set.add(id);
  sessionCommitted.set(key, set);
  return set;
}

/** Studio "New chat" while on the Imagine page — clears the canvas in place.
 *  The page still moves to a fresh chat row like every other mode; this only
 *  wipes the canvas immediately rather than waiting for the remount. */
export const IMAGINE_CLEAR_EVENT = "lykn-imagine-clear";

/** A batch mirrored into the chat thread — pending first, then as slots land. */
export type ImagineCommit = {
  id: string;
  prompt: string;
  /** The stable brief, which edit rounds stay anchored to. */
  concept: string;
  kind: BatchKind;
  aspectRatio: string;
  images: { url: string; storagePath?: string }[];
  /** True until every slot has settled (loading tiles still belong in the turn). */
  pending?: boolean;
  slots?: Array<{
    status: SlotStatus;
    url?: string;
    storagePath?: string;
    error?: string;
  }>;
  referenceUrls?: string[];
};

/**
 * Rebuild the canvas from the conversation. Imagine turns carry their images,
 * so a chat loaded from Supabase can show its past generations again instead
 * of opening blank — the batches themselves are never persisted separately.
 */
export function imagineBatchesFromTurns(
  msgs: Array<{
    id: string;
    content?: string;
    aiImages?: { url: string; storagePath?: string }[];
    imagine?: { aspect?: string; kind?: BatchKind; concept?: string; pending?: boolean };
    createdAt?: string;
  }>,
): ImagineBatch[] {
  const out: ImagineBatch[] = [];
  const seen = new Set<string>();
  for (const m of msgs || []) {
    if (m.imagine?.pending) continue;
    const images = Array.isArray(m.aiImages) ? m.aiImages.filter((i) => i?.url) : [];
    if (!images.length) continue;
    const sig = images.map((i) => i.url).join("\n");
    if (seen.has(sig)) continue;
    seen.add(sig);
    const label = String(m.content || "").trim();
    out.push({
      id: `turn-${m.id}`,
      label,
      prompt: label,
      concept: String(m.imagine?.concept || label),
      kind: m.imagine?.kind || "generate",
      aspectRatio: String(m.imagine?.aspect || "1:1"),
      slots: images.map((img, i) => ({
        id: `turn-${m.id}-${i}`,
        status: "done" as SlotStatus,
        url: img.url,
        storagePath: img.storagePath,
      })),
      createdAt: (m.createdAt ? Date.parse(m.createdAt) : NaN) || Date.now(),
    });
  }
  return out;
}

function newId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `im-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function friendlyError(err: string, httpStatus?: number): string {
  const e = String(err || "");
  if (httpStatus === 401 || /unauthoriz|invalid or expired|missing or invalid auth|jwt|sign in/i.test(e)) {
    return "Sign in again to generate";
  }
  if (httpStatus === 413 || /payload|too large|entity too large/i.test(e)) {
    return "Reference image too large — try a smaller one";
  }
  if (/quota|limit|subscription_required|402/i.test(e) || httpStatus === 402 || httpStatus === 429) {
    if (/rate/i.test(e) || httpStatus === 429) return "Too fast — wait a moment";
    if (/subscription|402/i.test(e) || httpStatus === 402) return "Subscription required";
    return "Monthly image limit reached";
  }
  if (/moderation|safety/i.test(e)) return "Prompt was blocked — try rephrasing";
  if (/rate/i.test(e)) return "Too fast — wait a moment";
  return "Generation failed";
}

/** Errors worth silently retrying — provider blips when 4 slots fire together. */
function isTransientImagineFailure(err: string, httpStatus?: number): boolean {
  if (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return true;
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403 || httpStatus === 413) return false;
  const e = String(err || "");
  if (
    /moderation|safety|prompt_too_long|unauthoriz|subscription|monthly.?limit|image_gen_monthly|payload|too large|model_returned_no_image|prompt was blocked/i.test(
      e,
    )
  ) {
    return false;
  }
  return (
    !httpStatus ||
    httpStatus >= 500 ||
    /rate|overloaded|timeout|network|econnreset|fetch failed|temporarily|unavailable|capacity|resource.?exhaust|try again|image_generation_failed|gemini_http|openai_http|openai_network/i.test(
      e,
    )
  );
}

const SLOT_STAGGER_MS = 280;
const SLOT_MAX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Reference images the server can actually fetch.
 *
 * A generation kept on this device is addressed by `lykn-blob://`, which means
 * nothing outside this process, so those are read off disk and sent inline —
 * the endpoint accepts `data:image/` references for exactly this reason. Any
 * that cannot be read are dropped rather than sent broken: refining without
 * the reference still produces an image, refining with a dead URL fails the
 * whole request.
 */
async function imagineReferencePayload(urls?: string[]): Promise<string[]> {
  const list = (urls || []).filter(Boolean);
  if (!list.length) return [];

  const out: string[] = [];
  for (const url of list) {
    if (!isDeviceLocalUrl(url)) {
      out.push(url);
      continue;
    }
    const read = await deviceLocalUrlToDataUrl(url, "reference");
    if (read) out.push(read.dataUrl);
  }
  return out;
}


/** Aspect-ratio → CSS ratio for the grid cells ("3:2" → "3 / 2"). */
function cssAspect(ar: string): string {
  const m = /^(\d+):(\d+)$/.exec(ar);
  return m ? `${m[1]} / ${m[2]}` : "1 / 1";
}

const BUBBLE_MD = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-4 last:mb-0 whitespace-pre-wrap leading-[1.65]">{children}</p>
  ),
};

/** Same user-prompt bubble the rest of chat uses — Appearance tokens ride on
 *  `lykn-user-prompt-bubble`, so size / color / tail stay in lockstep. */
function ImagineUserPrompt({
  text,
  referenceUrls,
  expanded,
  onToggleExpand,
}: {
  text: string;
  referenceUrls?: string[];
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const refs = (referenceUrls || []).filter(Boolean);
  const isLong = text.length > 320;
  const clamp =
    isLong && !expanded
      ? {
          display: "-webkit-box" as const,
          WebkitLineClamp: 5 as const,
          WebkitBoxOrient: "vertical" as const,
          overflow: "hidden" as const,
        }
      : undefined;
  return (
    <div className="flex flex-col items-end gap-2">
      {refs.length > 0 ? (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
          {refs.map((url) => (
            <GeneratedImage
              key={url}
              src={url}
              alt=""
              className="h-14 w-14 rounded-xl object-cover ring-1 ring-black/10 dark:ring-white/12"
            />
          ))}
        </div>
      ) : null}
      {text ? (
        <div className="group flex max-w-[80%] flex-col items-end">
          <div
            className="lykn-user-prompt-bubble rounded-[15px] rounded-br-[4px] border border-black/8 bg-background px-3 py-1 text-[14px] leading-[1.25] text-black/90 shadow-[0_2px_8px_rgba(0,0,0,0.045)] dark:border-white/10 dark:text-white/90 [&_table]:my-1 [&_td]:px-2 [&_th]:px-2"
            style={clamp}
          >
            <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS} components={BUBBLE_MD}>
              {text}
            </ReactMarkdown>
          </div>
          {isLong ? (
            <button
              type="button"
              onClick={onToggleExpand}
              title={expanded ? "Show less" : "Show full prompt"}
              aria-label={expanded ? "Show less" : "Show full prompt"}
              className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-black/55 transition-colors hover:bg-black/5 hover:text-black/85 dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white/85"
            >
              {expanded ? (
                <span className="leading-none">Show less</span>
              ) : (
                <>
                  <MoreHorizontal className="h-3.5 w-3.5" />
                  <span className="leading-none">Show more</span>
                </>
              )}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Older session batches predate the concept field; keep their brief stable. */
function withConcept(list: ImagineBatch[]): ImagineBatch[] {
  return list.map((b) =>
    b.concept ? b : { ...b, concept: String(b.label || b.prompt || "").trim() },
  );
}

/** Live session memory wins over history — it holds in-flight batches too. */
function hydrateBatches(key: string, seed: ImagineBatch[]): ImagineBatch[] {
  const live = sessionBatches.get(key) || [];
  return withConcept(live.length ? live : seed || []);
}

export type ImagineGenerateInput = {
  text?: string;
  referenceUrls?: string[];
  documents?: { name: string; text: string }[];
  aspectRatio?: string;
};

export type ImagineEditInput = {
  url: string;
  prompt?: string;
  aspect?: string;
  storagePath?: string;
  /** Live canvas batch this image belongs to — keeps prev/next on the 4-up. */
  batchId?: string;
  index?: number;
};

export type StudioImagineHandle = {
  generate: (input: ImagineGenerateInput) => boolean;
  openEdit: (input: ImagineEditInput) => void;
  retrySlot: (batchId: string, slotIndex: number) => void;
};

export type StudioImagineModeProps = {
  /** Keys the session batch memory (per chat). */
  chatKey: string;
  /** Past Imagine turns in this chat, so a reloaded canvas isn't blank. */
  seedBatches?: ImagineBatch[];
  /** Writes / updates the chat turn: once on send, then as each slot lands. */
  onCommitBatch?: (commit: ImagineCommit) => void;
  /** Opens the chat page's vault picker for the bar's "Vault" menu row. */
  onPullVault?: () => void;
  /** Optional Save-to-vault for a generated image (url, prompt, storage meta). */
  onSaveImage?: (
    url: string,
    prompt?: string,
    meta?: { storagePath?: string; mimeType?: string },
  ) => void | Promise<boolean | void>;
  savedUrls?: Set<string>;
  /**
   * Share the chat thread and composer. Imagine then only draws in-flight
   * batches, the first-run showcase, and the mask editor — the conversation
   * and the bar stay on LyknChatView so switching modes doesn't drop them.
   */
  sharedThread?: boolean;
  /** The chat already has turns — hide the empty-page headline. */
  hasThread?: boolean;
  /** When false the overlay hides but in-flight work keeps running. */
  visible?: boolean;
  /** Showcase tile picked on the empty Imagine page — attach to the shared bar. */
  onAttachReference?: (dataUrl: string, name: string) => void;
  /** Shared-thread: a batch is in flight so the empty headline can hide now. */
  onBusyChange?: (busy: boolean) => void;
};

const StudioImagineMode = forwardRef<StudioImagineHandle, StudioImagineModeProps>(function StudioImagineMode({
  chatKey,
  seedBatches,
  onCommitBatch,
  onPullVault,
  onSaveImage,
  savedUrls,
  sharedThread = false,
  hasThread = false,
  visible = true,
  onAttachReference,
  onBusyChange,
}, ref) {
  const key = chatKey || "unkeyed";
  const [batches, setBatches] = useState<ImagineBatch[]>(() => hydrateBatches(key, seedBatches || []));
  const batchesRef = useRef(batches);
  batchesRef.current = batches;
  const seedRef = useRef(seedBatches);
  seedRef.current = seedBatches;
  // Sample tiles under the bar are first-run only. Anyone who has already
  // generated (this session, this chat, or an older cached chat) never
  // sees them again — including on a fresh empty Imagine page.
  const [imagineUsed, setImagineUsed] = useState(() => {
    if (hasUsedImagine()) return true;
    const already =
      (sessionBatches.get(key) || []).length > 0 || !!(seedBatches && seedBatches.length);
    if (already) markImagineUsed();
    return already;
  });
  useEffect(() => {
    if (imagineUsed) return;
    if (!batches.length && !(seedBatches && seedBatches.length)) return;
    markImagineUsed();
    setImagineUsed(true);
  }, [batches.length, seedBatches, imagineUsed]);
  /** Batches already written into the conversation, so none is written twice. */
  const committedRef = useRef<Set<string>>(new Set(sessionCommitted.get(key) || []));
  useEffect(() => {
    sessionBatches.set(key, batches);
  }, [key, batches]);
  // Chat switch: swap in that chat's batches and the commits already recorded
  // for it. A remount must not treat live session batches as new turns.
  useEffect(() => {
    committedRef.current = new Set(sessionCommitted.get(key) || []);
    setBatches(hydrateBatches(key, seedRef.current || []));
  }, [key]);
  // A chat loads asynchronously, so its turns often arrive after this mounted.
  // Adopt them once, and only while this chat's canvas is still empty.
  useEffect(() => {
    if (!seedBatches?.length) return;
    if ((sessionBatches.get(key) || []).length) return;
    setBatches(withConcept(seedBatches));
  }, [key, seedBatches]);

  // Mirror the canvas into the conversation as soon as a batch starts, then
  // again as each slot lands. Waiting until every image finished hid the
  // prompt bubble and left older 4-ups expanded for the whole generate.
  const onCommitBatchRef = useRef(onCommitBatch);
  onCommitBatchRef.current = onCommitBatch;
  const emitBatchCommit = useCallback((b: ImagineBatch, pending: boolean) => {
    const fn = onCommitBatchRef.current;
    if (!fn) return;
    const done = b.slots.filter((s) => s.status === "done" && s.url);
    fn({
      id: b.id,
      prompt: b.label,
      concept: b.concept,
      kind: b.kind,
      aspectRatio: b.aspectRatio,
      images: done.map((s) => ({ url: String(s.url), storagePath: s.storagePath })),
      pending,
      slots: b.slots.map((s) => ({
        status: s.status,
        url: s.url,
        storagePath: s.storagePath,
        error: s.error,
      })),
      referenceUrls: b.referenceUrls,
    });
  }, []);
  useEffect(() => {
    if (!onCommitBatchRef.current) return;
    for (const b of batches) {
      // Batches rebuilt from history already are turns.
      if (b.id.startsWith("turn-")) {
        committedRef.current = markSessionCommitted(key, b.id, committedRef.current);
        continue;
      }
      const loading = b.slots.some((s) => s.status === "loading");
      const done = b.slots.filter((s) => s.status === "done" && s.url);
      const allFailed = !loading && b.slots.length > 0 && b.slots.every((s) => s.status === "error");
      const settled = !loading && (done.length > 0 || allFailed);
      if (!settled) {
        emitBatchCommit(b, true);
        continue;
      }
      if (committedRef.current.has(b.id)) continue;
      committedRef.current = markSessionCommitted(key, b.id, committedRef.current);
      emitBatchCommit(b, false);
    }
  }, [batches, emitBatchCommit, key]);

  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<string>(() => loadImagineAspect());
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  /** Prompt wrapped past one line — the pill squares off like the Home bar. */
  const [promptTall, setPromptTall] = useState(false);
  const [remarksTall, setRemarksTall] = useState(false);
  const [quotaNote, setQuotaNote] = useState<string>("");
  const [attachments, setAttachments] = useState<ImagineAttachment[]>([]);
  /** "+" menu open state, and whether files are still being read. */
  const [addOpen, setAddOpen] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  /** A Finder drag is over the bar. */
  const [dropping, setDropping] = useState(false);
  // Edit space: batch + slot index. null = closed.
  const [lightbox, setLightbox] = useState<{ batchId: string; index: number } | null>(null);
  /** An image opened from the shared chat thread — not one of this canvas's slots. */
  const [guestEdit, setGuestEdit] = useState<{ batch: ImagineBatch; index: number } | null>(null);
  const [remarks, setRemarks] = useState("");
  const [hasMask, setHasMask] = useState(false);
  const [savedFlash, setSavedFlash] = useState<Set<string>>(new Set());
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState<ImagineDownloadFormat>(
    () => loadImagineDownloadFormat(),
  );
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  /** Long Imagine prompts clamp like chat until the user opens them. */
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(() => new Set());

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const remarksRef = useRef<HTMLTextAreaElement | null>(null);
  const maskRef = useRef<ImagineMaskCanvasHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const finderInputId = useId();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const layoutPanelRef = useRef<HTMLDivElement | null>(null);
  const addRef = useRef<HTMLDivElement | null>(null);
  const addPanelRef = useRef<HTMLDivElement | null>(null);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const [addPos, setAddPos] = useState<{ left?: number; bottom?: number }>({});
  const [layoutPos, setLayoutPos] = useState<{ left?: number; bottom?: number }>({});
  /** Set below — lets the vault listener reuse the url→reference path. */
  const attachShowcaseRef = useRef<((src: string, name: string) => Promise<void>) | null>(null);

  // Grow the prompt with its content and flag the two-line case, so the pill
  // squares off instead of stretching into a lozenge. The empty height is the
  // one-line baseline — measuring beats guessing at the line box.
  const promptBaseHRef = useRef(0);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    if (full > 0 && !promptBaseHRef.current) promptBaseHRef.current = full;
    el.style.height = `${Math.min(full, 128)}px`;
    setPromptTall(Boolean(promptBaseHRef.current) && full > promptBaseHRef.current + 4);
  }, [prompt]);

  const remarksBaseHRef = useRef(0);
  useEffect(() => {
    const el = remarksRef.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    if (full > 0 && !remarksBaseHRef.current) remarksBaseHRef.current = full;
    el.style.height = `${Math.min(full, 128)}px`;
    setRemarksTall(Boolean(remarksBaseHRef.current) && full > remarksBaseHRef.current + 4);
  }, [remarks, lightbox, guestEdit]);

  // Layout menu: click-away / Escape, matching the Home bar's popovers.
  useEffect(() => {
    if (!layoutMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (layoutRef.current?.contains(t) || layoutPanelRef.current?.contains(t)) return;
      setLayoutMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLayoutMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [layoutMenuOpen]);

  // Same click-away / Escape handling as the desktop chat bar's "+" menu:
  // the panel hangs as a sibling of the bar, so outside-click has to clear
  // both the trigger and the panel.
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addRef.current?.contains(t) || addPanelRef.current?.contains(t)) return;
      setAddOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  // Studio "New chat" while this page is up → wipe the canvas back to the
  // centered empty state.
  useEffect(() => {
    const onClear = () => {
      sessionBatches.delete(key);
      sessionCommitted.delete(key);
      committedRef.current = new Set();
      setBatches([]);
      setPrompt("");
      setAttachments([]);
      setLightbox(null);
      setGuestEdit(null);
      setRemarks("");
      setHasMask(false);
      maskRef.current?.clear();
    };
    window.addEventListener(IMAGINE_CLEAR_EVENT, onClear);
    return () => window.removeEventListener(IMAGINE_CLEAR_EVENT, onClear);
  }, [key]);

  const anyLoading = useMemo(
    () => batches.some((b) => b.slots.some((s) => s.status === "loading")),
    [batches],
  );
  useEffect(() => {
    if (!sharedThread) return;
    onBusyChange?.(anyLoading);
  }, [sharedThread, anyLoading, onBusyChange]);

  const patchSlot = useCallback((batchId: string, slotId: string, patch: Partial<ImagineSlot>) => {
    setBatches((prev) =>
      prev.map((b) =>
        b.id === batchId
          ? { ...b, slots: b.slots.map((s) => (s.id === slotId ? { ...s, ...patch } : s)) }
          : b,
      ),
    );
  }, []);

  const runSlot = useCallback(
    async (batch: ImagineBatch, slot: ImagineSlot, attempt = 0) => {
      try {
        const wantsBytes = isLocalVaultEnabled();
        // A local reference lives behind lykn-blob://, which only this machine
        // can resolve — inline it so the provider has real pixels to work from.
        const references = await imagineReferencePayload(batch.referenceUrls);
        // Do NOT attach Authorization here — installAuthFetch injects a
        // refreshed JWT and retries on 401. A stale getSession() token would
        // lock out that refresh path and every slot would land as failed.
        const res = await fetch(`${API_BASE_URL}/api/ai/imagine-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: batch.prompt,
            aspectRatio: batch.aspectRatio === "1:1" ? undefined : batch.aspectRatio,
            referenceImages: references.length ? references : undefined,
            maskImage: batch.maskImage || undefined,
            deliverBytes: wantsBytes || undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok || !(data.imageUrl || data.imageBase64)) {
          const rawErr = String(data?.error || `http_${res.status}`);
          // Keep the tile spinning and retry transient provider/rate blips
          // automatically — firing 4 parallel gens often trips one slot.
          if (attempt + 1 < SLOT_MAX_ATTEMPTS && isTransientImagineFailure(rawErr, res.status)) {
            await sleep(900 * (attempt + 1) + Math.floor(Math.random() * 400));
            return runSlot(batch, slot, attempt + 1);
          }
          patchSlot(batch.id, slot.id, {
            status: "error",
            error: friendlyError(rawErr, res.status),
          });
          return;
        }

        if (typeof data.imageBase64 === "string" && data.imageBase64) {
          // Bytes never went to a bucket, so this is the only copy — a failed
          // write has to surface as a failed slot rather than an empty tile.
          const stored = await storeLocalGeneration({
            base64: data.imageBase64,
            mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
          });
          // The blob directory is named for its row, so this URL is the only
          // handle a save needs — no separate id to carry around.
          patchSlot(batch.id, slot.id, { status: "done", url: stored.url });
        } else {
          patchSlot(batch.id, slot.id, {
            status: "done",
            url: data.imageUrl,
            storagePath: typeof data.storagePath === "string" ? data.storagePath : undefined,
          });
        }
        if (data.monthlyRemaining !== undefined && data.monthlyRemaining !== "unlimited") {
          setQuotaNote(`${data.monthlyRemaining} image${data.monthlyRemaining === 1 ? "" : "s"} left this month`);
        }
      } catch {
        if (attempt + 1 < SLOT_MAX_ATTEMPTS) {
          await sleep(900 * (attempt + 1) + Math.floor(Math.random() * 400));
          return runSlot(batch, slot, attempt + 1);
        }
        patchSlot(batch.id, slot.id, { status: "error", error: "Network error" });
      }
    },
    [patchSlot],
  );

  const startBatch = useCallback(
    (opts: {
      label: string;
      prompt: string;
      concept: string;
      kind: BatchKind;
      referenceUrls?: string[];
      maskImage?: string;
      aspectRatio: string;
    }) => {
      const batch: ImagineBatch = {
        id: newId(),
        label: opts.label,
        prompt: opts.prompt,
        concept: opts.concept,
        kind: opts.kind,
        referenceUrls: opts.referenceUrls,
        maskImage: opts.maskImage,
        aspectRatio: opts.aspectRatio,
        slots: Array.from({ length: IMAGINE_BATCH_SIZE }, () => ({
          id: newId(),
          status: "loading" as SlotStatus,
        })),
        createdAt: Date.now(),
      };
      setBatches((prev) => [...prev, batch]);
      markImagineUsed();
      setImagineUsed(true);
      // Same tick as send — don't wait for the batches effect or the
      // prompt bubble sits behind a still-expanded previous 4-up.
      emitBatchCommit(batch, true);
      // Stagger starts so four identical provider calls don't collide on the
      // same rate-limit window; each slot still lands independently.
      batch.slots.forEach((slot, i) => {
        window.setTimeout(() => {
          void runSlot(batch, slot);
        }, i * SLOT_STAGGER_MS);
      });
      window.setTimeout(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      }, 60);
    },
    [runSlot, emitBatchCommit],
  );

  const handleSend = useCallback(() => {
    const text = prompt.trim();
    if (!text) return;
    const refs = imagineReferenceUrls(attachments);
    setPrompt("");
    setAttachments([]);
    startBatch({
      label: text,
      prompt: buildImaginePrompt(text, attachments),
      concept: text,
      kind: "generate",
      referenceUrls: refs.length ? refs : undefined,
      aspectRatio: aspect,
    });
  }, [prompt, aspect, attachments, startBatch]);

  const generate = useCallback(
    (input: ImagineGenerateInput) => {
      const text = String(input.text || "").trim();
      const refs = (input.referenceUrls || []).filter(Boolean);
      const docs = (input.documents || []).filter((d) => String(d.text || "").trim());
      if (!text && !refs.length) return false;
      const atts: ImagineAttachment[] = [
        ...refs.map((url, i) => ({
          id: `r${i}-${Date.now()}`,
          name: `ref-${i + 1}`,
          kind: "image" as const,
          dataUrl: url,
        })),
        ...docs.map((d, i) => ({
          id: `d${i}-${Date.now()}`,
          name: d.name || "note",
          kind: "text" as const,
          text: d.text,
        })),
      ];
      const ratio = saveImagineAspect(input.aspectRatio || aspect);
      if (ratio !== aspect) setAspect(ratio);
      startBatch({
        label: text || "Image",
        prompt: buildImaginePrompt(text || "Generate an image from the reference.", atts),
        concept: text || "the reference image",
        kind: "generate",
        referenceUrls: refs.length ? refs : undefined,
        aspectRatio: ratio,
      });
      return true;
    },
    [startBatch, aspect],
  );

  // Imagine's "conversation under way" signal for the Studio shell — batches
  // rather than chat turns (the home desktop's rounded bar docks to the
  // bottom once the canvas has content). When the chat thread is shared,
  // that page already broadcasts turns; only signal while a fresh canvas
  // is generating so the bar docks before the first commit lands.
  const hasBatches = batches.length > 0;
  useEffect(() => {
    if (sharedThread && hasThread) return;
    window.dispatchEvent(
      new CustomEvent("lykn-chat-activity-changed", { detail: { active: hasBatches } }),
    );
  }, [hasBatches, sharedThread, hasThread]);

  // Home-screen chat bar hand-off: a stashed Imagine prompt starts generating
  // as soon as this page mounts (or via the seed event when already warm).
  // Shared-thread Imagine takes sends through the chat composer instead.
  useEffect(() => {
    if (sharedThread) return;
    const consume = (fallback = "") => {
      let text = "";
      try {
        text = sessionStorage.getItem("lykn_pending_imagine_prompt") || "";
        if (text) sessionStorage.removeItem("lykn_pending_imagine_prompt");
      } catch {
        /* storage blocked — fall back to the event payload */
      }
      text = (text || fallback).trim();
      // Files the home bar sent along. Claimed before the empty-prompt bail so
      // they can't linger and reappear against some later prompt.
      const files = takePendingHomeChatFiles();
      const folders = takePendingHomeChatFolders();
      if (!text && !files.length && !folders.length) return;

      if (!files.length && !folders.length) {
        startBatch({
          label: text,
          prompt: text,
          concept: text,
          kind: "generate",
          aspectRatio: aspect,
        });
        return;
      }

      // Reading them has to finish before the batch starts, or the references
      // would miss the generation they were dropped for.
      void (async () => {
        setIngesting(true);
        try {
          const read = await ingestImagineFiles(files, [], API_BASE_URL);
          const folderAtts = (folders || [])
            .filter((f: { name: string; listing: string }) => f?.listing)
            .map((f: { name: string; listing: string }) =>
              imagineAttachmentFromFolder(f.name, f.listing),
            );
          const all = [...read, ...folderAtts];
          if (!text) {
            // Dropped with nothing to make yet — hold them on the bar.
            setAttachments((prev) => [...prev, ...all]);
            return;
          }
          const refs = imagineReferenceUrls(all);
          startBatch({
            label: text,
            prompt: buildImaginePrompt(text, all),
            concept: text,
            kind: "generate",
            referenceUrls: refs.length ? refs : undefined,
            aspectRatio: aspect,
          });
        } finally {
          setIngesting(false);
        }
      })();
    };
    consume();
    const onSeed = (e: Event) =>
      consume(String((e as CustomEvent).detail?.text || ""));
    window.addEventListener("lykn-imagine-seed", onSeed);
    return () => window.removeEventListener("lykn-imagine-seed", onSeed);
  }, [startBatch, aspect, sharedThread]);

  // "+" attachments. Images ride as pixel references for the next batch;
  // documents are read for their words and become prompt context, so a brand
  // sheet or a spec can steer a generation it has no pixels for.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const handlePickFiles = useCallback(async (files: FileList | File[] | null) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setIngesting(true);
    try {
      const added = await ingestImagineFiles(list, attachmentsRef.current, API_BASE_URL);
      if (added.length) setAttachments((prev) => [...prev, ...added]);
    } finally {
      setIngesting(false);
    }
  }, []);

  /** Mac paths (desktop icons, Files window, internal drags) → attachments. */
  const ingestMacPaths = useCallback(async (paths: string[]) => {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    setIngesting(true);
    try {
      const files = await filesFromMacPaths(list).catch(() => [] as File[]);
      if (files.length) {
        const added = await ingestImagineFiles(files, attachmentsRef.current, API_BASE_URL);
        if (added.length) setAttachments((prev) => [...prev, ...added]);
      }
      // Whatever couldn't be read as a file is treated as a folder and
      // attached as its listing, the same way the desktop bar does it.
      const readNames = new Set(files.map((f) => f.name));
      const folderPaths = list.filter((p) => !readNames.has(fileNameFromPath(p)));
      if (folderPaths.length) {
        const snaps = await snapshotMacFolders(folderPaths).catch(() => []);
        const folderAtts = snaps
          .filter((s: { name: string; listing: string }) => s?.listing)
          .map((s: { name: string; listing: string }) =>
            imagineAttachmentFromFolder(s.name, s.listing),
          );
        if (folderAtts.length) {
          setAttachments((prev) => [
            ...prev,
            ...folderAtts.filter((f) => !prev.some((p) => p.name === f.name)),
          ]);
        }
      }
    } finally {
      setIngesting(false);
    }
  }, []);

  const openAddFinder = useCallback(() => {
    const pick = typeof window !== "undefined" ? (window as any).lykn?.pickOpenFiles : null;
    if (typeof pick !== "function") return;
    setAddOpen(false);
    setIngesting(true);
    pick()
      .then((rows: any[]) => {
        const files = (Array.isArray(rows) ? rows : [])
          .map((row) => {
            if (!row?.name || row.data == null) return null;
            let body = row.data;
            if (body?.type === "Buffer" && Array.isArray(body.data)) {
              body = new Uint8Array(body.data);
            }
            return new File([body], row.name, {
              type: row.type || "",
              lastModified: Number(row.lastModified) || Date.now(),
            });
          })
          .filter(Boolean) as File[];
        if (files.length) void handlePickFiles(files);
      })
      .catch(() => {
        /* cancelled or bridge unavailable */
      })
      .finally(() => setIngesting(false));
  }, [handlePickFiles]);

  /** Opens the same vault picker the chat page's "+" menu uses. */
  const openAddVault = useCallback(() => {
    setAddOpen(false);
    onPullVault?.();
  }, [onPullVault]);

  // A pick from the vault window lands here while Imagine is the visible
  // surface. A saved image becomes a pixel reference; anything else
  // contributes its text. Files chosen from a folder on the Mac arrive as
  // paths instead and go through the same ingest a drag onto the bar uses.
  useEffect(() => {
    if (sharedThread) return;
    const onVaultPaths = (e: Event) => {
      const picked = (e as CustomEvent).detail?.paths;
      if (Array.isArray(picked) && picked.length) void ingestMacPaths(picked);
    };
    window.addEventListener(VAULT_PICK_PATHS_EVENT, onVaultPaths);
    return () => window.removeEventListener(VAULT_PICK_PATHS_EVENT, onVaultPaths);
  }, [ingestMacPaths, sharedThread]);

  useEffect(() => {
    if (sharedThread) return;
    const onVaultAdd = (e: Event) => {
      const d = ((e as CustomEvent).detail || {}) as any;
      const att = d.attachment || (Array.isArray(d.attachments) ? d.attachments[0] : null);
      const name = String(d.title || att?.name || "Vault item").trim();
      const isImage =
        att && (att.type === "image" || String(att.mime || "").startsWith("image/"));

      if (isImage && att.url) {
        void attachShowcaseRef.current?.(String(att.url), name);
        return;
      }
      const body = String(
        d.content || att?.extractedText || att?.pdfText || att?.transcript || "",
      ).trim();
      if (!body) return;
      setAttachments((prev) =>
        prev.some((a) => a.name === name)
          ? prev
          : [...prev, imagineAttachmentFromFolder(name, body)],
      );
    };
    window.addEventListener(VAULT_PICK_ITEMS_EVENT, onVaultAdd);
    return () => window.removeEventListener(VAULT_PICK_ITEMS_EVENT, onVaultAdd);
  }, [sharedThread]);

  // Internal LYKN drags (desktop icons, Files window) carry Mac paths.
  const barDrop = useDropZone({
    copies: true,
    accept: (payload: { paths: string[] }) => payload.paths.length > 0,
    onDrop: (payload: { paths: string[] }) => void ingestMacPaths(payload.paths),
  });

  // Landing-page showcase tile → attach as a reference for the next generate.
  const attachShowcase = useCallback(async (src: string, name: string) => {
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      if (blob.size > MAX_ATTACHMENT_BYTES) return;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      if (!dataUrl.startsWith("data:image/")) return;
      if (onAttachReference) {
        onAttachReference(dataUrl, name);
        return;
      }
      setAttachments((prev) => {
        if (prev.some((a) => a.name === name)) return prev;
        if (prev.filter((a) => a.kind === "image").length >= MAX_IMAGE_ATTACHMENTS) return prev;
        return [...prev, { id: newId(), name, kind: "image", dataUrl }];
      });
      inputRef.current?.focus();
    } catch {
      /* ignore fetch/attach failures */
    }
  }, [onAttachReference]);
  attachShowcaseRef.current = attachShowcase;

  const retrySlot = useCallback(
    (batch: ImagineBatch, slot: ImagineSlot) => {
      patchSlot(batch.id, slot.id, { status: "loading", error: undefined });
      void runSlot(batch, slot);
    },
    [patchSlot, runSlot],
  );

  const retrySlotAt = useCallback(
    (batchId: string, slotIndex: number) => {
      const batch = batchesRef.current.find((b) => b.id === batchId);
      const slot = batch?.slots[slotIndex];
      if (!batch || !slot) return;
      retrySlot(batch, slot);
    },
    [retrySlot],
  );

  /* ---------- lightbox ---------- */

  const lightboxBatch =
    guestEdit?.batch || (lightbox ? batches.find((b) => b.id === lightbox.batchId) || null : null);
  const lightboxIndex = guestEdit ? guestEdit.index : lightbox?.index ?? 0;
  const lightboxSlot = lightboxBatch ? lightboxBatch.slots[lightboxIndex] : null;
  const lightboxUrl = lightboxSlot?.status === "done" ? lightboxSlot.url : undefined;

  const resetEditNotes = useCallback(() => {
    setRemarks("");
    setHasMask(false);
    maskRef.current?.clear();
  }, []);

  const openLightbox = useCallback(
    (batchId: string, index: number) => {
      setGuestEdit(null);
      setLightbox({ batchId, index });
      resetEditNotes();
      window.setTimeout(() => remarksRef.current?.focus(), 50);
    },
    [resetEditNotes],
  );

  const openEdit = useCallback(
    (input: ImagineEditInput) => {
      const url = String(input.url || "");
      if (!url) return;
      const live = batchesRef.current;
      const byId = input.batchId ? live.find((b) => b.id === input.batchId) : undefined;
      const matchIn = (batch: ImagineBatch) => {
        const byUrl = batch.slots.findIndex((s) => s.status === "done" && s.url === url);
        if (byUrl >= 0) return byUrl;
        const path = String(input.storagePath || "");
        if (!path) return -1;
        return batch.slots.findIndex((s) => s.status === "done" && s.storagePath === path);
      };
      if (byId) {
        const hinted = byId.slots[input.index ?? -1];
        if (hinted?.status === "done" && hinted.url) {
          openLightbox(byId.id, input.index as number);
          return;
        }
        const index = matchIn(byId);
        if (index >= 0) {
          openLightbox(byId.id, index);
          return;
        }
      }
      for (const batch of live) {
        const index = matchIn(batch);
        if (index >= 0) {
          openLightbox(batch.id, index);
          return;
        }
      }
      const note = String(input.prompt || "");
      setLightbox(null);
      setGuestEdit({
        batch: {
          id: `guest-${url}`,
          label: note,
          prompt: note,
          concept: note || "the reference image",
          kind: "generate",
          aspectRatio: input.aspect || "1:1",
          slots: [
            {
              id: "g0",
              status: "done",
              url,
              storagePath: input.storagePath,
            },
          ],
          createdAt: Date.now(),
        },
        index: 0,
      });
      resetEditNotes();
      window.setTimeout(() => remarksRef.current?.focus(), 50);
    },
    [openLightbox, resetEditNotes],
  );

  const closeLightbox = useCallback(() => {
    setLightbox(null);
    setGuestEdit(null);
    setDownloadOpen(false);
    resetEditNotes();
  }, [resetEditNotes]);

  useImperativeHandle(ref, () => ({ generate, openEdit, retrySlot: retrySlotAt }), [generate, openEdit, retrySlotAt]);

  const stepLightbox = useCallback(
    (dir: 1 | -1) => {
      if (!lightboxBatch) return;
      const done = lightboxBatch.slots
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.status === "done" && s.url);
      if (done.length < 2) return;
      const current = guestEdit ? guestEdit.index : lightbox?.index ?? 0;
      const pos = done.findIndex(({ i }) => i === current);
      const next = done[(pos + dir + done.length) % done.length];
      resetEditNotes();
      if (lightbox) {
        setLightbox({ batchId: lightbox.batchId, index: next.i });
        return;
      }
      if (guestEdit) {
        setGuestEdit({ batch: guestEdit.batch, index: next.i });
      }
    },
    [guestEdit, lightbox, lightboxBatch, resetEditNotes],
  );

  const canStepLightbox =
    (lightboxBatch?.slots.filter((s) => s.status === "done" && s.url).length || 0) > 1;

  // Outline + prompt → new batch grounded in this image and the mask.
  const handleRefine = useCallback(() => {
    if (!lightboxBatch || !lightboxUrl) return;
    const note = remarks.trim();
    if (!note) return;

    const concept =
      String(lightboxBatch.concept || "").trim() ||
      String(lightboxBatch.label || "").trim() ||
      "the reference image";

    const maskImage = maskRef.current?.exportLuma() || undefined;
    const combined = buildEditPrompt({
      concept,
      notes: note,
      hasMask: Boolean(maskImage),
    });

    resetEditNotes();
    setLightbox(null);
    setGuestEdit(null);
    startBatch({
      label: note,
      prompt: combined,
      concept,
      kind: "refine",
      referenceUrls: [lightboxUrl],
      maskImage,
      aspectRatio: lightboxBatch.aspectRatio,
    });
  }, [lightboxBatch, lightboxUrl, remarks, startBatch, resetEditNotes]);

  const saveLightboxImage = useCallback(async () => {
    // Only the open lightbox slot — never the rest of the batch.
    if (!lightboxUrl || !onSaveImage || !lightboxBatch || !lightboxSlot) return;
    if (lightboxSlot.status !== "done" || !lightboxSlot.url) return;
    const url = lightboxSlot.url;
    if (savingUrl === url || savedFlash.has(url) || savedUrls?.has(url)) return;

    setSavingUrl(url);
    try {
      const result = await onSaveImage(
        url,
        // Short concept/label only — full batch prompt is shared by all 4 slots.
        lightboxBatch.concept || lightboxBatch.label,
        {
          storagePath: lightboxSlot.storagePath,
        },
      );
      if (result === false) return;
      setSavedFlash((p) => new Set(p).add(url));
    } finally {
      setSavingUrl((cur) => (cur === url ? null : cur));
    }
  }, [
    lightboxUrl,
    lightboxBatch,
    lightboxSlot,
    onSaveImage,
    savingUrl,
    savedFlash,
    savedUrls,
  ]);

  const handleSave = useCallback(() => {
    void saveLightboxImage();
  }, [saveLightboxImage]);

  useEffect(() => {
    if (!downloadOpen) return;
    const onDown = (e: MouseEvent) => {
      if (downloadMenuRef.current?.contains(e.target as Node)) return;
      setDownloadOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setDownloadOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [downloadOpen]);

  const handleDownloadAs = useCallback(
    (format: ImagineDownloadFormat) => {
      const url = lightboxUrl;
      if (!url || downloading) return;
      const picked = saveImagineDownloadFormat(format);
      setDownloadFormat(picked);
      setDownloadOpen(false);
      setDownloading(true);
      void (async () => {
        try {
          let source: Blob;
          if (isDeviceLocalUrl(url)) {
            const read = await deviceLocalUrlToDataUrl(url, "download");
            if (!read) throw new Error("read");
            const res = await fetch(read.dataUrl);
            if (!res.ok) throw new Error("read");
            source = await res.blob();
          } else {
            const res = await fetch(url);
            if (!res.ok) throw new Error("fetch");
            source = await res.blob();
          }
          const encoded = await encodeImageToFormat(source, picked);
          const label = lightboxBatch?.concept || lightboxBatch?.label || "lykn-image";
          const name = imagineDownloadFilename(label, picked);
          const filters = imagineDownloadFilters(picked);
          if (canSaveFileAs()) {
            const saved = await saveFileToChosenFolder(encoded, name, encoded.type, { filters });
            if (saved) {
              toast({ title: "Saved", description: saved });
            }
            return;
          }
          await downloadToComputer(encoded, name, encoded.type);
          toast({ title: "Downloaded", description: name });
        } catch {
          toast({
            title: "Couldn't download this",
            description: "The image couldn't be written. Try again in a moment.",
            variant: "destructive",
          });
        } finally {
          setDownloading(false);
        }
      })();
    },
    [downloading, lightboxBatch, lightboxUrl],
  );

  const isSaved = !!lightboxUrl && (savedUrls?.has(lightboxUrl) || savedFlash.has(lightboxUrl));
  const isSaving = !!lightboxUrl && savingUrl === lightboxUrl;

  const canRefine = remarks.trim().length > 0;

  /* ---------- render ---------- */

  const empty = sharedThread
    ? !hasThread && !anyLoading
    : batches.length === 0;
  // Shared-thread Imagine writes the 4-up into the transcript so a new
  // prompt can collapse prior batches. The floating overlay would sit on
  // top of that turn and eat the space those collapses just made.
  const overlayBatches: ImagineBatch[] = [];
  const showShowcase = empty && !imagineUsed;

  // Bottom showcase: three slots at a time, advance by three so the whole
  // row rotates to a fresh set (landing-page Imagine collage cadence).
  const [showcaseTick, setShowcaseTick] = useState(0);
  useEffect(() => {
    if (!showShowcase) return;
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch {
      /* ignore */
    }
    const id = window.setInterval(
      () => setShowcaseTick((t) => t + 3),
      SHOWCASE_ROTATE_MS,
    );
    return () => window.clearInterval(id);
  }, [showShowcase]);
  const showcaseN = SHOWCASE_IMAGES.length;

  const activeLayout =
    IMAGE_LAYOUT_OPTIONS.find((o) => o.value === aspect) || IMAGE_LAYOUT_OPTIONS[0];
  const ActiveLayoutIcon = activeLayout.icon;
  const barTall = promptTall || attachments.length > 0;
  // Appearance › Chat bar shape. This bar is the desktop pill in another mode,
  // so it wears the same class and answers the same choice — including Slate,
  // which is a two-row layout rather than a radius.
  const slate = useAppearance().chatBarShape === "slate";

  useLayoutEffect(() => {
    if (!addOpen && !layoutMenuOpen) return;
    const place = () => {
      if (addOpen) {
        setAddPos(barMenuOffset(menuWrapRef.current, addRef.current, addPanelRef.current));
      }
      if (layoutMenuOpen) {
        setLayoutPos(
          barMenuOffset(menuWrapRef.current, layoutRef.current, layoutPanelRef.current),
        );
      }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [addOpen, layoutMenuOpen, slate, barTall]);

  const addButton = (
    <div ref={addRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setLayoutMenuOpen(false);
          setAddOpen((o) => !o);
        }}
        title="Add from Vault or Finder"
        aria-label="Add from Vault or Finder"
        aria-expanded={addOpen}
        className={`${ICON_BTN} ${
          addOpen ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white/90" : ""
        }`}
      >
        {ingesting || dropping ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
      </button>
    </div>
  );

  const finderInput = (
    <input
      id={finderInputId}
      ref={fileInputRef}
      type="file"
      accept={IMAGINE_FILE_ACCEPT}
      multiple
      className="pointer-events-none absolute h-px w-px opacity-0"
      onChange={(e) => {
        void handlePickFiles(e.target.files);
        e.target.value = "";
        setAddOpen(false);
      }}
    />
  );

  const field = (
    <textarea
      ref={inputRef}
      value={prompt}
      onChange={(e) => setPrompt(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      }}
      rows={1}
      placeholder="Describe the image you want…"
      // flex-auto, not flex-1: the auto-grown height is the flex basis, so the
      // field fills the tall Slate shell and then pushes it taller. flex-1
      // would zero that basis and leave the bar stuck at its minimum.
      className={`min-w-0 resize-none bg-transparent py-1 text-black/85 outline-none ring-0 placeholder:text-black/40 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 dark:text-white/90 dark:placeholder:text-white/40 ${
        slate ? "w-full flex-auto px-2 text-[0.92rem]" : "flex-1 self-center text-[0.85rem]"
      }`}
    />
  );

  const layoutButton = (
    <div ref={layoutRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setAddOpen(false);
          setLayoutMenuOpen((o) => !o);
        }}
        title="Image layout"
        aria-label="Image layout"
        aria-expanded={layoutMenuOpen}
        className={`flex h-8 max-w-[8.25rem] items-center gap-1 rounded-full px-2 text-[0.68rem] font-medium transition-colors ${
          layoutMenuOpen
            ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white/90"
            : "text-black/60 hover:bg-black/10 hover:text-black/85 dark:text-white/65 dark:hover:bg-white/15 dark:hover:text-white/90"
        }`}
      >
        <ActiveLayoutIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="truncate">{activeLayout.shortLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-40" />
      </button>
    </div>
  );

  const sendButton = (
    <button
      type="button"
      onClick={handleSend}
      disabled={!prompt.trim()}
      title="Generate 4 images"
      aria-label="Generate 4 images"
      className={SEND_BTN}
    >
      {anyLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <ChatSendIcon className="h-4 w-4" />
      )}
    </button>
  );

  // Shared prompt bar — the desktop's rounded chat pill, with a layout menu
  // where normal chat puts its research sources. Sits under the header on the
  // empty page, then docks to the bottom once batches exist.
  const promptBar = (
    <div className="lykn-imagine-prompt-bar pointer-events-none w-full">
      {quotaNote ? (
        <p className="mb-1.5 text-center text-[11px] text-black/40 dark:text-white/40">{quotaNote}</p>
      ) : null}
      {/* The pill blurs its own backdrop, so it is a backdrop root: a popover
          nested inside it would have nothing to blur and would render flat.
          The layout menu is therefore a sibling of the bar, not a child. */}
      <div
        ref={menuWrapRef}
        className="pointer-events-none relative mx-auto flex w-full max-w-xl justify-center"
      >
        <div
          ref={barDrop.ref}
          onDragOver={(e) => {
            if (!e.dataTransfer?.types?.includes("Files")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropping(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDropping(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer?.files?.length) return;
            e.preventDefault();
            setDropping(false);
            void handlePickFiles(e.dataTransfer.files);
          }}
          className={`lykn-home-chat-bar pointer-events-auto relative flex w-full flex-col ${BAR_SURFACE} ${
            slate
              ? "min-h-[6.5rem] gap-1.5 rounded-[28px] p-2.5"
              : barTall
                ? "gap-1 rounded-[1.6rem] py-2 pl-1.5 pr-1.5"
                : "rounded-full py-1.5 pl-1.5 pr-1.5"
          } ${dropping || barDrop.hot ? "ring-2 ring-blue-400/60" : ""}`}
        >
          {finderInput}
          {attachments.length > 0 ? (
            <div className="flex max-h-32 flex-wrap items-end gap-1.5 overflow-y-auto px-1.5 pt-0.5">
              {attachments.map((a) => {
                const remove = (
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:bg-black/75 group-hover:opacity-100"
                    title="Remove"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                );
                if (a.kind === "image") {
                  return (
                    <span
                      key={a.id}
                      className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-black/10"
                    >
                      <img
                        src={a.dataUrl}
                        alt={a.name}
                        draggable={false}
                        className="h-full w-full object-cover"
                      />
                      <span className="absolute right-0.5 top-0.5">{remove}</span>
                    </span>
                  );
                }
                // Documents and folders have no pixels to preview — they read
                // as a named chip so it's clear the model gets their text.
                const isFolder = !/\.[a-z0-9]{1,5}$/i.test(a.name);
                return (
                  <span
                    key={a.id}
                    className="group flex h-14 shrink-0 items-center gap-2 rounded-xl bg-black/10 px-2.5 dark:bg-white/10"
                    title={a.name}
                  >
                    {isFolder ? (
                      <FolderIcon className="h-4 w-4 shrink-0 opacity-60" />
                    ) : (
                      <FileText className="h-4 w-4 shrink-0 opacity-60" />
                    )}
                    <span className="max-w-[7rem] truncate text-[0.7rem] text-black/70 dark:text-white/75">
                      {a.name}
                    </span>
                    {remove}
                  </span>
                );
              })}
            </div>
          ) : null}
          {slate ? (
            <>
              {field}
              {/* Controls along the bottom: what shapes the prompt on the left,
                  what acts on it on the right — same split as the chat pill. */}
              <div className="flex w-full items-center gap-1.5 px-0.5">
                {addButton}
                {layoutButton}
                <span className="flex-1" />
                {sendButton}
              </div>
            </>
          ) : (
            <div className="flex w-full items-center gap-1.5">
              {addButton}
              {field}
              {layoutButton}
              {sendButton}
            </div>
          )}
        </div>

        {addOpen && (
          <div
            ref={addPanelRef}
            style={addPos}
            className={`pointer-events-auto absolute z-40 w-48 rounded-[14px] p-1.5 ${BAR_SURFACE}`}
          >
            <button
              type="button"
              onClick={openAddVault}
              className="lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] text-black/70 dark:text-white/75"
            >
              <Library className="h-3.5 w-3.5 shrink-0 opacity-70" />
              Vault
            </button>
            <label
              htmlFor={finderInputId}
              className="lg-menu-row relative flex w-full cursor-pointer items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] text-black/70 dark:text-white/75"
              onClick={(e) => {
                if (typeof (window as any).lykn?.pickOpenFiles === "function") {
                  e.preventDefault();
                  openAddFinder();
                }
              }}
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0 opacity-70" />
              Finder
            </label>
          </div>
        )}

        {layoutMenuOpen && (
          <div
            ref={layoutPanelRef}
            style={layoutPos}
            className={`pointer-events-auto absolute z-40 w-52 rounded-[14px] p-1.5 ${BAR_SURFACE}`}
          >
            {IMAGE_LAYOUT_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const on = opt.value === aspect;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-active={on || undefined}
                  onClick={() => {
                    setAspect(saveImagineAspect(opt.value));
                    setLayoutMenuOpen(false);
                  }}
                  className={`lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] ${
                    on ? "font-medium text-black dark:text-white" : "text-black/70 dark:text-white/75"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  const showcaseRow = (
    <div className="lykn-imagine-showcase pointer-events-none absolute inset-x-0 bottom-12 mx-auto w-full max-w-4xl px-6 sm:bottom-14">
      <div className="pointer-events-auto flex gap-3">
        {[0, 1, 2].map((offset) => (
          <ImagineShowcaseSlot
            key={offset}
            active={(showcaseTick + offset) % showcaseN}
            delayMs={offset * 140}
            onPick={(src, name) => void attachShowcase(src, name)}
          />
        ))}
      </div>
    </div>
  );

  const overlayGrid = (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 z-[1] mx-auto w-full max-w-2xl px-4">
      <div className="space-y-4">
        {overlayBatches.map((b) => (
          <div key={b.id} className="pointer-events-auto">
            <div className="mt-1 px-4 py-3">
              <div className={`grid gap-2 ${b.slots.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                {b.slots.map((s, i) => (
                  <div
                    key={s.id}
                    className="group/img relative overflow-hidden rounded-xl bg-black/[0.04] dark:bg-white/[0.05]"
                    style={{ aspectRatio: cssAspect(b.aspectRatio) }}
                  >
                    {s.status === "done" && s.url ? (
                      <button
                        type="button"
                        onClick={() => openLightbox(b.id, i)}
                        className="block w-full cursor-zoom-in"
                        title="Open to edit"
                      >
                        <GeneratedImage
                          src={s.url}
                          alt={b.label}
                          className="w-full object-cover"
                          style={{ aspectRatio: cssAspect(b.aspectRatio) }}
                          loading="lazy"
                        />
                      </button>
                    ) : s.status === "error" ? (
                      <button
                        type="button"
                        onClick={() => retrySlot(b, s)}
                        className="flex h-full w-full flex-col items-center justify-center gap-2 text-black/45 transition-colors hover:text-black/70 dark:text-white/45 dark:hover:text-white/75"
                        title="Retry"
                      >
                        <RefreshCw className="h-4 w-4" />
                        <span className="px-3 text-center text-[11px] leading-snug">{s.error}</span>
                      </button>
                    ) : (
                      <div className="lykn-imagine-shimmer absolute inset-0" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div
      className={`lykn-imagine-root pointer-events-none absolute inset-0 ${
        sharedThread ? "z-[70]" : "flex flex-col"
      } ${sharedThread && !visible ? "hidden" : ""}`}
    >
      {sharedThread ? (
        <>
          {visible && showShowcase ? showcaseRow : null}
          {visible && overlayBatches.length > 0 ? overlayGrid : null}
        </>
      ) : empty ? (
        // Same empty-page stack as Chat / Build: headline + bar centered as a
        // unit. Showcase tiles are out of flow so they cannot raise the bar.
        // The full-screen frames stay click-through so desktop icons remain live.
        <div className="pointer-events-none relative flex flex-1 flex-col overflow-hidden">
          <div className="lykn-imagine-empty pointer-events-none relative flex min-h-0 flex-1 justify-center overflow-hidden px-4 py-4">
            <div className="lykn-imagine-stack pointer-events-none mx-auto my-auto flex w-full max-w-2xl flex-col gap-8 sm:gap-10">
              <div className="lykn-imagine-hero pointer-events-none space-y-2.5 text-center">
                <p className="text-xl font-semibold tracking-tight text-black dark:text-white sm:text-3xl">
                  Generate any image
                </p>
                <p className="mx-auto max-w-lg text-[13px] leading-relaxed text-black/55 dark:text-white/50 sm:text-sm">
                  Describe any image and LYKN generates a set of variations you can refine.
                </p>
              </div>
              <div className="lykn-imagine-empty-bar pointer-events-none">{promptBar}</div>
            </div>
          </div>
          {showShowcase ? showcaseRow : null}
        </div>
      ) : (
        <>
          {/* pb-40's worth of clearance for the docked bar, plus whatever a
              taller shape adds — it grows up off a fixed bottom edge, so all
              of the extra height eats into the batches rather than half. */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center"
            style={{ top: "var(--header-height-sm, 4.2rem)" }}
          >
          <div
            ref={scrollRef}
            className="lykn-chat-ink pointer-events-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 pt-6 scrollbar-hide"
            style={{ paddingBottom: "calc(10rem + 2 * var(--lykn-home-bar-grow))" }}
          >
              <div className="space-y-4">
              {batches.map((b) => (
                <React.Fragment key={b.id}>
                  <ImagineUserPrompt
                    text={b.label}
                    referenceUrls={b.referenceUrls}
                    expanded={expandedPrompts.has(b.id)}
                    onToggleExpand={() =>
                      setExpandedPrompts((prev) => {
                        const next = new Set(prev);
                        if (next.has(b.id)) next.delete(b.id);
                        else next.add(b.id);
                        return next;
                      })
                    }
                  />
                  <div className="w-full">
                    <div className="h-6" aria-hidden />
                    <div className="mt-1 px-4 py-3">
                    <div className={`grid gap-2 ${b.slots.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                    {b.slots.map((s, i) => (
                      <div
                        key={s.id}
                        className="group/img relative overflow-hidden rounded-xl bg-black/[0.04] dark:bg-white/[0.05]"
                        style={{ aspectRatio: cssAspect(b.aspectRatio) }}
                      >
                        {s.status === "done" && s.url ? (
                          <button
                            type="button"
                            onClick={() => openLightbox(b.id, i)}
                            className="block w-full cursor-zoom-in"
                            title="Open to edit"
                          >
                            <GeneratedImage
                              src={s.url}
                              alt={b.label}
                              className="w-full object-cover"
                              style={{ aspectRatio: cssAspect(b.aspectRatio) }}
                              loading="lazy"
                            />
                          </button>
                        ) : s.status === "error" ? (
                          <button
                            type="button"
                            onClick={() => retrySlot(b, s)}
                            className="flex h-full w-full flex-col items-center justify-center gap-2 text-black/45 transition-colors hover:text-black/70 dark:text-white/45 dark:hover:text-white/75"
                            title="Retry"
                          >
                            <RefreshCw className="h-4 w-4" />
                            <span className="px-3 text-center text-[11px] leading-snug">{s.error}</span>
                          </button>
                        ) : (
                          <div className="lykn-imagine-shimmer absolute inset-0" />
                        )}
                      </div>
                    ))}
                    </div>
                    </div>
                  </div>
                </React.Fragment>
              ))}
              </div>
          </div>
          </div>

          {/* Prompt bar docks to the bottom once the first batch starts. */}
          <div className="lykn-imagine-dock pointer-events-none absolute inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-5">
            <div className="pointer-events-none w-full max-w-2xl">{promptBar}</div>
          </div>
        </>
      )}

      <LyknMediaPop
        open={!!(lightboxBatch && lightboxUrl && (lightbox || guestEdit))}
        onClose={closeLightbox}
        title={lightboxBatch?.label}
        hint={
          <span className="flex items-center gap-2">
            <PenLine className="h-3.5 w-3.5 opacity-60" />
            <span className="text-[11px] font-medium text-black/55 dark:text-white/60">
              Click dots or drag to outline
            </span>
          </span>
        }
        onPrev={canStepLightbox ? () => stepLightbox(-1) : undefined}
        onNext={canStepLightbox ? () => stepLightbox(1) : undefined}
        topBar={
          lightboxUrl ? (
            <>
              <div ref={downloadMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setDownloadOpen((v) => !v)}
                  disabled={downloading}
                  className={`flex h-9 w-9 items-center justify-center rounded-full ${MEDIA_POP_PANEL} disabled:opacity-40`}
                  title="Download"
                  aria-label="Download"
                  aria-haspopup="menu"
                  aria-expanded={downloadOpen}
                >
                  {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                </button>
                {downloadOpen ? (
                  <div
                    role="menu"
                    className={`absolute right-0 top-full z-30 mt-2 w-44 rounded-[14px] p-1.5 ${MEDIA_POP_PANEL}`}
                  >
                    <p className="px-2.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">
                      Save as
                    </p>
                    {IMAGINE_DOWNLOAD_FORMATS.map((opt) => {
                      const on = opt.id === downloadFormat;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="menuitem"
                          onClick={() => handleDownloadAs(opt.id)}
                          className={`flex w-full items-center justify-between gap-2 rounded-[0.5rem] px-2.5 py-1.5 text-left text-[0.75rem] ${
                            on ? "font-medium text-black dark:text-white" : "text-black/70 dark:text-white/75"
                          }`}
                        >
                          <span>{opt.label}</span>
                          <span className="text-[10px] font-normal text-black/40 dark:text-white/40">
                            {opt.hint}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              {onSaveImage ? (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaved || isSaving}
                  className={`flex h-9 w-9 items-center justify-center rounded-full ${MEDIA_POP_PANEL} ${
                    isSaved ? "text-emerald-700 dark:text-emerald-300" : ""
                  }`}
                  title={isSaved ? "Saved" : isSaving ? "Saving…" : "Save this image only"}
                  aria-label={isSaved ? "Saved" : "Save"}
                >
                  {isSaved ? <Check className="h-4 w-4" /> : isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bookmark className="h-4 w-4" />}
                </button>
              ) : null}
            </>
          ) : null
        }
        footer={
          lightboxUrl ? (
            <div className="mx-auto w-full max-w-xl">
              <div
                className={`lykn-home-chat-bar flex w-full flex-col ${BAR_SURFACE} ${
                  slate
                    ? "min-h-[6.5rem] gap-1.5 rounded-[28px] p-2.5"
                    : remarksTall
                      ? "gap-1 rounded-[1.6rem] py-2 pl-1.5 pr-1.5"
                      : "rounded-full py-1.5 pl-1.5 pr-1.5"
                }`}
              >
                {slate ? (
                  <>
                    <textarea
                      ref={remarksRef}
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleRefine();
                        }
                      }}
                      rows={1}
                      placeholder={hasMask ? "Describe the change..." : "Describe the edit or outline a region first"}
                      className="lykn-home-chat-bar-input min-w-0 w-full flex-auto resize-none bg-transparent px-2 py-1 text-[0.92rem] text-black/85 outline-none ring-0 placeholder:text-black/40 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 dark:text-white/90 dark:placeholder:text-white/40"
                    />
                    <div className="flex w-full items-center gap-1.5 px-0.5">
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={handleRefine}
                        disabled={!canRefine}
                        className={SEND_BTN}
                        title="Apply edit"
                        aria-label="Apply edit"
                      >
                        <ChatSendIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex w-full items-center gap-1.5">
                    <textarea
                      ref={remarksRef}
                      value={remarks}
                      onChange={(e) => setRemarks(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleRefine();
                        }
                      }}
                      rows={1}
                      placeholder={hasMask ? "Describe the change..." : "Describe the edit or outline a region first"}
                      className="lykn-home-chat-bar-input min-w-0 flex-1 self-center resize-none bg-transparent py-1 text-[0.85rem] text-black/85 outline-none ring-0 placeholder:text-black/40 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 dark:text-white/90 dark:placeholder:text-white/40"
                    />
                    <button
                      type="button"
                      onClick={handleRefine}
                      disabled={!canRefine}
                      className={SEND_BTN}
                      title="Apply edit"
                      aria-label="Apply edit"
                    >
                      <ChatSendIcon className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : null
        }
      >
        {lightboxUrl && lightboxBatch ? (
          <ImagineMaskCanvas
            key={lightboxUrl}
            ref={maskRef}
            src={lightboxUrl}
            alt={lightboxBatch.label}
            onMaskChange={setHasMask}
          />
        ) : null}
      </LyknMediaPop>
    </div>
  );
});

StudioImagineMode.displayName = "StudioImagineMode";

export default StudioImagineMode;
