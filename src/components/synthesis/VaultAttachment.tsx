import { useEffect, useMemo, useState } from "react";
import { ExternalLink, LayoutGrid } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  resolveStorageTarget,
  isSupabaseStorageUrl,
  type VaultAttachment as VaultAttachmentData,
} from "@/lib/vaultContent";
import LinkPreview from "@/components/LinkPreview";
import { safeExternalUrl, safeHtmlPreviewUrl } from "@/lib/safeExternalUrl";

// Renders a single Vault attachment in whatever shape best fits its
// `type` field: image / video / YouTube embed / bookmark / spreadsheet
// / generic external link / file. Originally lived inline in
// SynthesisLayer's DetailPanel; extracted so the NeuronPanel can render
// the same media without a circular import back through the page
// module.
//
// Supabase-storage-hosted URLs get re-signed on demand (the public
// storage URLs persisted with older attachments expire after a few
// hours), so the renderer always shows a working preview even when the
// note was saved months ago.

const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "tiff", "avif",
]);

function inferAttachmentType(att: VaultAttachmentData): string {
  const explicit = String(att?.type || "").toLowerCase();
  if (explicit && explicit !== "file") return explicit;
  const rawUrl = String(att?.url || "").trim();
  const name = String(att?.name || att?.title || "").trim();
  const mime = String((att as any)?.mimeType || "").toLowerCase().split(";")[0].trim();
  const extSource = name || rawUrl.split("?")[0].split("/").pop() || "";
  const ext = extSource.split(".").pop()?.toLowerCase() || "";
  if (rawUrl.startsWith("data:image/")) return "image";
  if (rawUrl.startsWith("data:video/")) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (["html", "htm"].includes(ext) || mime === "text/html") return "html";
  if (rawUrl.includes("youtube.com") || rawUrl.includes("youtu.be")) return "youtube";
  return explicit || "file";
}

function linkLabel(att: VaultAttachmentData, rawUrl: string, name: string): string {
  if (name) return name;
  if (isSupabaseStorageUrl(rawUrl)) {
    const pathTail = String(att?.storagePath || rawUrl.split("/").pop() || "").split("/").pop();
    return pathTail || "View file";
  }
  return rawUrl;
}

