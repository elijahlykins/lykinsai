import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { API_BASE_URL } from "@/lib/api-config";
import { useAuth } from "@/lib/SupabaseAuth";

const CATEGORIES = {
  bug: { label: "Report a bug", placeholder: "What happened, and what did you expect?" },
  suggestion: { label: "Suggestion", placeholder: "What should we improve or add?" },
};

export default function FeedbackModal({ open, onOpenChange, defaultType = "bug" }) {
  const { user } = useAuth();
  const [type, setType] = useState(defaultType);
  useEffect(() => { setType(defaultType); }, [defaultType]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("idle");

  const resetForm = () => {
    setSubject("");
    setBody("");
    setStatus("idle");
  };

  const handleOpenChange = (next) => {
    if (!next) resetForm();
    onOpenChange(next);
  };

  const handleTypeChange = (t) => {
    setType(t);
    setStatus("idle");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch(`${API_BASE_URL}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          subject: subject.trim() || `${type === "bug" ? "Bug Report" : "Suggestion"}`,
          body: body.trim(),
          userEmail: user?.email || "anonymous",
          userId: user?.id || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to send");
      setStatus("success");
      setTimeout(() => handleOpenChange(false), 1800);
    } catch {
      setStatus("error");
    }
  };

  const cat = CATEGORIES[type] || CATEGORIES.bug;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-white dark:bg-[#1e1e1e] border-white/15 dark:border-gray-700 text-black dark:text-white max-w-md">
        <DialogHeader>
          <DialogTitle className="text-black dark:text-white">Feedback</DialogTitle>
          <DialogDescription className="sr-only">
            Send a bug report or suggestion.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4">
          {Object.entries(CATEGORIES).map(([key, { label }]) => (
            <button
              key={key}
              type="button"
              onClick={() => handleTypeChange(key)}
              className={`text-sm font-medium transition-colors ${
                type === key
                  ? "text-black dark:text-white"
                  : "text-black/45 dark:text-white/45 hover:text-black dark:hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {status === "success" ? (
          <p className="py-6 text-sm text-black/70 dark:text-white/70">
            Sent. Thanks for the feedback.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-1">
            <input
              type="text"
              placeholder="Subject (optional)"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-0 py-1.5 text-sm bg-transparent border-0 border-b border-gray-200 dark:border-gray-700 text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 rounded-none focus:outline-none focus:border-black/40 dark:focus:border-white/40"
            />
            <Textarea
              placeholder={cat.placeholder}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              className="resize-none bg-transparent border-0 border-b border-gray-200 dark:border-gray-700 rounded-none px-0 shadow-none text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-black/40 dark:focus-visible:border-white/40"
              required
            />

            {status === "error" && (
              <p className="text-xs text-red-600 dark:text-red-400">
                Something went wrong. Please try again.
              </p>
            )}

            <button
              type="submit"
              disabled={!body.trim() || status === "sending"}
              className="self-start text-sm font-medium text-black dark:text-white hover:opacity-70 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {status === "sending" ? "Sending…" : "Send"}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
