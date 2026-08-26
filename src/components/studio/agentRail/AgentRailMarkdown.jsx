// Agent rail markdown — renders agent answers in the narrow dark-glass
// thread: the same remark/rehype pipeline as the main chat, plus the
// `lykn-agent-step://` deliverable pills, typed-out notes, and the step
// transcript layout the runtime streams.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Link as LinkIcon } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import {
  CHAT_REMARK_PLUGINS,
  CHAT_REHYPE_PLUGINS,
  normalizeMathDelimiters,
} from "@/lib/chat/chatMarkdown";
import { ChatPopImage } from "@/components/lyknChat/LyknMediaPop";
import LyknOutlineSpinner from "@/components/lyknChat/LyknOutlineSpinner";
import { openStudioLink } from "@/components/studio/studioLinks";

/**
 * Deliverable pill for `![lykn_step:kind:title](lykn-agent-step://agent/idx)`
 * markers in agent answers — click opens that step's report/artifact/image in
 * the agent's browser subtab (same behavior as the Glass overlay's step chips).
 */
function railStepStatus(src) {
  const m = /lykn-agent-step:\/\/[^/]+\/\d+\/(live|pending|done)/i.exec(String(src || ""));
  return (m?.[1] || "done").toLowerCase();
}

export function draftHasLiveStep(text) {
  return /lykn-agent-step:\/\/[^)\s]+\/live\b/i.test(String(text || ""));
}

export function answerIsStepTranscript(text) {
  return /lykn-agent-step:\/\//i.test(String(text || ""));
}

/** Reasoning rides in the marker title as one " · "-joined line; show it as lines. */
function splitRailStepDetail(detail) {
  return String(detail || "")
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);
}

