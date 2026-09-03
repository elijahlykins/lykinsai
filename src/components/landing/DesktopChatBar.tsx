import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  AudioLines,
  ChevronDown,
  Code,
  ImagePlus,
  MessageCircle,
  Mic,
  Plus,
  Telescope,
} from "lucide-react";
import { BotMark } from "@/components/bots/BotAvatar";

export const DESKTOP_CHAT_MODES = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "build", label: "Build", icon: Code },
  { id: "imagine", label: "Imagine", icon: ImagePlus },
  { id: "research", label: "Research", icon: Telescope },
] as const;

export type DesktopChatMode = (typeof DESKTOP_CHAT_MODES)[number]["id"];

const PLACEHOLDERS: Record<DesktopChatMode, string> = {
  chat: "Ask me anything...",
  build: "Describe what you want to build...",
  imagine: "Describe the image you want...",
  research: "What should I research?",
};

const PROMPT_IDEAS: { mode: DesktopChatMode; text: string }[] = [
  { mode: "chat", text: "What's due on my calendar this week?" },
  { mode: "build", text: "Build a simple habit tracker" },
  { mode: "research", text: "Research Tesla's latest AI chip" },
  { mode: "imagine", text: "A poster for Friday's launch" },
  { mode: "chat", text: "Summarize the files on my desktop" },
];

function useCycledPrompt(
  enabled: boolean,
  onModeChange?: (id: DesktopChatMode) => void,
) {
  const [typed, setTyped] = useState("");
  const jumpRef = useRef<(index: number) => void>(() => {});
  const modeRef = useRef(onModeChange);
  modeRef.current = onModeChange;

  useEffect(() => {
    if (!enabled) {
      setTyped("");
      return;
    }
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let i = 0;
    let pos = 0;
    let phase: "type" | "hold" | "delete" = "type";
    let timer = 0;
    let stopped = false;

    const idea = () => PROMPT_IDEAS[i];
    const applyMode = () => modeRef.current?.(idea().mode);

    const clear = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
    };

    const schedule = (fn: () => void, ms: number) => {
      clear();
      timer = window.setTimeout(fn, ms);
    };

    const startAt = (index: number) => {
      i = ((index % PROMPT_IDEAS.length) + PROMPT_IDEAS.length) % PROMPT_IDEAS.length;
      pos = 0;
      phase = "type";
      setTyped("");
      applyMode();
      if (reduced) {
        setTyped(idea().text);
        return;
      }
      schedule(tick, 280);
    };

    const tick = () => {
      if (stopped || reduced) return;
      const text = idea().text;
      if (phase === "type") {
        pos += 1;
        setTyped(text.slice(0, pos));
        if (pos >= text.length) {
          phase = "hold";
          schedule(tick, 2100);
        } else {
          schedule(tick, 40);
        }
        return;
      }
      if (phase === "hold") {
        phase = "delete";
        schedule(tick, 20);
        return;
      }
      pos -= 1;
      setTyped(text.slice(0, Math.max(0, pos)));
      if (pos <= 0) {
        startAt(i + 1);
        return;
      }
      schedule(tick, 18);
    };

    jumpRef.current = startAt;
    startAt(0);
    return () => {
      stopped = true;
      clear();
    };
  }, [enabled]);

  return { typed, jumpTo: (index: number) => jumpRef.current(index) };
}

/** Types `text` out once on mount, then leaves it in place. */
function useTypedOnce(text: string | undefined, enabled: boolean) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!enabled || !text) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTyped(text);
      return;
    }
    setTyped("");
    let pos = 0;
    let timer = 0;
    const tick = () => {
      pos += 1;
      setTyped(text.slice(0, pos));
      if (pos < text.length) timer = window.setTimeout(tick, 42);
    };
    timer = window.setTimeout(tick, 420);
    return () => window.clearTimeout(timer);
  }, [text, enabled]);
  return typed;
}

const ICON_BTN =
  "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-black/60 transition-colors hover:bg-black/10 hover:text-black/85";

