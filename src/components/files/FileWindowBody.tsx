/**
 * The one place LYKN turns a file into pixels.
 *
 * Every surface used to carry its own copy of this switch — the Files browser,
 * the chat attachment viewer, the AI's "pull that up", the generated-image
 * lightbox — and they had drifted apart on which formats they admitted to
 * handling. The window frame around this is shared too, so a photo from the
 * Desktop and a photo LYKN drew now open into the same thing.
 */

import { useEffect, useState } from "react";
import { FileQuestion, ImageOff } from "lucide-react";
import { TEXT_PREVIEW_CAP } from "@/components/macfiles/preview";
import { safeHtmlPreviewUrl } from "@/lib/safeExternalUrl";
import type { ResolvedFile } from "@/lib/files/fileSource";

const FILL = "h-full w-full object-contain";
const SHEET =
  "h-full w-full overflow-auto bg-white/70 px-6 py-5 text-left dark:bg-black/30";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-black/55 dark:text-white/55">
      {children}
    </div>
  );
}

function TextBody({ url, fallback }: { url: string; fallback: string }) {
  const [state, setState] = useState<{ status: string; body: string }>(() =>
    fallback ? { status: "ready", body: fallback } : { status: "loading", body: "" },
  );

  useEffect(() => {
    if (fallback || !url) return undefined;
    let cancelled = false;
    setState({ status: "loading", body: "" });
    fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const slice = (await response.text()).slice(0, TEXT_PREVIEW_CAP);
        if (!cancelled) setState({ status: "ready", body: slice });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", body: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [url, fallback]);

  if (state.status === "loading") return <Centered>Reading…</Centered>;
  if (state.status === "error") {
    return <Centered>That file couldn&rsquo;t be read.</Centered>;
  }
  return (
    <pre className={`${SHEET} whitespace-pre-wrap break-words font-mono text-[0.78rem] leading-relaxed text-black/85 dark:text-white/85`}>
      {state.body}
    </pre>
  );
}

/**
 * An image that admits when it has nothing to show. Generated images are the
 * reason: a `lykn-blob://` URL in a chat that synced from another device points
 * at bytes that were never on this one.
 */
function ImageBody({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  if (failed) {
    return (
      <Centered>
        <ImageOff className="h-8 w-8 opacity-40" strokeWidth={1.2} />
        <p>This image isn&rsquo;t on this device.</p>
      </Centered>
    );
  }
  return (
    <img
      src={url}
      alt={name}
      className={FILL}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * A built page, running rather than read as source. The host allowlist and the
 * sandbox both come from `safeHtmlPreviewUrl` so this frame is governed by the
 * same policy as every other artifact preview — an untrusted host gets no frame
 * at all rather than a laxer one.
 */
function HtmlBody({ url, name }: { url: string; name: string }) {
  const preview = safeHtmlPreviewUrl(url);
  if (!preview) {
    return (
      <Centered>
        <FileQuestion className="h-10 w-10 opacity-40" strokeWidth={1.2} />
        <p>This page can&rsquo;t be shown here.</p>
      </Centered>
    );
  }
  return (
    <iframe
      src={preview.url}
      title={name}
      sandbox={preview.sandbox}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}

export default function FileWindowBody({
  file,
  onOpenExternally,
}: {
  file: ResolvedFile;
  onOpenExternally?: (() => void) | null;
}) {
  switch (file.media) {
    case "image":
      return <ImageBody url={file.url} name={file.name} />;
    case "video":
      return <video src={file.url} controls autoPlay playsInline className={`${FILL} bg-black`} />;
    case "audio":
      return (
        <Centered>
          <audio src={file.url} controls autoPlay className="w-full max-w-sm" />
        </Centered>
      );
    case "pdf":
      return (
        <iframe
          src={file.url}
          title={file.name}
          className="h-full w-full border-0 bg-white"
        />
      );
    case "html":
      return <HtmlBody url={file.url} name={file.name} />;
    case "youtube":
      return (
        <iframe
          src={`https://www.youtube.com/embed/${file.videoId}`}
          title={file.name}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
          allowFullScreen
          className="h-full w-full border-0 bg-black"
        />
      );
    case "text":
      return <TextBody url={file.url} fallback={file.text} />;
    default:
      return (
        <Centered>
          <FileQuestion className="h-10 w-10 opacity-40" strokeWidth={1.2} />
          <p>LYKN can&rsquo;t show this kind of file yet.</p>
          {onOpenExternally && (
            <button
              type="button"
              onClick={onOpenExternally}
              className="rounded-xl bg-black/85 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
            >
              Open in the default app
            </button>
          )}
        </Centered>
      );
  }
}