function RailStepPill({ src, alt, title: detail }) {
  const m = /^lykn-agent-step:\/\/([^/]+)\/(\d+)/i.exec(String(src || ""));
  const agentId = m?.[1] || "";
  const stepIndex = m ? Number(m[2]) : null;
  let title = String(alt || "").replace(/^lykn[-_]step\s*:/i, "").trim();
  const kt = String(alt || "").match(/^lykn[-_]step\s*:([^:]+):(.+)$/i);
  if (kt) title = String(kt[2] || title).trim();
  const shortTitle =
    title.replace(/^\s*step\s+\d+\s*[—–\-·:]\s*/i, "").trim() || "Step";
  const status = railStepStatus(src);
  const pending = status === "pending";
  const live = status === "live";
  const reasonLines = splitRailStepDetail(detail);
  // A step that can account for itself opens on click; the browser is a button
  // inside it. Steps with nothing to say still jump straight to the page.
  const expandable = reasonLines.length > 0 && !pending;
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`my-1 w-full max-w-full overflow-hidden rounded-lg border border-white/10 text-[0.72rem] ${
        open ? "bg-white/[0.08]" : "bg-white/[0.05]"
      } ${pending ? "pointer-events-none opacity-40" : ""}`}
    >
      <button
        type="button"
        title={expandable ? "Show what the agent was doing" : status === "done" ? "Open this step" : ""}
        disabled={pending}
        onClick={() => {
          if (pending) return;
          if (expandable) {
            setOpen((v) => !v);
            return;
          }
          if (stepIndex == null) return;
          void window.lykn?.agentShowStep?.(agentId, stepIndex);
        }}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition ${
          live ? "text-white/75" : "text-white/85 hover:bg-white/[0.06]"
        }`}
      >
        {live ? (
          <LyknOutlineSpinner size={14} className="flex-none" />
        ) : pending ? (
          <span className="mx-0.5 h-2 w-2 flex-none rounded-full bg-white/30" aria-hidden="true" />
        ) : (
          <span
            className="flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full bg-emerald-400/20 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.45)]"
            aria-hidden="true"
          >
            <Check className="h-2.5 w-2.5 text-emerald-200" strokeWidth={3.4} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-white/90">{shortTitle}</span>
        {expandable ? (
          <ChevronRight
            className={`h-3 w-3 flex-none text-white/30 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {expandable && open ? (
        <div className="border-t border-white/10 px-2.5 py-2 pl-[30px] text-[0.7rem] leading-relaxed text-white/70">
          {reasonLines.map((line, i) => (
            <p key={i} className={i ? "mt-1.5" : ""}>
              {line}
            </p>
          ))}
          {status === "done" && stepIndex != null ? (
            <button
              type="button"
              onClick={() => void window.lykn?.agentShowStep?.(agentId, stepIndex)}
              className="mt-2 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[0.68rem] text-white/75 transition hover:bg-white/10 hover:text-white"
            >
              Open in the browser
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Markdown for the agent rail — same remark/rehype pipeline as the main chat,
// with components sized for the narrow dark-glass thread.
const RAIL_MD_COMPONENTS = {
  img: ({ src, alt, title }) => {
    const s = String(src || "");
    const a = String(alt || "");
    // Deliverable step markers render as clickable "open" pills, not images.
    if (/^lykn-agent-step:\/\//i.test(s) || /^lykn[-_]step\s*:/i.test(a)) {
      return <RailStepPill src={s} alt={a} title={String(title || "")} />;
    }
    if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) {
      return (
        <ChatPopImage
          src={s}
          alt={a}
          className="my-1.5 h-auto max-h-44 w-auto max-w-full rounded-lg border border-white/15"
        />
      );
    }
    // Unknown lykn-* markers: never show a broken-image glyph.
    return null;
  },
  p: (props) => <p className="mb-1.5 last:mb-0" {...props} />,
  ul: (props) => <ul className="mb-1.5 list-disc space-y-0.5 pl-4 last:mb-0" {...props} />,
  ol: (props) => <ol className="mb-1.5 list-decimal space-y-0.5 pl-4 last:mb-0" {...props} />,
  li: (props) => <li className="leading-relaxed" {...props} />,
  h1: (props) => <p className="mb-1 mt-2 text-[0.82rem] font-bold text-white first:mt-0" {...props} />,
  h2: (props) => <p className="mb-1 mt-2 text-[0.8rem] font-bold text-white first:mt-0" {...props} />,
  h3: (props) => <p className="mb-1 mt-1.5 text-[0.78rem] font-semibold text-white first:mt-0" {...props} />,
  h4: (props) => <p className="mb-1 mt-1.5 text-[0.78rem] font-semibold text-white/90 first:mt-0" {...props} />,
  strong: (props) => <strong className="font-semibold text-white" {...props} />,
  a: ({ children, href, ...props }) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 text-sky-300 underline underline-offset-2 hover:text-sky-200"
      onClick={(e) => {
        const u = String(href || "").trim();
        if (!u || !/^https?:\/\//i.test(u)) return;
        e.preventDefault();
        openStudioLink(u);
      }}
    >
      <LinkIcon className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
      <span className="min-w-0 truncate">{children}</span>
    </a>
  ),
  blockquote: (props) => (
    <blockquote className="mb-1.5 border-l-2 border-white/25 pl-2 text-white/70" {...props} />
  ),
  hr: () => <div className="my-2 border-t border-white/15" />,
  code: (props) => (
    <code
      className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.7rem] text-white/90"
      {...props}
    />
  ),
  pre: (props) => (
    <pre
      className="mb-1.5 overflow-x-auto rounded-lg bg-black/40 p-2 text-[0.7rem] leading-relaxed last:mb-0 [&>code]:bg-transparent [&>code]:p-0"
      {...props}
    />
  ),
  table: (props) => (
    <div className="mb-1.5 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-[0.7rem]" {...props} />
    </div>
  ),
  th: (props) => (
    <th className="border border-white/15 bg-white/[0.06] px-1.5 py-1 text-left font-semibold" {...props} />
  ),
  td: (props) => <td className="border border-white/15 px-1.5 py-1 align-top" {...props} />,
};

/**
 * react-markdown blanks any URL whose scheme it doesn't recognize, and that
 * silently emptied the `src` of every agent step marker: the pill still drew
 * itself from the alt text, but with no agent id, no index and no status, so
 * every step in the rail showed a finished check and none of them could be
 * opened. Step markers are minted by the agent runtime rather than coming from
 * page content, so this one scheme is safe to pass through; everything else
 * still goes through the default sanitizer.
 */
function railUrlTransform(url) {
  const u = String(url || "");
  if (/^lykn-agent-step:\/\//i.test(u)) return u;
  return defaultUrlTransform(u);
}

function RailMarkdown({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={CHAT_REMARK_PLUGINS}
      rehypePlugins={CHAT_REHYPE_PLUGINS}
      components={RAIL_MD_COMPONENTS}
      urlTransform={railUrlTransform}
    >
      {normalizeMathDelimiters(String(children || ""))}
    </ReactMarkdown>
  );
}

const RAIL_STEP_LINE_RE =
  /^!\[([^\]]*)\]\((lykn-agent-step:\/\/[^)\s]+)(?:\s+"([^"]*)")?\)$/i;

/**
 * Split a step transcript into pills, the explanation under each one, and
 * any closing summary after the `---` seam the runtime inserts.
 */
function parseRailStepBlocks(md) {
  const lines = String(md || "")
    .replace(/\s+$/, "")
    .split("\n");
  const blocks = [];
  let i = 0;
  let proseI = 0;
  while (i < lines.length) {
    const m = RAIL_STEP_LINE_RE.exec(lines[i].trim());
    if (m) {
      const src = m[2];
      const idxMatch = /lykn-agent-step:\/\/([^/]+)\/(\d+)/i.exec(src);
      const agentId = idxMatch?.[1] || "";
      const stepIndex = idxMatch?.[2] || String(blocks.length);
      blocks.push({
        kind: "step",
        key: `step-${agentId}-${stepIndex}`,
        alt: m[1],
        src,
        title: m[3] || "",
      });
      i += 1;
      const noteLines = [];
      while (i < lines.length) {
        const next = lines[i].trim();
        if (RAIL_STEP_LINE_RE.test(next) || /^---+$/.test(next)) break;
        noteLines.push(lines[i]);
        i += 1;
      }
      const note = noteLines.join("\n").trim();
      if (note) {
        blocks.push({
          kind: "note",
          key: `note-${agentId}-${stepIndex}`,
          text: note,
        });
      }
      continue;
    }
    if (/^---+$/.test(lines[i].trim())) {
      i += 1;
      continue;
    }
    const proseLines = [];
    while (i < lines.length) {
      const next = lines[i].trim();
      if (RAIL_STEP_LINE_RE.test(next)) break;
      if (/^---+$/.test(next)) {
        i += 1;
        break;
      }
      proseLines.push(lines[i]);
      i += 1;
    }
    const text = proseLines.join("\n").trim();
    if (text) {
      blocks.push({ kind: "prose", key: `prose-${proseI++}`, text });
    }
  }
  return blocks;
}

/**
 * Type an explanation out word by word. Finished history snaps to the full
 * text; a live note grows toward whatever the runtime last sent.
 */
function TypedRailNote({ text, animate }) {
  const target = String(text || "");
  const [shown, setShown] = useState(() => (animate ? "" : target));
  const shownRef = useRef(animate ? "" : target);
  const targetRef = useRef(target);
  shownRef.current = shown;
  targetRef.current = target;

  useEffect(() => {
    if (!animate) {
      setShown(target);
      shownRef.current = target;
      return undefined;
    }
    if (target !== shownRef.current && !target.startsWith(shownRef.current)) {
      setShown("");
      shownRef.current = "";
    }
    let timer = 0;
    const stepMs = target.length > 220 ? 12 : target.length > 80 ? 16 : 22;
    const tick = () => {
      const nextTarget = targetRef.current;
      const prev = shownRef.current;
      if (prev === nextTarget) return;
      const rest = nextTarget.startsWith(prev) ? nextTarget.slice(prev.length) : nextTarget;
      const m = rest.match(/^(\s+|\S+)/);
      const next = (nextTarget.startsWith(prev) ? prev : "") + (m ? m[1] : rest);
      shownRef.current = next;
      setShown(next);
      if (next !== nextTarget) timer = window.setTimeout(tick, stepMs);
    };
    if (shownRef.current !== target) timer = window.setTimeout(tick, stepMs);
    return () => window.clearTimeout(timer);
  }, [animate, target]);

  useEffect(() => {
    const el = document.querySelector("[data-agent-thread]");
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  if (!shown) return null;
  return <RailMarkdown>{shown}</RailMarkdown>;
}

function RailStepTranscript({ text, animate = false }) {
  const blocks = parseRailStepBlocks(text);
  if (!blocks.length) return <RailMarkdown>{text}</RailMarkdown>;
  let lastTypedKey = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "note" || blocks[i].kind === "prose") {
      lastTypedKey = blocks[i].key;
      break;
    }
  }
  return (
    <div className="space-y-2">
      {blocks.map((b) => {
        if (b.kind === "step") {
          return <RailStepPill key={b.key} src={b.src} alt={b.alt} title={b.title} />;
        }
        if (b.kind === "note") {
          return (
            <div key={b.key} className="pl-1 text-white/70">
              <TypedRailNote text={b.text} animate={animate && b.key === lastTypedKey} />
            </div>
          );
        }
        return (
          <div key={b.key}>
            <TypedRailNote text={b.text} animate={animate && b.key === lastTypedKey} />
          </div>
        );
      })}
    </div>
  );
}

export function RailAgentBody({ text, animate = false }) {
  const body = String(text || "");
  if (!body) return null;
  if (answerIsStepTranscript(body)) {
    return <RailStepTranscript text={body} animate={animate} />;
  }
  return <RailMarkdown>{body}</RailMarkdown>;
}
