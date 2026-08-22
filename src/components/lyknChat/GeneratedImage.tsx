import React, { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { isLocalBlobUrl } from "@/lib/vault/repository/mediaUrl";

/**
 * A generated image that may no longer be reachable.
 *
 * When the vault is local, Imagine writes its output straight to disk and the
 * chat turn records a `lykn-blob://` URL. That URL is durable in the only
 * sense that matters day to day — reload the chat on this Mac and the image is
 * there — but it is not portable and it is not permanent: the same chat opened
 * on the web has no way to resolve the scheme, and an image the user never
 * saved is eventually collected by the sweep in electron/localStore/blobs.cjs.
 *
 * Both cases arrive here as a load failure, and both deserve better than a
 * broken-image glyph, so they get a tile that says what happened. Cloud URLs
 * are left alone: those fail transiently while a signed URL is being re-minted,
 * and swapping them for a placeholder would flash on every expiry.
 */
export default function GeneratedImage({
  src,
  alt,
  className,
  style,
  loading,
  draggable,
}: {
  src: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  loading?: "lazy" | "eager";
  draggable?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  // A retry or a new batch reuses this slot; forget the previous failure.
  useEffect(() => setFailed(false), [src]);

  if (failed && isLocalBlobUrl(src)) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1.5 bg-black/[0.04] px-3 text-center text-black/40 dark:bg-white/[0.05] dark:text-white/40 ${className || ""}`}
        style={style}
        title="This image was kept on the Mac that generated it. Save an image to the vault to keep it for good."
      >
        <ImageOff className="h-4 w-4" />
        <span className="text-[11px] leading-tight">Not on this device</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      loading={loading}
      draggable={draggable}
      onError={() => setFailed(true)}
    />
  );
}
