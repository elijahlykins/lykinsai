import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  X, Settings, ExternalLink, ArrowRight, Copy, Zap, Send, Save, Trash2,
  ToggleLeft, ToggleRight, Loader2, AlertTriangle, Sparkles, Globe,
  Play, Download, Upload, RefreshCw, Link2, Share2, Lock, Unlock,
  Eye, EyeOff, ChevronRight, ChevronDown, Plus, Minus, Check, Heart,
  Star, Bookmark, Bell, Mail, MessageSquare, Search, Filter, Archive,
  Clipboard, FileText, Folder, Image, Video, Music, Code, Terminal,
  Wifi, Cloud, Database, Shield, Users, UserPlus, LogOut, LogIn,
  Moon, Sun, Palette, LayoutGrid, Layers, GitBranch, Rocket,
  Home, Calendar, CreditCard, Crosshair, Compass,
} from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/SupabaseAuth";

/* ── Icon registry ─────────────────────────────────────────────────── */

const ICON_MAP: Record<string, React.FC<{ className?: string }>> = {
  "external-link": ExternalLink, "arrow-right": ArrowRight, copy: Copy, zap: Zap,
  send: Send, save: Save, trash: Trash2, sparkles: Sparkles, globe: Globe,
  play: Play, download: Download, upload: Upload, refresh: RefreshCw,
  link: Link2, share: Share2, lock: Lock, unlock: Unlock, eye: Eye, "eye-off": EyeOff,
  "chevron-right": ChevronRight, "chevron-down": ChevronDown, plus: Plus, minus: Minus,
  check: Check, heart: Heart, star: Star, bookmark: Bookmark, bell: Bell,
  mail: Mail, message: MessageSquare, search: Search, filter: Filter, archive: Archive,
  clipboard: Clipboard, file: FileText, folder: Folder, image: Image, video: Video,
  music: Music, code: Code, terminal: Terminal, wifi: Wifi, cloud: Cloud,
  database: Database, shield: Shield, users: Users, "user-plus": UserPlus,
  "log-out": LogOut, "log-in": LogIn, moon: Moon, sun: Sun, palette: Palette,
  grid: LayoutGrid, layers: Layers, "git-branch": GitBranch, rocket: Rocket,
  home: Home, calendar: Calendar, "credit-card": CreditCard,
  crosshair: Crosshair, compass: Compass, settings: Settings, x: X,
};

const ICON_NAMES = Object.keys(ICON_MAP);

/* ── Types ─────────────────────────────────────────────────────────── */

type ButtonStyle = "filled" | "outline" | "ghost" | "icon" | "icon-label";
type ButtonAction = "url" | "navigate" | "copy" | "toggle" | "automate" | "ai" | "submit" | "canvas" | "block" | "custom";
type NavigateTarget = "page" | "board" | "project";
type BlockTargetAction = "scroll" | "select";

type ButtonConfig = {
  label: string;
  icon: string;
  style: ButtonStyle;
  action: ButtonAction;
  url?: string;
  route?: string;
  navigateTarget?: NavigateTarget;
  navigateValue?: string;
  navigateLabel?: string;
  copyText?: string;
  webhookUrl?: string;
  aiPrompt?: string;
  eventName?: string;
  targetBlockId?: string;
  blockAction?: BlockTargetAction;
  onClickCode?: string;
  description?: string;
  _needsSetup?: boolean;
  confirm: boolean;
  toggleState?: boolean;
};

const DEFAULT_CONFIG: ButtonConfig = {
  label: "Button", icon: "zap", style: "filled", action: "url",
  url: "", route: "", navigateTarget: "page", navigateValue: "", navigateLabel: "",
  copyText: "", webhookUrl: "", aiPrompt: "", eventName: "",
  targetBlockId: "", blockAction: "scroll", onClickCode: "",
  description: "", _needsSetup: false,
  confirm: false, toggleState: false,
};

function parseConfig(content: string): ButtonConfig {
  try {
    const p = JSON.parse(content);
    if (p && typeof p === "object") return { ...DEFAULT_CONFIG, ...p };
  } catch {}
  return { ...DEFAULT_CONFIG };
}

/* ── App pages ─────────────────────────────────────────────────────── */

const APP_PAGES = [
  { path: "/", label: "Home", icon: "home" },
  { path: "/omnia", label: "Chat", icon: "message" },
  { path: "/memory", label: "Memory", icon: "image" },
  { path: "/calendar", label: "Calendar", icon: "calendar" },
  { path: "/teamspaces", label: "Teamspaces", icon: "users" },
  { path: "/reminders", label: "Reminders", icon: "bell" },
  { path: "/settings", label: "Settings", icon: "settings" },
  { path: "/connections", label: "Connections", icon: "link" },
  { path: "/billing", label: "Billing", icon: "credit-card" },
  { path: "/trash", label: "Trash", icon: "trash" },
] as const;

/* ── Style + action maps ──────────────────────────────────────────── */

