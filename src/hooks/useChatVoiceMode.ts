// useChatVoiceMode owns the chat page's realtime Voice Mode integration:
// eligibility (main-model agents only, with silent exit on model switch),
// assembling the LYKN-grounded session instructions from prefs + recent chat
// + workspace/KB context, mirroring finalized voice turns into the written
// chat thread, the display_document reader hook, and the voice paste/attach
// pipeline (ingest -> OCR -> vision description -> chat mirror -> quiet vault
// auto-save -> contextual update). Extracted verbatim from
// src/pages/LyknChat.tsx (LyknChat decomposition phase, see
// docs/REFACTOR_LOG.md).
import { useCallback, useEffect, useRef } from "react";
import { getAiPrefs } from "@/lib/ai-prefs";
import { openLyknMediaPop } from "@/lib/lyknMediaPop";
import { maybeAutoNameChat, buildAttachmentContext } from "@/lib/ai/chatSendOrchestrator";
import { ingestChatFiles } from "@/lib/chat/ingestChatFiles";
import { ocrImageAttachments } from "@/lib/ai/imageOcr";
import { extractYouTubeVideoId } from "@/lib/media/youtube";
import {
  inferUrlAttachmentType,
  makeAttId,
} from "@/lib/lyknChat/chatAttachmentInput";
import type {
  FocusedChatAttachment,
  PromptMessage,
} from "@/lib/lyknChat/chatTurnTypes";
import { snapshotLyknBots } from "@/lib/voice/voiceDesktopTools";

