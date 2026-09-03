import { useState } from "react";
import { FolderOpen, HardDrive, Plus, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { isLocalModeAvailable } from "@/lib/localMode";
import { useMacSync } from "@/lib/macSync";

function shortenHome(p) {
  return String(p || "").replace(/^\/Users\/[^/]+/, "~");
}

/**
 * Switch that grants LYKN file + terminal access on this device. Only renders
 * inside the desktop shell (where the Electron bridge exists). First enable
 * shows a one-time consent dialog explaining what access is granted. When
 * enabled, a folder button opens the synced-folders manager (which folders
 * LYKN can see — the "Sync with Mac" allowlist).
 *
 * variant="pill" (default) — compact labeled pill for header rows.
 * variant="menu" — full-width row styled to sit inside the chat "+" menu.
 */
export default function LocalModeToggle({ variant = "pill" }) {
  const [available] = useState(() => isLocalModeAvailable());
  const [foldersOpen, setFoldersOpen] = useState(false);
  const sync = useMacSync();
  const enabled = sync.enabled;

  if (!available) return null;

  const canManageFolders = enabled && sync.available;
  const folderButton = canManageFolders ? (
    <button
      type="button"
      onClick={() => setFoldersOpen(true)}
      className="flex items-center justify-center rounded-md p-1 text-black/55 dark:text-white/55 hover:text-black/85 dark:hover:text-white/85 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
      title="Choose which folders LYKN can see"
      aria-label="Manage synced folders"
    >
      <FolderOpen className="w-3.5 h-3.5" />
    </button>
  ) : null;

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
          <span className="ml-auto flex items-center gap-1.5">
            {folderButton}
            <Switch
              checked={enabled}
              disabled={sync.busy}
              onCheckedChange={(next) => sync.requestToggle(next)}
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
          {folderButton}
          <Switch
            checked={enabled}
            disabled={sync.busy}
            onCheckedChange={(next) => sync.requestToggle(next)}
            aria-label="Local mode"
          />
        </div>
      )}

      <Dialog
        open={sync.confirming}
        onOpenChange={(open) => {
          if (!open) sync.cancelEnable();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Give LYKN access to your Mac?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Local mode lets LYKN work directly on this computer, but only
                  in folders you choose. When it is on, LYKN can:
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Read, search, and list files in the folders you approve</li>
                  <li>Create and edit files in those folders</li>
                  <li>Run terminal commands with those folders as the working directory</li>
                </ul>
                <p className="text-black/60 dark:text-white/60">
                  Enabling Local mode does not share your whole home folder.
                  After you turn it on, pick the folders LYKN may use. You can
                  share the whole home folder later if you want. Files stay on
                  this Mac. Consequential commands (delete-like, download, clone)
                  still ask first. You can turn Local mode off anytime.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={sync.cancelEnable}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-black/70 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                await sync.confirmEnable();
                setFoldersOpen(true);
              }}
              className="rounded-lg px-3 py-1.5 text-sm font-medium bg-black text-white dark:bg-white dark:text-black hover:opacity-90 transition-opacity"
            >
              Enable Local mode
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={foldersOpen} onOpenChange={setFoldersOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Folders synced with LYKN</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p className="text-black/60 dark:text-white/60">
                  LYKN and its AI can only see what you sync. Everything stays on
                  this Mac.
                </p>
                <label className="flex items-center gap-3 rounded-xl border border-black/10 dark:border-white/15 px-3 py-2.5 cursor-pointer">
                  <span className="flex-1">
                    <span className="block font-medium text-black/85 dark:text-white/90">
                      Share my whole home folder
                    </span>
                    <span className="block text-xs text-black/55 dark:text-white/55">
                      {sync.syncAll
                        ? 'LYKN can see everything in your home folder.'
                        : 'LYKN can only see the folders below.'}
                    </span>
                  </span>
                  <Switch
                    checked={sync.syncAll}
                    onCheckedChange={(next) => sync.setSyncAll(next)}
                    aria-label="Share my whole home folder"
                  />
                </label>
                {!sync.syncAll && (
                  <div className="space-y-1.5">
                    {sync.empty && (
                      <p className="text-xs text-black/50 dark:text-white/50 px-1">
                        No folders synced yet. LYKN can't see any files.
                      </p>
                    )}
                    {sync.folders.map((folder) => (
                      <div
                        key={folder}
                        className="flex items-center gap-2 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-3 py-2"
                      >
                        <FolderOpen className="w-3.5 h-3.5 shrink-0 text-black/55 dark:text-white/55" />
                        <span className="flex-1 truncate text-[13px] text-black/80 dark:text-white/85">
                          {shortenHome(folder)}
                        </span>
                        <button
                          type="button"
                          onClick={() => sync.removeFolder(folder)}
                          className="rounded p-0.5 text-black/45 dark:text-white/45 hover:text-black/85 dark:hover:text-white/85 transition-colors"
                          aria-label={`Stop syncing ${folder}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => void sync.addFolders()}
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium text-black/70 dark:text-white/75 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add folder
                    </button>
                  </div>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setFoldersOpen(false)}
              className="rounded-lg px-3 py-1.5 text-sm font-medium bg-black text-white dark:bg-white dark:text-black hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