const STYLE_CLASSES: Record<ButtonStyle, string> = {
  filled:     "bg-blue-500/90 hover:bg-blue-500 border-blue-400/50 text-white shadow-md",
  outline:    "bg-transparent hover:bg-black/5 border-black/20 text-black/80",
  ghost:      "bg-transparent hover:bg-black/8 border-transparent text-black/70",
  icon:       "bg-white/30 hover:bg-white/50 border-white/40 text-black/70 shadow-sm",
  "icon-label": "bg-white/40 hover:bg-white/60 border-white/50 text-black/80 shadow-sm",
};

const TOGGLED_STYLE = "bg-emerald-500/90 hover:bg-emerald-500 border-emerald-400/50 text-white shadow-md";

const ACTION_META: Record<string, { label: string; icon: string }> = {
  url:       { label: "Open URL",     icon: "external-link" },
  navigate:  { label: "Navigate",     icon: "compass" },
  copy:      { label: "Copy",         icon: "copy" },
  toggle:    { label: "Toggle",       icon: "zap" },
  automate:  { label: "Automate",     icon: "rocket" },
  ai:        { label: "AI Action",    icon: "sparkles" },
  submit:    { label: "Submit",       icon: "send" },
  block:     { label: "Block",        icon: "crosshair" },
  custom:    { label: "Custom",       icon: "code" },
};

const VISIBLE_ACTIONS = Object.keys(ACTION_META) as ButtonAction[];

/* ── Helpers ──────────────────────────────────────────────────────── */

function blockPreview(b: any): string {
  if (!b) return "Unknown";
  const fmt = String(b.format || "plain");
  if (fmt === "table") return "Table";
  if (fmt === "calendar") return "Calendar";
  if (fmt === "media") return "Media";
  if (fmt === "button") {
    try { return `Button: ${JSON.parse(b.content).label || "Button"}`; } catch {}
    return "Button";
  }
  const txt = String(b.content || "").replace(/\n/g, " ").trim();
  if (!txt) return "Empty text";
  return txt.length > 35 ? txt.slice(0, 35) + "…" : txt;
}

