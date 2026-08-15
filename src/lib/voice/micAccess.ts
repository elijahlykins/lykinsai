/**
 * Microphone access for dictation and Voice Mode.
 *
 * In a browser, `getUserMedia` shows Chrome's own permission prompt. Inside the
 * Electron shell it does not: macOS gates the mic behind TCC, and the system
 * "Allow LYKN to use the microphone?" dialog only appears when the MAIN process
 * calls `systemPreferences.askForMediaAccess`. Without that, `getUserMedia`
 * either rejects or hands back a silent track, which is why the mic buttons
 * appeared to do nothing.
 *
 * Every mic entry point should go through `requestMicStream` so the OS prompt
 * happens first and failures come back as a message we can show the user.
 */

type MicBridge = {
  ensureMic?: () => Promise<boolean>;
  micStatus?: () => Promise<string>;
  openMicSettings?: () => void;
};

export type MicErrorCode = "unsupported" | "os-denied" | "denied" | "no-device" | "failed";

export class MicAccessError extends Error {
  code: MicErrorCode;

  constructor(code: MicErrorCode, message: string) {
    super(message);
    this.name = "MicAccessError";
    this.code = code;
  }
}

function getBridge(): MicBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { lykn?: MicBridge; lyknOverlay?: MicBridge };
  if (typeof w.lykn?.ensureMic === "function") return w.lykn;
  if (typeof w.lyknOverlay?.ensureMic === "function") return w.lyknOverlay;
  return null;
}

/** True when running inside the desktop shell (where the OS gates the mic). */
export function isDesktopMicHost(): boolean {
  return getBridge() !== null;
}

/** Open System Settings → Privacy & Security → Microphone (desktop only). */
export function openMicSettings(): void {
  try {
    getBridge()?.openMicSettings?.();
  } catch {
    /* ignore */
  }
}

/**
 * Ask the OS for microphone access. Resolves true when the app may record.
 * On the web there is nothing to ask at this level — Chrome prompts on
 * getUserMedia — so this resolves true and the browser prompt does the work.
 */
export async function ensureMicPermission(): Promise<boolean> {
  const bridge = getBridge();
  if (!bridge?.ensureMic) return true;
  try {
    return (await bridge.ensureMic()) !== false;
  } catch {
    // Bridge missing the handler (older shell) — let getUserMedia try anyway.
    return true;
  }
}

/**
 * Prompt for microphone access if needed, then open a stream.
 * Throws `MicAccessError` with a user-facing message when it can't.
 */
export async function requestMicStream(
  constraints: MediaStreamConstraints = { audio: true },
): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new MicAccessError("unsupported", "This device can't record audio.");
  }

  if (!(await ensureMicPermission())) {
    throw new MicAccessError(
      "os-denied",
      "LYKN needs microphone access. Enable LYKN under System Settings → Privacy & Security → Microphone, then try again.",
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err: unknown) {
    throw new MicAccessError(micErrorCode(err), micErrorMessage(err));
  }
}

function micErrorCode(err: unknown): MicErrorCode {
  const name = (err as { name?: string })?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-device";
  return "failed";
}

/** User-facing copy for any mic failure, including MicAccessError. */
export function micErrorMessage(err: unknown): string {
  if (err instanceof MicAccessError) return err.message;
  switch (micErrorCode(err)) {
    case "denied":
      return isDesktopMicHost()
        ? "Microphone access was denied. Enable LYKN under System Settings → Privacy & Security → Microphone."
        : "Microphone access was denied. Allow it in your browser's site settings and try again.";
    case "no-device":
      return "No microphone was found. Connect one and try again.";
    default:
      return "Couldn't start the microphone. Try again.";
  }
}
