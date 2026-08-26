/**
 * Compact live view of a LyknChat thread for the browser rail.
 * The full chat surface stays mounted behind the window; this reads the
 * same in-memory snapshot so replies stream here too.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import {
  CHAT_REHYPE_PLUGINS,
  CHAT_REMARK_PLUGINS,
  normalizeMathDelimiters,
} from "@/lib/chat/chatMarkdown";
import {
  getThreadSnapshot,
  subscribeThreadRuntime,
  type ThreadSnapshot,
} from "@/lib/chat/chatThreadRuntime";
import type { PromptMessage } from "@/lib/lyknChat/chatTurnTypes";
import { ChatPopImage } from "@/components/lyknChat/LyknMediaPop";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import { useBuildThoughtTrail } from "@/hooks/useThinkingStatus";

const MD = {
  img: ({ src, alt }: { src?: string; alt?: string }) => {
    const s = String(src || "");
    if (!/^https?:\/\//i.test(s) && !/^data:image\//i.test(s)) return null;
    return (
      <ChatPopImage
        src={s}
        alt={String(alt || "")}
        className="my-1.5 h-auto max-h-44 w-auto max-w-full rounded-lg border border-white/15"
      />
    );
  },
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-white/30 underline-offset-2 hover:decoration-white/70"
    >
      {children}
    </a>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="mb-2 last:mb-0">{children}</p>
  ),
};

function assistantImages(msg: PromptMessage) {
  const listed = Array.isArray(msg.aiImages) ? msg.aiImages : [];
  const urls = listed.map((img) => String(img?.url || "").trim()).filter(Boolean);
  const single = String(msg.aiImageUrl || "").trim();
  if (single && !urls.includes(single)) urls.unshift(single);
  return urls;
}

function RailMarkdown({ text }: { text: string }) {
  const body = normalizeMathDelimiters(String(text || "").trim());
  if (!body) return null;
  return (
    <ReactMarkdown
      remarkPlugins={CHAT_REMARK_PLUGINS}
      rehypePlugins={CHAT_REHYPE_PLUGINS}
      components={MD}
    >
      {body}
    </ReactMarkdown>
  );
}

function readSnap(chatId: string): ThreadSnapshot | null {
  return getThreadSnapshot(chatId);
}

export default function AttachedChatThread({ chatId }: { chatId: string }) {
  const id = String(chatId || "").trim();
  const [snap, setSnap] = useState<ThreadSnapshot | null>(() => (id ? readSnap(id) : null));
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return undefined;
    const pull = () => setSnap(readSnap(id));
    pull();
    return subscribeThreadRuntime(pull);
  }, [id]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap?.chatMessages, snap?.isChatLoading, snap?.chatStatusText]);

  const messages = snap?.chatMessages || [];
  const loading = !!snap?.isChatLoading;
  const status = String(snap?.chatStatusText || "").trim();
  const trail = useBuildThoughtTrail(status, loading);

  return (
    <div
      ref={threadRef}
      data-attached-chat-thread
      className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 scrollbar-hide"
    >
      {messages.length === 0 && !loading && (
        <p className="px-2 pt-10 text-center text-xs leading-relaxed text-white/40">
          This is the same conversation. Ask a follow-up about the page.
        </p>
      )}
      {messages.map((msg) => {
        const user = String(msg.content || "").trim();
        const reply = String(msg.aiResponse || "").trim();
        const images = assistantImages(msg);
        return (
          <div key={msg.id} className="space-y-2">
            {user ? (
              <div className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-white px-3 py-1.5 text-[0.78rem] leading-relaxed text-black shadow-[0_4px_14px_rgba(0,0,0,0.25)]">
                  {user}
                </div>
              </div>
            ) : null}
            {reply ? (
              <div className="lykn-rail-md break-words text-[0.78rem] leading-relaxed text-white/85">
                <RailMarkdown text={reply} />
              </div>
            ) : null}
            {(msg as { botWorking?: boolean; botStatus?: string; botTrail?: string[] }).botWorking ? (
              // A Bot turn still in flight — same live status line the main
              // chat shows, so the rail never sits on a blank row.
              <div className="min-w-0 text-[0.72rem] text-white/70">
                <ThinkingIndicator
                  status={(msg as { botStatus?: string }).botStatus || "Thinking…"}
                  compact
                  tone="inherit"
                  trail={(msg as { botTrail?: string[] }).botTrail}
                />
              </div>
            ) : null}
            {images.map((src) => (
              <ChatPopImage
                key={src}
                src={src}
                alt=""
                className="h-auto max-h-44 w-auto max-w-full rounded-lg border border-white/15"
              />
            ))}
          </div>
        );
      })}
      {loading && (
        <div className="min-w-0 text-[0.72rem] text-white/70">
          <ThinkingIndicator status={status || "Thinking…"} compact tone="inherit" trail={trail} />
        </div>
      )}
    </div>
  );
}
