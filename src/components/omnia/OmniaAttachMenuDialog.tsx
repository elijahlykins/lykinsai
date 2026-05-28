import React from "react";
import { Image as ImageIcon, Link as LinkIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddLink: (url: string) => void;
  onPickFiles: () => void;
};

export default function OmniaAttachMenuDialog({ open, onOpenChange, onAddLink, onPickFiles }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl border border-white/30 bg-[#f2f2f7]/65 backdrop-blur-md text-black shadow-lg">
        <DialogHeader>
          <DialogTitle className="text-black">Add Attachment</DialogTitle>
          <DialogDescription className="text-black/60">
            Add links or upload files to your chat
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <button
            type="button"
            onClick={() => {
              const url = prompt("Enter any URL:");
              if (!url) return;
              onAddLink(url);
              onOpenChange(false);
            }}
            className="w-full flex items-center gap-3 justify-start rounded-xl px-3 py-2 bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
          >
            <LinkIcon className="w-5 h-5" />
            Add Link
          </button>
          <button
            type="button"
            onClick={() => {
              onPickFiles();
            }}
            className="w-full flex items-center gap-3 justify-start rounded-xl px-3 py-2 bg-white/35 border border-white/30 backdrop-blur-sm hover:opacity-90"
          >
            <ImageIcon className="w-5 h-5" />
            Add Media / Files
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
