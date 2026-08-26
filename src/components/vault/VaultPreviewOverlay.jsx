// VaultPreviewOverlay renders the Vault's expanded-card experience: the
// LyknMediaPop lightbox with media/type-specific bodies, the details rail
// (projects, tags, why-I-saved-this, comments CRUD), and the share sheet
// anchored to its Share button (VaultPreviewShareMenu). Extracted verbatim
// from src/pages/Vault.jsx (Vault decomposition phase, see
// docs/REFACTOR_LOG.md); the page still owns all preview state and passes it
// down, so open/close/edit behavior is unchanged.
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Copy,
  Download,
  FileText,
  Globe,
  Layers,
  Link as LinkIcon,
  Loader2,
  Maximize2,
  MessageCircle,
  Mic,
  Music,
  Pencil,
  Plus,
  Share,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { CHAT_REMARK_PLUGINS, CHAT_REHYPE_PLUGINS } from "@/lib/chat/chatMarkdown";
import LinkPreview from "@/components/LinkPreview";
import { SocialEmbedInline } from "@/components/media/SocialEmbedInline";
import LyknMediaPop from "@/components/lyknChat/LyknMediaPop";
import WhyEditor from "@/components/vault/WhyEditor";
import { renderConnectorListCard } from "@/components/vault/vaultCardRenderers";
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from "@/lib/media/youtube";
import { looksLikeImageAttachment, resolveRenderType } from "@/lib/vault/attachmentType";
import { safeExternalUrl, safeAttachmentUrl, safeHtmlPreviewUrl } from "@/lib/safeExternalUrl";
import {
  parseAttachmentsFromNote,
  stripAttachmentsMarker,
} from "@/lib/vault/attachmentsMarker";
import {
  isSupabaseStorageUrlText,
  isVoiceNoteCard,
  parseAttachmentNotes,
  parseQuickNoteComments,
  parseStorageTarget,
  sanitizeCardTitle,
  vaultPdfEmbedUrl,
} from "@/lib/vault/vaultCardHelpers";
import { removeWakeVaultPreviewQuickNote } from "@/lib/wake/wakeVaultPreviewQuickNotes";

const resolveAttachmentType = resolveRenderType;

