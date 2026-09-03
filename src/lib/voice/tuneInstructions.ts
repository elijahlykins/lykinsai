/**
 * Self-tuning voice instructions.
 *
 * When the user tells the assistant to change how it behaves in voice
 * ("turn up the sarcasm by 15%", "be warmer", "talk less"), the voice agent
 * calls the `update_voice_instructions` tool. That tool is handled HERE in the
 * browser — not the server's /api/ai/realtime/tool dispatch — because the
 * user's voice-instruction prompt lives in their local settings, not the DB:
 * we read the current text, ask the server to rewrite it with the suggestion
 * applied, persist the result back to localStorage, and broadcast the
 * settings-changed event so the rest of the app (and the next session's
 * grounding, which reads `voicePrompt` via getAiPrefs) picks it up.
 *
 * Both voice paths (OpenAI Realtime via useRealtimeVoice, ElevenLabs via
 * LyknChatVoiceModeEleven) intercept this tool name and return the JSON string
 * produced here as the tool result the voice model speaks back from.
 */
import { API_BASE_URL } from "@/lib/api-config";

/** Tool name the voice agents call; shared so dispatch interceptors can match it. */
export const TUNE_VOICE_TOOL = "update_voice_instructions";

/** localStorage key shared with SettingsModal / getAiPrefs. */
const SETTINGS_KEY = "lykinsai_settings";

function readVoicePrompt(): string {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return "";
    const s = JSON.parse(raw);
    return typeof s?.voicePrompt === "string" ? s.voicePrompt : "";
  } catch {
    return "";
  }
}

/**
 * Persist a rewritten instruction prompt into the user's local settings and
 * broadcast the settings-changed event so any open Settings UI + the next
 * session's grounding (chat via getAiPrefs, voice via buildVoiceInstructions)
 * pick it up immediately. `scope` selects which field: "voice" → voicePrompt,
 * "chat" → userPrompt (the "Custom instructions" textarea in Settings).
 *
 * Shared by the voice tool (below) and the chat orchestrator, which calls this
 * when the assistant rewrites the user's instructions via the
 * `lykn_update_assistant_instructions` chat tool.
 */
export function persistInstructionPrompt(scope: "chat" | "voice", text: string): void {
  const field = scope === "voice" ? "voicePrompt" : "userPrompt";
  let s: Record<string, unknown> = {};
  try {
    s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
  } catch {
    s = {};
  }
  s[field] = text;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  // Mirror SettingsModal.persistSettings so any open settings UI + the next
  // session's grounding pick up the change immediately.
  try { window.dispatchEvent(new CustomEvent("lykinsai_settings_changed")); } catch { /* ignore */ }
  try { window.dispatchEvent(new Event("storage")); } catch { /* ignore */ }
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const { supabase } = await import("@/lib/supabase");
    const sess = await supabase?.auth?.getSession?.();
    const token = sess?.data?.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* anonymous */ }
  return headers;
}

/**
 * Apply a user's behavior suggestion to their saved voice instructions and
 * persist the rewrite. Returns a JSON string the voice model feeds back as the
 * tool result (always resolves — failures come back as { ok: false }).
 */
export async function applyVoiceInstructionTune(params: unknown): Promise<string> {
  const suggestion = String((params as { suggestion?: unknown })?.suggestion || "").trim();
  if (!suggestion) {
    return JSON.stringify({ ok: false, error: "no_suggestion", message: "I didn't catch what to change." });
  }
  try {
    const current = readVoicePrompt();
    const headers = await authHeaders();
    const res = await fetch(`${API_BASE_URL}/api/ai/tune-instructions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ current, suggestion, scope: "voice" }),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!res.ok || !data?.ok || !data?.instructions) {
      return JSON.stringify({
        ok: false,
        error: data?.error || "tune_failed",
        message: data?.message || "I couldn't update my instructions just now.",
      });
    }
    persistInstructionPrompt("voice", String(data.instructions));
    return JSON.stringify({
      ok: true,
      updated: true,
      summary: data.summary || "updated how I behave in voice",
      message: "Saved. This will shape how I sound from now on.",
    });
  } catch {
    return JSON.stringify({
      ok: false,
      error: "tune_request_failed",
      message: "I couldn't reach the settings service to update that.",
    });
  }
}
