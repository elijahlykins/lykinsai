import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  isLocalModeAvailable,
  getLocalModeCached,
  refreshLocalMode,
  setLocalMode,
  subscribeLocalMode,
} from "@/lib/localMode";

const CONSENT_KEY = "lykn_local_mode_consented";

/**
 * Switch that grants LYKN file + terminal access on this device. Only renders
 * inside the desktop shell (where the Electron bridge exists). First enable
 * shows a one-time consent dialog explaining what access is granted.
 *
 * variant="pill" (default) — compact labeled pill for header rows.
 * variant="menu" — full-width row styled to sit inside the chat "+" menu.
 */
export default function LocalModeToggle({ variant = "pill" }) {
  const [available] = useState(() => isLocalModeAvailable());
  const [enabled, setEnabled] = useState(() => getLocalModeCached());
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!available) return;
    void refreshLocalMode();
    return subscribeLocalMode(setEnabled);
  }, [available]);

  if (!available) return null;

  const applyEnabled = async (next) => {
    setBusy(true);
    try {
      const result = await setLocalMode(next);
      setEnabled(result);
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (next) => {
    if (next) {
      const consented =
        typeof window !== "undefined" && localStorage.getItem(CONSENT_KEY) === "1";
      if (!consented) {
        setConfirmOpen(true);
        return;
      }
    }
    await applyEnabled(next);
  };

  const confirmEnable = async () => {
    try {
      localStorage.setItem(CONSENT_KEY, "1");
    } catch {
      /* storage blocked — proceed anyway for this session */
    }
    setConfirmOpen(false);
    await applyEnabled(true);
  };

  return (
    <>
      {variant === "menu" ? (
        <div
          className="w-full flex items-center gap-3 rounded-xl px-2.5 py-2 text-[13px] font-medium text-black/85 dark:text-white/90"
          title="Let LYKN read and write files and run terminal commands on this Mac"
        >
          <span className="w-5 h-5 flex items-center justify-center shrink-0 opacity-80">
            <HardDrive
              className={`w-[1.05rem] h-[1.05rem] ${enabled ? "text-blue-600 dark:text-blue-400" : ""}`}
            />
          </span>
          Local mode
          <span className="ml-auto flex items-center">
            <Switch
              checked={enabled}
              disabled={busy}
              onCheckedChange={(next) => void handleToggle(next)}
              aria-label="Local mode"
            />
          </span>
        </div>
      ) : (
        <div
          className="inline-flex items-center gap-2 rounded-md px-2 py-1 shrink-0"
          title="Let LYKN read and write files and run terminal commands on this Mac"
        >
          <HardDrive
            className={`w-3 h-3 ${enabled ? "text-blue-600 dark:text-blue-400" : "text-black/50 dark:text-white/50"}`}
          />
          <span className="text-[0.6875rem] font-medium text-black/65 dark:text-white/65">
            Local
          </span>
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(next) => void handleToggle(next)}
            aria-label="Local mode"
          />
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Give LYKN access to your Mac?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Local mode lets LYKN work directly on this computer. When it is
                  on, LYKN can:
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Read, search, and list files in your home folder</li>
                  <li>Create and edit files</li>
                  <li>Run terminal commands</li>
                </ul>
                <p className="text-black/60 dark:text-white/60">
                  LYKN asks before it looks through your files, and asks again
                  for every action that writes, deletes, or could change your
                  system. You can turn Local mode off anytime from this switch.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-black/70 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmEnable()}
              className="rounded-lg px-3 py-1.5 text-sm font-medium bg-black text-white dark:bg-white dark:text-black hover:opacity-90 transition-opacity"
            >
              Enable Local mode
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
