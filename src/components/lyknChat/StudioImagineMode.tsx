import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ImagePlus,
  Loader2,
  MapPin,
  RefreshCw,
  Shuffle,
  Sparkles,
  X as XIcon,
} from "lucide-react";
import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
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
 * slot pops in as its request finishes). Clicking an image opens an edit
 * space: the image is large and centered, with overall comments plus
 * click-to-flag region notes. Submitting generates a NEW batch grounded in
 * that image's pixels (images/edits path) — Midjourney's "vary + remix"
 * loop. All requests hit POST /api/ai/imagine-image — one image per call.
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

export const IMAGINE_BATCH_SIZE = 4;

type SlotStatus = "loading" | "done" | "error";

type ImagineSlot = {
  id: string;
  status: SlotStatus;
  url?: string;
  error?: string;
};

type BatchKind = "generate" | "refine" | "variations";

export type ImagineBatch = {
  id: string;
  /** What the user typed for this batch (prompt, or edit remarks). */
  label: string;
  /** Full prompt sent to the model. */
  prompt: string;
  kind: BatchKind;
  /** Pixel references: attached images and/or the generation being refined. */
  referenceUrls?: string[];
  aspectRatio: string;
  slots: ImagineSlot[];
  createdAt: number;
};

type ImagineAttachment = { id: string; dataUrl: string; name: string };

/** Region flag on the edit canvas — percent coords from the image top-left. */
type ImagePin = {
  id: string;
  x: number; // 0–100
  y: number; // 0–100
  note: string;
};

const ASPECT_OPTIONS = ["1:1", "3:2", "2:3", "16:9", "9:16"] as const;

/** Shared glass/neutral chrome for the edit space (matches Studio bars). */
const EDIT_PANEL =
  "border border-black/10 bg-white/80 text-black/85 shadow-lg backdrop-blur-2xl " +
  "dark:border-white/12 dark:bg-black/45 dark:text-white/90";
const EDIT_FIELD =
  "rounded-xl border border-black/10 bg-white/70 text-black/85 outline-none " +
  "placeholder:text-black/35 focus:border-black/25 " +
  "dark:border-white/15 dark:bg-white/[0.07] dark:text-white/90 " +
  "dark:placeholder:text-white/35 dark:focus:border-white/30";
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// Session-scoped batch memory keyed by chat id — survives pill flips
// (component unmounts) within the same Studio session. Not persisted.
const sessionBatches = new Map<string, ImagineBatch[]>();

/** Studio "New chat" while on the Imagine page — clears the canvas in place
 *  (Imagine sessions don't write chat turns, so a fresh chat row would
 *  change nothing visible). The mounted component listens and resets. */
export const IMAGINE_CLEAR_EVENT = "lykn-imagine-clear";

