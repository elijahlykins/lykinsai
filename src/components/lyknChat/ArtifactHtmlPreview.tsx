import React, { useEffect, useRef, useState } from "react";
import { isTrustedHtmlPreviewHost, preferInlineHtmlPreview, safeHtmlPreviewUrl } from "@/lib/safeExternalUrl";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";

const IFRAME_SANDBOX_SRCDOC =
  "allow-scripts allow-popups allow-forms allow-presentation";

export function isTrustedArtifactMessage(
  ev: MessageEvent,
  previewUrl: string | null | undefined,
  iframe: HTMLIFrameElement | null,
): boolean {
  if (iframe?.contentWindow && ev.source === iframe.contentWindow) {
    return true;
  }
  const origin = String(ev.origin || "");
  if (origin === "null") return false;
  if (typeof window !== "undefined" && origin === window.location.origin) return true;
  try {
    if (previewUrl) {
      const previewOrigin = new URL(previewUrl).origin;
      if (origin === previewOrigin) return true;
    }
  } catch {
    /* ignore bad preview URL */
  }
  try {
    return isTrustedHtmlPreviewHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export type ArtifactHtmlPreviewProps = {
  title: string;
  srcDoc?: string;
  previewUrl?: string | null;
  className?: string;
  iframeRef?: React.Ref<HTMLIFrameElement>;
  /** Called when the runner reports a runtime/console error. */
  onRuntimeError?: (err: { message: string; kind: string; at: number }) => void;
  onReady?: () => void;
};

/**
 * Sandboxed HTML artifact frame. The iframe stays mounted so the runner can
 * post ready/error, but the user only sees it after a clean ready. Syntax
 * and mount failures stay behind the building placeholder instead of a red dump.
 */
export default function ArtifactHtmlPreview({
  title,
  srcDoc,
  previewUrl,
  className = "",
  iframeRef,
  onRuntimeError,
  onReady,
}: ArtifactHtmlPreviewProps) {
  const localRef = useRef<HTMLIFrameElement | null>(null);
  const [phase, setPhase] = useState<"booting" | "ready" | "error">("booting");
  const htmlPreview = previewUrl ? safeHtmlPreviewUrl(previewUrl) : null;
  const useSrcDoc = Boolean(srcDoc) && (!htmlPreview || preferInlineHtmlPreview(previewUrl));
  const frameKey = useSrcDoc ? `srcdoc:${String(srcDoc).length}` : String(previewUrl || "");
  // Only React artifact builds embed the runner that posts ready/error.
  // Plain HTML documents (reports, written docs) never postMessage, so
  // holding the cover for them left "Opening the preview…" up forever.
  const runnerDoc = useSrcDoc && /lykn-artifact/.test(String(srcDoc || ""));

  useEffect(() => {
    setPhase("booting");
  }, [frameKey]);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const data = ev?.data;
      if (!data || data.source !== "lykn-artifact") return;
      if (!isTrustedArtifactMessage(ev, previewUrl || null, localRef.current)) return;
      if (data.type === "ready") {
        setPhase((prev) => (prev === "error" ? prev : "ready"));
        onReady?.();
        return;
      }
      if (data.type !== "runtime_error" && data.type !== "console_error") return;
      const message = String(data.message || "").trim().slice(0, 2000);
      if (!message) return;
      if (data.type === "runtime_error") setPhase("error");
      onRuntimeError?.({
        message,
        kind: String(data.kind || data.type || "error"),
        at: typeof data.at === "number" ? data.at : Date.now(),
      });
    };
    window.addEventListener("message", onMsg);
    // Remote hosted previews may never postMessage. Srcdoc RUNNER documents
    // always do (ready after a successful mount, or runtime_error) — do not
    // auto-reveal one that never checked out. Plain srcdoc documents reveal
    // on iframe load instead (see onLoad below).
    const timeout = useSrcDoc
      ? 0
      : window.setTimeout(() => {
          setPhase((prev) => (prev === "booting" ? "ready" : prev));
        }, 8000);
    return () => {
      window.removeEventListener("message", onMsg);
      if (timeout) window.clearTimeout(timeout);
    };
  }, [frameKey, previewUrl, onReady, onRuntimeError, useSrcDoc]);

  const setRefs = (el: HTMLIFrameElement | null) => {
    localRef.current = el;
    if (!iframeRef) return;
    if (typeof iframeRef === "function") iframeRef(el);
    else iframeRef.current = el;
  };

  if (!useSrcDoc && !htmlPreview) return null;

  const cover =
    phase !== "ready" ? (
      <div className="absolute inset-0 z-20 flex items-center justify-center bg-white dark:bg-zinc-950">
        <ThinkingIndicator
          status={
            phase === "error"
              ? "This preview isn't ready yet. Ask to fix it."
              : "Opening the preview…"
          }
        />
      </div>
    ) : null;

  return (
    <div className={`relative h-full w-full ${className}`}>
      {useSrcDoc ? (
        <iframe
          ref={setRefs}
          title={title}
          srcDoc={srcDoc}
          className="h-full w-full border-0 bg-white"
          sandbox={IFRAME_SANDBOX_SRCDOC}
          referrerPolicy="no-referrer"
          onLoad={() => {
            // A plain document has no runner to post ready — loaded is ready.
            if (!runnerDoc) setPhase((prev) => (prev === "booting" ? "ready" : prev));
          }}
        />
      ) : (
        <iframe
          ref={setRefs}
          title={title}
          src={htmlPreview!.url}
          className="h-full w-full border-0 bg-white"
          sandbox={htmlPreview!.sandbox}
          referrerPolicy="no-referrer"
        />
      )}
      {cover}
    </div>
  );
}
