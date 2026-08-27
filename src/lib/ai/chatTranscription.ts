import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";

// ============================================================================
// chatTranscription — attachment / YouTube transcription + grounding
// ============================================================================
// The transcription + media-grounding phases of the chat send pipeline.
// orchestrateChatSend calls these in the same order as always:
// transcribeAttachments → fetchYouTubeGrounding, after buildAttachmentContext
// and before request-body construction.
//
// LOAD-BEARING CONTRACTS — do not "improve" these:
//   • Attachments are mutated IN PLACE (`att.transcript = …`). The engine's
//     optimistic user message holds the SAME objects, so shared identity is
//     how transcripts become visible to later turns. Never clone/copy here.
//   • The send-level AbortController is shared. fetchYouTubeGrounding's 120s
//     timers abort the WHOLE send on timeout (not just transcription).
//   • Failures are swallowed and the send continues without a transcript.
//   • Status strings/timing are UI-visible; keep them exactly as-is.

/** One cached full-transcript fetch, keyed by videoId in the engine's
 *  per-session cache so repeat questions about the same video skip the
 *  network round-trip. */
export type CachedYouTubeTranscript = {
  fetchedAt: number;
  title: string;
  url: string;
  transcript: string;
  segments: Array<{ startSec: number; endSec: number; text: string }>;
  source?: string;
};

/* ------------------------------------------------------------------ */
/*  Shared caption → Whisper retry policy                              */
/* ------------------------------------------------------------------ */

/**
 * Fetch a YouTube transcript, retrying once with `retryWhisper=1` when the
 * server could only return the video description (`source:
 * "description_fallback"`). Both transcription flows (per-attachment and
 * send-level grounding) share this policy so caption→Whisper fallback
 * behavior can never drift between them again.
 *
 * The flows intentionally differ in two ways, surfaced as options:
 *   • `retryRequiresTranscript` — the attachment flow only retries when the
 *     first response actually carried description text; grounding retries on
 *     the fallback source alone.
 *   • `timeoutMs`/`onTimeout` — grounding arms a hard timer around each fetch
 *     that aborts the WHOLE send; the attachment flow has no timer.
 *
 * Network errors are swallowed (res → null) so callers always get a result
 * object; a failed fetch just means no transcript.
 */
export async function fetchYouTubeTranscriptWithWhisperRetry(opts: {
  apiBase: string;
  videoId: string;
  signal: AbortSignal;
  /** Fired just before the Whisper retry — callers show different copy. */
  onRetryStatus?: () => void;
  /** Only retry when the first response carried a non-empty transcript. */
  retryRequiresTranscript?: boolean;
  timeoutMs?: number;
  onTimeout?: () => void;
}): Promise<{ json: any; source: string; whisperAttempted: boolean }> {
  const { apiBase, videoId, signal } = opts;
  const arm = () =>
    opts.timeoutMs
      ? setTimeout(() => { if (!signal.aborted) opts.onTimeout?.(); }, opts.timeoutMs)
      : null;

  let timer = arm();
  const res = await fetch(
    `${apiBase}/api/youtube/transcript?id=${encodeURIComponent(videoId)}`,
    { signal },
  ).catch(() => null);
  if (timer) clearTimeout(timer);

  let json: any = res && res.ok ? await res.json().catch(() => ({})) : {};
  let source = String(json?.source || "").toLowerCase();
  let whisperAttempted = Boolean(json?.whisperAttempted);
  const firstTranscript = String(json?.transcript || "").trim();

  const shouldRetry =
    source === "description_fallback" &&
    !signal.aborted &&
    (!opts.retryRequiresTranscript || Boolean(firstTranscript));
  if (shouldRetry) {
    opts.onRetryStatus?.();
    timer = arm();
    const retryRes = await fetch(
      `${apiBase}/api/youtube/transcript?id=${encodeURIComponent(videoId)}&retryWhisper=1`,
      { signal },
    ).catch(() => null);
    if (timer) clearTimeout(timer);
    if (retryRes && retryRes.ok) {
      const retryJson: any = await retryRes.json().catch(() => ({}));
      const retrySource = String(retryJson?.source || "").toLowerCase();
      whisperAttempted = whisperAttempted || Boolean(retryJson?.whisperAttempted);
      if (retrySource !== "description_fallback" && String(retryJson?.transcript || "").trim()) {
        json = retryJson;
        source = retrySource;
      }
    }
  }

  return { json, source, whisperAttempted };
}

/* ------------------------------------------------------------------ */
/*  Phase 1: Transcribe attachments                                    */
/* ------------------------------------------------------------------ */