function extractJson(text: string): Record<string, any> | null {
  const raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1].trim() : raw;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(raw.slice(first, last + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

/* ── AI prompt builder ────────────────────────────────────────────── */

function buildButtonPrompt(
  description: string,
  boards: { id: string; title: string }[],
  projects: { id: string; name: string }[],
  canvasBlocks: { id: string; preview: string }[],
): string {
  return [
    "You are a button builder for a canvas workspace app. The user describes what a button should do and you write the code that makes it work.",
    "",
    "Return ONLY a JSON object (no markdown fences, no explanation) with these fields:",
    '{',
    '  "label": "short button text",',
    '  "icon": "icon name from the list below",',
    '  "style": "filled | outline | ghost | icon | icon-label",',
    '  "confirm": true/false (true only for destructive actions or if user asks for confirmation),',
    '  "onClickCode": "async JavaScript code that runs when clicked"',
    '}',
    "",
    "The onClickCode runs inside an async function and has access to a `ctx` object with these APIs:",
    "",
    "  ctx.navigate(path)        — SPA navigate to any route (e.g. ctx.navigate('/calendar'))",
    "  ctx.showFeedback(msg)     — show a brief toast message on the button",
    "  ctx.clipboard.writeText(t) — copy text to clipboard",
    "  ctx.fetch(url, opts)      — make HTTP requests",
    "  ctx.dispatchEvent(name, detail) — dispatch a custom DOM event",
    "  ctx.blocks                — object of all blocks on the current canvas { [id]: block }",
    "  ctx.blockOrder            — array of block IDs in order",
    "  ctx.selectBlocks([ids])   — select blocks on the canvas",
    "  ctx.setCamera({x, y})     — pan the canvas camera to a position",
    "  ctx.blockId               — this button's own block ID",
    "",
    "To scroll to & highlight a specific block:",
    '  const b = ctx.blocks["BLOCK_ID"];',
    "  if (b) {",
    "    ctx.setCamera({ x: (b.x||0) + (b.width||200)/2 - window.innerWidth/2, y: (b.y||0) + (b.height||100)/2 - window.innerHeight/2 });",
    '    const el = document.querySelector(`[data-block-id="BLOCK_ID"]`);',
    '    if (el) { el.classList.add("ring-2","ring-blue-400","ring-offset-2"); setTimeout(() => el.classList.remove("ring-2","ring-blue-400","ring-offset-2"), 1500); }',
    "  }",
    "",
    "To open an external URL: window.open(url, '_blank', 'noopener');",
    "",
    "Write clean, minimal code. No comments needed. Handle errors with try/catch when using fetch or clipboard.",
    "",
    `Available icons: ${ICON_NAMES.join(", ")}`,
    "",
    "App pages the user can navigate to:",
    ...APP_PAGES.map(p => `  "${p.label}" → ctx.navigate("${p.path}")`),
    "",
    boards.length ? "User's boards (navigate with ctx.navigate('/canvas/ID')):\n" + boards.slice(0, 20).map(b => `  "${b.title || "Untitled"}" → id "${b.id}"`).join("\n") : "User's boards: (none)",
    "",
    projects.length ? "User's projects (navigate with ctx.navigate('/project/ID')):\n" + projects.slice(0, 20).map(p => `  "${p.name || "Untitled"}" → id "${p.id}"`).join("\n") : "User's projects: (none)",
    "",
    canvasBlocks.length ? "Blocks on current canvas:\n" + canvasBlocks.slice(0, 20).map(b => `  ${b.preview} → id "${b.id}"`).join("\n") : "Blocks on current canvas: (none)",
    "",
    `User wants: "${description}"`,
    "",
    "Return ONLY the JSON object.",
  ].join("\n");
}

/* ── Component ─────────────────────────────────────────────────────── */

export const ButtonBlock = memo(function ButtonBlock({ id }: { id: string }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const block = useCanvasStore((s) => s.blocks[id]);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const selectBlocks = useCanvasStore((s) => s.selectBlocks);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(id));
  const updateBlock = useCanvasStore((s) => s.updateBlock);
  const pushHistory = useCanvasStore((s) => s.pushHistory);
  const deleteBlock = useCanvasStore((s) => s.deleteBlock);
  const moveBlocksFromSnapshot = useCanvasStore((s) => s.moveBlocksFromSnapshot);
  const setCamera = useCanvasStore((s) => s.setCamera);
  const blockOrder = useCanvasStore((s) => s.blockOrder);

  const dragRef = useRef<any>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [configTab, setConfigTab] = useState<"ai" | "manual" | "icon">("ai");
  const [iconSearch, setIconSearch] = useState("");
  const [feedbackMsg, setFeedbackMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const [aiInput, setAiInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState("");

  const [navSearch, setNavSearch] = useState("");
  const [boards, setBoards] = useState<{ id: string; title: string }[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [blockSearch, setBlockSearch] = useState("");

  /* Fetch boards + projects once on mount */
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const [bRes, pRes] = await Promise.all([
        supabase.from("omnia_boards").select("id, title").eq("user_id", user.id).order("created_at", { ascending: false }),
        supabase.from("omnia_projects").select("id, name").eq("user_id", user.id).order("updated_at", { ascending: false }),
      ]);
      if (cancelled) return;
      setBoards((bRes.data || []) as any);
      setProjects((pRes.data || []) as any);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  /* Canvas blocks for pickers */
  const canvasBlocks = useMemo(() => {
    const st = useCanvasStore.getState();
    return blockOrder
      .filter((bid) => bid !== id && st.blocks[bid] && st.blocks[bid].type !== "create")
      .map((bid) => ({ id: bid, preview: blockPreview(st.blocks[bid]) }));
  }, [blockOrder, id]);

  const style = useMemo(() => {
    if (!block || block.type !== "text" || (block as any).format !== "button") return null;
    return { position: "absolute" as const, left: `${block.x}px`, top: `${block.y}px`, width: `${block.width}px`, height: `${block.height}px`, overflow: "visible" as const };
  }, [block]);

  if (!block || block.type !== "text" || (block as any).format !== "button" || !style) return null;

  const config = parseConfig(String((block as any).content || ""));
  const needsSetup = Boolean(config._needsSetup);
  const BtnIcon = ICON_MAP[config.icon] || Zap;
  const isToggled = config.action === "toggle" && config.toggleState;

  const save = (patch: Partial<ButtonConfig>) => {
    const next = { ...config, ...patch };
    pushHistory();
    updateBlock(id, { content: JSON.stringify(next) } as any);
  };

  const showFeedback = (msg: string, ms = 1500) => {
    setFeedbackMsg(msg);
    setTimeout(() => setFeedbackMsg(""), ms);
  };

  /* ── AI Generation ──────────────────────────────────────────────── */

  const generateConfig = async (description: string) => {
    if (!description.trim()) return;
    setGenerating(true);
    setAiError("");
    try {
      const prompt = buildButtonPrompt(description.trim(), boards, projects, canvasBlocks);
      const { API_BASE_URL } = await import("@/lib/api-config");
      const res = await fetch(`${API_BASE_URL}/api/ai/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-3-opus-20240229", prompt }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(String(err.error || res.statusText || "AI request failed"));
      }

      const data = await res.json();
      const parsed = extractJson(String(data.response || ""));
      if (!parsed || !parsed.label) {
        throw new Error("Opus returned invalid config. Try being more specific.");
      }

      const newConfig: ButtonConfig = {
        ...DEFAULT_CONFIG,
        label: String(parsed.label || "Button"),
        icon: String(parsed.icon || "zap"),
        style: (["filled", "outline", "ghost", "icon", "icon-label"].includes(parsed.style) ? parsed.style : "filled") as ButtonStyle,
        action: "custom",
        onClickCode: String(parsed.onClickCode || ""),
        confirm: Boolean(parsed.confirm),
        description: description.trim(),
        _needsSetup: false,
      };

      pushHistory();
      updateBlock(id, { content: JSON.stringify(newConfig) } as any);
      setConfigOpen(false);
    } catch (err: any) {
      setAiError(err.message || "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  /* ── Execute ─────────────────────────────────────────────────────── */

  const executeAction = async () => {
    if (config.confirm && !confirming) { setConfirming(true); return; }
    setConfirming(false);

    switch (config.action) {
      case "url":
        if (config.url) window.open(config.url, "_blank", "noopener");
        break;

      case "navigate": {
        const target = config.navigateTarget || "page";
        const value = config.navigateValue || config.route || "";
        if (!value) break;
        if (target === "page") nav(value);
        else if (target === "board") nav(`/canvas/${value}`);
        else if (target === "project") nav(`/project/${value}`);
        break;
      }

      case "copy":
        if (config.copyText) {
          try { await navigator.clipboard.writeText(config.copyText); showFeedback("Copied!"); }
          catch { showFeedback("Failed"); }
        }
        break;

      case "toggle":
        save({ toggleState: !config.toggleState });
        window.dispatchEvent(new CustomEvent("omnia_button_toggle", {
          detail: { blockId: id, state: !config.toggleState, label: config.label },
        }));
        break;

      case "automate":
        if (config.webhookUrl) {
          setLoading(true);
          try {
            await fetch(config.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: id, label: config.label, timestamp: Date.now() }) });
            showFeedback("Done!");
          } catch { showFeedback("Error"); }
          finally { setLoading(false); }
        }
        break;

      case "ai":
        window.dispatchEvent(new CustomEvent("omnia_button_ai", {
          detail: { blockId: id, prompt: config.aiPrompt || config.label },
        }));
        showFeedback("Sent to AI");
        break;

      case "submit":
        window.dispatchEvent(new CustomEvent(config.eventName || "omnia_button_submit", {
          detail: { blockId: id, label: config.label },
        }));
        showFeedback("Submitted");
        break;

      case "canvas":
        window.dispatchEvent(new CustomEvent(config.eventName || "omnia_button_canvas", {
          detail: { blockId: id, label: config.label },
        }));
        break;

      case "block": {
        const tid = config.targetBlockId;
        if (!tid) { showFeedback("No target"); break; }
        const st = useCanvasStore.getState();
        const tb = st.blocks[tid];
        if (!tb) { showFeedback("Not found"); break; }
        const bx = Number((tb as any).x) || 0;
        const by = Number((tb as any).y) || 0;
        const bw = Number((tb as any).width) || 200;
        const bh = Number((tb as any).height) || 100;
        setCamera({ x: bx + bw / 2 - window.innerWidth / 2, y: by + bh / 2 - window.innerHeight / 2 });
        if (config.blockAction === "select") selectBlocks([tid]);
        setTimeout(() => {
          const el = document.querySelector(`[data-block-id="${tid}"]`);
          if (el) {
            el.classList.add("ring-2", "ring-blue-400", "ring-offset-2", "transition-shadow");
            setTimeout(() => el.classList.remove("ring-2", "ring-blue-400", "ring-offset-2", "transition-shadow"), 1500);
          }
        }, 100);
        showFeedback(config.blockAction === "select" ? "Selected" : "Scrolled");
        break;
      }

      case "custom": {
        if (!config.onClickCode) break;
        setLoading(true);
        try {
          const ctx = {
            blockId: id,
            navigate: nav,
            blocks: useCanvasStore.getState().blocks,
            blockOrder: useCanvasStore.getState().blockOrder,
            selectBlocks,
            setCamera,
            showFeedback,
            clipboard: navigator.clipboard,
            fetch: window.fetch.bind(window),
            dispatchEvent: (name: string, detail: any) => window.dispatchEvent(new CustomEvent(name, { detail })),
          };
          const fn = new Function("ctx", `return (async () => { ${config.onClickCode} })()`);
          await fn(ctx);
        } catch (err: any) {
          showFeedback(`Error: ${(err.message || "Failed").slice(0, 40)}`, 3000);
        } finally {
          setLoading(false);
        }
        break;
      }
    }
  };

  const cancelConfirm = () => setConfirming(false);

  /* ── Drag ─────────────────────────────────────────────────────────── */
  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault(); bringToFront(id);
    if (e.shiftKey) toggleSelect(id); else if (!isSelected) selectBlocks([id]); pushHistory();
    const st = useCanvasStore.getState(); const sel = st.selectedIds;
    const ids = sel.includes(id) && sel.length > 1 ? sel : [id];
    const snapshot = ids.map((bid) => { const b = st.blocks[bid]; return { id: bid, x: Number((b as any)?.x) || 0, y: Number((b as any)?.y) || 0 }; });
    dragRef.current = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, originX: block.x, originY: block.y, raf: null, lastX: block.x, lastY: block.y, snapshot, capturer: e.currentTarget as HTMLElement };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d || d.pointerId !== e.pointerId) return;
    if (e.pointerType === "mouse" && e.buttons === 0) { dragRef.current = null; return; }
    d.lastX = d.originX + (e.clientX - d.startClientX); d.lastY = d.originY + (e.clientY - d.startClientY);
    if (d.raf != null) return;
    d.raf = window.requestAnimationFrame(() => { const d2 = dragRef.current; if (!d2) return; d2.raf = null; moveBlocksFromSnapshot(d2.snapshot, d2.lastX - d2.originX, d2.lastY - d2.originY, { snap: true }); });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null; try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };

  /* ── Filters ────────────────────────────────────────────────────── */
  const filteredIcons = iconSearch ? ICON_NAMES.filter((n) => n.includes(iconSearch.toLowerCase())) : ICON_NAMES;
  const filteredPages = navSearch ? APP_PAGES.filter((p) => p.label.toLowerCase().includes(navSearch.toLowerCase())) : [...APP_PAGES];
  const filteredBoards = navSearch ? boards.filter((b) => (b.title || "").toLowerCase().includes(navSearch.toLowerCase())) : boards;
  const filteredProjects = navSearch ? projects.filter((p) => (p.name || "").toLowerCase().includes(navSearch.toLowerCase())) : projects;
  const filteredBlocks = blockSearch ? canvasBlocks.filter((b) => b.preview.toLowerCase().includes(blockSearch.toLowerCase())) : canvasBlocks;

  const baseStyle = isToggled ? TOGGLED_STYLE : (STYLE_CLASSES[config.style] || STYLE_CLASSES.filled);
  const isIconOnly = config.style === "icon";
  const showLabel = config.style !== "icon";

  /* ── Render ──────────────────────────────────────────────────────── */
  return (
    <div
      data-canvas-block data-block-id={id}
      className="absolute group" style={style}
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return;
        const t = e.target as Element | null;
        if (t?.closest?.("[data-delete-button]") || t?.closest?.("[data-drag-handle]") || t?.closest?.("[data-config-panel]")) return;
        if (e.shiftKey) toggleSelect(id); else if (!isSelected) selectBlocks([id]);
      }}
    >
      <div className={`h-full w-full relative ${isSelected ? "omnia-selected-glass" : ""}`}>
        {/* Delete */}
        <button data-delete-button type="button"
          className="absolute -top-2 -right-2 z-30 w-5 h-5 rounded-full bg-white/80 border border-black/15 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-black/70 hover:text-red-500"
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); pushHistory(); deleteBlock(id); }}
        ><X className="w-3 h-3" /></button>

        {/* Settings gear (hidden during initial setup) */}
        {!needsSetup && (
          <button type="button"
            className="absolute -top-2 -left-2 z-30 w-5 h-5 rounded-full bg-white/80 border border-black/15 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-black/70 hover:text-blue-500"
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); setConfigOpen(!configOpen); setConfigTab("ai"); setNavSearch(""); setBlockSearch(""); setAiInput(config.description || ""); setAiError(""); }}
          ><Settings className="w-3 h-3" /></button>
        )}

        {/* Drag handle */}
        <div data-drag-handle
          className="absolute top-0 left-0 right-0 z-20 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ height: "6px" }}
          onPointerDown={startDrag} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd} onLostPointerCapture={onDragEnd}
        />

        {/* ── Initial AI setup prompt (single-row brick) ── */}
        {needsSetup ? (
          <div
            data-config-panel
            className="w-full h-full glass-text-card rounded-lg overflow-hidden flex items-center px-2.5 gap-2"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              className="flex-1 min-w-0 bg-transparent text-[0.8125rem] text-black/80 dark:text-white/80 outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
              placeholder="Describe what you want this button to do..."
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); generateConfig(aiInput); } }}
              autoFocus
            />
            {aiError && <span className="text-[0.625rem] text-red-500 flex-shrink-0 truncate max-w-[80px]" title={aiError}>Error</span>}
            <button
              type="button"
              className="flex-shrink-0 w-6 h-6 rounded-md bg-blue-500/90 hover:bg-blue-500 text-white flex items-center justify-center transition-colors disabled:opacity-40"
              disabled={generating || !aiInput.trim()}
              onClick={() => generateConfig(aiInput)}
              title="Generate"
            >
              {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            </button>
          </div>
        ) : confirming ? (
          /* ── Confirm prompt ── */
          <div className="w-full h-full rounded-lg border border-amber-400/50 bg-amber-50/90 backdrop-blur-sm flex items-center justify-center gap-2 text-[0.75rem]">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            <span className="text-amber-800 font-medium">Sure?</span>
            <button type="button" className="px-2 py-0.5 rounded bg-red-500 text-white text-[0.625rem] font-semibold hover:bg-red-600" onClick={(e) => { e.stopPropagation(); executeAction(); }} onPointerDown={(e) => e.stopPropagation()}>Yes</button>
            <button type="button" className="px-2 py-0.5 rounded bg-black/10 text-black/60 text-[0.625rem] font-semibold hover:bg-black/15" onClick={(e) => { e.stopPropagation(); cancelConfirm(); }} onPointerDown={(e) => e.stopPropagation()}>No</button>
          </div>
        ) : (
          /* ── The configured button ── */
          <button
            type="button"
            className={`w-full h-full ${isIconOnly ? "rounded-full" : "rounded-lg"} border backdrop-blur-sm flex items-center justify-center gap-1.5 transition-all text-[0.8125rem] font-medium ${baseStyle}`}
            onClick={(e) => { e.stopPropagation(); executeAction(); }}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (
              <>
                {config.action === "toggle" ? (
                  isToggled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />
                ) : (
                  <BtnIcon className={isIconOnly ? "w-5 h-5" : "w-3.5 h-3.5"} />
                )}
                {showLabel && <span>{config.label}</span>}
              </>
            )}
            {feedbackMsg && <span className="text-[0.625rem] ml-1 opacity-80">{feedbackMsg}</span>}
          </button>
        )}

        {/* ── Config panel (after setup) ── */}
        {configOpen && !needsSetup && (
          <div
            data-config-panel
            className="absolute left-0 top-full mt-2 w-80 rounded-lg border border-white/40 bg-white/95 backdrop-blur-xl shadow-xl z-50 p-3 text-[0.75rem]"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Tabs */}
            <div className="flex gap-1 mb-2">
              <button type="button" className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-medium flex items-center justify-center gap-1 ${configTab === "ai" ? "bg-blue-50 text-blue-700 border border-blue-200" : "hover:bg-black/5 border border-transparent"}`} onClick={() => { setConfigTab("ai"); setAiInput(config.description || ""); setAiError(""); }}>
                <Sparkles className="w-3 h-3" /> Describe
              </button>
              <button type="button" className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-medium flex items-center justify-center gap-1 ${configTab === "manual" ? "bg-black/10 border border-black/10" : "hover:bg-black/5 border border-transparent"}`} onClick={() => setConfigTab("manual")}>
                <Settings className="w-3 h-3" /> Manual
              </button>
              <button type="button" className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-medium flex items-center justify-center gap-1 ${configTab === "icon" ? "bg-black/10 border border-black/10" : "hover:bg-black/5 border border-transparent"}`} onClick={() => setConfigTab("icon")}>
                <Palette className="w-3 h-3" /> Icon
              </button>
            </div>

            {/* ── AI / Describe Tab ── */}
            {configTab === "ai" && (
              <div className="space-y-2">
                <div className="glass-text-card rounded-lg p-2.5 flex items-start gap-2">
                  <textarea
                    className="flex-1 bg-transparent text-[0.75rem] leading-relaxed text-black/80 dark:text-white/80 outline-none resize-none placeholder:text-black/35 dark:placeholder:text-white/35 overflow-hidden scrollbar-hide"
                    style={{ overflow: "hidden" }}
                    rows={2}
                    placeholder="Describe what this button should do..."
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); generateConfig(aiInput); } }}
                  />
                  <button
                    type="button"
                    className="flex-shrink-0 mt-0.5 w-7 h-7 rounded-lg bg-blue-500/90 hover:bg-blue-500 text-white flex items-center justify-center transition-colors disabled:opacity-40"
                    disabled={generating || !aiInput.trim()}
                    onClick={() => generateConfig(aiInput)}
                    title="Regenerate"
                  >
                    {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  </button>
                </div>
                {aiError && <div className="text-[0.625rem] text-red-500 px-1">{aiError}</div>}

                {config.description && (
                  <div className="px-1 text-[0.625rem] text-black/40 flex items-center gap-1.5">
                    <Check className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                    <span className="truncate"><span className="text-black/60 font-medium">{config.label}</span> · {config.action === "custom" ? "custom code" : config.action}</span>
                  </div>
                )}
                <button type="button" className="w-full py-1 rounded bg-black/5 hover:bg-black/10 text-[0.6875rem] font-medium text-black/70 transition-colors" onClick={() => setConfigOpen(false)}>Done</button>
              </div>
            )}

            {/* ── Manual Tab ── */}
            {configTab === "manual" && (
              <div className="space-y-2.5">
                {/* Label */}
                <div>
                  <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">Label</label>
                  <input className="w-full px-2 py-1 rounded border border-black/15 bg-white text-[0.75rem] outline-none focus:border-blue-400" value={config.label} onChange={(e) => save({ label: e.target.value })} />
                </div>

                {/* Style */}
                <div>
                  <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">Style</label>
                  <div className="flex gap-1 flex-wrap">
                    {(["filled", "outline", "ghost", "icon", "icon-label"] as ButtonStyle[]).map((s) => (
                      <button key={s} type="button"
                        className={`px-2 py-0.5 rounded text-[0.625rem] border ${config.style === s ? "border-blue-400 bg-blue-50" : "border-black/10 hover:bg-black/5"}`}
                        onClick={() => save({ style: s })}
                      >{s}</button>
                    ))}
                  </div>
                </div>

                {/* Action */}
                <div>
                  <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">Action</label>
                  <div className="grid grid-cols-3 gap-1">
                    {VISIBLE_ACTIONS.map((a) => {
                      const meta = ACTION_META[a];
                      const Icon = ICON_MAP[meta.icon] || Zap;
                      return (
                        <button key={a} type="button"
                          className={`flex items-center gap-1 px-1.5 py-1 rounded text-[9px] border ${config.action === a ? "border-blue-400 bg-blue-50" : "border-black/8 hover:bg-black/5"}`}
                          onClick={() => save({ action: a, icon: meta.icon })}
                        >
                          <Icon className="w-3 h-3" />
                          <span>{meta.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* ── Action-specific fields ── */}

                {config.action === "url" && (
                  <div>
                    <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">URL</label>
                    <input className="w-full px-2 py-1 rounded border border-black/15 bg-white text-[0.75rem] outline-none focus:border-blue-400" placeholder="https://..." value={config.url || ""} onChange={(e) => save({ url: e.target.value })} />
                  </div>
                )}

                {config.action === "navigate" && (
                  <div>
                    <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">Navigate To</label>
                    <div className="flex gap-1 mb-1.5">
                      {(["page", "board", "project"] as NavigateTarget[]).map((t) => (
                        <button key={t} type="button"
                          className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-medium border ${(config.navigateTarget || "page") === t ? "border-blue-400 bg-blue-50" : "border-black/10 hover:bg-black/5"}`}
                          onClick={() => { save({ navigateTarget: t, navigateValue: "", navigateLabel: "" }); setNavSearch(""); }}
                        >{t.charAt(0).toUpperCase() + t.slice(1)}</button>
                      ))}
                    </div>
                    <div className="relative mb-1">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-black/30 pointer-events-none" />
                      <input className="w-full pl-6 pr-2 py-1 rounded border border-black/15 bg-white text-[0.6875rem] outline-none focus:border-blue-400" placeholder={`Search ${config.navigateTarget || "page"}s...`} value={navSearch} onChange={(e) => setNavSearch(e.target.value)} />
                    </div>
                    <div className="max-h-[120px] overflow-y-auto rounded border border-black/10 scrollbar-hide">
                      {(config.navigateTarget || "page") === "page" && filteredPages.map((p) => {
                        const PIcon = ICON_MAP[p.icon] || Globe;
                        const selected = config.navigateValue === p.path;
                        return (
                          <button key={p.path} type="button" className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-[0.6875rem] hover:bg-blue-50/50 ${selected ? "bg-blue-50 text-blue-700 font-medium" : "text-black/70"}`} onClick={() => save({ navigateValue: p.path, navigateLabel: p.label })}>
                            <PIcon className="w-3.5 h-3.5 flex-shrink-0 opacity-60" /><span className="truncate flex-1">{p.label}</span><span className="text-[9px] text-black/30">{p.path}</span>{selected && <Check className="w-3 h-3 ml-1 text-blue-500" />}
                          </button>
                        );
                      })}
                      {(config.navigateTarget || "page") === "board" && (filteredBoards.length === 0
                        ? <div className="px-2 py-3 text-center text-[0.625rem] text-black/40">{boards.length === 0 ? "No boards yet" : "No matches"}</div>
                        : filteredBoards.map((b) => {
                          const selected = config.navigateValue === b.id;
                          return (<button key={b.id} type="button" className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-[0.6875rem] hover:bg-blue-50/50 ${selected ? "bg-blue-50 text-blue-700 font-medium" : "text-black/70"}`} onClick={() => save({ navigateValue: b.id, navigateLabel: b.title || "Untitled Board" })}><LayoutGrid className="w-3.5 h-3.5 flex-shrink-0 opacity-60" /><span className="truncate flex-1">{b.title || "Untitled Board"}</span>{selected && <Check className="w-3 h-3 ml-1 text-blue-500" />}</button>);
                        })
                      )}
                      {(config.navigateTarget || "page") === "project" && (filteredProjects.length === 0
                        ? <div className="px-2 py-3 text-center text-[0.625rem] text-black/40">{projects.length === 0 ? "No projects yet" : "No matches"}</div>
                        : filteredProjects.map((p) => {
                          const selected = config.navigateValue === p.id;
                          return (<button key={p.id} type="button" className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-[0.6875rem] hover:bg-blue-50/50 ${selected ? "bg-blue-50 text-blue-700 font-medium" : "text-black/70"}`} onClick={() => save({ navigateValue: p.id, navigateLabel: p.name || "Untitled Project" })}><Folder className="w-3.5 h-3.5 flex-shrink-0 opacity-60" /><span className="truncate flex-1">{p.name || "Untitled Project"}</span>{selected && <Check className="w-3 h-3 ml-1 text-blue-500" />}</button>);
                        })
                      )}
                    </div>
                  </div>
                )}

                {config.action === "copy" && (
                  <div>
                    <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">Text to Copy</label>
                    <textarea className="w-full px-2 py-1 rounded border border-black/15 bg-white text-[0.75rem] outline-none focus:border-blue-400 resize-none" rows={2} placeholder="Text to copy..." value={config.copyText || ""} onChange={(e) => save({ copyText: e.target.value })} />
                  </div>
                )}

                {config.action === "automate" && (
                  <div>
                    <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">Webhook URL</label>
                    <input className="w-full px-2 py-1 rounded border border-black/15 bg-white text-[0.75rem] outline-none focus:border-blue-400" placeholder="https://api.example.com/webhook" value={config.webhookUrl || ""} onChange={(e) => save({ webhookUrl: e.target.value })} />
                  </div>
                )}

                {config.action === "ai" && (
                  <div>
                    <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">AI Prompt</label>
                    <textarea className="w-full px-2 py-1 rounded border border-black/15 bg-white text-[0.75rem] outline-none focus:border-blue-400 resize-none" rows={2} placeholder="Generate a summary of..." value={config.aiPrompt || ""} onChange={(e) => save({ aiPrompt: e.target.value })} />
                  </div>
                )}

                {config.action === "submit" && (
                  <div>
                    <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">Event Name</label>
                    <input className="w-full px-2 py-1 rounded border border-black/15 bg-white text-[0.75rem] outline-none focus:border-blue-400" placeholder="my_custom_event" value={config.eventName || ""} onChange={(e) => save({ eventName: e.target.value })} />
                  </div>
                )}

                {config.action === "block" && (
                  <div>
                    <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">Target Block</label>
                    <div className="relative mb-1">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-black/30 pointer-events-none" />
                      <input className="w-full pl-6 pr-2 py-1 rounded border border-black/15 bg-white text-[0.6875rem] outline-none focus:border-blue-400" placeholder="Search blocks..." value={blockSearch} onChange={(e) => setBlockSearch(e.target.value)} />
                    </div>
                    <div className="max-h-[100px] overflow-y-auto rounded border border-black/10 scrollbar-hide mb-1.5">
                      {filteredBlocks.length === 0
                        ? <div className="px-2 py-3 text-center text-[0.625rem] text-black/40">{canvasBlocks.length === 0 ? "No other blocks" : "No matches"}</div>
                        : filteredBlocks.map((b) => {
                          const selected = config.targetBlockId === b.id;
                          return (<button key={b.id} type="button" className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-[0.6875rem] hover:bg-blue-50/50 ${selected ? "bg-blue-50 text-blue-700 font-medium" : "text-black/70"}`} onClick={() => save({ targetBlockId: b.id })}><Crosshair className="w-3.5 h-3.5 flex-shrink-0 opacity-50" /><span className="truncate flex-1">{b.preview}</span>{selected && <Check className="w-3 h-3 ml-1 text-blue-500" />}</button>);
                        })
                      }
                    </div>
                    <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">When Clicked</label>
                    <div className="flex gap-1">
                      {(["scroll", "select"] as BlockTargetAction[]).map((a) => (
                        <button key={a} type="button" className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-medium border ${(config.blockAction || "scroll") === a ? "border-blue-400 bg-blue-50" : "border-black/10 hover:bg-black/5"}`} onClick={() => save({ blockAction: a })}>{a === "scroll" ? "Scroll To" : "Select"}</button>
                      ))}
                    </div>
                  </div>
                )}

                {config.action === "custom" && (
                  <div>
                    <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">JavaScript Code</label>
                    <textarea
                      className="w-full px-2 py-1 rounded border border-black/15 bg-white text-[0.6875rem] font-mono outline-none focus:border-blue-400 resize-none"
                      rows={4}
                      placeholder={`ctx.showFeedback("Hello!");\nctx.navigate("/calendar");`}
                      value={config.onClickCode || ""}
                      onChange={(e) => save({ onClickCode: e.target.value })}
                    />
                    <div className="text-[9px] text-black/40 mt-0.5">ctx: blockId, navigate, blocks, selectBlocks, setCamera, showFeedback, clipboard, fetch, dispatchEvent</div>
                  </div>
                )}

                {/* Modifiers */}
                <div>
                  <label className="block text-[0.625rem] font-medium text-black/60 mb-0.5">Behavior</label>
                  <label className="flex items-center gap-1 text-[0.625rem] text-black/70 cursor-pointer">
                    <input type="checkbox" className="rounded" checked={config.confirm} onChange={(e) => save({ confirm: e.target.checked })} />
                    Confirm before action
                  </label>
                </div>

                <button type="button" className="w-full py-1 rounded bg-black/5 hover:bg-black/10 text-[0.6875rem] font-medium text-black/70 transition-colors" onClick={() => setConfigOpen(false)}>Done</button>
              </div>
            )}

            {/* ── Icon Tab ── */}
            {configTab === "icon" && (
              <div>
                <input
                  className="w-full px-2 py-1 rounded border border-black/15 bg-white text-[0.75rem] outline-none focus:border-blue-400 mb-2"
                  placeholder="Search icons..."
                  value={iconSearch}
                  onChange={(e) => setIconSearch(e.target.value)}
                />
                <div className="grid grid-cols-8 gap-1 max-h-[200px] overflow-y-auto scrollbar-hide">
                  {filteredIcons.map((name) => {
                    const Icon = ICON_MAP[name];
                    if (!Icon) return null;
                    return (
                      <button key={name} type="button"
                        className={`w-full aspect-square rounded flex items-center justify-center border transition-colors ${config.icon === name ? "border-blue-400 bg-blue-50" : "border-transparent hover:bg-black/5"}`}
                        onClick={() => { save({ icon: name }); setConfigTab("ai"); }}
                        title={name}
                      >
                        <Icon className="w-4 h-4 text-black/70" />
                      </button>
                    );
                  })}
                  {filteredIcons.length === 0 && <div className="col-span-8 text-center text-[0.625rem] text-black/40 py-4">No icons found</div>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