export default function VaultAttachment({ att, full = false }: { att: VaultAttachmentData; full?: boolean }) {
  const type = inferAttachmentType(att);
  const rawUrl = String(att?.url || "").trim();
  const name = String(att?.name || att?.title || "").trim();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Images can load a smaller rendition (Phase 3 variants): thumb in the
  // compact card, medium in the full view. Video keeps the original (its
  // variant is a poster image, not a playable file).
  const variantPrefer: "thumb" | "medium" | undefined =
    type === "image" ? (full ? "medium" : "thumb") : undefined;
  const storageTarget = useMemo(
    () => resolveStorageTarget(att, variantPrefer ? { prefer: variantPrefer } : undefined),
    [att, variantPrefer],
  );
  // Re-resolve whenever we have a storage path — saved URLs expire, and HTML
  // artifacts need a branded file-proxy URL (correct MIME + frame-ancestors)
  // rather than a raw Supabase signed link.
  const needsSigning = !!storageTarget?.path && !!storageTarget?.bucket;
  const displayUrl = signedUrl || rawUrl;

  useEffect(() => {
    if (!needsSigning || !storageTarget) return;
    let cancelled = false;
    (async () => {
      try {
        if (type === "html") {
          // HTML artifacts need the branded file proxy (MIME + frame-ancestors
          // + script CSP). A raw Supabase signed URL blanks the iframe — never
          // fall through to one for html.
          const { API_BASE_URL } = await import("@/lib/api-config");
          const session = (await supabase.auth.getSession())?.data?.session;
          const token = session?.access_token;
          if (token) {
            const resp = await fetch(`${API_BASE_URL}/api/storage/file-proxy-url`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                storagePath: storageTarget.path,
                bucket: storageTarget.bucket,
                filename: name || "artifact.html",
              }),
            });
            if (resp.ok) {
              const { url } = await resp.json();
              if (!cancelled && url && !/supabase\.co\/storage\//i.test(url)) {
                setSignedUrl(url);
                return;
              }
            }
          }
          if (!cancelled) setFailed(true);
          return;
        }
        const { data } = await supabase.storage
          .from(storageTarget.bucket)
          .createSignedUrl(storageTarget.path, 60 * 60 * 24);
        if (!cancelled && data?.signedUrl) setSignedUrl(data.signedUrl);
        else if (!cancelled) setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsSigning, storageTarget, type, name]);

  if (type === "image") {
    if (needsSigning && !signedUrl) {
      if (failed)
        return (
          <div className="rounded-lg border border-black/5 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03] p-4 flex items-center justify-center">
            <span className="text-[0.6875rem] text-gray-400">Image unavailable</span>
          </div>
        );
      return (
        <div className="rounded-lg border border-black/5 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03] h-[120px] flex items-center justify-center animate-pulse">
          <span className="text-[0.625rem] text-gray-400">Loading…</span>
        </div>
      );
    }
    return (
      <div className="rounded-lg overflow-hidden border border-black/5 dark:border-white/8">
        <img
          src={displayUrl}
          alt={name}
          className={full ? "w-full max-h-[78vh] object-contain bg-black/5 dark:bg-white/5" : "w-full max-h-[240px] object-cover"}
          loading="lazy"
        />
        {name && !full && (
          <p className="text-[0.625rem] text-gray-400 dark:text-gray-500 px-2 py-1 truncate">
            {name}
          </p>
        )}
      </div>
    );
  }

  if (type === "video" && !att?.videoId) {
    if (needsSigning && !signedUrl && !failed) {
      return (
        <div className="rounded-lg border border-black/5 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03] h-[120px] flex items-center justify-center animate-pulse">
          <span className="text-[0.625rem] text-gray-400">Loading…</span>
        </div>
      );
    }
    if (displayUrl) {
      return (
        <div className="rounded-lg overflow-hidden border border-black/5 dark:border-white/8">
          <video
            src={displayUrl}
            controls
            playsInline
            preload="metadata"
            className={full ? "w-full max-h-[78vh]" : "w-full max-h-[200px]"}
          />
          {name && (
            <p className="text-[0.625rem] text-gray-400 dark:text-gray-500 px-2 py-1 truncate">
              {name}
            </p>
          )}
        </div>
      );
    }
  }

  if ((type === "youtube" || att?.videoId) && (att?.videoId || rawUrl)) {
    const videoId =
      att?.videoId || rawUrl.match(/(?:youtu\.be\/|v=)([^&\s]+)/)?.[1];
    if (videoId) {
      return (
        <div className="rounded-lg overflow-hidden border border-black/5 dark:border-white/8">
          <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
            <iframe
              src={`https://www.youtube.com/embed/${videoId}`}
              className="absolute inset-0 w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
              allowFullScreen
            />
          </div>
          {name && (
            <p className="text-[0.625rem] text-gray-400 dark:text-gray-500 px-2 py-1 truncate">
              {name}
            </p>
          )}
        </div>
      );
    }
  }

  if ((type === "bookmark" || type === "link") && rawUrl) {
    // Bookmarks carry full Open Graph metadata when they were saved
    // through the Vault's "Save link" flow (`image`, `description`,
    // `siteName`, `favicon`, plus optional oembed for tweets / etc.).
    // Render the rich `LinkPreview` card so the neuron panel matches
    // the way the same bookmark appears in the Vault grid — a tile
    // with a hero image, favicon + site name, title, and snippet —
    // rather than the single-line chip we used to show here. Bookmarks
    // saved before the OG-aware flow shipped (or by older mobile
    // versions) just have a url + title; LinkPreview degrades to a
    // chip with the favicon in that case, so the fallback is still
    // graceful.
    return (
      <LinkPreview
        url={rawUrl}
        title={String(att?.title || name || "")}
        description={String(att?.description || "")}
        image={String(att?.image || "")}
        siteName={String(att?.siteName || "")}
        favicon={String(att?.favicon || "")}
        authorName={String(att?.authorName || "")}
        authorHandle={String(att?.authorHandle || "")}
        oembedType={String(att?.oembedType || "")}
        variant="vault"
      />
    );
  }

  if (type === "spreadsheet") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/5 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03]">
        <LayoutGrid size={12} className="text-emerald-400 flex-shrink-0" />
        <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">
          {name || "Spreadsheet"}
        </span>
        {att?.rows && att?.cols && (
          <span className="text-[0.575rem] text-gray-400 ml-auto">
            {att.rows}×{att.cols}
          </span>
        )}
      </div>
    );
  }

  if (type === "html") {
    if (needsSigning && !signedUrl && !failed) {
      return (
        <div className="rounded-lg border border-black/5 dark:border-white/8 bg-[#15130f] h-[180px] flex items-center justify-center animate-pulse">
          <span className="text-[0.625rem] text-white/45">Loading preview…</span>
        </div>
      );
    }
    const htmlPreview = safeHtmlPreviewUrl(signedUrl || (!needsSigning ? displayUrl : ""));
    if (htmlPreview) {
      return (
        <div className="rounded-lg overflow-hidden border border-black/5 dark:border-white/8 bg-[#15130f]">
          {name ? (
            <p className="text-[0.625rem] text-gray-500 dark:text-gray-400 px-2 py-1 truncate border-b border-black/5 dark:border-white/8 bg-white dark:bg-transparent">
              {name}
            </p>
          ) : null}
          <iframe
            src={htmlPreview.url}
            title={name || "Artifact preview"}
            className={full ? "w-full h-[min(60vh,480px)] border-0" : "w-full h-[180px] border-0"}
            sandbox={htmlPreview.sandbox}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        </div>
      );
    }
    if (failed || needsSigning) {
      return (
        <div className="rounded-lg border border-black/5 dark:border-white/8 bg-[#15130f] h-[180px] flex items-center justify-center">
          <span className="text-[0.625rem] text-white/45">Preview unavailable</span>
        </div>
      );
    }
  }

  if (rawUrl) {
    const label = linkLabel(att, rawUrl, name);
    // Only render a clickable anchor for safe schemes — a `javascript:` URL in
    // a stored attachment would otherwise execute on click.
    const safeUrl = safeExternalUrl(rawUrl);
    if (!safeUrl) {
      return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/5 dark:border-white/8">
          <ExternalLink size={12} className="text-gray-400 flex-shrink-0" />
          <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">
            {label}
          </span>
        </div>
      );
    }
    return (
      <a
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-black/5 dark:border-white/8 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
      >
        <ExternalLink size={12} className="text-gray-400 flex-shrink-0" />
        <span className="text-[0.6875rem] text-gray-600 dark:text-gray-300 truncate">
          {label}
        </span>
      </a>
    );
  }

  return null;
}
