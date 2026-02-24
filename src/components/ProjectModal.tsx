import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type ProjectModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (args: { name: string; mode: "blank" | "files" }) => Promise<void> | void;
};

export default function ProjectModal({ open, onOpenChange, onCreate }: ProjectModalProps) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"blank" | "files">("blank");

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await onCreate({ name: trimmed, mode });
    setName("");
    setMode("blank");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-control text-black border border-white/50 shadow-2xl">
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm text-black/60">Project name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled Project"
              className="mt-2 w-full rounded-xl bg-white/70 border border-white/50 px-3 py-2 text-black outline-none backdrop-blur-md"
            />
          </div>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setMode("blank")}
              className={`w-full rounded-xl border px-3 py-2 text-left ${
                mode === "blank" ? "border-white/60 bg-white/40" : "border-white/40 bg-white/20"
              }`}
            >
              Start with a blank board
            </button>
            <button
              type="button"
              onClick={() => setMode("files")}
              className={`w-full rounded-xl border px-3 py-2 text-left ${
                mode === "files" ? "border-white/60 bg-white/40" : "border-white/40 bg-white/20"
              }`}
            >
              Upload files first
            </button>
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            className="w-full rounded-full bg-white/30 border border-white/60 px-4 py-2 text-sm font-medium hover:bg-white/40"
          >
            Create Project
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
