// Result-reconciliation stage of the chat send pipeline: turn the raw
// accumulated stream text into the final visible reply (sanitize, rescue
// leaked action JSON, extract sources / connections / embeds), commit it to
// the message list + rolling thread, persist conversation memory, and
// fire-and-forget the chat auto-name. Extracted VERBATIM from
// chatSendOrchestrator.ts (C3B decomposition, see docs/REFACTOR_LOG.md)
// minus the dead canvas block-write branches. The tag-action / YouTube-embed
// helpers previously lived in useChatEngine and were dependency-injected;
// they moved here because they are pure post-processing with no React state.
import { supabase } from "@/lib/supabase";
import {
  finalizeVisibleReply,
  stripModelTruncationNote,
} from "@/lib/ai/responseText";
import { stripToolSyntaxFromFinal } from "@/lib/ai/toolSyntaxStrip";
import { finalizeResearchReport } from "@/lib/ai/researchReportFinalize";
import { rescueInlineBlockMarkup } from "@/lib/ai/actionJsonRescue";
import {
  looksLikeDeflectingQuestion,
  buildDirectVideoAnswerFromGrounding,
  extractSourceLinks,
  extractAiConnections,
  extractWebLinksFromText,
} from "@/lib/chat/chatResponseExtractors";
import { saveExchange, invalidateMemoryCache } from "@/lib/conversationMemory";
import { AI_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import { notifyLyknChatsChanged } from "@/lib/lyknChat/chatsChanged";
import type { ChatSendParams } from "@/lib/ai/chatSendOrchestrator";

/* ------------------------------------------------------------------ */
/*  Auto-name                                                          */
/* ------------------------------------------------------------------ */

// Per-session memory of which boards we've already auto-named (or tried
// hard enough to). The server is the source of truth — it short-circuits
// on a non-default title — but tracking client-side prevents redundant
// requests on every subsequent message after a successful rename, and
// caps retries on boards that legitimately have no nameable content yet.
const autoNamedBoardsSucceeded = new Set<string>();
const autoNamedBoardsAttempts = new Map<string, number>();
const AUTO_NAME_MAX_ATTEMPTS = 4;

/**
 * Auto-name a chat board from a single user→assistant exchange, mirroring
 * what the regular send path does. Safe to call repeatedly: it self-gates on
 * the placeholder title, a per-session success cache, and a per-board retry
 * budget, so callers (regular text sends *and* Voice Mode turns) don't need to
 * track any of that themselves.
 *
 * Fire-and-forget — errors are swallowed; a missed title just leaves the
 * "New Chat" placeholder in place.
 */
export function maybeAutoNameChat(args: {
  chatId: string | null | undefined;
  userId: string | null | undefined;
  currentTitle: string | null | undefined;
  userMessage: string;
  assistantReply: string;
}): void {
  const namingChatId = args.chatId ? String(args.chatId) : "";
  const currentTitle = String(args.currentTitle || "").trim();
  const titleIsDefault =
    !currentTitle || currentTitle === "New Chat" || currentTitle === "Untitled board";
  const userMessage = String(args.userMessage || "").trim();
  const assistantReply = String(args.assistantReply || "").trim();
  const prevAttempts = namingChatId ? autoNamedBoardsAttempts.get(namingChatId) || 0 : 0;
  if (
    !args.userId ||
    !namingChatId ||
    !titleIsDefault ||
    (!userMessage && !assistantReply) ||
    autoNamedBoardsSucceeded.has(namingChatId) ||
    prevAttempts >= AUTO_NAME_MAX_ATTEMPTS
  ) {
    return;
  }
  autoNamedBoardsAttempts.set(namingChatId, prevAttempts + 1);
  void (async () => {
    try {
      const { API_BASE_URL: apiBase } = await import("@/lib/api-config");
      const res = await fetch(`${apiBase}/api/ai/name-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: namingChatId,
          userMessage,
          assistantReply,
        }),
      });
      if (!res.ok) return;
      const json = await res.json().catch(() => null);
      // `already_named` (manual rename in another tab, or a previous
      // auto-name that succeeded but raced our local cache) returns
      // applied:false but still includes the live title — treat that
      // as success so we stop retrying and pick up the real title.
      if (json?.reason === "already_named" && typeof json?.title === "string" && json.title.trim()) {
        autoNamedBoardsSucceeded.add(namingChatId);
        return;
      }
      const newTitle = json?.applied && typeof json.title === "string" ? json.title.trim() : "";
      if (!newTitle) return;
      autoNamedBoardsSucceeded.add(namingChatId);
      // Mirror the manual-rename event contract in MobileLyknChat
      // / AppSidebar so LyknChat's rename listener picks up the title
      // (which also syncs `titleRef.current`, preventing the next
      // autosave from writing the stale local copy back).
      window.dispatchEvent(
        new CustomEvent("lyknchat_renamed", {
          detail: { chatId: namingChatId, title: newTitle },
        }),
      );
      notifyLyknChatsChanged();
    } catch {
      // Auto-naming is purely cosmetic — never let a flake bubble up.
    }
  })();
}

/* ------------------------------------------------------------------ */
/*  Post-processing helpers (formerly injected from useChatEngine)     */
/* ------------------------------------------------------------------ */

/** Apply `[TAG_NOTES:noteId|tag,tag]` markers to the vault, then strip them
 *  from the visible text. */
async function extractAndApplyTagActions(responseText: string, userId: string | undefined): Promise<string> {
  const re = /\[TAG_NOTES:([^|\]]+)\|([^\]]+)\]/g;
  const actions: Array<{ noteId: string; tags: string[] }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(responseText)) !== null) {
    const noteId = m[1].trim();
    const rawTags = m[2].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (noteId && rawTags.length) actions.push({ noteId, tags: rawTags });
  }
  if (actions.length > 0 && userId) {
    for (const action of actions) {
      try {
        const { data: existing } = await supabase.from("vault_items").select("tags").eq("id", action.noteId).eq("user_id", userId).single();
        const currentTags: string[] = Array.isArray(existing?.tags) ? existing.tags : [];
        await supabase.from("vault_items").update({ tags: [...new Set([...currentTags, ...action.tags])] }).eq("id", action.noteId).eq("user_id", userId);
      } catch {}
    }
  }
  return responseText.replace(/\s*\[TAG_NOTES:[^\]]*\]/g, "").trimEnd();
}

async function validateYouTubeVideoId(videoId: string, userToken: string | undefined): Promise<boolean> {
  try {
    const res = await fetch(`/api/youtube/video?id=${encodeURIComponent(videoId)}`, {
      headers: userToken ? { Authorization: `Bearer ${userToken}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch { return true; }
}

/** Find YouTube URLs in the reply, validate them, drop links to unavailable
 *  videos from the text, and patch the embed list onto the message. */
async function extractAndEmbedYouTubeUrls(
  aiText: string,
  promptId: string,
  userToken: string | undefined,
  setChatMessages: ChatSendParams["state"]["setChatMessages"],
): Promise<{ urls: { url: string; videoId: string }[]; cleanText: string }> {
  const re = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/g;
  const cands: { url: string; videoId: string }[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(aiText)) !== null) { const vid = m[1]; if (vid && !seen.has(vid)) { seen.add(vid); cands.push({ url: m[0], videoId: vid }); } }
  if (!cands.length) return { urls: [], cleanText: aiText };
  const validResults = await Promise.all(cands.map(async (c) => ({ ...c, valid: await validateYouTubeVideoId(c.videoId, userToken) })));
  const urls = validResults.filter((r) => r.valid);
  const invalidIds = new Set(validResults.filter((r) => !r.valid).map((r) => r.videoId));
  let cleanText = aiText;
  if (invalidIds.size > 0) { for (const badId of invalidIds) cleanText = cleanText.replace(new RegExp(`https?://(?:www\\.)?(?:youtube\\.com/watch\\?v=|youtu\\.be/|youtube\\.com/embed/|youtube\\.com/shorts/)${badId.replace(/[-]/g, '\\-')}[^\\s]*`, 'g'), ''); cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim(); }
  if (!urls.length) return { urls: [], cleanText };
  setChatMessages((prev) => prev.map((m2) => m2.id === promptId ? { ...m2, aiYouTubeUrls: urls } : m2));
  return { urls, cleanText };
}

/** Strip `[PULL_MEDIA:...]` markers. The canvas pull path is gone; the
 *  markers are hidden-from-user tokens that must never render. */
function stripPullMediaMarkers(aiText: string): { cleanText: string; pulled: number } {
  return { cleanText: aiText.replace(/\s*\[PULL_MEDIA:[^\]]*\]/g, "").trimEnd(), pulled: 0 };
}

/* ------------------------------------------------------------------ */
/*  Post-process AI response                                           */
/*  (The action-JSON rescue machinery this phase leans on lives in     */
/*  src/lib/ai/actionJsonRescue.ts.)                                   */
/* ------------------------------------------------------------------ */

export async function postProcessResponse(
  p: ChatSendParams,
  aiTextRaw: string,
  promptId: string,
  youtubeGrounding: string,
  asksAboutVideo: boolean,
  cappedText: string,
  servedModel: string | null = null,
  generatedImageUrl: string | null = null,
  streamedSources: { title: string; url: string }[] = [],
): Promise<void> {
  const { state, typing, identity } = p;

  // Repair weak dangling tails and strip any self-emitted "_…response
  // truncated. Ask 'continue'
  // for the rest._" / "[response truncated]" style note BEFORE
  // finalizeVisibleReply runs so the dangling-tail repair acts on the
  // model's last real sentence rather than on the truncation marker.
  const visibleReply = finalizeVisibleReply(
    finalizeResearchReport(
      stripModelTruncationNote(
        stripToolSyntaxFromFinal(
          aiTextRaw,
        ),
      ),
    ),
  );

  let aiText = visibleReply.trim();

  // Rescue any block-creation markup the AI may have leaked into the chat
  // text (legacy `[CREATE_BLOCK:...]`, ```json fences, or bare action JSON)
  // and strip it from what the user sees. Execution of the recovered
  // actions died with the canvas — this is compatibility sanitation only.
  aiText = rescueInlineBlockMarkup(aiText);
  const hasYTG = Boolean(String(youtubeGrounding || "").trim() && String(youtubeGrounding || "").trim() !== "(none)");
  if (asksAboutVideo && hasYTG) {
    const fallback = buildDirectVideoAnswerFromGrounding(youtubeGrounding);
    if (fallback && (!aiText || looksLikeDeflectingQuestion(aiText))) aiText = fallback;
  }
  // Defensive logging + better fallback: if every stripping pass (learned
  // tag, sanitize, action rescue) ate the whole reply, the model probably
  // emitted ONLY hidden tags / ONLY action JSON, or the stream returned
  // no text at all. The vague "Could you rephrase?" fallback hid the real
  // issue; log the raw text in dev so we can see exactly what came back.
  if (!aiText && import.meta.env.DEV) {
    const rawSummary = String(aiTextRaw || "").trim();
    const rawPreview = rawSummary.slice(0, 200).replace(/\s+/g, " ");
    console.warn(
      `[chatSendOrchestrator] visible reply empty after post-processing. ` +
        `Raw=${rawSummary.length} chars: "${rawPreview}${rawSummary.length > 200 ? "…" : ""}". ` +
        `Likely: model emitted only hidden tags / action JSON, or stream returned no text.`,
    );
  }
  // Reaching this fallback means the server's cross-provider chain ran to
  // completion AND every provider returned zero visible text. (The server
  // already retries gemini → openai → claude → grok internally.) Telling
  // the user to "switch models" here is misleading because every model has
  // already been tried; surface the centralized transient-failure copy
  // instead so they know to just retry the same prompt in a moment.
  const finalText = aiText || AI_TEMPORARY_FAILURE_TEXT;
  const { connections: aiConnections, cleanText: textWithoutConnections } = extractAiConnections(finalText);
  if (aiConnections.length > 0) {
    const boardConns = aiConnections.filter((c) => c.sourceType === "board");
    const mediaConns = aiConnections.filter((c) => c.sourceType === "media");
    if (boardConns.length > 0) {
      state.setConnectionCards(boardConns);
      state.setShowConnectionCard(true);
    }
    if (mediaConns.length > 0) {
      const cached = p.context.getCachedWorkspaceSummary()?.full || "";
      const resolved = mediaConns.map((mc) => {
        const m = cached.match(new RegExp(`"${mc.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\(id=([^)]+)\\)`));
        return m?.[1] ? { title: mc.title, reason: mc.reason, noteId: m[1] } : null;
      }).filter(Boolean) as Array<{ title: string; reason: string; noteId: string }>;
      if (resolved.length > 0) {
        state.setMediaSuggestions(resolved);
        state.setSelectedMediaIds(new Set());
        state.setShowMediaSuggestion(true);
      }
    }
  }
  const textAfterTags = await extractAndApplyTagActions(textWithoutConnections, identity.userId);
  const { cleanText: displayText, sources: extractedSources } = extractSourceLinks(textAfterTags);
  // Deep research streams its full source list (every page searched/read)
  // as an early SSE event — richer than the trailing "Sources:" block the
  // model writes. Keep the streamed list first, then any extra citations.
  const sources = (() => {
    if (!streamedSources.length) return extractedSources;
    const seen = new Set(streamedSources.map((s) => s.url));
    return [...streamedSources, ...extractedSources.filter((s) => !seen.has(s.url))];
  })();
  const ytResult = await extractAndEmbedYouTubeUrls(displayText, promptId, identity.userToken, state.setChatMessages);
  const textAfterYt = ytResult.cleanText || displayText;
  const mediaResult = stripPullMediaMarkers(textAfterYt);
  // Always prefer mediaResult.cleanText whenever it differs from the input.
  // The previous `pulled > 0` gate left raw [PULL_MEDIA:...] markers visible
  // to the user when every pull failed (deleted note / RLS / broken URL),
  // breaking the prompt-level "hidden from user" contract.
  const finalDisplayText = mediaResult.cleanText !== textAfterYt ? mediaResult.cleanText : textAfterYt;
  const webLinks = extractWebLinksFromText(finalDisplayText);
  // Cancel any pending rAF commit BEFORE we set the final text. Otherwise
  // the queued frame fires with a stale `streamTargetTextRef` and overwrites
  // our final commit with the pre-cleanup in-stream view (which is how a
  // user sees "server finished but UI is cut off"). We also sync the target
  // ref to the final text so any in-flight frame that already started can't
  // introduce regressions.
  if (p.streamRefs.streamTypingRafRef.current) {
    clearTimeout(p.streamRefs.streamTypingRafRef.current);
    p.streamRefs.streamTypingRafRef.current = null;
  }
  p.streamRefs.streamTargetTextRef.current = finalDisplayText;
  p.streamRefs.streamDisplayedLenRef.current = finalDisplayText.length;
  const replyModel = servedModel || identity.selectedModel || null;
  const completedAt = new Date().toISOString();
  state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? {
    ...m,
    aiResponse: finalDisplayText,
    aiModel: replyModel || undefined,
    aiCompletedAt: completedAt,
    sources,
    aiYouTubeUrls: ytResult.urls.length ? ytResult.urls : undefined,
    aiWebLinks: webLinks.length ? webLinks : undefined,
  } : m)));
  // Push the post-cleanup display text into conversation memory so future
  // turns and saved exchanges don't reference internal markers / source tags.
  // A generated image gets its markdown line appended HERE (memory only — the
  // visible bubble renders it as a card): the server's follow-up detector
  // reads it from `conversation` to re-force lykn_generate_image when the
  // next message is a tweak ("same thing but…", "make it darker").
  const threadContent = generatedImageUrl
    ? `${finalDisplayText}\n\n![Generated image](${generatedImageUrl})`
    : finalDisplayText;
  p.aiThread.push({ role: "assistant", content: threadContent, model: replyModel || undefined, at: completedAt });
  if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
  typing.maybeRunConversationSummary();
  if (identity.userId) { invalidateMemoryCache(); saveExchange(identity.userId, "chat", identity.routeChatId || identity.chatId || null, p.context.titleRef.current || null, cappedText, finalDisplayText); }

  // === AUTO-NAME — fire-and-forget after any user→assistant turn while
  // the chat is still using the default placeholder title.
  //
  // Generates a 2-5 word title from this exchange and writes it through
  // to `lykn_chats.title` server-side, then surfaces the new title in
  // every mounted view (sidebar, mobile sheet, toolbar) via the existing
  // `lyknchat_renamed` + `lykinsai_chats_changed` events.
  //
  // Gates:
  //   • signed-in user (guests have no DB row)
  //   • we have a real board id (route or persisted)
  //   • title is still the default — never clobber a manual rename
  //   • haven't already named this board in this session (server is the
  //     real source of truth, but skipping the round-trip is free)
  //   • haven't already burned the per-board retry budget — caps the
  //     "user keeps chatting with title stuck on New Chat" case at a few
  //     extra attempts instead of hitting /api/ai/name-chat on every send
  //
  // Note we intentionally don't require `aiThread.length === 2` like an
  // earlier revision did — that branch only fired on a brand-new chat's
  // very first reply, so any chat created before this feature shipped
  // (or any first-attempt that lost a race / hit a network blip) was
  // stuck on "New Chat" forever even as the user kept chatting.
  //
  // Errors are silent — a missed title just means the chat keeps the
  // "New Chat" placeholder, which is exactly what it shows today.
  maybeAutoNameChat({
    chatId: identity.routeChatId || identity.chatId,
    userId: identity.userId,
    currentTitle: p.context.titleRef.current,
    userMessage: cappedText,
    assistantReply: finalDisplayText,
  });
  state.setChatStatusText(mediaResult.pulled > 0 ? "Media added to board" : ytResult.urls.length ? "Video embedded" : aiConnections.length > 0 ? "Connection found" : "Answered");

  // Persist the finished turn promptly so switching devices (phone → laptop)
  // doesn't depend on the 30s autosave interval or a tab-background event.
  if (identity.userId) {
    setTimeout(() => window.dispatchEvent(new Event("lyknchat_flush_save")), 300);
  }
}
