import { extractYouTubeVideoId } from "@/lib/media/youtube";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";
import type { ChatSendParams } from "@/lib/ai/chatSendOrchestrator";

// ============================================================================
// chatTranscription — attachment / YouTube / uploaded-media transcription
// ============================================================================
// The transcription + media-grounding phases of the chat send pipeline,
// extracted VERBATIM from chatSendOrchestrator.ts (Wave 3B decomposition,
// see docs/REFACTOR_LOG.md). orchestrateChatSend calls these in the same
// order as before: transcribeAttachments → fetchYouTubeGrounding →
// transcribeUploadedVideos, after buildAttachmentContext and before
// request-body construction.
//
// LOAD-BEARING CONTRACTS — do not "improve" these:
//   • Attachments are mutated IN PLACE (`att.transcript = …`). The engine's
//     optimistic user message holds the SAME objects, so shared identity is
//     how transcripts become visible to later turns. Never clone/copy here.
//   • The send-level AbortController is shared. fetchYouTubeGrounding's 120s
//     timers abort the WHOLE send on timeout (not just transcription).
//   • Failures are swallowed and the send continues without a transcript.
//   • Status strings/timing are UI-visible; keep them exactly as-is.

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
        const attTimeout = setTimeout(() => { /* caller owns abort */ }, 120000);
        const tRes = await fetch(`${apiBase}/api/youtube/transcript?id=${encodeURIComponent(att.videoId)}`, { signal });
        clearTimeout(attTimeout);
        if (tRes.ok) {
          const tData = await tRes.json() as any;
          const t = String(tData?.transcript || "").trim();
          const tSource = String(tData?.source || "").toLowerCase();
          if (t && tSource === "description_fallback") {
            if (!signal.aborted) {
              onStatus("No captions, transcribing audio...");
              const retryRes = await fetch(`${apiBase}/api/youtube/transcript?id=${encodeURIComponent(att.videoId)}&retryWhisper=1`, { signal }).catch(() => null);
              if (retryRes && retryRes.ok) {
                const retryData = await retryRes.json() as any;
                const retrySource = String(retryData?.source || "").toLowerCase();
                const retryT = String(retryData?.transcript || "").trim();
                if (retryT && retrySource !== "description_fallback") {
                  att.transcript = retryT;
                } else {
                  att.transcript = `[VIDEO DESCRIPTION — not a transcript of spoken audio]\n${t}`;
                }
              } else {
                att.transcript = `[VIDEO DESCRIPTION — not a transcript of spoken audio]\n${t}`;
              }
            }
          } else if (t) {
            att.transcript = t;
          }
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
/*  Phase 2: YouTube grounding for board videos                        */
/* ------------------------------------------------------------------ */

export async function fetchYouTubeGrounding(
  p: ChatSendParams,
  apiBase: string,
  isBrickAction: boolean,
  earlyFocusedIds: string[],
  hasFocusedVideo: boolean,
): Promise<{ youtubeGrounding: string; youtubeTranscriptSource: string }> {
  const { text, abortController, youtube, analysis, state, context } = p;
  const signal = abortController.signal;
  const asksAboutVideo = !isBrickAction && analysis.isVideoQuestion(text);
  const needsFullTranscript = asksAboutVideo || isBrickAction || hasFocusedVideo;

  const boardVideos = youtube.getAllYouTubeBlocks();
  const attachedYouTubeVideos = p.sentAttachments
    .filter((a) => a.type?.toLowerCase() === "youtube" && a.videoId)
    .map((a) => ({ videoId: a.videoId!, url: a.url, title: a.name || `YouTube ${a.videoId}` }));
  const seen = new Set<string>();
  const allYouTubeVideos: Array<{ videoId: string; url: string; title: string }> = [];

  if (hasFocusedVideo) {
    const st = p.canvas.getCanvasState();
    for (const fid of earlyFocusedIds) {
      const blk: any = st.blocks?.[fid];
      if (!blk) continue;
      const t = String(blk.type || "").toLowerCase();
      const m = String(blk.mode || blk.data?.mode || "").toLowerCase();
      if (t !== "youtube" && !(t === "create" && m === "video")) continue;
      const vid = String(blk.videoId || blk.data?.videoId || "");
      const rawUrl = String(blk.url || blk.data?.url || "");
      const resolvedVid = vid || extractYouTubeVideoId(rawUrl) || "";
      if (resolvedVid && !seen.has(resolvedVid)) {
        seen.add(resolvedVid);
        allYouTubeVideos.push({
          videoId: resolvedVid,
          url: rawUrl || `https://www.youtube.com/watch?v=${resolvedVid}`,
          title: String(blk.data?.title || blk.data?.name || "").trim(),
        });
      }
    }
  }

  for (const v of [...attachedYouTubeVideos, ...boardVideos]) {
    if (seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    allYouTubeVideos.push(v);
  }

  let youtubeGrounding = "";
  let youtubeTranscriptSource = "";

  if (needsFullTranscript && allYouTubeVideos.length > 0 && !signal.aborted) {
    const targetVideo = allYouTubeVideos[0];
    state.setChatStatusText("Fetching video transcript...");
    try {
      const tTimeout = setTimeout(() => { if (!signal.aborted) abortController.abort(); }, 120000);
      let tRes = await fetch(
        `${apiBase}/api/youtube/transcript?id=${encodeURIComponent(targetVideo.videoId)}`,
        { signal }
      ).catch(() => null);
      clearTimeout(tTimeout);
      let tJson: any = tRes && tRes.ok ? await tRes.json().catch(() => ({})) : {};
      let transcriptSource = String(tJson?.source || "").toLowerCase();

      let whisperWasAttempted = Boolean(tJson?.whisperAttempted);
      if (transcriptSource === "description_fallback" && !signal.aborted) {
        state.setChatStatusText("No captions found, transcribing video audio...");
        const retryTimeout = setTimeout(() => { if (!signal.aborted) abortController.abort(); }, 120000);
        const retryRes = await fetch(
          `${apiBase}/api/youtube/transcript?id=${encodeURIComponent(targetVideo.videoId)}&retryWhisper=1`,
          { signal }
        ).catch(() => null);
        clearTimeout(retryTimeout);
        if (retryRes && retryRes.ok) {
          const retryJson: any = await retryRes.json().catch(() => ({}));
          const retrySource = String(retryJson?.source || "").toLowerCase();
          whisperWasAttempted = whisperWasAttempted || Boolean(retryJson?.whisperAttempted);
          if (retrySource !== "description_fallback" && String(retryJson?.transcript || "").trim()) {
            tJson = retryJson;
            transcriptSource = retrySource;
          }
        }
      }

      youtubeTranscriptSource = transcriptSource;
      const fullTranscript = String(tJson?.transcript || "").trim();
      if (fullTranscript) {
        youtube.youtubeTranscriptCache[targetVideo.videoId] = {
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
          const whisperNote = whisperWasAttempted
            ? "Audio transcription was attempted using Whisper speech-to-text but the audio could not be downloaded from YouTube."
            : "No audio transcription was attempted.";
          youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId}\n${whisperNote}\nVideo description (this is NOT a transcript of spoken audio — it is only the video's description/metadata):\n${safeTranscript}`;
          state.setChatStatusText("Transcription failed, only description available...");
        } else {
          youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId}\nFull transcript:\n${safeTranscript}`;
          state.setChatStatusText("Transcript ready, generating response...");
        }
      } else {
        const whisperNote = whisperWasAttempted ? " Audio transcription was attempted but failed." : "";
        state.setChatStatusText("No transcript available, answering from metadata...");
        youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId} (${targetVideo.url})\n(No transcript or description available.${whisperNote})`;
      }
    } catch {
      if (!signal.aborted) {
        state.setChatStatusText("Transcript fetch failed, answering from metadata...");
        youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId} (${targetVideo.url})\n(Transcript fetch failed)`;
      }
    }
  } else if (!isBrickAction && allYouTubeVideos.length > 0 && !signal.aborted) {
    const hasAnyCachedTranscript = allYouTubeVideos.some(
      (v) => youtube.youtubeTranscriptCache[v.videoId]?.transcript,
    );
    if (hasAnyCachedTranscript) {
      state.setChatStatusText("Analyzing visible YouTube videos...");
      youtubeGrounding = await youtube.buildYouTubeGrounding(apiBase, text, signal);
    }
  }

  return { youtubeGrounding, youtubeTranscriptSource };
}

/* ------------------------------------------------------------------ */
/*  Phase 3: Whisper for uploaded video/audio canvas blocks            */
/* ------------------------------------------------------------------ */

export async function transcribeUploadedVideos(
  p: ChatSendParams,
  apiBase: string,
  earlyFocusedIds: string[],
  needsFullTranscript: boolean,
): Promise<string> {
  const signal = p.abortController.signal;
  if (signal.aborted) return "";

  const focusedSet = new Set(earlyFocusedIds);
  const st = p.canvas.getCanvasState();
  const allBlockIds: string[] = Array.isArray(st.blockOrder) ? st.blockOrder : [];
  const scanIds = needsFullTranscript
    ? [...earlyFocusedIds, ...allBlockIds.filter((id: string) => !focusedSet.has(id))]
    : earlyFocusedIds;
  const transcribedUrls = new Set<string>();
  const MAX_WHISPER_BLOCKS = 3;
  let whisperCount = 0;
  let uploadedVideoTranscript = "";

  for (const fid of scanIds) {
    if (signal.aborted || whisperCount >= MAX_WHISPER_BLOCKS) break;
    const blk: any = st.blocks?.[fid];
    if (!blk) continue;
    const t = String(blk.type || "").toLowerCase();
    const m = String(blk.mode || blk.data?.mode || "").toLowerCase();
    const isUploadedVideo = (t === "create" && m === "video") || t === "video";
    const isUploadedAudio = (t === "create" && m === "audio") || t === "audio";
    if (!isUploadedVideo && !isUploadedAudio) continue;
    const vid = String(blk.videoId || blk.data?.videoId || "");
    const rawUrl = String(blk.url || blk.data?.url || "");
    const resolvedVid = vid || extractYouTubeVideoId(rawUrl) || "";
    if (resolvedVid) continue;
    if (!rawUrl || transcribedUrls.has(rawUrl)) continue;
    transcribedUrls.add(rawUrl);
    try {
      p.state.setChatStatusText("Transcribing uploaded video...");
      const resp = await fetch(rawUrl, { signal });
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const mimeType = String(blk.data?.mime || blk.mime || blob.type || "video/mp4");
      const ext = mimeType.split("/")[1] || "mp4";
      const fileName = String(blk.data?.name || `video.${ext}`);
      const formData = new FormData();
      formData.append("file", blob, fileName);
      const wRes = await fetch(`${apiBase}/api/whisper/transcribe`, {
        method: "POST",
        body: formData,
        signal,
      });
      if (wRes.ok) {
        const wData = await wRes.json();
        const tr = String(wData?.transcript || "").trim();
        if (tr) {
          whisperCount++;
          const safeTr = tr.length > 10000
            ? tr.slice(0, 10000) + "\n...[transcript truncated]"
            : tr;
          uploadedVideoTranscript += `\nUploaded video "${fileName}":\n${safeTr}`;
        }
      }
    } catch { /* continue without transcript */ }
  }
  return uploadedVideoTranscript;
}
