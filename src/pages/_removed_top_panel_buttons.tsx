/**
 * REMOVED TOP PANEL BUTTONS — preserved for future reference.
 *
 * These were originally rendered inside the top panel in OmniaCanvas.tsx
 * within the `{topPanelOpen && ( ... )}` block.
 *
 * To restore, import the required icons/components and paste the relevant
 * JSX back into the panel's `<div className="flex items-center gap-1 ...">`.
 */

// ─── Back Button ─────────────────────────────────────────────────────────────
/*
<button
  type="button"
  onClick={() => nav(-1)}
  className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
  title="Back"
>
  <ArrowLeft className="w-4 h-4" />
</button>

<div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />
*/

// ─── AI Mode Selector (Think / Plan / Agent) ─────────────────────────────────
/*
<Select
  value={aiMode}
  onValueChange={(value: string) => {
    const mode = value as AiMode;
    setAiMode(mode);
    try {
      const saved = localStorage.getItem("lykinsai_settings");
      const settings = saved ? JSON.parse(saved) : {};
      settings.aiMode = mode;
      localStorage.setItem("lykinsai_settings", JSON.stringify(settings));
      window.dispatchEvent(new CustomEvent("lykinsai_settings_changed"));
    } catch {}
  }}
>
  <SelectTrigger className="w-[8.125rem] h-9 rounded-full glass-control hover:opacity-90 text-xs font-medium gap-1.5 px-3 [&>span]:flex [&>span]:items-center [&>span]:justify-center [&>span]:w-full">
    <SelectValue placeholder="Mode" />
  </SelectTrigger>
  <SelectContent
    align="end"
    className="glass-control border border-white/25 dark:border-white/10 bg-white/35 dark:bg-white/10 backdrop-blur-xl shadow-lg overflow-hidden min-w-[8.125rem]"
  >
    {(Object.entries(AI_MODE_META) as [AiMode, typeof AI_MODE_META["think"]][]).map(([key, meta]) => {
      const Icon = meta.icon;
      return (
        <SelectItem key={key} value={key} className="flex items-center justify-center pl-3 pr-8 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <Icon className="w-3.5 h-3.5 shrink-0" />
            {meta.label}
          </span>
        </SelectItem>
      );
    })}
  </SelectContent>
</Select>

<div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />
*/

// ─── Undo / Redo Buttons ─────────────────────────────────────────────────────
/*
<button
  type="button"
  onPointerDown={(e) => { e.preventDefault(); }}
  onClick={() => { if (!runNativeUndoRedo("undo")) undo(); }}
  disabled={!isEditingField && !canUndo}
  className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
  title="Undo (Ctrl/Cmd+Z)"
>
  <Undo2 className="w-4 h-4" />
</button>
<button
  type="button"
  onPointerDown={(e) => { e.preventDefault(); }}
  onClick={() => { if (!runNativeUndoRedo("redo")) redo(); }}
  disabled={!isEditingField && !canRedo}
  className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
  title="Redo (Ctrl/Cmd+Shift+Z / Ctrl+Y)"
>
  <Redo2 className="w-4 h-4" />
</button>

<div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />
*/

// ─── Trash / Clear Canvas Button ─────────────────────────────────────────────
/*
<button
  type="button"
  onClick={clearCanvasAndPrompts}
  className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
  title="Clear canvas"
>
  <Trash2 className="w-4 h-4" />
</button>

<div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1" />
*/

// ─── Attachments (+) Button ──────────────────────────────────────────────────
/*
<button
  type="button"
  onClick={() => setShowAttachMenu(true)}
  className="rounded-full w-9 h-9 p-0 hover:bg-black/10 dark:hover:bg-white/15 transition-colors touch-manipulation flex items-center justify-center"
  title="Attachments"
>
  <Plus className="w-4 h-4" />
</button>
*/

// ─── Required imports for restoration ────────────────────────────────────────
/*
import { ArrowLeft, Undo2, Redo2, Trash2, Plus } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

State variables needed:
- aiMode, setAiMode (AiMode type + AI_MODE_META)
- undo, redo, canUndo, canRedo (from useCanvasStore)
- isEditingField, runNativeUndoRedo
- clearCanvasAndPrompts
- showAttachMenu, setShowAttachMenu
*/

export {};