export function useChatVoiceMode({
  user,
  chatId,
  routeChatId,
  title,
  titleRef,
  activeCustomModelId,
  isMainAgentChat,
  voiceModeOn,
  setVoiceMode,
  chatMessagesRef,
  setChatMessages,
  aiThreadRef,
  getCachedWorkspaceSummary,
  getCachedKbText,
  saveYouTubeToMedia,
  saveLinkToMedia,
  saveAttachmentToMedia,
}: {
  user: { id?: string } | null;
  chatId: string | null;
  routeChatId: string | null | undefined;
  title: string;
  titleRef: React.MutableRefObject<string>;
  activeCustomModelId: string | null;
  isMainAgentChat: boolean;
  voiceModeOn: boolean;
  setVoiceMode: (on: boolean) => void;
  chatMessagesRef: React.MutableRefObject<PromptMessage[]>;
  setChatMessages: React.Dispatch<React.SetStateAction<PromptMessage[]>>;
  aiThreadRef: React.MutableRefObject<Array<{ role: "user" | "assistant"; content: string }>>;
  getCachedWorkspaceSummary: () => { full?: string } | null | undefined;
  getCachedKbText: () => unknown;
  saveYouTubeToMedia: (videoId: string, url: string) => Promise<void>;
  saveLinkToMedia: (linkUrl: string) => Promise<void>;
  saveAttachmentToMedia: (
    att: FocusedChatAttachment,
    opts?: { source?: string; quiet?: boolean },
  ) => Promise<boolean | undefined>;
}) {

  // Voice Mode is only offered on "main model agents": the default LYKN
  // model (no custom model active) or the user's main-agent orchestrator.
  // Model-Builder custom/sub agents are excluded for the MVP.
  const voiceModeEligible = !activeCustomModelId || isMainAgentChat;

  // Switching to an ineligible model while voice mode is on silently exits
  // voice mode so the chat can't get stuck speaking on an unsupported agent.
  useEffect(() => {
    if (!voiceModeEligible && voiceModeOn) setVoiceMode(false);
  }, [voiceModeEligible, voiceModeOn, setVoiceMode]);

  // Assemble the LYKN-grounded system instructions for a realtime voice
  // session from the same workspace/KB context the text chat uses, plus the
  // recent conversation so voice picks up where the user left off.
  const buildVoiceInstructions = useCallback(async (): Promise<string> => {
    // The server caps the whole client grounding at 8000 chars. We budget here
    // so the WRITTEN CHAT conversation is guaranteed to survive: it used to be
    // appended last and got truncated away entirely behind a long workspace
    // summary, so voice couldn't actually "see" the chat the user was having.
    const MAX = 7800;
    const parts: string[] = [];
    let used = 0;
    const push = (s: string) => {
      const text = String(s || "").trim();
      if (!text) return;
      const remaining = MAX - used;
      if (remaining <= 0) return;
      const clipped = text.length > remaining ? `${text.slice(0, Math.max(0, remaining - 1))}…` : text;
      parts.push(clipped);
      used += clipped.length + 2; // +2 for the "\n\n" join separator
    };

    // User preferences (custom assistant name + voice feel) ride along in the
    // session grounding, which is appended after the base instructions so a
    // rename / tone directive here overrides the default "you are LYKN" persona.
    const voicePrefs = getAiPrefs() as { aiName?: string; voicePrompt?: string };
    const aiName = voicePrefs.aiName || "LYKN";
    if (voicePrefs.aiName) {
      push(`Your name is now "${voicePrefs.aiName}". Always refer to yourself as "${voicePrefs.aiName}" instead of "LYKN".`);
    }
    if (voicePrefs.voicePrompt) {
      push(`How the user wants you to sound and behave in voice conversations — follow this:\n${String(voicePrefs.voicePrompt).slice(0, 1500)}`);
    }
    const boardTitle = String(titleRef.current || title || "").trim();
    if (boardTitle) push(`The user's current workspace is titled "${boardTitle}".`);

    // Conversation FIRST among the large blocks (after prefs): this is the chat
    // the user was just having, and the whole point of voice is to continue it
    // seamlessly. Pushed before workspace/KB so the budget can never starve it.
    try {
      const recent = (chatMessagesRef.current || []).slice(-24);
      const convo = recent
        .map((m) => {
          const atts = Array.isArray((m as { attachments?: { name?: string; type?: string }[] }).attachments)
            ? (m as { attachments?: { name?: string; type?: string }[] }).attachments || []
            : [];
          const attNote = atts.length
            ? ` [shared: ${atts.map((a) => a?.name || a?.type || "file").slice(0, 5).join(", ")}]`
            : "";
          const lines: string[] = [];
          if (m.content || attNote) lines.push(`User: ${String(m.content || "").slice(0, 800)}${attNote}`);
          if (m.aiResponse) lines.push(`${aiName}: ${String(m.aiResponse).slice(0, 800)}`);
          return lines.join("\n");
        })
        .filter(Boolean)
        .join("\n");
      if (convo) {
        push(`The written chat conversation in this workspace so far (oldest first, most recent last) — pick it up naturally and reference earlier points when relevant:\n${convo.slice(0, 5000)}`);
      }
    } catch { /* ignore */ }

    // Workspace + KB fill whatever budget the conversation left. Generous caps;
    // the running budget trims them down (and gives them MORE room on a fresh
    // chat with little/no conversation yet).
    try {
      const ws = getCachedWorkspaceSummary()?.full;
      if (ws) push(`Workspace & memory summary:\n${String(ws).slice(0, 6000)}`);
    } catch { /* ignore */ }
    try {
      const kb = typeof getCachedKbText === "function" ? getCachedKbText() : "";
      const kbText = typeof kb === "string" ? kb : String((kb as { text?: string })?.text || "");
      if (kbText) push(`Relevant saved knowledge:\n${kbText.slice(0, 4000)}`);
    } catch { /* ignore */ }

    try {
      const bots = snapshotLyknBots();
      if (bots.length) {
        const lines = bots.map((bot) => (bot.role ? `- ${bot.name} - ${bot.role}` : `- ${bot.name}`)).join("\n");
        push(
          `[LYKN BOTS] Desktop teammates you can send with ask_bot. ` +
            `If they want a website opened and did not name a bot, use browser_agent.\n${lines}`,
        );
      }
    } catch { /* ignore */ }

    return parts.join("\n\n");
  }, [title, getCachedWorkspaceSummary, getCachedKbText]);

  // Voice Mode persists each finalized turn into the chat thread so the full
  // conversation is waiting in the text chat when the user switches back. The
  // live transcript is intentionally NOT shown in the voice UI; this is the
  // single source of truth for what was said.
  const voiceTurnIdRef = useRef<string | null>(null);
  const lastVoiceUserTextRef = useRef<string>("");
  const newMsgId = useCallback(
    () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `voice-${Date.now().toString(36)}`),
    [],
  );

  // A vault document the voice agent pulled up on screen (display_document).
  // Rendered in the embedded reader above the voice overlay; null when closed.
  const handleVoiceDisplayDocument = useCallback((payload: unknown) => {
    const p = payload as { ok?: boolean; kind?: string; url?: string; title?: string; media?: "image" | "video" | "audio" | "pdf" | "file" } | null;
    if (!p) return;
    if (p.ok && p.kind === "vault") {
      openLyknMediaPop({ type: "vault-payload", payload: p });
      return;
    }
    if (p.kind === "url" && typeof p.url === "string" && p.url) {
      openLyknMediaPop({ type: "url", url: p.url, title: p.title, kind: p.media });
    }
  }, []);

  const handleVoiceUserTranscript = useCallback((text: string) => {
    const content = String(text || "").trim();
    if (!content) return;
    const id = newMsgId();
    voiceTurnIdRef.current = id;
    lastVoiceUserTextRef.current = content;
    const msg: PromptMessage = { id, role: "user", content, kind: "prompt", viaVoice: true };
    setChatMessages((prev) => [...prev, msg]);
    try { aiThreadRef.current = [...(aiThreadRef.current || []), { role: "user", content }]; } catch { /* ignore */ }
  }, [newMsgId, setChatMessages, aiThreadRef]);

  const handleVoiceAssistantReply = useCallback((text: string) => {
    const reply = String(text || "").trim();
    if (!reply) return;
    const pendingId = voiceTurnIdRef.current;
    setChatMessages((prev) => {
      const target = pendingId ? prev.find((m) => m.id === pendingId) : null;
      // Attach the reply to the pending user turn when it has none yet;
      // otherwise (assistant spoke first, or a follow-up) start a fresh turn.
      if (target && !target.aiResponse) {
        return prev.map((m) => (m.id === pendingId ? { ...m, aiResponse: reply } : m));
      }
      const id = newMsgId();
      return [...prev, { id, role: "user", content: "", aiResponse: reply, kind: "prompt", viaVoice: true }];
    });
    voiceTurnIdRef.current = null;
    try { aiThreadRef.current = [...(aiThreadRef.current || []), { role: "assistant", content: reply }]; } catch { /* ignore */ }
    // Auto-name the chat from this voice exchange exactly like a typed turn
    // would, so voice-only conversations show a real title in history
    // instead of being stuck on "New Chat".
    try {
      maybeAutoNameChat({
        chatId: routeChatId || chatId,
        userId: user?.id,
        currentTitle: titleRef.current,
        userMessage: lastVoiceUserTextRef.current,
        assistantReply: reply,
      });
    } catch { /* auto-name is cosmetic */ }
  }, [newMsgId, setChatMessages, aiThreadRef, routeChatId, chatId, titleRef, user?.id]);

  // Paste / attach from Voice Mode. The voice overlay captures the clipboard
  // (or a file pick / drop / link) and hands us the raw inputs. We run them
  // through the SAME ingestion the typed composer uses, mirror the result into
  // the written chat as a `viaVoice` turn (so the conversation stays in sync),
  // and return a text summary the caller injects into the live voice session
  // as a contextual update — that's how the agent gets to "see" the paste.
  const handleVoiceAttach = useCallback(async (
    input: { files?: File[]; text?: string },
  ): Promise<string> => {
    const collected: FocusedChatAttachment[] = [];
    const add = (att: FocusedChatAttachment) => { collected.push(att); };
    const update = (id: string, patch: Record<string, unknown>) => {
      const i = collected.findIndex((a) => a.id === id);
      if (i >= 0) collected[i] = { ...collected[i], ...patch };
    };

    const rawText = String(input?.text || "").trim();
    const isBareUrl = /^https?:\/\/\S+$/i.test(rawText) && !/\s/.test(rawText);
    let noteText = isBareUrl ? "" : rawText;

    // Files → attachments (images/pdf/docs/spreadsheets/audio/video), reusing
    // the shared picker/paste pipeline (text extraction + background upload).
    try {
      if (input?.files?.length) {
        await ingestChatFiles(input.files, add, {
          userId: user?.id,
          updateAttachment: update,
        });
      }
    } catch { /* ingestion is best-effort */ }

    // A pasted URL becomes a link/youtube/media attachment, unfurled for the
    // agent so it gets the page title + description, not just a bare URL.
    if (isBareUrl) {
      const urlType = inferUrlAttachmentType(rawText);
      const videoId = urlType === "youtube" ? (extractYouTubeVideoId(rawText) || "") : "";
      const linkAtt: FocusedChatAttachment = {
        id: makeAttId(), type: urlType, url: rawText, name: rawText, mime: "", size: 0,
        ...(videoId ? { videoId } : {}),
      };
      if (urlType === "link") {
        try {
          const { API_BASE_URL } = await import("@/lib/api-config");
          const res = await fetch(`${API_BASE_URL}/api/unfurl?url=${encodeURIComponent(rawText)}`);
          if (res.ok) {
            const meta = await res.json();
            linkAtt.name = meta?.title || linkAtt.name;
            linkAtt.linkTitle = meta?.title || "";
            linkAtt.linkDescription = meta?.description || "";
            linkAtt.linkImage = meta?.image || "";
            linkAtt.linkSiteName = meta?.siteName || "";
            linkAtt.linkFavicon = meta?.favicon || "";
          }
        } catch { /* unfurl is best-effort */ }
      }
      collected.push(linkAtt);
    }

    if (!collected.length && !noteText) return "";

    // OCR pasted images so the voice agent can read text inside them (the live
    // voice LLM is text-only; the image itself still rides into the written
    // chat where the vision model can see it on the next typed turn).
    try {
      await ocrImageAttachments(collected, new AbortController().signal, () => {});
    } catch { /* OCR is additive, never blocking */ }

    // Describe pasted IMAGES with a vision model. The realtime voice LLM is
    // text-only and can't fetch the image url, so without a written
    // description a photo (no OCR text) is completely invisible to it — the
    // agent would say it "can't see images". We hand each image's data url to
    // /api/ai/describe-image and stash the 2-3 sentence result on the
    // attachment so buildAttachmentContext can fold it into what the agent
    // "sees" this turn.
    try {
      const imageAtts = collected.filter(
        (a) => (a.type || "").toLowerCase() === "image" && !a.aiDescription && a.url,
      );
      if (imageAtts.length) {
        const { API_BASE_URL } = await import("@/lib/api-config");
        const { supabase } = await import("@/lib/supabase");
        let authHeader: Record<string, string> = {};
        try {
          const sess = await supabase?.auth?.getSession?.();
          const token = sess?.data?.session?.access_token;
          if (token) authHeader = { Authorization: `Bearer ${token}` };
        } catch { /* anonymous — endpoint may still allow */ }
        await Promise.all(
          imageAtts.map(async (att) => {
            try {
              const res = await fetch(`${API_BASE_URL}/api/ai/describe-image`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeader },
                body: JSON.stringify({ imageUrl: att.url, fileType: "image", fileName: att.name }),
              });
              if (!res.ok) return;
              const data = await res.json().catch(() => null);
              const description = String(data?.description || "").trim();
              if (description) att.aiDescription = description;
            } catch { /* description is additive, never blocking */ }
          }),
        );
      }
    } catch { /* vision description is best-effort */ }

    // Mirror into the written chat as a shared (no-response) user turn so the
    // pasted content shows up in the conversation exactly like a typed attach.
    const id = newMsgId();
    const fallbackLabel = collected.length === 1
      ? `Shared ${collected[0].name || "a file"}`
      : collected.length > 1
        ? `Shared ${collected.length} files`
        : "";
    const mirrorMsg: PromptMessage = {
      id,
      role: "user",
      content: noteText || fallbackLabel,
      kind: "prompt",
      viaVoice: true,
      ...(collected.length ? { attachments: collected } : {}),
    };
    setChatMessages((prev) => [...prev, mirrorMsg]);
    try {
      const threadNote = [noteText, buildAttachmentContext(collected)].filter(Boolean).join("\n");
      aiThreadRef.current = [...(aiThreadRef.current || []), { role: "user", content: threadNote || fallbackLabel }];
    } catch { /* ignore */ }

    // Auto-save everything pasted into the voice paste bar to the vault,
    // reusing the same side-rail "Save to Vault" helpers so pasted files and
    // links persist permanently instead of living only inside this voice
    // conversation. Fire-and-forget: it must not block the contextual update
    // the agent is waiting on, and each item is best-effort on its own.
    if (user?.id && collected.length) {
      void (async () => {
        for (const att of collected) {
          const t = (att.type || "").toLowerCase();
          try {
            if (t === "youtube" && att.videoId) {
              await saveYouTubeToMedia(att.videoId, att.url || "");
            } else if (t === "link" || t === "bookmark") {
              if (att.url) await saveLinkToMedia(att.url);
            } else {
              // Images already carry a downscaled data URL; documents/audio/
              // video have no URL, so fall back to the original File bytes.
              const rawFile =
                att.rawFile || (input?.files || []).find((file) => file.name === att.name);
              // Keep the voice source tag: the voice `add_to_project` tool
              // resolves "add this to my <project>" by looking up the most
              // recent vault row saved with it.
              await saveAttachmentToMedia(rawFile ? { ...att, rawFile } : att, {
                source: "lykn-voice-attachment",
                quiet: true,
              });
            }
          } catch { /* per-item best-effort */ }
        }
      })();
    }

    // Context the voice agent "sees": a note + extracted/ocr/link text.
    const parts: string[] = [];
    if (noteText) parts.push(`The user pasted this into the chat: ${noteText}`);
    const attachCtx = buildAttachmentContext(collected);
    if (attachCtx) {
      parts.push(
        `The user just shared the following in the chat. Treat it as context for the conversation.${attachCtx}`,
      );
    }
    return parts.join("\n\n");
  }, [user?.id, newMsgId, setChatMessages, aiThreadRef, saveYouTubeToMedia, saveLinkToMedia, saveAttachmentToMedia]);

  return {
    voiceModeEligible,
    buildVoiceInstructions,
    newMsgId,
    handleVoiceDisplayDocument,
    handleVoiceUserTranscript,
    handleVoiceAssistantReply,
    handleVoiceAttach,
  };
}
