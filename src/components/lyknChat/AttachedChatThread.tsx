/**
 * Compact live view of a LyknChat thread for the browser side panel.
 * Same conversation language as Home (markdown, bubbles, sources, artifacts)
 * with sidebar spacing. Display is keyed to this chatId only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  CHAT_REHYPE_PLUGINS,
  CHAT_REMARK_PLUGINS,
  normalizeMathDelimiters,
} from "@/lib/chat/chatMarkdown";
import { normalizeChecklistSyntax } from "@/lib/chatChunks";
import {
  getThreadSnapshot,
  subscribeThreadRuntime,
} from "@/lib/chat/chatThreadRuntime";
import type { PromptMessage } from "@/lib/lyknChat/chatTurnTypes";
import { ChatPopImage } from "@/components/lyknChat/LyknMediaPop";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import { useBuildThoughtTrail } from "@/hooks/useThinkingStatus";
import { hydrateThreadSnapshotFromLocal } from "@/lib/lyknChat/hydrateThreadSnapshot";
import {
  handleLyknBrowserClick,
  openArtifactInStudioBrowser,
  studioOpenChatOpts,
} from "@/lib/lyknChat/openInStudioBrowser";
import {
  BROWSER_MD_COMPONENTS,
  chatOwnedMarkdownAnchor,
} from "@/components/lyknChat/chatMarkdownComponents";
import {
  extractChatArtifacts,
  sortArtifactsForDisplay,
} from "@/lib/ai/chatArtifacts";
import { SiteFavicon } from "@/components/SiteFavicon";
import { safeExternalUrl } from "@/lib/safeExternalUrl";
import { chatAttachmentLabel } from "@/lib/chat/chatAttachmentFile";
import { railShowsWaitingIndicator } from "@/lib/lyknChat/railThreadView";

function RailMarkdown({
  text,
  components,
}: {
  text: string;
  components: Record<string, unknown>;
}) {
  const body = normalizeMathDelimiters(normalizeChecklistSyntax(String(text || "").trim()));
  if (!body) return null;
  return (
    <ReactMarkdown
      remarkPlugins={CHAT_REMARK_PLUGINS}
      rehypePlugins={CHAT_REHYPE_PLUGINS}
      components={components as never}
    >
      {body}
    </ReactMarkdown>
  );
}

function assistantImages(msg: PromptMessage) {
  const listed = Array.isArray(msg.aiImages) ? msg.aiImages : [];
  const urls = listed.map((img) => String(img?.url || "").trim()).filter(Boolean);
  const single = String(msg.aiImageUrl || "").trim();
  if (single && !urls.includes(single)) urls.unshift(single);
  return urls;
}

function RailSourceChips({
  chatId,
  sources,
  links,
}: {
  chatId: string;
  sources?: { title: string; url: string }[];
  links?: string[];
}) {
  const owned = studioOpenChatOpts(chatId);
  const chips: { key: string; href: string; label: string }[] = [];
  for (const src of sources || []) {
    const href = safeExternalUrl(src.url) || src.url;
    if (!href) continue;
    chips.push({ key: `s:${href}`, href, label: src.title || href });
  }
  for (const link of links || []) {
    const href = safeExternalUrl(link) || link;
    if (!href) continue;
    let domain = href;
    try {
      domain = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      /* keep href */
    }
    chips.push({ key: `l:${href}`, href, label: domain });
  }
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <a
          key={chip.key}
          href={chip.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => handleLyknBrowserClick(e, chip.href, chip.label, owned)}
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-black/10 bg-white/70 px-2 py-0.5 text-[11px] text-black/70 backdrop-blur-sm transition-all hover:border-black/25 hover:shadow-sm"
        >
          <SiteFavicon url={chip.href} className="h-3 w-3" />
          <span className="min-w-0 truncate">{chip.label}</span>
        </a>
      ))}
    </div>
  );
}

