import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { Check, AlertCircle, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import { saveLinkToVault } from "@/lib/saveToVault";
import { toast } from "@/components/ui/use-toast";
import { safeExternalUrl } from "@/lib/safeExternalUrl";

const PENDING_SHARE_KEY = "lykn:pendingShare";
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;

function extractUrl(...sources) {
  for (const raw of sources) {
    if (!raw) continue;
    const s = String(raw).trim();
    if (!s) continue;
    if (/^https?:\/\//i.test(s)) return s;
    const match = s.match(URL_RE);
    if (match) return match[0];
  }
  return null;
}

function readSharePayload(search) {
  const params = new URLSearchParams(search);
  const url = params.get("url");
  const text = params.get("text");
  const title = params.get("title");
  const resolved = extractUrl(url, text, title);
  return { url: resolved, title: title || "", text: text || "" };
}

export default function ShareReceiver() {
  const nav = useNavigate();
  const location = useLocation();
  const { user, loading } = useAuth();
  // idle → resolve URL; confirm → wait for explicit save; saving/done/error/dup
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [pendingUrl, setPendingUrl] = useState("");
  const redirectTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (redirectTimerRef.current) window.clearTimeout(redirectTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (loading) return;

    let { url } = readSharePayload(location.search);

    // Fallback: a Google-OAuth sign-in round-trip (full page redirect) loses
    // both router state and the query string, so the URL stashed before the
    // login bounce is the only survivor. Without this read the user came back
    // authenticated only to be told "No link was shared".
    if (!url) {
      try {
        url = extractUrl(sessionStorage.getItem(PENDING_SHARE_KEY));
      } catch {
        /* storage may be blocked */
      }
    }

    const safe = safeExternalUrl(url);
    if (!safe || !/^https?:\/\//i.test(safe)) {
      setStatus("error");
      setMessage("No link was shared. Try sharing again from the app.");
      setPendingUrl("");
      return;
    }

    if (!user) {
      try {
        sessionStorage.setItem(PENDING_SHARE_KEY, safe);
      } catch {
        /* storage may be blocked; fall through */
      }
      nav("/login", {
        replace: true,
        state: { from: { pathname: "/share", search: `?url=${encodeURIComponent(safe)}` } },
      });
      return;
    }

    // Logged-in: require an explicit confirm before writing to the vault so a
    // drive-by `/share?url=` open (or a malicious page that navigates here)
    // cannot silently add attacker-chosen links.
    setPendingUrl(safe);
    setStatus("confirm");
    setMessage("Save this link to your Vault?");
  }, [loading, user, location.search, nav]);

  const runSave = useCallback(() => {
    if (!user || !pendingUrl) return;
    setStatus("saving");
    setMessage("Saving to Vault…");

    try {
      sessionStorage.removeItem(PENDING_SHARE_KEY);
    } catch {
      /* noop */
    }

    saveLinkToVault({ userId: user.id, url: pendingUrl })
      .then((result) => {
        if (result.ok) {
          setStatus("done");
          setMessage("Saved to Vault");
          toast({ title: "Saved to Vault", description: pendingUrl });
          redirectTimerRef.current = window.setTimeout(() => nav("/vault", { replace: true }), 900);
          return;
        }
        if (result.reason === "duplicate") {
          setStatus("dup");
          setMessage("Already in your Vault");
          toast({ title: "Already saved", description: pendingUrl });
          redirectTimerRef.current = window.setTimeout(() => nav("/vault", { replace: true }), 900);
        } else if (result.reason === "cap") {
          setStatus("error");
          setMessage("Vault is full. Upgrade to keep saving.");
        } else if (result.reason === "rate") {
          setStatus("error");
          setMessage("You're saving too fast. Try again in a moment.");
        } else {
          setStatus("error");
          setMessage(result.message || "Could not save that link. Please try again.");
        }
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.error("[ShareReceiver] save failed:", err);
        setStatus("error");
        setMessage("Could not save that link. Please try again.");
      });
  }, [user, pendingUrl, nav]);

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 px-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm"
      >
        <div className="flex items-center gap-3">
          {status === "saving" && <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />}
          {status === "done" && <Check className="h-5 w-5 text-emerald-500" />}
          {status === "dup" && <Check className="h-5 w-5 text-neutral-400" />}
          {status === "error" && <AlertCircle className="h-5 w-5 text-red-500" />}
          {(status === "idle" || status === "saving") && (
            <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
          )}
          <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {status === "idle" || status === "saving" ? "Saving to Vault" : "Save to Vault"}
          </div>
        </div>
        <div className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          {message || "Preparing…"}
        </div>
        {status === "confirm" && pendingUrl ? (
          <>
            <p className="mt-3 break-all rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300">
              {pendingUrl}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={runSave}
                className="flex-1 rounded-lg bg-neutral-900 dark:bg-neutral-100 px-3 py-2 text-sm font-medium text-white dark:text-neutral-900 hover:opacity-90"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => nav("/vault", { replace: true })}
                className="flex-1 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                Cancel
              </button>
            </div>
          </>
        ) : null}
        {status === "error" && (
          <button
            type="button"
            onClick={() => nav("/vault", { replace: true })}
            className="mt-4 w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Open Vault
          </button>
        )}
      </motion.div>
    </div>
  );
}
