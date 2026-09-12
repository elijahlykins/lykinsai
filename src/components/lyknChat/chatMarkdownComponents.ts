import React, { useCallback, useRef } from "react";
import { flattenNodeText } from "@/lib/chatChunks";
import { ChatCodeBlock } from "@/components/lyknChat/ChatCodeBlock";
import { ChatPopImage } from "@/components/lyknChat/LyknMediaPop";
import { handleLyknBrowserClick, studioOpenChatOpts } from "@/lib/lyknChat/openInStudioBrowser";

// ============================================================================
// chatMarkdownComponents — ReactMarkdown component config for chat bubbles
// ============================================================================
// The renderer map ReactMarkdown uses for every assistant reply, extracted
// verbatim from useChatEngine (Wave 3A decomposition, see
// docs/REFACTOR_LOG.md). The performance-critical part is IDENTITY: a new
// components object makes ReactMarkdown drop its memoization and re-walk the
// AST from scratch, so the static map is a module constant and the per-message
// map is cached per msgId below.

// Static, identity-stable markdown components shared across every message.
// Previously this object was recreated on every `buildChatMarkdownComponents`
// call (which fires per-message inside the chat render loop, which itself
// re-runs on every streaming token). A new components object causes
// ReactMarkdown to drop its memoization and re-walk the AST from scratch
// — for a 50-message chat that was thousands of wasted markdown re-parses
// per second during streaming.
export const STATIC_MD_COMPONENTS = {
  h1: ({ children }: any) => React.createElement("h1", { className: "text-xl font-semibold mt-6 mb-2.5 tracking-tight" }, children),
  h2: ({ children }: any) => React.createElement("h2", { className: "text-lg font-semibold mt-5 mb-2 tracking-tight" }, children),
  h3: ({ children }: any) => React.createElement("h3", { className: "text-base font-semibold mt-4 mb-1.5 tracking-tight" }, children),
  p: ({ children }: any) => React.createElement("p", { className: "mb-4 last:mb-0 leading-[1.65] whitespace-pre-wrap" }, children),
  ul: ({ children, className }: any) => {
    const isTaskList = /\bcontains-task-list\b/.test(String(className || ""));
    return React.createElement(
      "ul",
      { className: isTaskList ? "my-3 list-none space-y-1.5 pl-1" : "my-3 list-disc pl-5 space-y-1.5" },
      children,
    );
  },
  ol: ({ children }: any) => React.createElement("ol", { className: "my-3 list-decimal pl-5 space-y-1.5" }, children),
  strong: ({ children }: any) => React.createElement("strong", { className: "font-semibold" }, children),
  blockquote: ({ children }: any) => React.createElement("blockquote", { className: "border-l-2 border-black/20 dark:border-white/20 pl-3 my-2 text-black/70 dark:text-white/70 italic" }, children),
  code: (props: any) => React.createElement(ChatCodeBlock, props),
  pre: ({ children }: any) => React.createElement(React.Fragment, null, children),
  // Inline markdown images — e.g. files the AI pulled in from the user's
  // Mac in Local Mode, or any other ![alt](url) in a reply.
  img: ({ src, alt }: any) =>
    React.createElement(ChatPopImage, {
      src,
      alt: alt || "",
      className:
        "my-3 max-h-[24rem] max-w-full rounded-xl border border-black/[0.08] dark:border-white/[0.08] shadow-none object-contain",
    }),
  a: chatOwnedMarkdownAnchor(),
  table: ({ children }: any) =>
    React.createElement(
      "div",
      {
        // Glass card: translucent surface + backdrop blur, matching
        // ChatArtifactCard / LoadInGreetingBlocks so chat deliverables share
        // one material.
        className:
          "my-4 overflow-hidden rounded-2xl border border-white/40 " +
          "bg-white/50 backdrop-blur-md shadow-none " +
          "dark:border-white/10 dark:bg-white/[0.06]",
      },
      React.createElement(
        "div",
        { className: "overflow-x-auto" },
        React.createElement("table", { className: "w-full min-w-full border-collapse text-[12px]" }, children),
      ),
    ),
  thead: ({ children }: any) =>
    React.createElement(
      "thead",
      { className: "bg-white/35 dark:bg-white/[0.05]" },
      children,
    ),
  tbody: ({ children }: any) => React.createElement("tbody", null, children),
  tr: ({ children }: any) =>
    React.createElement("tr", {
      // Zebra tints stay translucent so the glass blur reads through the rows.
      className:
        "border-b border-black/[0.05] even:bg-white/30 " +
        "dark:border-white/[0.06] dark:even:bg-white/[0.035]",
    }, children),
  th: ({ children }: any) =>
    React.createElement(
      "th",
      {
        className:
          "whitespace-nowrap border-b border-black/[0.08] px-3 py-2 text-left " +
          "text-[10px] font-semibold uppercase tracking-[0.08em] text-black/50 " +
          "dark:border-white/[0.1] dark:text-white/50",
      },
      children,
    ),
  td: ({ children }: any) =>
    React.createElement(
      "td",
      { className: "px-3 py-1.5 text-black/75 dark:text-white/75" },
      children,
    ),
};