export function DesktopModePills({
  mode,
  onChange,
  className = "",
}: {
  mode: DesktopChatMode;
  onChange: (id: DesktopChatMode) => void;
  className?: string;
}) {
  return (
    <div className={`gl-desk-modes ${className}`.trim()} aria-hidden="true">
      {DESKTOP_CHAT_MODES.map(({ id, label, icon: Icon }) => {
        const on = id === mode;
        return (
          <button
            key={id}
            type="button"
            className={`gl-desk-mode${on ? " is-on" : ""}`}
            onClick={() => onChange(id)}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Marketing replica of the Home desktop chat bar (HomeChatBar).
 * Visual only: focus / Enter / send funnel into the live landing demo.
 */
export default function DesktopChatBar({
  onActivate,
  className = "",
  showModes = true,
  mode: modeProp,
  onModeChange,
  cyclePrompts = false,
  staticPrompt,
  typeStaticPrompt = false,
}: {
  onActivate?: () => void;
  className?: string;
  showModes?: boolean;
  mode?: DesktopChatMode;
  onModeChange?: (id: DesktopChatMode) => void;
  cyclePrompts?: boolean;
  /** Fixed text shown in the bar instead of the cycled prompt ideas. */
  staticPrompt?: string;
  /** Type the static prompt out once on mount instead of showing it whole. */
  typeStaticPrompt?: boolean;
}) {
  const [internalMode, setInternalMode] = useState<DesktopChatMode>("chat");
  const { typed, jumpTo } = useCycledPrompt(cyclePrompts, onModeChange);
  const typedOnce = useTypedOnce(staticPrompt, typeStaticPrompt);
  const mode = modeProp ?? internalMode;
  const setMode = (id: DesktopChatMode) => {
    onModeChange?.(id);
    if (modeProp == null) setInternalMode(id);
    onActivate?.();
    if (cyclePrompts) {
      const idx = PROMPT_IDEAS.findIndex((idea) => idea.mode === id);
      if (idx >= 0) jumpTo(idx);
    }
  };

  return (
    <div className={`gl-desk-bar ${className}`.trim()}>
      {showModes ? (
        <DesktopModePills mode={mode} onChange={setMode} />
      ) : null}

      <div className="lykn-home-chat-bar lg-desktop-surface gl-desk-composer">
        <button
          type="button"
          className="gl-desk-bot"
          title="Talk to a Bot"
          aria-label="Talk to a Bot"
          onClick={onActivate}
        >
          <BotMark className="h-[19px] w-[19px]" />
          <ChevronDown className="h-3 w-3 shrink-0 opacity-40" />
        </button>
        <button
          type="button"
          className={ICON_BTN}
          title="Add from Vault or Finder"
          aria-label="Add from Vault or Finder"
          onClick={onActivate}
        >
          <Plus className="h-4 w-4" />
        </button>
        <textarea
          id="landing-desktop-ask"
          name="landing-desktop-ask"
          className="lykn-home-chat-bar-input gl-desk-ask"
          rows={1}
          value={
            staticPrompt != null
              ? typeStaticPrompt
                ? typedOnce
                : staticPrompt
              : cyclePrompts
                ? typed
                : undefined
          }
          placeholder={staticPrompt || cyclePrompts ? "" : PLACEHOLDERS[mode]}
          autoComplete="off"
          aria-label="Ask LYKN"
          readOnly
          onFocus={onActivate}
          onKeyDown={
            onActivate
              ? (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onActivate();
                  }
                }
              : undefined
          }
        />
        <button
          type="button"
          className={ICON_BTN}
          title="Dictate"
          aria-label="Dictate"
          onClick={onActivate}
        >
          <Mic className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={ICON_BTN}
          title="Voice Mode: talk hands-free"
          aria-label="Voice Mode"
          onClick={onActivate}
        >
          <AudioLines className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="lykn-chat-send-btn gl-desk-send"
          title="Send"
          aria-label="Send"
          onClick={onActivate}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
