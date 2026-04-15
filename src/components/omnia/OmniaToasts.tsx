import React, { useEffect, useRef } from "react";
import { Check, FileText, Sparkles, X } from "lucide-react";

export interface ConnectionCard {
  title: string;
  sourceType: "board" | "media";
  reason: string;
}

export interface MediaSuggestion {
  title: string;
  reason: string;
  noteId: string;
}

export interface AiSuggestion {
  id: string;
  text: string;
}

interface OmniaToastsProps {
  aiSuggestions: AiSuggestion[];
  showAiSuggestionToast: boolean;
  onSetShowAiSuggestionToast: (v: boolean) => void;
  lastSuggestionKeyRef: React.MutableRefObject<string>;

  connectionCards: ConnectionCard[];
  showConnectionCard: boolean;
  onDismissConnectionCard: () => void;
  onConnectionCardClick: (conn: ConnectionCard) => void;

  mediaSuggestions: MediaSuggestion[];
  showMediaSuggestion: boolean;
  selectedMediaIds: Set<string>;
  onToggleMedia: (noteId: string) => void;
  onImportMedia: () => void;
  onDismissMedia: () => void;
  importingMedia: boolean;
}

const OmniaToasts = React.memo(function OmniaToasts({
  aiSuggestions,
  showAiSuggestionToast,
  onSetShowAiSuggestionToast,
  lastSuggestionKeyRef,
  connectionCards,
  showConnectionCard,
  onDismissConnectionCard,
  onConnectionCardClick,
  mediaSuggestions,
  showMediaSuggestion,
  selectedMediaIds,
  onToggleMedia,
  onImportMedia,
  onDismissMedia,
  importingMedia,
}: OmniaToastsProps) {
  const connectionDismissTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!aiSuggestions.length) return;
    const key = aiSuggestions.map((s) => s.id).join("|");
    if (key === lastSuggestionKeyRef.current) return;
    lastSuggestionKeyRef.current = key;
    onSetShowAiSuggestionToast(true);
    const timer = window.setTimeout(() => onSetShowAiSuggestionToast(false), 6000);
    return () => window.clearTimeout(timer);
  }, [aiSuggestions, lastSuggestionKeyRef, onSetShowAiSuggestionToast]);

  useEffect(() => {
    if (!showConnectionCard || connectionCards.length === 0) return;
    if (connectionDismissTimerRef.current) window.clearTimeout(connectionDismissTimerRef.current);
    connectionDismissTimerRef.current = window.setTimeout(() => {
      onDismissConnectionCard();
      connectionDismissTimerRef.current = null;
    }, 8000);
    return () => {
      if (connectionDismissTimerRef.current) window.clearTimeout(connectionDismissTimerRef.current);
    };
  }, [showConnectionCard, connectionCards, onDismissConnectionCard]);

  return (
    <>
      {aiSuggestions.length > 0 && (
        <div
          className={`fixed right-3 sm:right-6 bottom-6 z-[85] w-[calc(100vw-1.5rem)] sm:w-[20rem] rounded-2xl border border-white/30 bg-[#f2f2f7]/65 backdrop-blur-md shadow-lg shadow-white/10 p-4 text-black transition-transform duration-300 ${
            showAiSuggestionToast ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0 pointer-events-none"
          }`}
        >
          <div className="text-xs font-semibold text-black/70 mb-2">AI Suggestions</div>
          <ul className="space-y-2 text-xs text-black/70">
            {aiSuggestions.slice(0, 4).map((suggestion) => (
              <li key={suggestion.id} className="rounded-xl border border-white/60 bg-white/60 px-3 py-2">
                {suggestion.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {connectionCards.length > 0 && (
        <div
          className={`fixed right-3 sm:right-6 z-[86] w-[calc(100vw-1.5rem)] sm:w-[22rem] rounded-2xl border border-blue-200/40 bg-white/75 backdrop-blur-md shadow-lg shadow-blue-500/5 p-4 text-black transition-all duration-300 ${
            showConnectionCard ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0 pointer-events-none"
          }`}
          style={{ bottom: aiSuggestions.length > 0 && showAiSuggestionToast ? "calc(1.5rem + 12rem)" : "1.5rem" }}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-500" />
              <span className="text-xs font-semibold text-blue-600">AI Connection Found</span>
            </div>
            <button
              type="button"
              onClick={onDismissConnectionCard}
              className="rounded-full w-5 h-5 flex items-center justify-center hover:bg-black/8 transition-colors"
            >
              <X className="w-3 h-3 text-black/40" />
            </button>
          </div>
          <ul className="space-y-2">
            {connectionCards.map((conn, i) => (
              <li
                key={`${conn.title}-${i}`}
                className="rounded-xl border border-blue-100 bg-white px-3 py-2.5 cursor-pointer hover:bg-blue-50/60 transition-colors"
                onClick={() => onConnectionCardClick(conn)}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                    conn.sourceType === "board"
                      ? "bg-blue-100 text-blue-600"
                      : "bg-green-100 text-green-600"
                  }`}>
                    {conn.sourceType}
                  </span>
                  <span className="text-xs font-medium text-black/80 truncate">{conn.title}</span>
                </div>
                <p className="text-[11px] text-black/55 leading-snug">{conn.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {mediaSuggestions.length > 0 && (
        <div
          className={`fixed right-3 sm:right-6 z-[87] w-[calc(100vw-1.5rem)] sm:w-[22rem] rounded-2xl border border-blue-200/40 bg-white/75 backdrop-blur-md shadow-lg shadow-blue-500/5 p-4 text-black transition-all duration-300 ${
            showMediaSuggestion ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0 pointer-events-none"
          }`}
          style={{ bottom: showConnectionCard && connectionCards.length > 0 ? "calc(1.5rem + 14rem)" : aiSuggestions.length > 0 && showAiSuggestionToast ? "calc(1.5rem + 12rem)" : "1.5rem" }}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-500" />
              <span className="text-xs font-semibold text-blue-600">Related Media Found</span>
            </div>
            <button
              type="button"
              onClick={onDismissMedia}
              className="rounded-full w-5 h-5 flex items-center justify-center hover:bg-black/8 transition-colors"
            >
              <X className="w-3 h-3 text-black/40" />
            </button>
          </div>
          <p className="text-[11px] text-black/45 mb-2">Select media to import onto this board</p>
          <ul className="space-y-1.5 max-h-[200px] overflow-y-auto scrollbar-hide">
            {mediaSuggestions.map((item) => {
              const isSelected = selectedMediaIds.has(item.noteId);
              return (
                <li
                  key={item.noteId}
                  className={`rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                    isSelected
                      ? "border-blue-400 bg-blue-50/80"
                      : "border-blue-100 bg-white hover:bg-blue-50/40"
                  }`}
                  onClick={() => onToggleMedia(item.noteId)}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                      isSelected ? "bg-blue-500 border-blue-500" : "border-black/20 bg-white"
                    }`}>
                      {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                    </div>
                    <span className="text-xs font-medium text-black/80 truncate">{item.title}</span>
                  </div>
                  <p className="text-[11px] text-black/50 leading-snug pl-6">{item.reason}</p>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            disabled={selectedMediaIds.size === 0 || importingMedia}
            className="mt-3 w-full py-2 rounded-xl text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-blue-500 text-white hover:bg-blue-600"
            onClick={onImportMedia}
          >
            {importingMedia ? "Importing…" : `Import ${selectedMediaIds.size > 0 ? selectedMediaIds.size : ""} Selected`}
          </button>
        </div>
      )}
    </>
  );
});

export default OmniaToasts;