export async function transcribeAttachments(
  sentAttachments: FocusedChatAttachment[],
  apiBase: string,
  isBrickAction: boolean,
  signal: AbortSignal,
  onStatus: (s: string) => void,
): Promise<void> {
  for (const att of sentAttachments) {
    if (att.transcript) continue;
    const attType = (att.type || "").toLowerCase();

    if (attType === "youtube" && att.videoId) {
      try {
        if (signal.aborted) break;
        onStatus(isBrickAction ? "Transcribing video..." : "Fetching video transcript...");
        const { json, source } = await fetchYouTubeTranscriptWithWhisperRetry({
          apiBase,
          videoId: att.videoId,
          signal,
          onRetryStatus: () => onStatus("No captions, transcribing audio..."),
          retryRequiresTranscript: true,
        });
        const t = String(json?.transcript || "").trim();
        if (t && source === "description_fallback") {
          att.transcript = `[VIDEO DESCRIPTION — not a transcript of spoken audio]\n${t}`;
        } else if (t) {
          att.transcript = t;
        }
      } catch { /* continue without transcript */ }
      continue;
    }

    if (attType === "video" || attType === "audio") {
      try {
        onStatus(`Transcribing ${att.name || attType}...`);
        const formData = new FormData();
        if (att.rawFile) {
          formData.append("file", att.rawFile, att.name || "upload");
        } else if (att.url && (att.url.startsWith("data:video/") || att.url.startsWith("data:audio/"))) {
          const base64 = att.url.split(",")[1];
          if (base64) {
            const binaryStr = atob(base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const mimeType = att.mime || att.url.split(";")[0].split(":")[1] || "audio/webm";
            const ext = mimeType.split("/")[1] || "webm";
            formData.append("file", new Blob([bytes], { type: mimeType }), att.name || `upload.${ext}`);
          }
        } else if (att.url && att.url.startsWith("http")) {
          const blobResp = await fetch(att.url, { signal });
          if (blobResp.ok) {
            const blob = await blobResp.blob();
            const mimeType = att.mime || blob.type || (attType === "audio" ? "audio/webm" : "video/mp4");
            const ext = mimeType.split("/")[1] || (attType === "audio" ? "webm" : "mp4");
            formData.append("file", blob, att.name || `upload.${ext}`);
          }
        }
        if (formData.has("file") && !signal.aborted) {
          const wRes = await fetch(`${apiBase}/api/whisper/transcribe`, { method: "POST", body: formData, signal });
          if (wRes.ok) {
            const wData = await wRes.json();
            const t = String(wData?.transcript || "").trim();
            if (t) att.transcript = t;
          }
        }
      } catch { /* continue without transcript */ }
      continue;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Phase 2: YouTube grounding for attached videos                     */
/* ------------------------------------------------------------------ */

/**
 * Fetch the full transcript for the first YouTube video attached to this
 * turn (when the turn needs one) and build the grounding block the request
 * builder injects into the prompt. Successful fetches are written to the
 * per-session `transcriptCache` so later turns about the same video skip
 * the network.
 *
 * The 120s timers here abort the WHOLE send on timeout — that is the
 * long-standing contract, not a bug.
 */
export async function fetchYouTubeGrounding(args: {
  apiBase: string;
  /** The turn asks about a video (or is a brick action) — fetch in full. */
  needsFullTranscript: boolean;
  sentAttachments: FocusedChatAttachment[];
  abortController: AbortController;
  transcriptCache: Record<string, CachedYouTubeTranscript>;
  setChatStatusText: (s: string) => void;
}): Promise<{ youtubeGrounding: string; youtubeTranscriptSource: string }> {
  const { apiBase, needsFullTranscript, sentAttachments, abortController, transcriptCache, setChatStatusText } = args;
  const signal = abortController.signal;

  const attachedYouTubeVideos = sentAttachments
    .filter((a) => a.type?.toLowerCase() === "youtube" && a.videoId)
    .map((a) => ({ videoId: a.videoId!, url: a.url, title: a.name || `YouTube ${a.videoId}` }));
  const seen = new Set<string>();
  const allYouTubeVideos: Array<{ videoId: string; url: string; title: string }> = [];
  for (const v of attachedYouTubeVideos) {
    if (seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    allYouTubeVideos.push(v);
  }

  let youtubeGrounding = "";
  let youtubeTranscriptSource = "";

  if (needsFullTranscript && allYouTubeVideos.length > 0 && !signal.aborted) {
    const targetVideo = allYouTubeVideos[0];
    setChatStatusText("Fetching video transcript...");
    try {
      const { json: tJson, source: transcriptSource, whisperAttempted } =
        await fetchYouTubeTranscriptWithWhisperRetry({
          apiBase,
          videoId: targetVideo.videoId,
          signal,
          onRetryStatus: () => setChatStatusText("No captions found, transcribing video audio..."),
          timeoutMs: 120000,
          onTimeout: () => abortController.abort(),
        });

      youtubeTranscriptSource = transcriptSource;
      const fullTranscript = String(tJson?.transcript || "").trim();
      if (fullTranscript) {
        transcriptCache[targetVideo.videoId] = {
          fetchedAt: Date.now(),
          title: targetVideo.title || `YouTube ${targetVideo.videoId}`,
          url: targetVideo.url,
          transcript: fullTranscript,
          segments: Array.isArray(tJson?.segments) ? tJson.segments : [],
          source: transcriptSource,
        };
        const safeTranscript =
          fullTranscript.length > 12000
            ? fullTranscript.slice(0, 10000) + "\n...[transcript truncated — " + Math.round(fullTranscript.length / 1000) + "k total chars]"
            : fullTranscript;
        if (transcriptSource === "description_fallback") {
          const whisperNote = whisperAttempted
            ? "Audio transcription was attempted using Whisper speech-to-text but the audio could not be downloaded from YouTube."
            : "No audio transcription was attempted.";
          youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId}\n${whisperNote}\nVideo description (this is NOT a transcript of spoken audio — it is only the video's description/metadata):\n${safeTranscript}`;
          setChatStatusText("Transcription failed, only description available...");
        } else {
          youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId}\nFull transcript:\n${safeTranscript}`;
          setChatStatusText("Transcript ready, generating response...");
        }
      } else {
        const whisperNote = whisperAttempted ? " Audio transcription was attempted but failed." : "";
        setChatStatusText("No transcript available, answering from metadata...");
        youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId} (${targetVideo.url})\n(No transcript or description available.${whisperNote})`;
      }
    } catch {
      if (!signal.aborted) {
        setChatStatusText("Transcript fetch failed, answering from metadata...");
        youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId} (${targetVideo.url})\n(Transcript fetch failed)`;
      }
    }
  }

  return { youtubeGrounding, youtubeTranscriptSource };
}
