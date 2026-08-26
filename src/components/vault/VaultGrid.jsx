// VaultGrid renders the Vault's card views once data is ready: the
// source-folder breadcrumb, the empty "Add attachments" state, the Tags and
// Type groupings, the wake-preview strip, the collage masonry / plain grid
// feed, the infinite-scroll sentinel, and the load-more / reveal skeletons.
// Extracted verbatim from src/pages/Vault.jsx (Vault decomposition phase, see
// docs/REFACTOR_LOG.md). The page still owns the readiness gate that decides
// whether this renders, and passes the card renderers down (see
// vaultCardRenderers.jsx for why those are factories).
import { motion } from "framer-motion";
import {
  CalendarDays,
  Check,
  ChevronRight,
  Globe,
  ListTodo,
  StickyNote,
  Tag,
  Upload,
} from "lucide-react";
import VaultLoadMoreSkeleton from "@/components/vault/VaultLoadMoreSkeleton";
import SourceFolderTile from "@/components/vault/SourceFolderTile";

export default function VaultGrid({
  collageColumnBuckets,
  collageGridCards,
  embeddedSearch,
  handleCardDragStart,
  handleCardPress,
  handleRequestAddMedia,
  handleRequestSaveLink,
  initialCardIdsRef,
  isEmbeddedMode,
  isFeedView,
  isLoadingMoreNotes,
  isVaultFirstPaintRef,
  isWakePreview,
  loadMoreRef,
  openCardMenuForAnchor,
  openFolderConnector,
  openSourceFolder,
  orderedVisibleCards,
  pendingRevealCount,
  registerCardRef,
  renderAttachmentCard,
  renderCollageCard,
  selectedCardIds,
  selectedFilterTags,
  setOpenSourceFolder,
  tagGroupedCards,
  typeGroupedCards,
  useMasonryLayout,
  vaultView,
  virtualizedCardStyle,
  wakeConnectorStripCards,
}) {
  return (
          <motion.div initial={false} animate={{ opacity: 1 }}>
            {openSourceFolder && openFolderConnector && (
              <div className="mb-4 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setOpenSourceFolder(null)}
                  className="inline-flex items-center gap-1.5 rounded-full glass-control px-3 py-1.5 text-[0.75rem] font-medium text-black/75 dark:text-white/75 hover:text-black dark:hover:text-white transition-colors"
                >
                  <ChevronRight className="w-3.5 h-3.5 rotate-180" />
                  <span>Back to Vault</span>
                </button>
                <div className="flex items-center gap-2 min-w-0">
                  {openFolderConnector.favicon && (
                    <img
                      src={openFolderConnector.favicon}
                      alt=""
                      width={20}
                      height={20}
                      className="block rounded-sm shrink-0"
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                    />
                  )}
                  <h2 className="text-sm font-semibold text-black/80 dark:text-white/80 truncate">
                    {openFolderConnector.name}
                  </h2>
                  <span className="text-xs text-black/40 dark:text-white/40 font-medium shrink-0">
                    {orderedVisibleCards.length} {orderedVisibleCards.length === 1 ? "item" : "items"}
                  </span>
                </div>
              </div>
            )}
            {orderedVisibleCards.length === 0 ? (
              <div className="flex flex-col items-start gap-4">
                <div className="break-inside-avoid mb-5 rounded-2xl border-2 border-dashed border-blue-500/30 p-6 flex flex-col items-center justify-center text-center w-full sm:w-64 min-h-[160px] gap-3">
                  <div className="text-sm font-medium text-black/40 dark:text-white/40 mb-1">Add attachments</div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={handleRequestAddMedia}
                      className="group/opt flex flex-col items-center gap-1.5 rounded-xl px-4 py-3 hover:bg-blue-500/[0.06] transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                        <Upload className="w-5 h-5 text-blue-500" />
                      </div>
                      <span className="text-xs font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Upload Files</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRequestSaveLink}
                      className="group/opt flex flex-col items-center gap-1.5 rounded-xl px-4 py-3 hover:bg-blue-500/[0.06] transition-colors"
                    >
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                        <Globe className="w-5 h-5 text-blue-500" />
                      </div>
                      <span className="text-xs font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Save Link</span>
                    </button>
                  </div>
                </div>
                {embeddedSearch.trim() ? (
                  <div className="glass-control rounded-2xl px-5 py-4 inline-block">
                    <p className="text-sm text-black/70 dark:text-white/70">No results match your search.</p>
                  </div>
                ) : selectedFilterTags.length > 0 ? (
                  <div className="glass-control rounded-2xl px-5 py-4 inline-block">
                    <p className="text-sm text-black/70 dark:text-white/70">Nothing matches the selected tags.</p>
                  </div>
                ) : null}
              </div>
            ) : vaultView === "tags" ? (
              <div className="space-y-8">
                <div className="rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex items-center justify-center text-center gap-4 max-w-xs">
                  <button type="button" onClick={handleRequestAddMedia} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Upload className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                  </button>
                  <button type="button" onClick={handleRequestSaveLink} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Globe className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Link</span>
                  </button>
                </div>
                {tagGroupedCards.map(([tagName, cards]) => (
                  <div key={tagName}>
                    <div className="flex items-center gap-2 mb-3">
                      <Tag className="w-4 h-4 text-black/40 dark:text-white/40" />
                      <h2 className="text-lg font-semibold text-black/80 dark:text-white/80">{tagName}</h2>
                      <span className="text-xs text-black/40 dark:text-white/40 font-medium">{cards.length}</span>
                    </div>
                    <div className={isEmbeddedMode ? "grid grid-cols-2 gap-2" : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2"}>
                      {cards.map((card) => {
                        const isSelected = selectedCardIds.has(card.id);
                        return (
                        <motion.article
                          initial={
                            isVaultFirstPaintRef.current || initialCardIdsRef.current?.has(card.id)
                              ? false
                              : { opacity: 0, scale: 0.97 }
                          }
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.15 }}
                          key={`${tagName}-${card.id}`}
                          data-vault-card-id={card.id}
                          data-card-id={card.id}
                          ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                          draggable={false}
                          onDragStart={handleCardDragStart}
                          onClick={(e) => handleCardPress(e, card)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            openCardMenuForAnchor(card.id, e.currentTarget);
                          }}
                          // Same browser-native culling as the main grid;
                          // tag view often renders the largest single
                          // page (every card duplicated per tag).
                          style={virtualizedCardStyle}
                          className={`rounded-2xl relative overflow-hidden cursor-pointer ${
                            card.kind === "attachment" || card.kind === "quick-note" || card.kind === "source-folder"
                              ? "bg-transparent border-0 shadow-none"
                              : "glass-control"
                          } ${isSelected ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-transparent" : ""}`}
                        >
                          {isSelected && card.kind !== "source-folder" && (
                            <span
                              data-no-preview="true"
                              className="absolute top-2 right-2 z-[120] w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-md pointer-events-none"
                            >
                              <Check className="w-3 h-3" strokeWidth={3} />
                            </span>
                          )}
                          {card.isDemo && !isWakePreview && (
                            <span className="absolute top-2 left-2 z-[120] rounded-full bg-black/45 text-white/95 text-[0.625rem] font-medium px-2 py-0.5 backdrop-blur-sm pointer-events-none">
                              Sample
                            </span>
                          )}
                          {card.kind === "source-folder" ? (
                            <SourceFolderTile card={card} heightClass="aspect-square w-full" />
                          ) : card.kind === "attachment" ? (
                            renderAttachmentCard(card, "aspect-square w-full")
                          ) : card.kind === "quick-note" ? (
                              <div className="glass-control rounded-2xl p-3 aspect-square w-full overflow-hidden">
                                <div className="flex items-center gap-1.5 text-black/60 dark:text-white/60 mb-1.5">
                                  {card.noteStyle === "meeting" ? (
                                    <CalendarDays className="w-3.5 h-3.5" />
                                  ) : card.noteStyle === "task" ? (
                                    <ListTodo className="w-3.5 h-3.5" />
                                  ) : (
                                    <StickyNote className="w-3.5 h-3.5" />
                                  )}
                                  <span className="text-[0.625rem] font-medium">{card.label || "Quick Note"}</span>
                                </div>
                                {card.title && card.noteStyle && card.noteStyle !== "quick" ? (
                                  <p className="text-[0.6875rem] font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</p>
                                ) : null}
                                <p className="text-xs text-black/70 dark:text-white/70 whitespace-pre-wrap break-words line-clamp-5">{card.excerpt}</p>
                              </div>
                          ) : (
                              <div className="glass-control rounded-2xl p-3 aspect-square w-full overflow-hidden">
                                <h3 className="text-xs font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</h3>
                                {card.question && <p className="text-[0.6875rem] text-black/60 dark:text-white/60 line-clamp-3">{card.question}</p>}
                              </div>
                          )}
                        </motion.article>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div ref={loadMoreRef} className="h-6" />
              </div>
            ) : vaultView === "type" ? (
              <div className="space-y-8">
                <div className="rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex items-center justify-center text-center gap-4 max-w-xs">
                  <button type="button" onClick={handleRequestAddMedia} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Upload className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                  </button>
                  <button type="button" onClick={handleRequestSaveLink} className="group/opt flex items-center gap-2 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors"><Globe className="w-4 h-4 text-blue-500" /></div>
                    <span className="text-[0.6875rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Link</span>
                  </button>
                </div>
                {typeGroupedCards.map(([typeName, cards]) => {
                  return (
                    <div key={typeName}>
                      <div className="flex items-center gap-2 mb-3">
                        <h2 className="text-lg font-semibold text-black/80 dark:text-white/80">{typeName}</h2>
                        <span className="text-xs text-black/40 dark:text-white/40 font-medium">{cards.length}</span>
                      </div>
                      <div className={isEmbeddedMode ? "grid grid-cols-2 gap-2" : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2"}>
                        {cards.map((card) => {
                          const isSelected = selectedCardIds.has(card.id);
                          return (
                          <motion.article
                            initial={
                              isVaultFirstPaintRef.current || initialCardIdsRef.current?.has(card.id)
                                ? false
                                : { opacity: 0, scale: 0.97 }
                            }
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.15 }}
                            key={`${typeName}-${card.id}`}
                            data-vault-card-id={card.id}
                            data-card-id={card.id}
                            ref={(el) => { if (card.kind === "attachment") registerCardRef(card.id, el); }}
                            draggable={false}
                            onDragStart={handleCardDragStart}
                            onClick={(e) => handleCardPress(e, card)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              openCardMenuForAnchor(card.id, e.currentTarget);
                            }}
                            // See `virtualizedCardStyle` definition above:
                            // browser-native off-screen culling kicks in
                            // once the rendered count crosses
                            // `VIRTUALIZE_AT`. No-op for small vaults.
                            style={virtualizedCardStyle}
                            className={`rounded-2xl relative overflow-hidden cursor-pointer ${
                              card.kind === "attachment" || card.kind === "quick-note"
                                ? "bg-transparent border-0 shadow-none"
                                : "glass-control"
                            } ${isSelected ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-transparent" : ""}`}
                          >
                            {isSelected && (
                              <span
                                data-no-preview="true"
                                className="absolute top-2 right-2 z-[120] w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-md pointer-events-none"
                              >
                                <Check className="w-3 h-3" strokeWidth={3} />
                              </span>
                            )}
                            {card.isDemo && !isWakePreview && (
                              <span className="absolute top-2 left-2 z-[120] rounded-full bg-black/45 text-white/95 text-[0.625rem] font-medium px-2 py-0.5 backdrop-blur-sm pointer-events-none">
                                Sample
                              </span>
                            )}
                            {card.kind === "attachment" ? (
                              renderAttachmentCard(card, "aspect-square w-full")
                            ) : card.kind === "quick-note" ? (
                                <div className="glass-control rounded-2xl p-3 aspect-square w-full overflow-hidden">
                                  <div className="flex items-center gap-1.5 text-black/60 dark:text-white/60 mb-1.5">
                                    {card.noteStyle === "meeting" ? (
                                      <CalendarDays className="w-3.5 h-3.5" />
                                    ) : card.noteStyle === "task" ? (
                                      <ListTodo className="w-3.5 h-3.5" />
                                    ) : (
                                      <StickyNote className="w-3.5 h-3.5" />
                                    )}
                                    <span className="text-[0.625rem] font-medium">{card.label || "Quick Note"}</span>
                                  </div>
                                  {card.title && card.noteStyle && card.noteStyle !== "quick" ? (
                                    <p className="text-[0.6875rem] font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</p>
                                  ) : null}
                                  <p className="text-xs text-black/70 dark:text-white/70 whitespace-pre-wrap break-words line-clamp-5">{card.excerpt}</p>
                                </div>
                            ) : (
                                <div className="glass-control rounded-2xl p-3 aspect-square w-full overflow-hidden">
                                  <h3 className="text-xs font-semibold text-black/80 dark:text-white/80 truncate mb-1">{card.title}</h3>
                                  {card.question && <p className="text-[0.6875rem] text-black/60 dark:text-white/60 line-clamp-3">{card.question}</p>}
                                </div>
                            )}
                          </motion.article>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                <div ref={loadMoreRef} className="h-6" />
              </div>
            ) : (
              <div className={isWakePreview ? "grid grid-cols-3 gap-3 items-start" : undefined}>
                {isWakePreview && (
                  <>
                    <div className="col-start-1 row-start-1 w-full rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex flex-col items-center justify-center text-center min-h-[11rem] gap-2">
                      <div className="text-xs font-medium text-black/40 dark:text-white/40">Add attachments</div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleRequestAddMedia}
                          className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                        >
                          <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                            <Upload className="w-4 h-4 text-blue-500" />
                          </div>
                          <span className="text-[0.625rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleRequestSaveLink}
                          className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                        >
                          <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                            <Globe className="w-4 h-4 text-blue-500" />
                          </div>
                          <span className="text-[0.625rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Link</span>
                        </button>
                      </div>
                    </div>
                    <div className="col-start-2 col-span-2 row-start-1 min-w-0 self-start">
                      <div className="grid grid-cols-2 gap-3">
                        {wakeConnectorStripCards.map((card) => (
                          <article
                            key={card.id}
                            data-vault-card-id={card.id}
                            data-card-id={card.id}
                            onClick={(e) => handleCardPress(e, card)}
                            className="rounded-2xl relative cursor-pointer overflow-visible"
                          >
                            {renderAttachmentCard(card, "h-20")}
                          </article>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              {useMasonryLayout ? (
                <div className={`flex items-start ${isEmbeddedMode ? "gap-2" : "gap-2 md:gap-2.5"}`}>
                  {collageColumnBuckets.map((bucket, colIdx) => (
                    <div key={`vault-col-${colIdx}`} className="flex-1 min-w-0 flex flex-col">
                      {colIdx === 0 && vaultView === "collage" && !isWakePreview && (
                        <div className="mb-2 rounded-2xl border-2 border-dashed border-blue-500/30 p-4 flex flex-col items-center justify-center text-center min-h-[130px] gap-2">
                          <div className="text-xs font-medium text-black/40 dark:text-white/40">Add attachments</div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleRequestAddMedia}
                              className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                            >
                              <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                                <Upload className="w-4 h-4 text-blue-500" />
                              </div>
                              <span className="text-[0.625rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Files</span>
                            </button>
                            <button
                              type="button"
                              onClick={handleRequestSaveLink}
                              className="group/opt flex flex-col items-center gap-1 rounded-xl px-3 py-2 hover:bg-blue-500/[0.06] transition-colors"
                            >
                              <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center group-hover/opt:bg-blue-500/20 transition-colors">
                                <Globe className="w-4 h-4 text-blue-500" />
                              </div>
                              <span className="text-[0.625rem] font-medium text-black/50 dark:text-white/50 group-hover/opt:text-blue-500 transition-colors">Link</span>
                            </button>
                          </div>
                        </div>
                      )}
                      {bucket.map((card) => renderCollageCard(card))}
                    </div>
                  ))}
                </div>
              ) : (
                <div className={
                  isWakePreview
                    ? "lykn-wake-vault-preview-grid col-start-1 col-span-3 row-start-2 grid grid-cols-3 gap-2"
                    : isEmbeddedMode
                    ? "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2"
                    : "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2"
                }>
                  {vaultView === "grid" && !isWakePreview && (
                    <div className="rounded-2xl border-2 border-dashed border-blue-500/30 flex flex-col items-center justify-center text-center aspect-square gap-2 p-4">
                      <div className="text-xs font-medium text-black/40 dark:text-white/40">Add attachments</div>
                      <div className="flex gap-1.5">
                        <button type="button" onClick={handleRequestAddMedia} className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center hover:bg-blue-500/20 transition-colors">
                          <Upload className="w-3.5 h-3.5 text-blue-500" />
                        </button>
                        <button type="button" onClick={handleRequestSaveLink} className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center hover:bg-blue-500/20 transition-colors">
                          <Globe className="w-3.5 h-3.5 text-blue-500" />
                        </button>
                      </div>
                    </div>
                  )}
                  {collageGridCards.map((card) => renderCollageCard(card))}
                </div>
              )}
              <div ref={loadMoreRef} className="h-6" />
              </div>
            )}
            {isFeedView
              ? pendingRevealCount > 0 && (
                  <VaultLoadMoreSkeleton
                    masonry={useMasonryLayout}
                    embedded={isEmbeddedMode}
                    count={pendingRevealCount}
                  />
                )
              : isLoadingMoreNotes && (
                  <VaultLoadMoreSkeleton
                    masonry={useMasonryLayout}
                    embedded={isEmbeddedMode}
                  />
                )}
          </motion.div>
  );
}