/** Compact markdown map for the browser side chat. Same primitives as Home. */
export const BROWSER_MD_COMPONENTS = {
  ...STATIC_MD_COMPONENTS,
  h1: ({ children }: any) =>
    React.createElement("h1", { className: "text-base font-semibold mt-3 mb-1.5 tracking-tight" }, children),
  h2: ({ children }: any) =>
    React.createElement("h2", { className: "text-[15px] font-semibold mt-2.5 mb-1 tracking-tight" }, children),
  h3: ({ children }: any) =>
    React.createElement("h3", { className: "text-sm font-semibold mt-2 mb-1 tracking-tight" }, children),
  p: ({ children }: any) =>
    React.createElement("p", { className: "mb-2 last:mb-0 leading-[1.55] whitespace-pre-wrap" }, children),
  ul: ({ children, className }: any) => {
    const isTaskList = /\bcontains-task-list\b/.test(String(className || ""));
    return React.createElement(
      "ul",
      { className: isTaskList ? "my-2 list-none space-y-1 pl-0.5" : "my-2 list-disc pl-4 space-y-1" },
      children,
    );
  },
  ol: ({ children }: any) =>
    React.createElement("ol", { className: "my-2 list-decimal pl-4 space-y-1" }, children),
  img: ({ src, alt }: any) =>
    React.createElement(ChatPopImage, {
      src,
      alt: alt || "",
      className:
        "my-1.5 max-h-40 max-w-full rounded-lg border border-black/[0.08] dark:border-white/[0.08] object-contain",
    }),
};

/**
 * Markdown `<a>` for a known owning conversation. Omit chatId for unbound opens.
 * Never looks up the active Home chat.
 */
export function chatOwnedMarkdownAnchor(chatId?: string | null) {
  const owned = studioOpenChatOpts(chatId);
  return ({ href, children, ...rest }: any) => {
    const url = String(href || "").trim();
    const isHttp = /^https?:\/\//i.test(url);
    return React.createElement(
      "a",
      {
        ...rest,
        href: url || undefined,
        target: isHttp ? "_blank" : undefined,
        rel: isHttp ? "noopener noreferrer" : undefined,
        className: "underline underline-offset-2 decoration-black/25 dark:decoration-white/25 hover:decoration-black/60 dark:hover:decoration-white/60",
        onClick: (e: React.MouseEvent) => {
          if (!isHttp) return;
          handleLyknBrowserClick(e, url, owned);
        },
      },
      children,
    );
  };
}

/**
 * Per-message markdown component builder.
 *
 * The msg-dependent pieces are `li` (checklist state) and `a` (owning
 * chatId for in-app browser opens). We cache the assembled object per
 * msgId and only invalidate when those inputs change.
 */
export function useChatMarkdownComponents(
  assistantTaskChecks: Record<string, Record<string, boolean>>,
  updateTaskCheck: (msgId: string, taskKey: string, checked: boolean) => void,
  chatId?: string | null,
): (msgId: string) => Record<string, React.ComponentType<any>> {
  const componentsCacheRef = useRef<Map<string, { checks: any; chatId: string; comps: Record<string, React.ComponentType<any>> }>>(new Map());
  const ownedChatId = String(chatId || "").trim();
  return useCallback((msgId: string): Record<string, React.ComponentType<any>> => {
    const checks = assistantTaskChecks[msgId];
    const cached = componentsCacheRef.current.get(msgId);
    if (cached && cached.checks === checks && cached.chatId === ownedChatId) return cached.comps;
    const comps: Record<string, React.ComponentType<any>> = {
      ...STATIC_MD_COMPONENTS,
      a: chatOwnedMarkdownAnchor(ownedChatId),
      li: ({ children, className }: any) => {
        const isTaskItem = /\btask-list-item\b/.test(String(className || ""));
        const raw = flattenNodeText(children).trim();
        const match = raw.match(/^\[( |x|X)\]\s+(.+)$/);
        if (!match && !isTaskItem) return React.createElement("li", { className: "leading-relaxed" }, children);
        let defaultChecked = false;
        let taskText = raw;
        if (match) {
          defaultChecked = String(match[1]).toLowerCase() === "x";
          taskText = match[2];
        } else {
          const nodes = React.Children.toArray(children);
          for (const node of nodes) {
            if (React.isValidElement(node) && (node.props as any)?.type === "checkbox") {
              defaultChecked = Boolean((node.props as any).checked);
              break;
            }
          }
        }
        const taskKey = match ? raw : `[${defaultChecked ? "x" : " "}] ${taskText}`;
        const isChecked = checks?.[taskKey] ?? defaultChecked;
        return React.createElement("li", { className: `list-none ml-0 flex items-start gap-2 leading-relaxed ${isChecked ? "opacity-60" : ""}` },
          React.createElement("input", { type: "checkbox", className: "mt-[0.28rem] shrink-0 accent-blue-500", checked: isChecked, onChange: (e: any) => updateTaskCheck(msgId, taskKey, e.target.checked) }),
          React.createElement("span", { className: isChecked ? "line-through" : "" }, taskText),
        );
      },
    };
    componentsCacheRef.current.set(msgId, { checks, chatId: ownedChatId, comps });
    return comps;
  }, [assistantTaskChecks, updateTaskCheck, ownedChatId]);
}
