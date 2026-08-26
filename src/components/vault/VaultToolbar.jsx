// VaultToolbar renders the Vault's header controls: the concept-search input
// (embedded instant-filter variant and the standard press-Enter variant), the
// view-mode dropdown (Collage / Grid / Tags / Type), the tag-filter dropdown
// with its "Not Tagged" pseudo-tag, the Connect-apps button, and the
// concept-search status line. Extracted verbatim from src/pages/Vault.jsx
// (Vault decomposition phase, see docs/REFACTOR_LOG.md). All state stays in
// Vault.jsx; dropdown dismissal effects live there too (shared with the other
// vault popovers).
import {
  Check,
  ChevronDown,
  Grid2X2,
  Layers,
  LayoutGrid,
  Loader2,
  Plug,
  Search,
  Tag,
  X,
} from "lucide-react";

const VAULT_VIEW_OPTIONS = [
  { id: "collage", icon: Layers, label: "Collage" },
  { id: "grid", icon: Grid2X2, label: "Grid" },
  { id: "tags", icon: Tag, label: "Tags" },
  { id: "type", icon: LayoutGrid, label: "Type" },
];

export default function VaultToolbar({
  allTags,
  conceptResultIds,
  embeddedSearch,
  embeddedTagDropdownRef,
  handleConceptSearch,
  isConceptSearching,
  isEmbeddedMode,
  isWakePreview,
  nav,
  onWakePreviewTabChange,
  selectedFilterTags,
  setConceptResultIds,
  setEmbeddedSearch,
  setSelectedFilterTags,
  setShowEmbeddedTagDropdown,
  setShowVaultViewDropdown,
  setVaultSearch,
  setVaultView,
  showEmbeddedTagDropdown,
  showVaultViewDropdown,
  studioSurface,
  vaultSearch,
  vaultView,
  vaultViewDropdownRef,
  visibleCards,
}) {
  return (
        <section className="mb-6">
          {isEmbeddedMode ? (
            <div className="space-y-3">
              <div className="relative w-full">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-black/35 dark:text-white/35 pointer-events-none" />
                <input
                  type="text"
                  value={embeddedSearch}
                  onChange={(e) => setEmbeddedSearch(e.target.value)}
                  placeholder="Search your vault: type an idea, topic, or keyword"
                  className="w-full h-11 rounded-2xl glass-control pl-10 pr-12 text-sm outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
                />
                {embeddedSearch.trim() ? (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
                    <button
                      type="button"
                      onClick={() => setEmbeddedSearch("")}
                      className="w-5 h-5 flex items-center justify-center text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
                      title="Clear search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(() => {
                  const current = VAULT_VIEW_OPTIONS.find((v) => v.id === vaultView) || VAULT_VIEW_OPTIONS[0];
                  const CurrentIcon = current.icon;
                  return (
                    <div className="relative" ref={vaultViewDropdownRef}>
                      <button
                        type="button"
                        onClick={() => setShowVaultViewDropdown((v) => !v)}
                        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.6875rem] font-medium bg-black/[0.04] hover:bg-black/[0.07] text-black/60 hover:text-black/80 dark:bg-white/10 dark:hover:bg-white/15 dark:text-white/60 transition-colors"
                      >
                        <CurrentIcon className="w-3 h-3" />
                        {current.label}
                        <ChevronDown className={`w-3 h-3 transition-transform ${showVaultViewDropdown ? "rotate-180" : ""}`} />
                      </button>
                      {showVaultViewDropdown && (
                        <div className="lg-menu absolute top-full left-0 mt-1 w-44 z-[400] py-1">
                          {VAULT_VIEW_OPTIONS.map((v) => {
                            const Icon = v.icon;
                            const active = vaultView === v.id;
                            return (
                              <button
                                key={v.id}
                                type="button"
                                onClick={() => {
                                  setVaultView(v.id);
                                  setShowVaultViewDropdown(false);
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors ${
                                  active ? "text-blue-600 dark:text-blue-400 font-medium" : "text-black/70 dark:text-white/70"
                                }`}
                              >
                                <Icon className="w-3.5 h-3.5 shrink-0" />
                                <span className="flex-1 truncate">{v.label}</span>
                                {active && <Check className="w-3 h-3" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              {allTags.length > 0 && (
                <div className="relative" ref={embeddedTagDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setShowEmbeddedTagDropdown((v) => !v)}
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.6875rem] font-medium bg-black/[0.04] hover:bg-black/[0.07] text-black/60 hover:text-black/80 dark:bg-white/10 dark:hover:bg-white/15 dark:text-white/60 transition-colors"
                  >
                    <Tag className="w-3 h-3" />
                    {selectedFilterTags.length > 0
                      ? `${selectedFilterTags.length} tag${selectedFilterTags.length > 1 ? "s" : ""} selected`
                      : "Filter by tag"}
                    <ChevronDown className={`w-3 h-3 transition-transform ${showEmbeddedTagDropdown ? "rotate-180" : ""}`} />
                  </button>
                  {selectedFilterTags.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedFilterTags([])}
                      className="ml-1.5 text-[0.625rem] text-blue-500 hover:text-blue-600"
                    >
                      Clear
                    </button>
                  )}
                  {showEmbeddedTagDropdown && (
                    <div className="lg-menu absolute top-full left-0 mt-1 w-52 max-h-56 overflow-y-auto z-[400] py-1 scrollbar-hide">
                      {(() => {
                        const untaggedActive = selectedFilterTags.includes("__untagged__");
                        return (
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedFilterTags((prev) =>
                                untaggedActive ? prev.filter((t) => t !== "__untagged__") : [...prev, "__untagged__"]
                              )
                            }
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors border-b border-black/5 dark:border-white/5 mb-0.5"
                          >
                            <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${untaggedActive ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400 ring-1 ring-blue-500/25" : "border border-black/20 dark:border-white/20"}`}>
                              {untaggedActive && <Check className="w-2.5 h-2.5" />}
                            </div>
                            <span className={`flex-1 truncate italic ${untaggedActive ? "text-black/90 dark:text-white/90 font-medium" : "text-black/50 dark:text-white/50"}`}>
                              Not Tagged
                            </span>
                          </button>
                        );
                      })()}
                      {allTags.map((tag) => {
                        const active = selectedFilterTags.includes(tag.name);
                        return (
                          <button
                            key={tag.name}
                            type="button"
                            onClick={() =>
                              setSelectedFilterTags((prev) =>
                                active ? prev.filter((t) => t !== tag.name) : [...prev, tag.name]
                              )
                            }
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                          >
                            <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${active ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400 ring-1 ring-blue-500/25" : "border border-black/20 dark:border-white/20"}`}>
                              {active && <Check className="w-2.5 h-2.5" />}
                            </div>
                            <span className={`flex-1 truncate ${active ? "text-black/90 dark:text-white/90 font-medium" : "text-black/65 dark:text-white/65"}`}>
                              {tag.name}
                            </span>
                            <span className="text-[0.625rem] text-black/30 dark:text-white/30">{tag.count}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              </div>
            </div>
          ) : (
            <>
              {!isWakePreview && (
                <>
                  <h1 className="text-3xl font-semibold">The Vault</h1>
                  <p className="text-black/60 dark:text-white/60 mt-1">
                    Your digital collage of media files, videos, images, and quick notes. Drag and drop files or folders anywhere on this page.
                  </p>
                </>
              )}
              <div
                className="relative z-[400] mt-4 flex flex-wrap items-center gap-3"
                style={{ minHeight: 1 }}
              >
                <form
                  className="relative w-full sm:flex-1 sm:max-w-xl"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleConceptSearch(vaultSearch);
                  }}
                >
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-black/35 dark:text-white/35" />
                  <input
                    type="text"
                    value={vaultSearch}
                    onChange={(e) => {
                      setVaultSearch(e.target.value);
                      if (conceptResultIds !== null) setConceptResultIds(null);
                    }}
                    placeholder={
                      isWakePreview
                        ? "Search your vault: type an idea, topic, or keyword"
                        : "Search your vault: type an idea, topic, or keyword and press Enter"
                    }
                    className="w-full h-11 rounded-2xl glass-control pl-10 pr-20 text-sm outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {isConceptSearching ? (
                      <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                    ) : vaultSearch.trim() ? (
                      <>
                        <button
                          type="submit"
                          className="w-7 h-7 flex items-center justify-center text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80 transition-colors"
                          title="Search"
                        >
                          <Search className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setVaultSearch(""); setConceptResultIds(null); }}
                          className="w-5 h-5 flex items-center justify-center text-black/40 dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : null}
                  </div>
                </form>
                {(() => {
                  const current = VAULT_VIEW_OPTIONS.find((v) => v.id === vaultView) || VAULT_VIEW_OPTIONS[0];
                  const CurrentIcon = current.icon;
                  return (
                    <div className="relative shrink-0" ref={vaultViewDropdownRef}>
                      <button
                        type="button"
                        onClick={() => setShowVaultViewDropdown((v) => !v)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-black/65 dark:text-white/65 hover:text-black/90 dark:hover:text-white/90 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                      >
                        <CurrentIcon className="w-3 h-3" />
                        {current.label}
                        <ChevronDown className={`w-3 h-3 transition-transform ${showVaultViewDropdown ? "rotate-180" : ""}`} />
                      </button>
                      {showVaultViewDropdown && (
                        <div className={`lg-menu absolute top-full mt-1 w-44 max-w-[calc(100vw-1.5rem)] z-[400] py-1 ${isWakePreview ? "left-0" : "left-0 md:left-auto md:right-0"}`}>
                          {VAULT_VIEW_OPTIONS.map((v) => {
                            const Icon = v.icon;
                            const active = vaultView === v.id;
                            return (
                              <button
                                key={v.id}
                                type="button"
                                onClick={() => {
                                  setVaultView(v.id);
                                  setShowVaultViewDropdown(false);
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors ${
                                  active ? "text-blue-600 dark:text-blue-400 font-medium" : "text-black/70 dark:text-white/70"
                                }`}
                              >
                                <Icon className="w-3.5 h-3.5 shrink-0" />
                                <span className="flex-1 truncate">{v.label}</span>
                                {active && <Check className="w-3 h-3" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {allTags.length > 0 && (
                  <div className="relative shrink-0" ref={embeddedTagDropdownRef}>
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowEmbeddedTagDropdown((v) => !v)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-black/65 dark:text-white/65 hover:text-black/90 dark:hover:text-white/90 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                      >
                        <Tag className="w-3 h-3" />
                        {selectedFilterTags.length > 0
                          ? `${selectedFilterTags.length} tag${selectedFilterTags.length > 1 ? "s" : ""} selected`
                          : "Filter by tag"}
                        <ChevronDown className={`w-3 h-3 transition-transform ${showEmbeddedTagDropdown ? "rotate-180" : ""}`} />
                      </button>
                      {selectedFilterTags.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedFilterTags([])}
                          className="text-[0.6875rem] text-blue-500 hover:text-blue-600"
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                    {showEmbeddedTagDropdown && (
                      <div className={`lg-menu absolute top-full mt-1 w-56 md:w-64 max-w-[calc(100vw-1.5rem)] max-h-72 overflow-y-auto z-[400] py-1 scrollbar-hide ${isWakePreview ? "left-0" : "left-0 md:left-auto md:right-0"}`}>
                        {(() => {
                          const untaggedActive = selectedFilterTags.includes("__untagged__");
                          return (
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedFilterTags((prev) =>
                                  untaggedActive ? prev.filter((t) => t !== "__untagged__") : [...prev, "__untagged__"]
                                )
                              }
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors border-b border-black/5 dark:border-white/5 mb-0.5"
                            >
                              <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${untaggedActive ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400 ring-1 ring-blue-500/25" : "border border-black/20 dark:border-white/20"}`}>
                                {untaggedActive && <Check className="w-2.5 h-2.5" />}
                              </div>
                              <span className={`flex-1 truncate italic ${untaggedActive ? "text-black/90 dark:text-white/90 font-medium" : "text-black/50 dark:text-white/50"}`}>
                                Not Tagged
                              </span>
                            </button>
                          );
                        })()}
                        {allTags.map((tag) => {
                          const active = selectedFilterTags.includes(tag.name);
                          return (
                            <button
                              key={tag.name}
                              type="button"
                              onClick={() =>
                                setSelectedFilterTags((prev) =>
                                  active ? prev.filter((t) => t !== tag.name) : [...prev, tag.name]
                                )
                              }
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                            >
                              <div className={`w-3.5 h-3.5 rounded flex items-center justify-center shrink-0 ${active ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400 ring-1 ring-blue-500/25" : "border border-black/20 dark:border-white/20"}`}>
                                {active && <Check className="w-2.5 h-2.5" />}
                              </div>
                              <span className={`flex-1 truncate ${active ? "text-black/90 dark:text-white/90 font-medium" : "text-black/65 dark:text-white/65"}`}>
                                {tag.name}
                              </span>
                              <span className="text-[0.625rem] text-black/30 dark:text-white/30">{tag.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                {!isWakePreview && !studioSurface && (
                  <button
                    type="button"
                    onClick={() => nav("/settings?section=connections")}
                    className="ml-auto shrink-0 inline-flex items-center gap-1.5 rounded-full bg-blue-500 px-3.5 py-2 text-[0.75rem] font-medium text-white shadow-sm hover:bg-blue-600 transition-colors"
                    title="Connect apps to your Vault"
                  >
                    <Plug className="w-3.5 h-3.5" />
                    Connect apps
                  </button>
                )}
                {isWakePreview && (
                  <button
                    type="button"
                    onClick={() => onWakePreviewTabChange?.("connections")}
                    className="ml-auto shrink-0 inline-flex items-center gap-1.5 rounded-full bg-blue-500 px-3.5 py-2 text-[0.75rem] font-medium text-white shadow-sm hover:bg-blue-600 transition-colors"
                    title="Connect apps to your Vault"
                  >
                    <Plug className="w-3.5 h-3.5" />
                    Connect apps
                  </button>
                )}
                </div>
              {isConceptSearching && (
                <p className="mt-2 text-xs text-black/40 dark:text-white/40">Reading through your vault...</p>
              )}
              {conceptResultIds !== null && !isConceptSearching && (() => {
                // Count only IDs that are actually present in the current
                // visible card list. The raw `conceptResultIds.length`
                // includes notes that have been filtered out (tag filter,
                // search), deleted, or aren't loaded — leading to "Found
                // 12 related items" when only 5 cards actually appear.
                const visibleIds = new Set(visibleCards.map((c) => c.id));
                const matchedCount = conceptResultIds.filter((id) => visibleIds.has(id)).length;
                return (
                <div className="mt-2 flex items-center gap-2 text-xs text-black/50 dark:text-white/50">
                  <span>
                    {matchedCount === 0
                      ? "Nothing in your vault matches that"
                      : `Found ${matchedCount} related item${matchedCount === 1 ? "" : "s"}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setVaultSearch(""); setConceptResultIds(null); }}
                    className="text-blue-500 hover:text-blue-600"
                  >
                    Show all
                  </button>
                </div>
                );
              })()}
            </>
          )}
        </section>
  );
}