export default function VaultPreviewOverlay({
  addAttachmentNote,
  addCardToProject,
  addQuickNoteComment,
  addWakePreviewCardComment,
  blockWakePreviewVaultMutation,
  chatAboutPreviewCard,
  confirmAndDeleteAttachment,
  drainUrlResolveQueue,
  driveMarkup,
  failedImageIds,
  imageRetryCountsRef,
  isCardActionBusy,
  isWakePreview,
  notes,
  openCardFullyInBrowser,
  previewCard,
  previewCommentComposerOpen,
  previewCommentDraft,
  previewDetailsOpen,
  previewEditingCommentId,
  previewFullUrl,
  previewProjectDropdownOpen,
  previewProjectDropdownRef,
  previewShareMenuRect,
  projects,
  removeAttachmentNote,
  removeQuickNoteCard,
  removeQuickNoteComment,
  removeWakePreviewCardComment,
  resolvePreviewShareText,
  resolvePreviewShareUrl,
  resolvedAttachmentUrls,
  saveCardWhy,
  setFailedImageIds,
  setOpenCardMenuId,
  setOpenCardMenuRect,
  setPreviewCard,
  setPreviewCommentComposerOpen,
  setPreviewCommentDraft,
  setPreviewDetailsOpen,
  setPreviewEditingCommentId,
  setPreviewFullUrl,
  setPreviewProjectDropdownOpen,
  setPreviewShareMenuRect,
  setResolvedAttachmentUrls,
  setTagPickerCardId,
  setTagPickerPosition,
  setWakePreviewQuickNotes,
  signedUrlCacheRef,
  updateAttachmentNote,
  updateQuickNoteComment,
  updateWakePreviewCardComment,
  urlResolveQueueRef,
  vaultCards,
  visibleCardIdsRef,
}) {
  return createPortal(
        (() => {
          // Prefer the live vaultCards entry so comment deletes (and other
          // in-place edits) reflect immediately without reopening preview.
          const card =
            vaultCards.find((c) => c.id === previewCard.id) || previewCard;
          const att = card.attachment || {};
          const previewStorageTarget =
            parseStorageTarget(att) || parseStorageTarget(att, "medium");
          const previewIsStorageBacked = !!(previewStorageTarget?.bucket && previewStorageTarget?.path);
          let type = card.type || resolveAttachmentType(att) || card.kind;
          // Storage images must never render as bookmark/file — that path
          // paints the raw supabase URL via LinkPreview / download links.
          const attLooksLikeImage =
            looksLikeImageAttachment(att) ||
            looksLikeImageAttachment({
              ...att,
              name: att.name || previewStorageTarget?.path || "",
              url: att.url || "",
            });
          if (
            card.kind === "attachment" &&
            attLooksLikeImage &&
            !["video", "audio", "pdf", "html", "youtube"].includes(String(type))
          ) {
            type = "image";
          }
          // Fresh signed URLs only — never fall back to attachment.url for
          // images (those are often expired signed storage links that then
          // surface as visible text in bookmark/file fallbacks).
          const signedOnly =
            previewFullUrl || resolvedAttachmentUrls[card.id] || "";
          const resolvedUrl =
            type === "image"
              ? signedOnly
              : (signedOnly || (!isSupabaseStorageUrlText(att.url) ? String(att.url || "") : "") || "");
          const imagePreviewUrl = signedOnly;
          const title = sanitizeCardTitle(
            card.title || att.name || "",
            card.kind === "quick-note" ? (card.label || "Quick Note") : (type === "image" ? "Image" : "Vault Item"),
          );
          const previewImageFailed = type === "image" && failedImageIds.has(card.id);
          const previewImageLoading =
            type === "image" && !previewImageFailed && !imagePreviewUrl && previewIsStorageBacked;
          const retryPreviewImage = () => {
            imageRetryCountsRef.current.delete(card.id);
            setFailedImageIds((prev) => {
              const next = new Set(prev);
              next.delete(card.id);
              return next;
            });
            if (previewStorageTarget?.bucket && previewStorageTarget?.path) {
              signedUrlCacheRef.current.delete(
                `${previewStorageTarget.bucket}:${previewStorageTarget.path}`,
              );
            }
            setResolvedAttachmentUrls((prev) => {
              const next = { ...prev };
              delete next[card.id];
              return next;
            });
            setPreviewFullUrl(null);
            visibleCardIdsRef.current.delete(card.id);
            urlResolveQueueRef.current.push(card);
            drainUrlResolveQueue();
          };
          const cardTags = Array.isArray(card.tags) ? card.tags : [];
          const previewNote = card.noteId
            ? notes.find((n) => String(n?.id) === String(card.noteId))
            : null;
          const previewWhy = String(previewNote?.why || "").trim();
          // Prefer live note body from the query cache so formatting stays
          // intact even if the card was built before `body` was attached.
          const previewTextBody = String(
            previewNote?.content
              ? stripAttachmentsMarker(String(previewNote.content)).replace(/\r\n/g, "\n").trim()
              : (card.body || card.excerpt || ""),
          ).trim();
          const canEditWhy = !isWakePreview && !!card.noteId;
          const videoId = type === "youtube"
            ? (extractYouTubeVideoId(String(att.url || "")) || String(att.videoId || "").trim() || null)
            : null;
          const youtubeEmbedUrl = videoId ? getYouTubeEmbedUrl(videoId) : "";

          let body;
          if (card.kind === "attachment" && type === "image") {
            if (previewImageFailed) {
              body = (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center px-6 h-full">
                  <FileText className="w-14 h-14 text-black/25 dark:text-white/25" />
                  <p className="text-sm text-black/60 dark:text-white/60">{title}</p>
                  <p className="text-xs text-black/40 dark:text-white/40">Preview unavailable</p>
                  <button
                    type="button"
                    onClick={retryPreviewImage}
                    className="text-sm font-medium text-blue-500 hover:text-blue-600 transition-colors"
                  >
                    Try again
                  </button>
                </div>
              );
            } else if (previewImageLoading || !imagePreviewUrl) {
              body = (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center h-full">
                  <Loader2 className="w-8 h-8 text-black/25 dark:text-white/25 animate-spin" />
                  <p className="text-sm text-black/45 dark:text-white/45">Loading image…</p>
                  {previewIsStorageBacked ? (
                    <button
                      type="button"
                      onClick={retryPreviewImage}
                      className="text-xs font-medium text-blue-500 hover:text-blue-600 transition-colors"
                    >
                      Try again
                    </button>
                  ) : null}
                </div>
              );
            } else {
              body = (
                <img
                  src={imagePreviewUrl}
                  alt={title}
                  className="max-h-full max-w-full w-auto h-auto object-contain bg-black/[0.03]"
                  draggable={false}
                  onError={() => {
                    setFailedImageIds((prev) => new Set(prev).add(card.id));
                  }}
                />
              );
            }
          } else if (card.kind === "attachment" && type === "video") {
            body = (
              <video
                src={resolvedUrl}
                controls
                autoPlay
                playsInline
                className="max-h-full max-w-full w-auto h-auto object-contain rounded-xl bg-black"
              />
            );
          } else if (card.kind === "attachment" && type === "audio") {
            const voiceNote = isVoiceNoteCard(card);
            body = (
              <div className="flex flex-col items-center justify-center gap-4 py-8 h-full">
                {voiceNote ? (
                  <Mic className="w-14 h-14 text-black/40 dark:text-white/40" />
                ) : (
                  <Music className="w-14 h-14 text-black/40 dark:text-white/40" />
                )}
                <p className="text-sm text-black/70 dark:text-white/70 text-center">{title}</p>
                <audio src={resolvedUrl} controls autoPlay className="w-full max-w-xl" />
              </div>
            );
          } else if (card.kind === "attachment" && type === "pdf") {
            body = (
              <iframe
                title={title}
                src={vaultPdfEmbedUrl(resolvedUrl)}
                className="w-full h-full min-h-[24rem] rounded-xl border border-white/30 dark:border-white/10 bg-white"
              />
            );
          } else if (card.kind === "attachment" && type === "html") {
            const htmlStorage = parseStorageTarget(att);
            const htmlIsStorage = !!(htmlStorage?.bucket && htmlStorage?.path);
            const markup = driveMarkup[card.id] || "";
            // Non-storage artifacts may still frame their original safe URL.
            // Storage-backed artifacts render from fetched markup above.
            const candidate =
              resolvedAttachmentUrls[card.id] || (!htmlIsStorage ? resolvedUrl : "");
            const htmlEmbed = /supabase\.co\/storage\//i.test(candidate || "")
              ? null
              : safeHtmlPreviewUrl(candidate);
            body = htmlEmbed ? (
              <iframe
                title={title}
                src={htmlEmbed.url}
                className="w-full h-full min-h-[24rem] rounded-xl border border-white/30 dark:border-white/10 bg-[#15130f]"
                sandbox={htmlEmbed.sandbox}
                referrerPolicy="no-referrer"
              />
            ) : markup ? (
              <iframe
                title={title}
                srcDoc={markup}
                className="w-full h-full min-h-[24rem] rounded-xl border border-white/30 dark:border-white/10 bg-white"
                sandbox="allow-scripts allow-popups allow-forms allow-modals allow-presentation"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 py-10 text-center h-full">
                <FileText className="w-14 h-14 text-black/30 dark:text-white/30" />
                <p className="text-sm text-black/70 dark:text-white/70">
                  {failedImageIds.has(card.id) ? "Preview unavailable" : "Loading preview…"}
                </p>
              </div>
            );
          } else if (card.kind === "attachment" && type === "youtube") {
            const isMockDemoYoutube = Boolean(card.isDemo && !youtubeEmbedUrl);
            if (isMockDemoYoutube) {
              body = (
                <div className="flex flex-col items-center justify-center gap-5 py-20 px-6 text-center rounded-xl bg-black/5 dark:bg-white/5 h-full">
                  <div className="w-16 h-11 bg-red-600 rounded-xl flex items-center justify-center shadow-lg">
                    <svg viewBox="0 0 24 24" fill="white" className="w-7 h-7 ml-0.5" aria-hidden>
                      <polygon points="8,5 20,12 8,19" />
                    </svg>
                  </div>
                  <p className="text-base font-medium text-black/75 dark:text-white/80">Sample YouTube video</p>
                </div>
              );
            } else if (youtubeEmbedUrl) {
              body = (
                <iframe
                  title={title}
                  src={youtubeEmbedUrl}
                  className="w-full h-full min-h-[22rem] rounded-xl border-0 bg-black"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              );
            } else {
              body = (
                <a href={safeExternalUrl(att.url) || undefined} target="_blank" rel="noreferrer" className="text-sm text-blue-500 underline">
                  Open YouTube video
                </a>
              );
            }
          } else if (card.kind === "attachment" && (type === "instagram" || type === "tiktok" || type === "facebook")) {
            body = (
              <div className="w-full h-full max-h-full overflow-auto rounded-xl">
                <SocialEmbedInline
                  platform={type}
                  oembedHtml={String(att.oembedHtml || "")}
                  url={String(att.url || resolvedUrl || "")}
                  thumbnailUrl={att.image || att.thumbnail_url || ""}
                  title={att.title || title || ""}
                  authorName={att.authorName || ""}
                  authorHandle={att.authorHandle || ""}
                />
              </div>
            );
          } else if (card.kind === "attachment" && type === "bookmark" && att.connectorList) {
            body = renderConnectorListCard(att, title, { expanded: true });
          } else if (card.kind === "attachment" && type === "bookmark") {
            body = (
              <div className="space-y-4">
                <LinkPreview
                  url={att.url || resolvedUrl || ""}
                  title={att.title || title || ""}
                  description={String(att.description || "")}
                  image={att.image || ""}
                  siteName={att.siteName || ""}
                  favicon={att.favicon || ""}
                  authorName={att.authorName || ""}
                  authorHandle={att.authorHandle || ""}
                  oembedType={att.oembedType || ""}
                  variant="vault"
                />
                {att.articleText && (
                  <div className="rounded-xl bg-white/40 dark:bg-white/5 border border-white/40 dark:border-white/10 px-4 py-3 max-h-[min(40vh,22rem)] overflow-y-auto text-sm text-black/80 dark:text-white/80 whitespace-pre-wrap">
                    {att.articleText}
                  </div>
                )}
                {(() => {
                  const openHref = safeAttachmentUrl(att.url || resolvedUrl);
                  if (!openHref || isSupabaseStorageUrlText(openHref)) return null;
                  return (
                    <a
                      href={openHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-500 hover:text-blue-600"
                    >
                      <Globe className="w-3.5 h-3.5" />
                      Open link in new tab
                    </a>
                  );
                })()}
              </div>
            );
          } else if (card.kind === "attachment" && type === "spreadsheet") {
            const cells = att.cells || {};
            const totalRows = Math.min(Number(att.rows) || 0, 200);
            const totalCols = Math.min(Number(att.cols) || 0, 50);
            body = (
              <div className="rounded-xl overflow-auto h-full max-h-full border border-white/30 dark:border-white/10 bg-white/60 dark:bg-white/5">
                <table className="w-full border-collapse text-xs">
                  <tbody>
                    {Array.from({ length: totalRows }, (_, r) => (
                      <tr key={r} className={r === 0 ? "bg-black/5 dark:bg-white/10 font-semibold" : ""}>
                        {Array.from({ length: totalCols }, (_, c) => (
                          <td key={c} className="px-2.5 py-1.5 border-b border-r border-black/6 dark:border-white/6 text-black/80 dark:text-white/80 whitespace-nowrap">
                            {cells[`${r},${c}`] || ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          } else if (card.kind === "attachment") {
            const safeDownload = safeAttachmentUrl(resolvedUrl);
            const hideStorageLink = isSupabaseStorageUrlText(safeDownload || resolvedUrl || "");
            body = (
              <div className="flex flex-col items-center gap-4 py-10 text-center">
                <FileText className="w-14 h-14 text-black/30 dark:text-white/30" />
                <p className="text-sm text-black/70 dark:text-white/70 break-words max-w-lg">{title}</p>
                {previewIsStorageBacked ? (
                  <button
                    type="button"
                    onClick={retryPreviewImage}
                    className="text-sm font-medium text-blue-500 hover:text-blue-600 transition-colors"
                  >
                    Try again
                  </button>
                ) : safeDownload && !hideStorageLink ? (
                  <a
                    href={safeDownload}
                    target="_blank"
                    rel="noreferrer"
                    download={title}
                    className="text-xs font-medium text-blue-500 hover:text-blue-600 underline"
                  >
                    Open / download file
                  </a>
                ) : null}
              </div>
            );
          } else if (card.kind === "quick-note") {
            const useMarkdown = !!(card.formatted || (card.noteStyle && card.noteStyle !== "quick"));
            body = (
              <div className="rounded-xl bg-white/45 dark:bg-white/5 border border-white/40 dark:border-white/10 px-5 py-4 h-full max-h-full overflow-y-auto">
                {useMarkdown ? (
                  <div className="vault-note-md text-sm text-black/85 dark:text-white/85 leading-relaxed break-words">
                    <style>{`
                      .vault-note-md h1 { font-size: 1.35rem; font-weight: 700; margin: 0 0 0.75em; }
                      .vault-note-md h2 { font-size: 1.1rem; font-weight: 600; margin: 1.25em 0 0.5em; }
                      .vault-note-md h3 { font-size: 1rem; font-weight: 600; margin: 1em 0 0.4em; }
                      .vault-note-md p { margin: 0 0 0.85em; white-space: pre-wrap; }
                      .vault-note-md ul, .vault-note-md ol { margin: 0 0 0.85em; padding-left: 1.35em; }
                      .vault-note-md ul { list-style: disc; }
                      .vault-note-md ol { list-style: decimal; }
                      .vault-note-md li { margin: 0.25em 0; }
                      .vault-note-md li + li { margin-top: 0.35em; }
                      .vault-note-md strong { font-weight: 600; }
                      .vault-note-md hr { margin: 1em 0; border-color: rgba(0,0,0,0.1); }
                      .dark .vault-note-md hr { border-color: rgba(255,255,255,0.12); }
                    `}</style>
                    <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={CHAT_REHYPE_PLUGINS}>
                      {previewTextBody}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-black/85 dark:text-white/85 whitespace-pre-wrap break-words leading-relaxed">
                    {previewTextBody}
                  </p>
                )}
              </div>
            );
          } else if (card.kind === "chat-preview") {
            body = (
              <div className="space-y-3 h-full max-h-full overflow-y-auto">
                {card.question && (
                  <div className="rounded-xl bg-white/45 dark:bg-white/5 border border-white/40 dark:border-white/10 px-4 py-3">
                    <div className="text-[0.625rem] uppercase tracking-wide text-black/45 dark:text-white/45 mb-1">You</div>
                    <p className="text-sm text-black/85 dark:text-white/85 whitespace-pre-wrap break-words">{card.question}</p>
                  </div>
                )}
                {card.answer && (
                  <div className="rounded-xl bg-black/5 dark:bg-white/[0.03] border border-black/8 dark:border-white/8 px-4 py-3">
                    <div className="text-[0.625rem] uppercase tracking-wide text-black/45 dark:text-white/45 mb-1">Assistant</div>
                    <p className="text-sm text-black/85 dark:text-white/85 whitespace-pre-wrap break-words">{card.answer}</p>
                  </div>
                )}
                {card.turnsCount ? (
                  <div className="text-[0.6875rem] text-black/50 dark:text-white/50">{card.turnsCount} turns in this thread</div>
                ) : null}
              </div>
            );
          } else {
            body = (
              <div className="text-sm text-black/60 dark:text-white/60">No preview available.</div>
            );
          }

          const canExpandExternally =
            card.kind === "attachment" &&
            ["html", "image", "video", "audio", "pdf", "youtube", "bookmark", "link", "file", "spreadsheet"].includes(
              String(type || resolveAttachmentType(att) || ""),
            );
          const shareUrl =
            type === "image"
              ? (previewFullUrl || resolvedUrl)
              : (resolvedUrl || String(att.url || ""));
          const openTagsPicker = (anchorEl) => {
            if (!card.noteId) return;
            const rect = anchorEl?.getBoundingClientRect?.();
            setOpenCardMenuId(null);
            setTagPickerCardId(card.id);
            setTagPickerPosition(
              rect
                ? { left: rect.left, top: rect.bottom + 8 }
                : { left: 24, top: 96 },
            );
          };
          const deleteFromPreview = () => {
            if (isWakePreview && card.isWakePreviewNote) {
              const ok = window.confirm(`Are you sure you want to delete "${card.title || "Quick Note"}"? This cannot be undone.`);
              if (!ok) return;
              removeWakeVaultPreviewQuickNote(card.id);
              setWakePreviewQuickNotes((prev) => prev.filter((note) => note.id !== card.id));
              setPreviewCard(null);
              return;
            }
            if (blockWakePreviewVaultMutation(card)) return;
            if (card.kind === "attachment") {
              confirmAndDeleteAttachment(card);
              setPreviewCard(null);
              return;
            }
            const ok = window.confirm(`Are you sure you want to delete "${card.title || "Quick Note"}"? This cannot be undone.`);
            if (!ok) return;
            void removeQuickNoteCard(card);
            setPreviewCard(null);
          };
          const togglePreviewShare = (event) => {
            event.stopPropagation();
            if (previewShareMenuRect) {
              setPreviewShareMenuRect(null);
              return;
            }
            setPreviewProjectDropdownOpen(false);
            setOpenCardMenuId(null);
            setOpenCardMenuRect(null);
            setTagPickerCardId(null);
            const rect = event.currentTarget.getBoundingClientRect();
            const anchor = {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            };
            const nativeShare = window.lykn?.nativeShare;
            if (typeof nativeShare === "function") {
              const safeUrl = resolvePreviewShareUrl(card, shareUrl);
              // Images, video, PDFs and files share as attachments; artifacts
              // and links share as a URL (that's what the recipient needs).
              const shareType = String(type || resolveAttachmentType(att) || "");
              const shareAsFile =
                card.kind === "attachment" &&
                ["image", "video", "audio", "pdf", "file", "spreadsheet"].includes(shareType);
              void nativeShare({
                title: title || "LYKN vault item",
                text: resolvePreviewShareText(card),
                url: safeUrl || "",
                asFile: shareAsFile,
                filename: String(att.name || title || ""),
                x: Math.round(rect.left),
                y: Math.round(rect.bottom),
              })
                .then((result) => {
                  // A main process from before the last restart still answers
                  // `ok` while showing nothing, so require the current API too:
                  // otherwise the click has no visible effect at all.
                  if (!result?.ok || result.api !== 2) setPreviewShareMenuRect(anchor);
                })
                .catch(() => setPreviewShareMenuRect(anchor));
              return;
            }
            setPreviewShareMenuRect(anchor);
          };

          return (
            <LyknMediaPop
              open
              onClose={() => setPreviewCard(null)}
              title={title || "Preview"}
              zIndex={9999}
            >
              <div className="flex max-h-[min(78vh,820px)] w-[min(96vw,980px)] flex-col overflow-hidden">
                <div className="mb-2 flex items-center justify-end gap-0.5 self-end rounded-full border border-black/10 bg-white/80 px-1.5 py-1 backdrop-blur-2xl dark:border-white/12 dark:bg-black/45">
                    {canExpandExternally ? (
                      <button
                        type="button"
                        onClick={() => { void openCardFullyInBrowser(card); }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-black/55 hover:bg-black/[0.06] hover:text-black/85 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white transition-colors"
                        title="Open in a separate window"
                        aria-label="Open in a separate window"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setPreviewDetailsOpen((open) => !open)}
                      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                        previewDetailsOpen
                          ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white"
                          : "text-black/55 hover:bg-black/[0.06] hover:text-black/85 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white"
                      }`}
                      title={previewDetailsOpen ? "Hide details" : "Show details"}
                      aria-label={previewDetailsOpen ? "Hide details" : "Show details"}
                      aria-pressed={previewDetailsOpen}
                    >
                      <Layers className="h-3.5 w-3.5" />
                    </button>
                    {card.noteId && !isWakePreview ? (
                      <button
                        type="button"
                        data-vault-popover-trigger=""
                        onClick={(event) => {
                          event.stopPropagation();
                          openTagsPicker(event.currentTarget);
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-black/55 hover:bg-black/[0.06] hover:text-black/85 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white transition-colors"
                        title="Tags"
                        aria-label="Tags"
                      >
                        <Tag className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => chatAboutPreviewCard(card)}
                      className="inline-flex h-6 items-center gap-1 rounded-md bg-blue-500/15 px-2 text-[0.68rem] font-semibold text-blue-700 hover:bg-blue-500/25 dark:text-blue-200 dark:hover:bg-blue-500/30 transition-colors"
                      title="Chat about this"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Chat
                    </button>
                    <button
                      type="button"
                      data-vault-popover-trigger=""
                      onClick={togglePreviewShare}
                      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                        previewShareMenuRect
                          ? "bg-black/10 text-black/85 dark:bg-white/15 dark:text-white"
                          : "text-black/55 hover:bg-black/[0.06] hover:text-black/85 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white"
                      }`}
                      title="Share"
                      aria-label="Share"
                    >
                      <Share className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={isCardActionBusy}
                      onClick={deleteFromPreview}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-black/40 hover:bg-red-500/15 hover:text-red-600 dark:text-white/50 dark:hover:text-red-300 disabled:opacity-40 transition-colors"
                      title="Delete"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl lg:flex-row">
                <div className="relative min-h-0 flex-1 overflow-hidden lg:flex-[1.9]">
                  <div className="h-full min-h-[16rem] lg:min-h-0 overflow-y-auto flex items-center justify-center">
                    <div className={`w-full h-full ${
                      type === "image"
                        ? "flex items-center justify-center p-5 sm:p-8"
                        : "p-3 sm:p-4"
                    }`}>
                      {body}
                    </div>
                  </div>
                </div>

                {/* Inspector stays tucked away by default, like Preview's sidebar. */}
                {previewDetailsOpen ? (
                <div className="shrink-0 w-full lg:w-[20rem] xl:w-[22rem] flex flex-col min-h-0 lg:max-h-full overflow-visible bg-[#f4f4f4] dark:bg-[#242424] px-5 sm:px-6 pt-5 pb-5">
                  <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-0.5">
                    {title ? (
                      <h2 className="pr-10 text-lg font-semibold text-black/85 dark:text-white/90 leading-snug line-clamp-3">
                        {title}
                      </h2>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {cardTags.map((t) => (
                        <span
                          key={t}
                          className="vault-tag-pill inline-flex items-center rounded-full border border-black/10 dark:border-white/12 bg-[#f4f1ea] dark:bg-white/[0.08] text-[11px] leading-none px-2.5 py-1 font-medium text-black/65 dark:text-white/70"
                        >
                          {t}
                        </span>
                      ))}
                      {card.noteId && !isWakePreview ? (
                        <button
                          type="button"
                          data-vault-popover-trigger=""
                          onClick={(e) => {
                            e.stopPropagation();
                            openTagsPicker(e.currentTarget);
                          }}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                          title="Add tag"
                          aria-label="Add tag"
                        >
                          <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                        </button>
                      ) : null}
                    </div>

                    {/* Add to project — above Why I saved this. */}
                    {!isWakePreview ? (
                      <div className="relative z-20" ref={previewProjectDropdownRef}>
                        <button
                          type="button"
                          data-vault-popover-trigger=""
                          disabled={isCardActionBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewShareMenuRect(null);
                            setPreviewProjectDropdownOpen((open) => !open);
                          }}
                          className={`w-full inline-flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                            previewProjectDropdownOpen
                              ? "border-black/15 dark:border-white/20 bg-black/[0.04] dark:bg-white/[0.08] text-black/80 dark:text-white/85"
                              : "border-black/10 dark:border-white/12 bg-black/[0.02] dark:bg-white/[0.04] text-black/70 dark:text-white/75 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                          }`}
                          aria-expanded={previewProjectDropdownOpen}
                          aria-haspopup="listbox"
                        >
                          <span className="truncate">Add to project</span>
                          <ChevronDown
                            className={`w-4 h-4 shrink-0 opacity-60 transition-transform ${
                              previewProjectDropdownOpen ? "rotate-180" : ""
                            }`}
                          />
                        </button>
                        {previewProjectDropdownOpen ? (
                          <div
                            data-vault-popover=""
                            role="listbox"
                            className="lg-menu absolute left-0 right-0 top-full mt-1.5 z-30 max-h-52 overflow-y-auto scrollbar-hide p-1.5"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {projects.length === 0 ? (
                              <div className="px-3 py-2.5 text-sm text-black/45 dark:text-white/45">
                                No projects yet
                              </div>
                            ) : (
                              projects.map((project) => (
                                <button
                                  key={project.id}
                                  type="button"
                                  role="option"
                                  disabled={isCardActionBusy}
                                  onClick={() => {
                                    if (blockWakePreviewVaultMutation(card)) return;
                                    void addCardToProject(card, project.id);
                                  }}
                                  className="w-full text-left rounded-lg px-3 py-2 text-sm text-black/80 dark:text-white/85 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] disabled:opacity-50 truncate transition-colors"
                                  title={project.name}
                                >
                                  {project.name}
                                </button>
                              ))
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div
                      data-vault-preview-comments=""
                      className="border-t border-black/8 dark:border-white/10 pt-4 space-y-3"
                      onMouseDown={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {(() => {
                        const canAddComment =
                          card.kind === "attachment" || card.kind === "quick-note";
                        const canMutateComments =
                          canAddComment && (!isWakePreview || card.isWakePreviewNote);
                        // Prefer live note/attachment from query cache so newly
                        // saved comments show immediately in the pulled-up card.
                        const liveAttachment = (() => {
                          if (card.kind !== "attachment" || !previewNote) return att;
                          const list = parseAttachmentsFromNote(previewNote);
                          const idx = Number(card.attachmentIndex);
                          if (Number.isFinite(idx) && idx >= 0 && idx < list.length) {
                            return list[idx] || att;
                          }
                          return att;
                        })();
                        const previewComments = card.kind === "attachment"
                          ? parseAttachmentNotes(liveAttachment)
                          : parseQuickNoteComments(previewNote || card);
                        const toggleNewComment = () => {
                          setPreviewShareMenuRect(null);
                          setPreviewProjectDropdownOpen(false);
                          if (previewCommentComposerOpen && !previewEditingCommentId) {
                            setPreviewCommentComposerOpen(false);
                            setPreviewCommentDraft("");
                            return;
                          }
                          setPreviewEditingCommentId(null);
                          setPreviewCommentDraft("");
                          setPreviewCommentComposerOpen(true);
                        };
                        const cancelCommentForm = () => {
                          setPreviewCommentComposerOpen(false);
                          setPreviewCommentDraft("");
                          setPreviewEditingCommentId(null);
                        };
                        const saveCommentForm = async () => {
                          const text = previewCommentDraft.trim();
                          if (!text || isCardActionBusy) return;
                          if (isWakePreview) {
                            if (previewEditingCommentId) {
                              updateWakePreviewCardComment(card, previewEditingCommentId, text);
                            } else {
                              addWakePreviewCardComment(card, text);
                            }
                            cancelCommentForm();
                            return;
                          }
                          if (blockWakePreviewVaultMutation(card)) return;
                          let ok = false;
                          if (previewEditingCommentId) {
                            ok = card.kind === "attachment"
                              ? await updateAttachmentNote(card, previewEditingCommentId, text)
                              : await updateQuickNoteComment(card, previewEditingCommentId, text);
                          } else {
                            ok = card.kind === "attachment"
                              ? await addAttachmentNote(card, text)
                              : await addQuickNoteComment(card, text);
                          }
                          if (ok) cancelCommentForm();
                        };
                        const startEditComment = (entry) => {
                          setPreviewShareMenuRect(null);
                          setPreviewProjectDropdownOpen(false);
                          setPreviewEditingCommentId(entry.id);
                          setPreviewCommentDraft(entry.text || "");
                          setPreviewCommentComposerOpen(false);
                        };
                        const showNewComposer =
                          canMutateComments && previewCommentComposerOpen && !previewEditingCommentId;

                        return (
                          <>
                            {canEditWhy ? (
                              <WhyEditor
                                variant="card"
                                initialValue={previewWhy}
                                busy={isCardActionBusy}
                                onSave={(value) => saveCardWhy(card, value)}
                                onAddComment={canMutateComments ? toggleNewComment : null}
                                commentActive={showNewComposer}
                              />
                            ) : (
                              <div className="space-y-1.5">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-black/40 dark:text-white/40">
                                    Why I saved this
                                  </p>
                                  {canMutateComments ? (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleNewComment();
                                      }}
                                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                                        showNewComposer
                                          ? "bg-blue-600 text-white"
                                          : "bg-blue-500 text-white hover:bg-blue-600"
                                      }`}
                                      title="Add comment"
                                      aria-label="Add comment"
                                    >
                                      <MessageCircle className="w-3.5 h-3.5" />
                                    </button>
                                  ) : null}
                                </div>
                                {previewWhy ? (
                                  <p className="text-sm text-black/80 dark:text-white/80 whitespace-pre-wrap break-words">{previewWhy}</p>
                                ) : (
                                  <p className="text-sm italic text-black/35 dark:text-white/35">Add why you saved this</p>
                                )}
                              </div>
                            )}

                            {showNewComposer ? (
                              <div className="space-y-2 rounded-xl border border-black/10 dark:border-white/12 bg-black/[0.02] dark:bg-white/[0.04] px-3 py-2.5">
                                <textarea
                                  value={previewCommentDraft}
                                  onChange={(e) => setPreviewCommentDraft(e.target.value)}
                                  autoFocus
                                  rows={3}
                                  maxLength={2000}
                                  placeholder="Write a comment…"
                                  className="w-full resize-y bg-transparent border-0 text-sm text-black/85 dark:text-white/85 outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
                                />
                                <div className="flex items-center gap-4">
                                  <button
                                    type="button"
                                    disabled={isCardActionBusy || !previewCommentDraft.trim()}
                                    onClick={() => { void saveCommentForm(); }}
                                    className="text-sm font-medium text-black dark:text-white hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                  >
                                    {isCardActionBusy ? "Saving…" : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={cancelCommentForm}
                                    className="text-sm text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}

                            {previewComments.length > 0 ? (
                              <div className="space-y-1.5">
                                {previewComments.map((entry) => {
                                  const isEditing = previewEditingCommentId === entry.id;
                                  return (
                                    <div
                                      key={entry.id}
                                      className="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-2.5 py-2"
                                    >
                                      {isEditing ? (
                                        <div className="space-y-2">
                                          <textarea
                                            value={previewCommentDraft}
                                            onChange={(e) => setPreviewCommentDraft(e.target.value)}
                                            autoFocus
                                            rows={3}
                                            maxLength={2000}
                                            className="w-full resize-y bg-transparent border-0 text-sm text-black/85 dark:text-white/85 outline-none"
                                          />
                                          <div className="flex items-center gap-4">
                                            <button
                                              type="button"
                                              disabled={isCardActionBusy || !previewCommentDraft.trim()}
                                              onClick={() => { void saveCommentForm(); }}
                                              className="text-sm font-medium text-black dark:text-white hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                                            >
                                              {isCardActionBusy ? "Saving…" : "Save"}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={cancelCommentForm}
                                              className="text-sm text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/70 transition-colors"
                                            >
                                              Cancel
                                            </button>
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="group flex items-start gap-1.5">
                                          <p className="flex-1 min-w-0 text-sm text-black/75 dark:text-white/75 whitespace-pre-wrap break-words">
                                            {entry.text}
                                          </p>
                                          {canMutateComments ? (
                                            <div className="flex items-center gap-0.5 shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
                                              <button
                                                type="button"
                                                disabled={isCardActionBusy}
                                                onClick={() => startEditComment(entry)}
                                                className="p-0.5 rounded text-black/35 dark:text-white/35 hover:text-black/70 dark:hover:text-white/70 disabled:opacity-40 transition-colors"
                                                title="Edit comment"
                                                aria-label="Edit comment"
                                              >
                                                <Pencil className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                disabled={isCardActionBusy}
                                                onClick={() => {
                                                  if (isWakePreview) {
                                                    removeWakePreviewCardComment(card, entry.id);
                                                    return;
                                                  }
                                                  if (blockWakePreviewVaultMutation(card)) return;
                                                  if (card.kind === "attachment") {
                                                    void removeAttachmentNote(card, entry.id);
                                                  } else {
                                                    void removeQuickNoteComment(card, entry.id);
                                                  }
                                                }}
                                                className="p-0.5 rounded text-black/30 dark:text-white/30 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 transition-colors"
                                                title="Delete comment"
                                                aria-label="Delete comment"
                                              >
                                                <Trash2 className="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          ) : null}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                </div>
                ) : null}
              </div>
              </div>
            </LyknMediaPop>
          );
        })(),
    document.body
  );
}

export function VaultPreviewShareMenu({
  previewCard,
  previewFullUrl,
  previewShareMenuRect,
  previewShareMenuRef,
  resolvePreviewShareText,
  resolvePreviewShareUrl,
  resolvedAttachmentUrls,
  sharePreviewCopyLink,
  sharePreviewCopyText,
  sharePreviewDownload,
  sharePreviewNative,
  sharePreviewOpenLink,
  vaultCards,
}) {
  return createPortal(
        (() => {
          const card =
            vaultCards.find((c) => c.id === previewCard.id) || previewCard;
          const att = card.attachment || {};
          const type = card.type || card.kind;
          const shareUrl =
            type === "image"
              ? (previewFullUrl || resolvedAttachmentUrls[card.id] || att.url || "")
              : (resolvedAttachmentUrls[card.id] || att.url || "");
          const safeUrl = resolvePreviewShareUrl(card, shareUrl);
          const shareText = resolvePreviewShareText(card);
          const canNativeShare =
            typeof navigator !== "undefined" && typeof navigator.share === "function";
          const canDownload =
            !!safeUrl &&
            card.kind === "attachment" &&
            ["image", "video", "audio", "pdf", "file", "html", "spreadsheet"].includes(
              String(type || resolveAttachmentType(att) || ""),
            );
          const menuW = Math.min(220, window.innerWidth - 16);
          const pad = 8;
          let left = previewShareMenuRect.left;
          if (left + menuW > window.innerWidth - pad) {
            left = Math.max(pad, window.innerWidth - menuW - pad);
          }
          if (left < pad) left = pad;
          // Prefer opening above the Share button so it stays over the card.
          const estimatedH = 220;
          const openUp = previewShareMenuRect.top > estimatedH + pad;
          const style = openUp
            ? { bottom: window.innerHeight - previewShareMenuRect.top + 8, left }
            : { top: previewShareMenuRect.bottom + 8, left };

          const itemClass =
            "w-full text-left rounded-xl px-3 py-2.5 text-sm hover:bg-black/[0.05] dark:hover:bg-white/[0.08] flex items-center gap-2.5 text-black/80 dark:text-white/85 transition-colors";

          return (
            <div
              ref={previewShareMenuRef}
              data-vault-popover=""
              className="lg-menu p-1.5 flex flex-col min-w-[11rem]"
              style={{ position: "fixed", width: menuW, zIndex: 10060, ...style }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {canNativeShare ? (
                <button
                  type="button"
                  onClick={() => { void sharePreviewNative(card, shareUrl); }}
                  className={itemClass}
                >
                  <Share className="w-4 h-4 shrink-0 opacity-70" />
                  Share…
                </button>
              ) : null}
              {safeUrl ? (
                <button
                  type="button"
                  onClick={() => { void sharePreviewCopyLink(card, shareUrl); }}
                  className={itemClass}
                >
                  <LinkIcon className="w-4 h-4 shrink-0 opacity-70" />
                  Copy link
                </button>
              ) : null}
              {shareText ? (
                <button
                  type="button"
                  onClick={() => { void sharePreviewCopyText(card); }}
                  className={itemClass}
                >
                  <Copy className="w-4 h-4 shrink-0 opacity-70" />
                  Copy text
                </button>
              ) : null}
              {canDownload ? (
                <button
                  type="button"
                  onClick={() => { void sharePreviewDownload(card, shareUrl); }}
                  className={itemClass}
                >
                  <Download className="w-4 h-4 shrink-0 opacity-70" />
                  Download
                </button>
              ) : null}
              {safeUrl ? (
                <button
                  type="button"
                  onClick={() => sharePreviewOpenLink(card, shareUrl)}
                  className={itemClass}
                >
                  <Globe className="w-4 h-4 shrink-0 opacity-70" />
                  Open link
                </button>
              ) : null}
              {!canNativeShare && !safeUrl && !shareText ? (
                <div className="px-3 py-2.5 text-sm text-black/45 dark:text-white/45">
                  Nothing to share yet.
                </div>
              ) : null}
            </div>
          );
        })(),
    document.body
  );
}
