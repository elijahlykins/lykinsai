import React from "react";
import { BookOpen, FileText, Link2, Music, Play, StickyNote, X } from "lucide-react";
import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import type { FocusedChatAttachment } from "@/lib/ai/chatSendOrchestrator";

type Props = {
  att: FocusedChatAttachment;
  onRemove: (id: string) => void;
};

export default function FocusedAttachmentPreview({ att, onRemove }: Props) {
  const t = att.type.toLowerCase();
  const videoId = att.videoId || (t === "youtube" ? extractYouTubeVideoId(att.url) : null);

  if (t === "youtube" && videoId) {
    return (
      <div className="relative w-40 h-24 rounded-xl overflow-hidden bg-black flex-shrink-0 group">
        <img
          src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
          alt={att.name || "YouTube"}
          className="w-full h-full object-cover"
          draggable={false}
        />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-9 h-7 bg-red-600 rounded-lg flex items-center justify-center shadow-md">
            <Play className="w-3.5 h-3.5 text-white ml-0.5" fill="white" />
          </div>
        </div>
        <button
          type="button"
          onClick={() => onRemove(att.id)}
          className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3" />
        </button>
        <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">
          {att.vaultTitle || att.name || "YouTube Video"}
        </span>
      </div>
    );
  }
  if (t === "image") {
    return (
      <div className="relative w-24 h-24 rounded-xl overflow-hidden bg-black/5 flex-shrink-0 group">
        <img src={att.url} alt={att.name || "Image"} className="w-full h-full object-cover" draggable={false} />
        <button
          type="button"
          onClick={() => onRemove(att.id)}
          className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  if (t === "video") {
    return (
      <div className="relative w-40 h-24 rounded-xl overflow-hidden bg-black flex-shrink-0 group">
        <video src={att.url} className="w-full h-full object-cover" preload="metadata" muted draggable={false} />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-9 h-7 bg-white/55 rounded-lg flex items-center justify-center shadow-sm">
            <Play className="w-3.5 h-3.5 text-black ml-0.5" fill="black" />
          </div>
        </div>
        <button
          type="button"
          onClick={() => onRemove(att.id)}
          className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X className="w-3 h-3" />
        </button>
        <span className="absolute bottom-1 left-1 right-6 text-[0.625rem] text-white truncate bg-black/50 rounded px-1">
          {att.vaultTitle || att.name || "Video"}
        </span>
      </div>
    );
  }
  if (t === "audio") {
    return (
      <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
        <Music className="w-4 h-4 flex-shrink-0 opacity-60" />
        <span className="max-w-[11.25rem] truncate text-xs">{att.vaultTitle || att.name || "Audio"}</span>
        <button
          type="button"
          onClick={() => onRemove(att.id)}
          className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  if (t === "vault") {
    return (
      <div className="relative inline-flex items-center gap-2 rounded-xl border border-violet-300/40 bg-violet-100/40 px-3 py-2 max-w-[16.25rem] group">
        <BookOpen className="w-4 h-4 flex-shrink-0 text-violet-500" />
        <div className="min-w-0">
          <span className="block text-xs font-medium truncate">{att.vaultTitle || "Vault item"}</span>
          {att.vaultContent && (
            <span className="block text-[0.625rem] opacity-60 truncate">{att.vaultContent.slice(0, 80)}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onRemove(att.id)}
          className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center flex-shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  if (t === "pdf") {
    return (
      <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
        <FileText className="w-4 h-4 flex-shrink-0 opacity-60" />
        <span className="max-w-[11.25rem] truncate text-xs">{att.vaultTitle || att.name || "PDF"}</span>
        <button
          type="button"
          onClick={() => onRemove(att.id)}
          className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  if (t === "note") {
    return (
      <div className="relative inline-flex items-center gap-2 rounded-xl border border-amber-300/40 bg-amber-100/40 px-3 py-2 max-w-[16.25rem] group">
        <StickyNote className="w-4 h-4 flex-shrink-0 text-amber-600" />
        <div className="min-w-0">
          <span className="block text-xs font-medium truncate">{att.name || "Note"}</span>
          {att.vaultContent && (
            <span className="block text-[0.625rem] opacity-60 truncate">{att.vaultContent.slice(0, 80)}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onRemove(att.id)}
          className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center flex-shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  return (
    <div className="relative inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/30 px-3 py-2 group">
      <Link2 className="w-4 h-4 flex-shrink-0 opacity-60" />
      <span className="max-w-[12.5rem] truncate text-xs">{att.vaultTitle || att.name || att.url || "Attachment"}</span>
      <button
        type="button"
        onClick={() => onRemove(att.id)}
        className="h-4 w-4 rounded-full hover:bg-black/10 flex items-center justify-center"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
