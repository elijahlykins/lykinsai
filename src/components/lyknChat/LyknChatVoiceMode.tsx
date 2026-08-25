import React from "react";
import { useRealtimeVoice, type RealtimeVoiceState } from "@/hooks/useRealtimeVoice";
import { isElevenLabsVoice } from "@/lib/voice/voiceConfig";
import LyknChatVoiceModeEleven from "./LyknChatVoiceModeEleven";
import VoiceModePopup from "./VoiceModePopup";
import VoiceTechOrb from "./VoiceTechOrb";

interface LyknChatVoiceModeProps {
  open: boolean;
  onClose: () => void;
  chatId?: string | null;
  voice?: string;
  /** Build the LYKN-grounded system instructions for the voice session. */
  buildInstructions?: () => string | Promise<string>;
  /** Persist a finalized user voice turn into the chat thread. */
  onUserTranscript?: (text: string) => void;
  /** Persist a finalized assistant voice reply into the chat thread. */
  onAssistantReply?: (text: string) => void;
  /**
   * Pull a saved vault item up on screen — fired when the agent calls the
   * `display_document` tool. The payload is a ChatNeuronVaultPayload the host
   * renders in the embedded document reader.
   */
  onDisplayDocument?: (payload: unknown) => void;
  /**
   * Handle a paste / file / link from the in-session paste bar: mirror it into
   * the written chat and return a text summary to inject into the live voice
   * session so the agent can "see" what was shared. Returns "" if nothing
   * usable was pasted.
   */
  onAttach?: (input: { files?: File[]; text?: string }) => Promise<string>;
}

const STATUS_COPY: Record<RealtimeVoiceState, string> = {
  idle: "Paused",
  connecting: "Connecting…",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

export default function LyknChatVoiceMode(props: LyknChatVoiceModeProps) {
  // Provider switch: keep the working OpenAI Realtime path as default; the
  // ElevenLabs path is its own component (different SDK + provider tree).
  if (isElevenLabsVoice) {
    return <LyknChatVoiceModeEleven {...props} />;
  }
  return <LyknChatVoiceModeOpenAI {...props} />;
}

function LyknChatVoiceModeOpenAI({ open, onClose, chatId, voice, buildInstructions, onUserTranscript, onAssistantReply, onDisplayDocument }: LyknChatVoiceModeProps) {
  const { state, micLevel, errorText, interrupt, retry } =
    useRealtimeVoice({ active: open, chatId, voice, buildInstructions, onUserTranscript, onAssistantReply, onDisplayDocument });

  return (
    <VoiceModePopup open={open} onClose={onClose}>
      <button
        type="button"
        onClick={interrupt}
        className="relative flex items-center justify-center outline-none"
        style={{ width: 148, height: 148 }}
        title={state === "speaking" ? "Tap to interrupt" : undefined}
        aria-label="Voice orb"
      >
        <VoiceTechOrb state={state} micLevel={micLevel} size={148} />
      </button>

      {/* Status only — live transcript/reply are intentionally hidden here
          (they read as confusing/glitchy mid-turn). The full conversation
          is persisted to the chat thread instead. */}
      <div className="mt-1 flex flex-col items-center gap-1.5 text-center px-2">
        <span className="text-foreground/75 text-sm font-medium">
          {state === "error" ? (errorText || STATUS_COPY.error) : STATUS_COPY[state]}
        </span>
        {state === "error" && (
          <button
            type="button"
            onClick={() => void retry()}
            className="mt-0.5 px-3 py-1 rounded-full bg-foreground/10 hover:bg-foreground/15 text-foreground/80 text-xs transition-colors"
          >
            Try again
          </button>
        )}
      </div>
    </VoiceModePopup>
  );
}