export default function AttachedChatThread({
  chatId,
  emptyHint = "Ask about this page.",
}: {
  chatId: string;
  emptyHint?: string;
}) {
  const id = String(chatId || "").trim();
  // Snapshots are mutated in place. A tick forces React to re-read them so
  // Home's typewriter / SSE deltas paint in the rail instead of dumping
  // the finished reply when loading flips false.
  const [runtimeRev, setRuntimeRev] = useState(0);
  const threadRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const programmaticScrollRef = useRef(false);

  const mdComponents = useMemo(
    () => ({
      ...BROWSER_MD_COMPONENTS,
      a: chatOwnedMarkdownAnchor(id),
    }),
    [id],
  );

  useEffect(() => {
    if (!id) return undefined;
    userScrolledUpRef.current = false;
    hydrateThreadSnapshotFromLocal(id);
    const pull = (changedId?: string | null) => {
      if (changedId && changedId !== id) return;
      setRuntimeRev((n) => n + 1);
    };
    pull();
    return subscribeThreadRuntime(pull);
  }, [id]);

  const snap = useMemo(
    () => (id ? getThreadSnapshot(id) : null),
    [id, runtimeRev],
  );

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const markScrolledUp = () => {
      userScrolledUpRef.current = true;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) markScrolledUp();
    };
    let lastScrollTop = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      const goingDown = top > lastScrollTop;
      lastScrollTop = top;
      const distance = el.scrollHeight - top - el.clientHeight;
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        if (distance <= 4) return;
      }
      if (userScrolledUpRef.current) {
        if (goingDown && distance <= 60) userScrolledUpRef.current = false;
      } else if (distance > 120) {
        userScrolledUpRef.current = true;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
    };
  }, [id]);

  useEffect(() => {
    if (userScrolledUpRef.current) return;
    const el = threadRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [id, runtimeRev, snap?.updatedAt, snap?.isChatLoading, snap?.chatStatusText]);

  const messages = snap?.chatMessages || [];
  const loading = !!snap?.isChatLoading;
  const status = String(snap?.chatStatusText || "").trim();
  const trail = useBuildThoughtTrail(status, loading);
  const liveBot = [...messages].reverse().find((m) => m.bot)?.bot || null;
  const botAlreadyWorking = messages.some((m) => (m as { botWorking?: boolean }).botWorking);
  const lastAiResponse = String(messages[messages.length - 1]?.aiResponse || "");
  const showWaiting = railShowsWaitingIndicator({
    loading,
    botAlreadyWorking,
    lastAiResponse,
  });
  const stopped = !loading && /^stopped$/i.test(status);

  return (
    <div
      ref={threadRef}
      data-attached-chat-thread
      data-rail-chat-id={id}
      className="lykn-chat-thread--browser min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 scrollbar-hide"
    >
      {messages.length === 0 && !loading && (
        <p className="px-2 pt-8 text-center text-[13px] leading-relaxed text-black/45">
          {emptyHint}
        </p>
      )}
      {messages.map((msg) => {
        const user = String(msg.content || "").trim();
        const reply = String(msg.aiResponse || "").trim();
        const images = assistantImages(msg);
        const artifacts = sortArtifactsForDisplay(extractChatArtifacts(msg.toolCalls));
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
        return (
          <div key={msg.id} className="lykn-chat-message--browser space-y-2">
            {user ? (
              <div className="flex justify-end">
                <div className="lykn-user-prompt-bubble max-w-[88%] break-words rounded-[15px] rounded-br-[4px] border border-black/8 bg-background px-2.5 py-1 text-[13px] leading-[1.35] text-black shadow-[0_2px_8px_rgba(0,0,0,0.045)]">
                  <span className="whitespace-pre-wrap">{user}</span>
                </div>
              </div>
            ) : null}
            {attachments.length ? (
              <div className="flex flex-wrap justify-end gap-1">
                {attachments.map((att) => (
                  <span
                    key={String(att.id || chatAttachmentLabel(att))}
                    className="max-w-[88%] truncate rounded-md border border-black/8 bg-white/80 px-2 py-0.5 text-[11px] text-black/55"
                  >
                    {chatAttachmentLabel(att)}
                  </span>
                ))}
              </div>
            ) : null}
            {reply ? (
              <div className="lykn-rail-md lykn-chat-ai-text min-w-0 break-words text-[13px] leading-[1.55] text-black">
                <RailMarkdown text={reply} components={mdComponents} />
              </div>
            ) : null}
            <RailSourceChips chatId={id} sources={msg.sources} links={msg.aiWebLinks} />
            {artifacts.length ? (
              <div className="flex flex-col gap-1.5">
                {artifacts.map((art) => (
                  <button
                    key={art.id}
                    type="button"
                    onClick={() => openArtifactInStudioBrowser(art, studioOpenChatOpts(id))}
                    className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-black/10 bg-white/70 px-2.5 py-2 text-left shadow-none transition-colors hover:bg-black/[0.04]"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/80 text-white dark:bg-white/15">
                      <FileText className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-semibold text-black">
                        {art.title}
                      </span>
                      <span className="block text-[10px] text-black/55">
                        {art.kind === "html" ? "Artifact" : (art.format || "file").toUpperCase()}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {(msg as { botWorking?: boolean; botStatus?: string }).botWorking ? (
              <div className="min-w-0 text-[12px] text-black">
                <ThinkingIndicator
                  status={(msg as { botStatus?: string }).botStatus || "Thinking…"}
                  compact
                  tone="brand"
                  bot={(msg as { bot?: { id: string; face: string; eyes: string; color: string } }).bot}
                />
              </div>
            ) : null}
            {images.map((src) => (
              <ChatPopImage
                key={src}
                src={src}
                alt=""
                className="h-auto max-h-40 w-auto max-w-full rounded-lg border border-black/[0.08]"
              />
            ))}
          </div>
        );
      })}
      {showWaiting ? (
        <div className="min-w-0 text-[12px] text-black">
          <ThinkingIndicator
            status={status || "Thinking…"}
            compact
            tone="brand"
            trail={trail}
            bot={liveBot}
          />
        </div>
      ) : null}
      {stopped ? (
        <p className="px-1 text-[11px] text-black/40">Stopped</p>
      ) : null}
    </div>
  );
}