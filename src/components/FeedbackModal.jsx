import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Bug, Lightbulb, Send, CheckCircle, AlertCircle } from "lucide-react";
import { API_BASE_URL } from "@/lib/api-config";
import { useAuth } from "@/lib/SupabaseAuth";

const CATEGORIES = {
  bug: { label: "Report a Bug", icon: Bug, placeholder: "Describe what happened and what you expected…" },
  suggestion: { label: "Suggestion", icon: Lightbulb, placeholder: "Tell us your idea or how we can improve…" },
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
      <DialogContent className="sm:max-w-md bg-white/95 backdrop-blur-xl border-black/10">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold text-black/80 flex items-center gap-2">
            <cat.icon className="w-4 h-4" />
            {cat.label}
          </DialogTitle>
          <DialogDescription className="text-xs text-black/50">
            We read every submission — thank you for helping us improve.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 mt-1">
          {Object.entries(CATEGORIES).map(([key, { label, icon: Icon }]) => (
            <button
              key={key}
              type="button"
              onClick={() => handleTypeChange(key)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors ${
                type === key
                  ? "bg-blue-500/10 border-blue-500/30 text-blue-700 font-medium"
                  : "border-black/10 text-black/50 hover:bg-black/5"
              }`}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>

        {status === "success" ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <CheckCircle className="w-8 h-8 text-green-500" />
            <p className="text-sm font-medium text-black/70">Sent! Thanks for your feedback.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3 mt-1">
            <input
              type="text"
              placeholder="Subject (optional)"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm placeholder:text-black/30 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
            />
            <Textarea
              placeholder={cat.placeholder}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              className="resize-none border-black/10 text-sm placeholder:text-black/30 focus:ring-blue-500/40"
              required
            />

            {status === "error" && (
              <div className="flex items-center gap-1.5 text-xs text-red-600">
                <AlertCircle className="w-3.5 h-3.5" />
                Something went wrong. Please try again.
              </div>
            )}

            <button
              type="submit"
              disabled={!body.trim() || status === "sending"}
              className="self-end flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send className="w-3.5 h-3.5" />
              {status === "sending" ? "Sending…" : "Send"}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
