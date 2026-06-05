import { API_BASE_URL } from "@/lib/api-config";
import { supabase } from "@/lib/supabase";
import { afterVaultNoteSaved } from "@/lib/vault/afterVaultSave";
import { uploadFileToStorage } from "@/lib/vault/uploadFileToStorage";

export const VOICE_NOTE_MIN_BYTES = 2000;

export function preferredAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  return MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
}

export function deriveVoiceNoteTitle(transcript: string): string {
  const line = String(transcript || "")
    .split(/\n/)[0]
    ?.trim()
    .replace(/\s+/g, " ");
  if (!line) return "Voice Note";
  return line.length > 72 ? `${line.slice(0, 69)}…` : line;
}

export async function transcribeVaultAudio(
  blob: Blob,
  opts?: { promptHint?: string; fileName?: string },
): Promise<{ transcript: string } | { error: string }> {
  if (!blob || blob.size < VOICE_NOTE_MIN_BYTES) {
    return { error: "Recording too short — try speaking a bit longer." };
  }

  const formData = new FormData();
  formData.append("audio", blob, opts?.fileName || "voice-note.webm");
  formData.append("model", "whisper-1");
  formData.append("language", "en");
  const hint = String(opts?.promptHint || "").trim();
  if (hint) formData.append("prompt", hint);

  const res = await fetch(`${API_BASE_URL}/api/ai/transcribe`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: String(data?.error || "Transcription failed") };
  }

  const transcript = String(data?.text || "").trim();
  if (!transcript) {
    return { error: "Couldn't pick up any speech — try again." };
  }
  return { transcript };
}

function buildVoiceNoteContent(
  transcript: string,
  attachment?: {
    url: string;
    storagePath: string;
    mimeType: string;
    size: number;
  },
): string {
  if (!attachment?.url) return transcript;
  const payload = [{
    type: "audio",
    url: attachment.url,
    name: "Voice recording",
    storagePath: attachment.storagePath,
    storageBucket: "user-files",
    size: attachment.size,
    mimeType: attachment.mimeType,
  }];
  return `${transcript}\n\n[ATTACHMENTS_JSON:${JSON.stringify(payload)}]`;
}

async function insertVoiceNoteRow(
  userId: string,
  title: string,
  content: string,
): Promise<{ note: Record<string, unknown> } | { error: string }> {
  const richInsert = {
    user_id: userId,
    title,
    content,
    source: "voice_note",
    tags: ["voice"],
  };

  let insertedNote: Record<string, unknown> | null = null;
  let noteError: { message?: string; code?: string } | null = null;

  ({ data: insertedNote, error: noteError } = await supabase
    .from("notes")
    .insert(richInsert)
    .select("id, title, content, tags, created_at, updated_at")
    .single());

  const missingColumnError =
    noteError &&
    (
      noteError.code === "PGRST204" ||
      noteError.message?.includes("Could not find") ||
      String(noteError.message || "").toLowerCase().includes("does not exist")
    );

  if (missingColumnError) {
    ({ data: insertedNote, error: noteError } = await supabase
      .from("notes")
      .insert({ user_id: userId, title, content })
      .select("id, title, content, created_at, updated_at")
      .single());
  }

  if (noteError || !insertedNote?.id) {
    return { error: noteError?.message || "Unable to save voice note." };
  }
  return { note: insertedNote };
}

export async function saveVoiceNoteToVault(opts: {
  userId: string;
  transcript: string;
  audioBlob?: Blob | null;
  mimeType?: string;
}): Promise<{ ok: true; note: Record<string, unknown> } | { ok: false; error: string }> {
  const { userId, transcript } = opts;
  const title = deriveVoiceNoteTitle(transcript);
  let content = transcript;
  const mimeType = opts.mimeType || opts.audioBlob?.type || preferredAudioMimeType();

  if (opts.audioBlob && opts.audioBlob.size >= VOICE_NOTE_MIN_BYTES) {
    try {
      const fileId = crypto.randomUUID();
      const ext = mimeType.includes("mp4") ? "m4a" : "webm";
      const storagePath = `${userId}/${fileId}/original.${ext}`;
      const uploaded = await uploadFileToStorage({
        file: opts.audioBlob,
        userId,
        storagePath,
        contentType: mimeType,
      });
      const url = uploaded.signedUrl || uploaded.publicUrl;
      if (url) {
        content = buildVoiceNoteContent(transcript, {
          url,
          storagePath,
          mimeType,
          size: opts.audioBlob.size,
        });
      }
    } catch {
      // Keep transcript-only note if storage upload fails.
    }
  }

  const inserted = await insertVoiceNoteRow(userId, title, content);
  if ("error" in inserted) {
    return { ok: false, error: inserted.error };
  }

  afterVaultNoteSaved(userId, String(inserted.note.id), { title, content });
  return { ok: true, note: inserted.note };
}