function newId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `im-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function authHeader(): Promise<Record<string, string>> {
  try {
    const session = (await supabase.auth.getSession())?.data?.session;
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
  } catch {
    return {};
  }
}

function friendlyError(err: string): string {
  const e = String(err || "");
  if (/quota|limit/i.test(e)) return "Monthly image limit reached";
  if (/moderation|safety/i.test(e)) return "Prompt was blocked — try rephrasing";
  if (/rate/i.test(e)) return "Too fast — wait a moment";
  return "Generation failed";
}

/** Aspect-ratio → CSS ratio for the grid cells ("3:2" → "3 / 2"). */
function cssAspect(ar: string): string {
  const m = /^(\d+):(\d+)$/.exec(ar);
  return m ? `${m[1]} / ${m[2]}` : "1 / 1";
}

export type StudioImagineModeProps = {
  /** Keys the session batch memory (per chat). */
  chatKey: string;
  /** Optional Save-to-vault for a generated image (url, prompt). */
  onSaveImage?: (url: string, prompt?: string) => void;
  savedUrls?: Set<string>;
};

export default function StudioImagineMode({ chatKey, onSaveImage, savedUrls }: StudioImagineModeProps) {
  const key = chatKey || "unkeyed";
  const [batches, setBatches] = useState<ImagineBatch[]>(() => sessionBatches.get(key) || []);
  const batchesRef = useRef(batches);
  batchesRef.current = batches;
  useEffect(() => {
    sessionBatches.set(key, batches);
  }, [key, batches]);
  // Chat switch: swap in that chat's session batches.
  useEffect(() => {
    setBatches(sessionBatches.get(key) || []);
  }, [key]);

  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<string>("1:1");
  const [quotaNote, setQuotaNote] = useState<string>("");
  const [attachments, setAttachments] = useState<ImagineAttachment[]>([]);
  // Edit space: batch + slot index. null = closed.
  const [lightbox, setLightbox] = useState<{ batchId: string; index: number } | null>(null);
  const [remarks, setRemarks] = useState("");
  /** Clicked region flags on the open image. */
  const [pins, setPins] = useState<ImagePin[]>([]);
  const [activePinId, setActivePinId] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<Set<string>>(new Set());

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const remarksRef = useRef<HTMLTextAreaElement | null>(null);
  const pinNoteRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageWrapRef = useRef<HTMLDivElement | null>(null);

  // Studio "New chat" while this page is up → wipe the canvas back to the
  // centered empty state.
  useEffect(() => {
    const onClear = () => {
      sessionBatches.delete(key);
      setBatches([]);
      setPrompt("");
      setAttachments([]);
      setLightbox(null);
      setRemarks("");
      setPins([]);
      setActivePinId(null);
    };
    window.addEventListener(IMAGINE_CLEAR_EVENT, onClear);
    return () => window.removeEventListener(IMAGINE_CLEAR_EVENT, onClear);
  }, [key]);

  const anyLoading = useMemo(
    () => batches.some((b) => b.slots.some((s) => s.status === "loading")),
    [batches],
  );

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
    async (batch: ImagineBatch, slot: ImagineSlot) => {
      try {
        const headers = { "Content-Type": "application/json", ...(await authHeader()) };
        const res = await fetch(`${API_BASE_URL}/api/ai/imagine-image`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            prompt: batch.prompt,
            aspectRatio: batch.aspectRatio === "1:1" ? undefined : batch.aspectRatio,
            referenceImages: batch.referenceUrls?.length ? batch.referenceUrls : undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok || !data.imageUrl) {
          patchSlot(batch.id, slot.id, {
            status: "error",
            error: friendlyError(data?.error || `http_${res.status}`),
          });
          return;
        }
        patchSlot(batch.id, slot.id, { status: "done", url: data.imageUrl });
        if (data.monthlyRemaining !== undefined && data.monthlyRemaining !== "unlimited") {
          setQuotaNote(`${data.monthlyRemaining} image${data.monthlyRemaining === 1 ? "" : "s"} left this month`);
        }
      } catch {
        patchSlot(batch.id, slot.id, { status: "error", error: "Network error" });
      }
    },
    [patchSlot],
  );

  const startBatch = useCallback(
    (opts: { label: string; prompt: string; kind: BatchKind; referenceUrls?: string[]; aspectRatio: string }) => {
      const batch: ImagineBatch = {
        id: newId(),
        label: opts.label,
        prompt: opts.prompt,
        kind: opts.kind,
        referenceUrls: opts.referenceUrls,
        aspectRatio: opts.aspectRatio,
        slots: Array.from({ length: IMAGINE_BATCH_SIZE }, () => ({
          id: newId(),
          status: "loading" as SlotStatus,
        })),
        createdAt: Date.now(),
      };
      setBatches((prev) => [...prev, batch]);
      // Fire all slots in parallel — each lands independently.
      for (const slot of batch.slots) void runSlot(batch, slot);
      window.setTimeout(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      }, 60);
    },
    [runSlot],
  );

  const handleSend = useCallback(() => {
    const text = prompt.trim();
    if (!text) return;
    const refs = attachments.map((a) => a.dataUrl);
    setPrompt("");
    setAttachments([]);
    startBatch({
      label: text,
      prompt: refs.length
        ? `${text}\n\nUse the attached reference image${refs.length > 1 ? "s" : ""} as the visual base.`
        : text,
      kind: "generate",
      referenceUrls: refs.length ? refs : undefined,
      aspectRatio: aspect,
    });
  }, [prompt, aspect, attachments, startBatch]);

  // "+" attachments — images ride as pixel references for the next batch.
  const handlePickFiles = useCallback((files: FileList | null) => {
    const list = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
    for (const file of list) {
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        if (!dataUrl.startsWith("data:image/")) return;
        setAttachments((prev) =>
          prev.length >= MAX_ATTACHMENTS
            ? prev
            : [...prev, { id: newId(), dataUrl, name: file.name }],
        );
      };
      reader.readAsDataURL(file);
    }
  }, []);

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
      setAttachments((prev) => {
        if (prev.some((a) => a.name === name)) return prev;
        if (prev.length >= MAX_ATTACHMENTS) return prev;
        return [...prev, { id: newId(), dataUrl, name }];
      });
      inputRef.current?.focus();
    } catch {
      /* ignore fetch/attach failures */
    }
  }, []);

  const retrySlot = useCallback(
    (batch: ImagineBatch, slot: ImagineSlot) => {
      patchSlot(batch.id, slot.id, { status: "loading", error: undefined });
      void runSlot(batch, slot);
    },
    [patchSlot, runSlot],
  );

  /* ---------- lightbox ---------- */

  const lightboxBatch = lightbox ? batches.find((b) => b.id === lightbox.batchId) || null : null;
  const lightboxSlot = lightboxBatch && lightbox ? lightboxBatch.slots[lightbox.index] : null;
  const lightboxUrl = lightboxSlot?.status === "done" ? lightboxSlot.url : undefined;

  const resetEditNotes = useCallback(() => {
    setRemarks("");
    setPins([]);
    setActivePinId(null);
  }, []);

  const openLightbox = useCallback(
    (batchId: string, index: number) => {
      setLightbox({ batchId, index });
      resetEditNotes();
      window.setTimeout(() => remarksRef.current?.focus(), 50);
    },
    [resetEditNotes],
  );

  const closeLightbox = useCallback(() => {
    setLightbox(null);
    resetEditNotes();
  }, [resetEditNotes]);

  const stepLightbox = useCallback(
    (dir: 1 | -1) => {
      if (!lightbox || !lightboxBatch) return;
      const done = lightboxBatch.slots
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.status === "done");
      if (done.length < 2) return;
      const pos = done.findIndex(({ i }) => i === lightbox.index);
      const next = done[(pos + dir + done.length) % done.length];
      resetEditNotes();
      setLightbox({ batchId: lightbox.batchId, index: next.i });
    },
    [lightbox, lightboxBatch, resetEditNotes],
  );

  const handleImageClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const wrap = imageWrapRef.current;
    const img = wrap?.querySelector("img");
    if (!img) return;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    if (x < 0 || x > 100 || y < 0 || y > 100) return;
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `pin-${Date.now()}`;
    const pin: ImagePin = { id, x, y, note: "" };
    setPins((prev) => [...prev, pin]);
    setActivePinId(id);
    window.setTimeout(() => pinNoteRef.current?.focus(), 40);
  }, []);

  const updatePinNote = useCallback((id: string, note: string) => {
    setPins((prev) => prev.map((p) => (p.id === id ? { ...p, note } : p)));
  }, []);

  const removePin = useCallback((id: string) => {
    setPins((prev) => prev.filter((p) => p.id !== id));
    setActivePinId((cur) => (cur === id ? null : cur));
  }, []);

  // Submit overall remarks + region flags → new batch grounded in this image.
  const handleRefine = useCallback(() => {
    if (!lightboxBatch || !lightboxUrl) return;
    const note = remarks.trim();
    const flagged = pins
      .map((p) => ({ ...p, note: p.note.trim() }))
      .filter((p) => p.note.length > 0);
    if (!note && !flagged.length) return;

    const regionBlock = flagged.length
      ? "\n\nRegion flags on the reference image (percent from top-left origin). " +
        "Apply each note to that area specifically:\n" +
        flagged
          .map(
            (p, i) =>
              `${i + 1}. Around (${Math.round(p.x)}% from left, ${Math.round(p.y)}% from top): ${p.note}`,
          )
          .join("\n")
      : "";

    const overallBlock = note
      ? `\n\nOverall edit notes (apply across the image): ${note}`
      : "";

    const combined =
      `${lightboxBatch.prompt}\n\n` +
      `Edit the reference image with the following directed changes. ` +
      `Keep everything else (subject, style, composition, lighting) intact unless a note asks otherwise.` +
      regionBlock +
      overallBlock;

    const label =
      note ||
      (flagged.length === 1 ? flagged[0].note : `${flagged.length} region edits`);

    resetEditNotes();
    setLightbox(null);
    startBatch({
      label,
      prompt: combined,
      kind: "refine",
      referenceUrls: [lightboxUrl],
      aspectRatio: lightboxBatch.aspectRatio,
    });
  }, [lightboxBatch, lightboxUrl, remarks, pins, startBatch, resetEditNotes]);

  // Midjourney "V" — variations of the selected image, no remarks needed.
  const handleVariations = useCallback(() => {
    if (!lightboxBatch || !lightboxUrl) return;
    setLightbox(null);
    startBatch({
      label: "Variations",
      prompt:
        `${lightboxBatch.prompt}\n\n` +
        "Create a fresh variation of the reference image: keep the subject, overall style and composition, but vary the details, pose, angle or background.",
      kind: "variations",
      referenceUrls: [lightboxUrl],
      aspectRatio: lightboxBatch.aspectRatio,
    });
  }, [lightboxBatch, lightboxUrl, startBatch]);

  const handleSave = useCallback(() => {
    if (!lightboxUrl || !onSaveImage || !lightboxBatch) return;
    onSaveImage(lightboxUrl, lightboxBatch.prompt);
    setSavedFlash((p) => new Set(p).add(lightboxUrl));
  }, [lightboxUrl, lightboxBatch, onSaveImage]);

  const isSaved = !!lightboxUrl && (savedUrls?.has(lightboxUrl) || savedFlash.has(lightboxUrl));

  const canRefine =
    remarks.trim().length > 0 || pins.some((p) => p.note.trim().length > 0);

  // Edit-space keyboard: Esc closes, arrows step (unless typing).
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeLightbox();
        return;
      }
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.key === "ArrowRight") stepLightbox(1);
      if (e.key === "ArrowLeft") stepLightbox(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, closeLightbox, stepLightbox]);

  /* ---------- render ---------- */

  const kindLabel = (b: ImagineBatch) =>
    b.kind === "refine" ? "Edit" : b.kind === "variations" ? "Variations" : null;

  const empty = batches.length === 0;

  // Bottom showcase: three slots at a time, advance by three so the whole
  // row rotates to a fresh set (landing-page Imagine collage cadence).
  const [showcaseTick, setShowcaseTick] = useState(0);
  useEffect(() => {
    if (!empty) return;
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
  }, [empty]);
  const showcaseN = SHOWCASE_IMAGES.length;

  // Shared prompt bar — sits under the header on the empty page (same stack
  // as Build / Research), then docks to the bottom once batches exist.
  const promptBar = (
    <div className="w-full">
      {quotaNote ? (
        <p className="mb-1.5 text-center text-[11px] text-black/40 dark:text-white/40">{quotaNote}</p>
      ) : null}
      <div className="flex flex-col gap-1.5 rounded-3xl border border-black/10 bg-white/70 p-2 shadow-xl backdrop-blur-2xl dark:border-white/15 dark:bg-black/40">
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-1.5 pt-1.5">
            {attachments.map((a) => (
              <div key={a.id} className="group relative">
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className="h-14 w-14 rounded-xl border border-black/10 object-cover dark:border-white/15"
                />
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/75 text-white opacity-0 shadow transition-opacity group-hover:opacity-100 dark:bg-white dark:text-black"
                  title="Remove"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-2 pl-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              handlePickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-full text-black/45 transition-colors hover:bg-black/[0.06] hover:text-black/75 dark:text-white/45 dark:hover:bg-white/[0.1] dark:hover:text-white/80"
            title="Add reference images"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
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
            className="max-h-32 min-h-[38px] flex-1 resize-none self-center bg-transparent py-2 text-[14px] text-black/85 outline-none placeholder:text-black/35 dark:text-white/90 dark:placeholder:text-white/35"
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="flex items-center gap-0.5 rounded-full bg-black/[0.05] p-0.5 dark:bg-white/[0.08]">
              {ASPECT_OPTIONS.map((ar) => (
                <button
                  key={ar}
                  type="button"
                  onClick={() => setAspect(ar)}
                  className={`rounded-full px-2 py-1 text-[10px] font-medium transition-colors ${
                    aspect === ar
                      ? "bg-black/80 text-white dark:bg-white dark:text-black"
                      : "text-black/45 hover:text-black/75 dark:text-white/45 dark:hover:text-white/80"
                  }`}
                  title={`Aspect ratio ${ar}`}
                >
                  {ar}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleSend}
              disabled={!prompt.trim()}
              className={`h-9 w-9 lykn-chat-neu-chat-send-btn flex items-center justify-center shrink-0 ${
                !prompt.trim()
                  ? "opacity-40 cursor-not-allowed"
                  : "text-blue-600 dark:text-blue-400"
              }`}
              title="Generate 4 images"
            >
              {anyLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.25} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="absolute inset-0 flex flex-col">
      {empty ? (
        // Centered header + chat bar. Three large rounded showcase tiles
        // sit above the bottom edge and fade-rotate through the pool.
        <div className="relative flex flex-1 flex-col overflow-hidden pt-16">
          {/* Center header + bar in the space ABOVE the showcase — never
              under it, so nothing needs to scroll on a normal viewport. */}
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 py-4">
            <div className="mx-auto w-full max-w-2xl translate-y-10 space-y-8 sm:translate-y-14 sm:space-y-10">
              <div className="pointer-events-none space-y-2.5 text-center">
                <p className="text-xl font-semibold tracking-tight text-black dark:text-white sm:text-3xl">
                  Generate any image
                </p>
                <p className="mx-auto max-w-lg text-[13px] leading-relaxed text-black/55 dark:text-white/50 sm:text-sm">
                  Describe any image and LYKN generates a set of variations you can refine.
                </p>
              </div>
              {promptBar}
            </div>
          </div>
          <div className="mx-auto mb-12 w-full max-w-4xl shrink-0 px-6 sm:mb-14">
            <div className="flex gap-3">
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
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-40 pt-16 scrollbar-hide">
            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-10">
              {batches.map((b) => (
                <div key={b.id} className="flex flex-col gap-2.5">
                  <div className="flex items-baseline gap-2 px-1">
                    {kindLabel(b) ? (
                      <span className="shrink-0 rounded-full border border-black/10 bg-black/[0.05] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black/55 dark:border-white/15 dark:bg-white/[0.08] dark:text-white/60">
                        {kindLabel(b)}
                      </span>
                    ) : null}
                    <p className="truncate text-[13px] text-black/60 dark:text-white/60" title={b.label}>
                      {b.label}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {b.slots.map((s, i) => (
                      <div
                        key={s.id}
                        className="relative overflow-hidden rounded-2xl border border-black/10 bg-black/[0.04] dark:border-white/12 dark:bg-white/[0.05]"
                        style={{ aspectRatio: cssAspect(b.aspectRatio) }}
                      >
                        {s.status === "done" && s.url ? (
                          <button
                            type="button"
                            onClick={() => openLightbox(b.id, i)}
                            className="group block h-full w-full cursor-zoom-in"
                            title="Open — write edit remarks"
                          >
                            <img
                              src={s.url}
                              alt={b.label}
                              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                              loading="lazy"
                            />
                            <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
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
              ))}
            </div>
          </div>

          {/* Prompt bar docks to the bottom once the first batch starts. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-5">
            <div className="pointer-events-auto w-full max-w-2xl">{promptBar}</div>
          </div>
        </>
      )}

      {/* Edit space — large centered image, overall notes + click-to-flag regions */}
      {lightbox && lightboxBatch && lightboxUrl ? (
        <div
          className="fixed inset-0 z-[110] flex flex-col"
          onClick={closeLightbox}
        >
          {/* Dense frosted veil — hides/blurs the studio behind edit mode.
              Extra layer because Electron vibrancy often weakens backdrop-filter. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[#e8e8e6]/95 backdrop-blur-3xl dark:bg-black/90 dark:backdrop-blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/20 dark:from-black/40 dark:via-black/20 dark:to-black/50"
          />

          {/* Top chrome */}
          <div
            className="relative z-20 flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-4 sm:px-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`flex items-center gap-2 rounded-full px-3 py-1.5 ${EDIT_PANEL}`}>
              <MapPin className="h-3.5 w-3.5 opacity-60" />
              <span className="text-[11px] font-medium text-black/55 dark:text-white/60">
                Click the image to flag a spot
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => stepLightbox(-1)}
                className={`flex h-9 w-9 items-center justify-center rounded-full ${EDIT_PANEL}`}
                title="Previous"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => stepLightbox(1)}
                className={`flex h-9 w-9 items-center justify-center rounded-full ${EDIT_PANEL}`}
                title="Next"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={closeLightbox}
                className={`flex h-9 w-9 items-center justify-center rounded-full ${EDIT_PANEL}`}
                title="Close"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Hero image — front and center */}
          <div
            className="relative z-20 flex min-h-0 flex-1 items-center justify-center px-4 py-2 sm:px-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              ref={imageWrapRef}
              className="relative max-h-full max-w-full cursor-crosshair"
              onClick={handleImageClick}
              title="Click to flag this part of the image"
            >
              <img
                src={lightboxUrl}
                alt={lightboxBatch.label}
                draggable={false}
                className="max-h-[min(68vh,720px)] w-auto max-w-[min(92vw,920px)] select-none rounded-2xl object-contain shadow-[0_24px_80px_rgba(0,0,0,0.28)] ring-1 ring-black/10 dark:ring-white/12"
              />
              {pins.map((pin, i) => {
                const active = pin.id === activePinId;
                // Flip the note bar to the left when the pin sits on the right half.
                const barOnLeft = pin.x > 58;
                return (
                  <div
                    key={pin.id}
                    className="absolute z-10"
                    style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActivePinId(pin.id);
                        window.setTimeout(() => pinNoteRef.current?.focus(), 40);
                      }}
                      className={`absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[11px] font-bold shadow-lg transition-transform ${
                        active
                          ? "scale-110 bg-black text-white ring-2 ring-white dark:bg-white dark:text-black dark:ring-black/40"
                          : "bg-white/95 text-black ring-1 ring-black/15 hover:scale-105 dark:bg-black/80 dark:text-white dark:ring-white/25"
                      }`}
                      title={pin.note || `Flag ${i + 1}`}
                    >
                      {i + 1}
                    </button>
                    {active ? (
                      <div
                        className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-full border border-black/10 bg-white px-1.5 py-1 shadow-lg dark:border-white/15 dark:bg-[#1c1c1e] ${
                          barOnLeft
                            ? "right-full mr-4"
                            : "left-full ml-4"
                        }`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          ref={pinNoteRef}
                          value={pin.note}
                          onChange={(e) => updatePinNote(pin.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              setActivePinId(null);
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              e.stopPropagation();
                              if (!pin.note.trim()) removePin(pin.id);
                              else setActivePinId(null);
                            }
                          }}
                          placeholder="Change this spot…"
                          className="w-[11rem] bg-transparent px-1.5 text-[12px] text-black/85 outline-none placeholder:text-black/35 dark:text-white/90 dark:placeholder:text-white/35 sm:w-[14rem]"
                        />
                        <button
                          type="button"
                          onClick={() => removePin(pin.id)}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-black/40 transition-colors hover:bg-black/[0.06] hover:text-black/70 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/85"
                          title="Remove flag"
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      </div>
                    ) : pin.note.trim() ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActivePinId(pin.id);
                          window.setTimeout(() => pinNoteRef.current?.focus(), 40);
                        }}
                        className={`absolute top-1/2 max-w-[9rem] -translate-y-1/2 truncate rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-medium text-black/70 shadow ring-1 ring-black/10 dark:bg-black/80 dark:text-white/75 dark:ring-white/15 ${
                          barOnLeft ? "right-full mr-3.5" : "left-full ml-3.5"
                        }`}
                        title={pin.note}
                      >
                        {pin.note}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Compact bottom bar — overall notes + actions */}
          <div
            className="relative z-20 mx-auto w-full max-w-2xl shrink-0 px-4 pb-5 pt-1 sm:px-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`flex items-end gap-2 rounded-2xl p-2.5 sm:p-3 ${EDIT_PANEL}`}>
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
                placeholder="Overall comments for the next batch…"
                className={`min-h-[40px] max-h-24 flex-1 resize-none px-3 py-2.5 text-[13px] leading-relaxed ${EDIT_FIELD}`}
              />
              <button
                type="button"
                onClick={handleVariations}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-black/10 text-black/60 transition-colors hover:bg-black/[0.05] dark:border-white/15 dark:text-white/70 dark:hover:bg-white/10"
                title="Variations"
              >
                <Shuffle className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={handleRefine}
                disabled={!canRefine}
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-black/90 px-3.5 text-[12px] font-semibold text-white transition-opacity disabled:opacity-30 dark:bg-white dark:text-black"
                title="Generate edited batch"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Generate</span>
              </button>
              <a
                href={lightboxUrl}
                download
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-black/45 transition-colors hover:bg-black/[0.05] hover:text-black/75 dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white/85"
                title="Download"
              >
                <Download className="h-4 w-4" />
              </a>
              {onSaveImage ? (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaved}
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                    isSaved
                      ? "text-emerald-700 dark:text-emerald-300"
                      : "text-black/45 hover:bg-black/[0.05] hover:text-black/75 dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white/85"
                  }`}
                  title={isSaved ? "Saved" : "Save"}
                >
                  {isSaved ? <Check className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
