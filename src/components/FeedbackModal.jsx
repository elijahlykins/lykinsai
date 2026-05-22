import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { API_BASE_URL } from "@/lib/api-config";
import { useAuth } from "@/lib/SupabaseAuth";

const CATEGORIES = {
  bug: { label: "Report a bug", placeholder: "Describe what happened and what you expected…" },
  suggestion: { label: "Suggestion", placeholder: "Tell us your idea or how we can improve…" },
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
      <DialogContent className="bg-white dark:bg-[#1e1e1e] border-white/15 dark:border-gray-700 text-black dark:text-white max-w-md backdrop-blur-md">
        <DialogHeader>
          <DialogTitle className="text-black dark:text-white">
            {cat.label}
          </DialogTitle>
          <DialogDescription className="text-xs text-gray-500 dark:text-gray-400">
            We read every submission — thank you for helping us improve.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-4 pt-1">
          {Object.entries(CATEGORIES).map(([key, { label }]) => (
            <button
              key={key}
              type="button"
              onClick={() => handleTypeChange(key)}
              className={`text-sm font-medium transition-colors ${
                type === key
                  ? "text-black dark:text-white"
                  : "text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {status === "success" ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <CheckCircle className="w-6 h-6 text-gray-500 dark:text-gray-400" />
            <p className="text-sm font-medium text-black dark:text-white">Sent. Thanks for your feedback.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3 pt-2">
            <input
              type="text"
              placeholder="Subject (optional)"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-white dark:bg-[#1f1d1d] border border-gray-200 dark:border-gray-700 text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 rounded-lg focus:outline-none focus:ring-1 focus:ring-black/20 dark:focus:ring-white/20"
            />
            <Textarea
              placeholder={cat.placeholder}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              className="resize-none bg-white dark:bg-[#1f1d1d] border-gray-200 dark:border-gray-700 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus-visible:ring-1 focus-visible:ring-black/20 dark:focus-visible:ring-white/20 focus-visible:ring-offset-0"
              required
            />

            {status === "error" && (
              <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="w-3.5 h-3.5" />
                Something went wrong. Please try again.
              </div>
            )}

            <button
              type="submit"
              disabled={!body.trim() || status === "sending"}
              className="self-end inline-flex items-center justify-center gap-2 rounded-lg bg-black text-white hover:bg-black/90 dark:bg-white dark:text-black dark:hover:bg-white/90 px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {status === "sending" ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Sending…
                </>
              ) : (
                "Send"
              )}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
