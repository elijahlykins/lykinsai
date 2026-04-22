import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, Eye, Home, Loader2, LogIn, Minus, Plus } from "lucide-react";
import { resolveShareToken, type SharedBoardSnapshot } from "@/lib/grid/sharedGrids";
import { exportGridAsHtml } from "@/lib/grid/exportGridHtml";

/* ------------------------------------------------------------------ */
/*  Block classification (subset of Canvas rendering, read-only)       */
/* ------------------------------------------------------------------ */

type LoadedBlock = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  mode?: string;
  data: Record<string, any>;
  content: string;
  brickColor?: string;
  textColor?: string;
};

const GFM_TABLE_RE = /(^|\n)\s*\|.+\|\s*\n\s*\|[\s:|-]+\|/;

function normalizeBlock(raw: any): LoadedBlock | null {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  const data = raw.data && typeof raw.data === "object" ? raw.data : {};
  return {
    id: String(raw.id),
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    width: Math.max(24, Number(raw.width) || 240),
    height: Math.max(24, Number(raw.height) || 48),
    type: String(raw.type || "text"),
    mode: raw.mode ? String(raw.mode) : undefined,
    data,
    content: String(data.content ?? raw.content ?? ""),
    brickColor: typeof data.brickColor === "string" ? data.brickColor : undefined,
    textColor: typeof data.textColor === "string" ? data.textColor : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Individual block renderer                                          */
/* ------------------------------------------------------------------ */

const BlockView: React.FC<{ block: LoadedBlock }> = ({ block }) => {
  const data = block.data;
  const text = block.content;
  const textVariant = String(data.textVariant || "body").toLowerCase();
  const isImage =
    (block.type === "create" && (block.mode === "image" || block.mode === "generated")) ||
    typeof data.src === "string";
  const imgSrc =
    typeof data.src === "string" && data.src
      ? data.src
      : typeof data.url === "string" && /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(data.url)
        ? data.url
        : "";

  const fontSize =
    textVariant === "h1" ? "42px" : textVariant === "h2" ? "28px" : "14px";
  const fontWeight = textVariant === "body" ? 400 : 500;

  const hasMarkdown = useMemo(
    () => /(?:^|\n)\s*#{1,6}\s|(?:\*\*|__).+(?:\*\*|__)|```|^\s*[-*]\s|(?:^|\n)\|.+\|/m.test(text),
    [text]
  );

  const hasTable = useMemo(() => GFM_TABLE_RE.test(text), [text]);

  return (
    <div
      className="absolute pointer-events-none select-text"
      style={{
        left: `${block.x}px`,
        top: `${block.y}px`,
        width: `${block.width}px`,
        height: isImage || hasTable ? undefined : `${block.height}px`,
        minHeight: `${block.height}px`,
      }}
    >
      <div
        className="w-full h-full rounded border border-white/22 backdrop-blur-[1px] overflow-hidden"
        style={{
          background: block.brickColor || "linear-gradient(145deg,rgba(255,255,255,0.16),rgba(255,255,255,0.06))",
          color: block.textColor || "inherit",
          boxShadow: "0 2px 8px rgba(0,0,0,0.10)",
          padding: "4px 8px",
        }}
      >
        {isImage && imgSrc ? (
          <img
            src={imgSrc}
            alt={String(data.title || data.name || "")}
            className="w-full h-full object-contain"
            onError={(e) => {
              const target = e.currentTarget;
              target.style.display = "none";
              const sibling = target.nextElementSibling as HTMLElement | null;
              if (sibling) sibling.style.display = "flex";
            }}
          />
        ) : null}
        {isImage ? (
          <div
            className="w-full h-full items-center justify-center text-[0.75rem] text-black/40 dark:text-white/40"
            style={{ display: imgSrc ? "none" : "flex" }}
          >
            (image unavailable)
          </div>
        ) : hasMarkdown ? (
          <div
            className="tracking-[-0.01em] text-foreground"
            style={{ fontSize, fontWeight, lineHeight: 1.5 }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        ) : (
          <div
            className="tracking-[-0.01em] whitespace-pre-wrap break-words text-foreground"
            style={{
              fontSize,
              fontWeight,
              lineHeight: textVariant === "h1" ? 1.15 : textVariant === "h2" ? 1.3 : 1.45,
              overflowWrap: "anywhere",
            }}
          >
            {text}
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Wires overlay (simple SVG)                                         */
/* ------------------------------------------------------------------ */

const WiresOverlay: React.FC<{
  blocks: Record<string, LoadedBlock>;
  wires: Array<{ id: string; fromId: string; toId: string }>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}> = ({ blocks, wires, bounds }) => {
  if (!wires.length) return null;
  const padding = 200;
  const width = bounds.maxX - bounds.minX + padding * 2;
  const height = bounds.maxY - bounds.minY + padding * 2;

  return (
    <svg
      className="absolute pointer-events-none"
      style={{
        left: `${bounds.minX - padding}px`,
        top: `${bounds.minY - padding}px`,
        width: `${width}px`,
        height: `${height}px`,
      }}
      viewBox={`${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}`}
    >
      {wires.map((w) => {
        const a = blocks[w.fromId];
        const b = blocks[w.toId];
        if (!a || !b) return null;
        const ax = a.x + a.width / 2;
        const ay = a.y + a.height / 2;
        const bx = b.x + b.width / 2;
        const by = b.y + b.height / 2;
        const midX = (ax + bx) / 2;
        return (
          <path
            key={w.id}
            d={`M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`}
            stroke="rgba(59,130,246,0.55)"
            strokeWidth="1.5"
            fill="none"
          />
        );
      })}
    </svg>
  );
};

/* ------------------------------------------------------------------ */
/*  Main viewer page                                                   */
/* ------------------------------------------------------------------ */

const SharedGrid: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState<SharedBoardSnapshot | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
  const panRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setError("Missing share token.");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await resolveShareToken(token);
        if (cancelled) return;
        if (!result) {
          setError("This share link is invalid, revoked, or has expired.");
        } else {
          setShare(result);
        }
      } catch (err) {
        if (cancelled) return;
        setError("Unable to load this shared grid.");
        if (import.meta.env.DEV) console.error("[LYKN] shared grid:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const { blocksMap, blocks, wires, bounds } = useMemo(() => {
    const snap = share?.snapshot;
    if (!snap || !snap.blocks) {
      return {
        blocksMap: {} as Record<string, LoadedBlock>,
        blocks: [] as LoadedBlock[],
        wires: [] as Array<{ id: string; fromId: string; toId: string }>,
        bounds: { minX: 0, minY: 0, maxX: 1280, maxY: 800 },
      };
    }
    const order: string[] = Array.isArray(snap.blockOrder)
      ? snap.blockOrder.filter((id: any) => typeof id === "string")
      : Object.keys(snap.blocks);
    const list: LoadedBlock[] = [];
    const map: Record<string, LoadedBlock> = {};
    for (const id of order) {
      const n = normalizeBlock(snap.blocks[id]);
      if (!n) continue;
      list.push(n);
      map[n.id] = n;
    }
    const wiresList = Array.isArray(snap.wireConnections)
      ? snap.wireConnections.filter((w: any) => w && w.fromId && w.toId)
      : [];
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const b of list) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    if (list.length === 0) {
      minX = 0;
      minY = 0;
      maxX = 1280;
      maxY = 800;
    }
    return {
      blocksMap: map,
      blocks: list,
      wires: wiresList,
      bounds: { minX, minY, maxX, maxY },
    };
  }, [share]);

  // Auto-fit to content on first load.
  useEffect(() => {
    if (!share || !viewportRef.current) return;
    const vp = viewportRef.current;
    const vpRect = vp.getBoundingClientRect();
    const contentW = bounds.maxX - bounds.minX;
    const contentH = bounds.maxY - bounds.minY;
    if (contentW <= 0 || contentH <= 0) return;
    const padding = 80;
    const fitZoom = Math.min(
      (vpRect.width - padding * 2) / contentW,
      (vpRect.height - padding * 2) / contentH,
      1
    );
    const zoom = Math.max(0.15, Math.min(1, fitZoom));
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    setCam({
      x: centerX - vpRect.width / (2 * zoom),
      y: centerY - vpRect.height / (2 * zoom),
      zoom,
    });
  }, [share, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!viewportRef.current) return;
    e.preventDefault();
    const vp = viewportRef.current.getBoundingClientRect();
    const px = e.clientX - vp.left;
    const py = e.clientY - vp.top;
    const delta = -e.deltaY;
    const factor = Math.pow(1.0015, delta);
    setCam((prev) => {
      const nextZoom = Math.max(0.15, Math.min(3, prev.zoom * factor));
      // Keep the world point under the cursor fixed.
      const wx = prev.x + px / prev.zoom;
      const wy = prev.y + py / prev.zoom;
      return { zoom: nextZoom, x: wx - px / nextZoom, y: wy - py / nextZoom };
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    panRef.current = { startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y };
  }, [cam.x, cam.y]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    setCam((prev) => ({
      ...prev,
      x: pan.camX - dx / prev.zoom,
      y: pan.camY - dy / prev.zoom,
    }));
  }, []);

  const onPointerUp = useCallback(() => {
    panRef.current = null;
  }, []);

  const handleZoomIn = () => setCam((c) => ({ ...c, zoom: Math.min(3, c.zoom * 1.2) }));
  const handleZoomOut = () => setCam((c) => ({ ...c, zoom: Math.max(0.15, c.zoom / 1.2) }));

  const handleDownloadGrid = useCallback(async () => {
    if (!share?.snapshot) return;
    try {
      const snap = { ...share.snapshot, title: share.title };
      await exportGridAsHtml(snap, {
        includeText: true,
        includeImages: true,
        includeVideos: true,
        includeFiles: true,
        includeLinks: true,
        includeNotes: true,
        inlineMedia: true,
      });
    } catch (err) {
      if (import.meta.env.DEV) console.error("[LYKN] grid export from share failed:", err);
    }
  }, [share]);

  if (loading) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-background text-foreground/70 gap-3">
        <Loader2 className="w-6 h-6 animate-spin" />
        <p className="text-sm">Loading shared grid…</p>
      </div>
    );
  }

  if (error || !share) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-background text-foreground gap-5 px-6 text-center">
        <div className="max-w-md">
          <h1 className="text-xl font-semibold mb-2">Grid unavailable</h1>
          <p className="text-sm text-foreground/60 mb-6">{error || "This share link could not be loaded."}</p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-full bg-black/8 dark:bg-white/10 hover:bg-black/12 dark:hover:bg-white/15 px-4 py-2 text-sm"
          >
            <Home className="w-3.5 h-3.5" />
            Back to LYKN
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-black/8 dark:border-white/8 bg-background/80 backdrop-blur-md z-10">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/" className="shrink-0" title="LYKN">
            <div className="w-6 h-6 rounded bg-black/8 dark:bg-white/12 flex items-center justify-center text-[0.7rem] font-bold text-foreground">L</div>
          </Link>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{share.title}</div>
            <div className="flex items-center gap-1.5 text-[0.6875rem] text-foreground/50">
              <Eye className="w-3 h-3" />
              View-only shared grid
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDownloadGrid}
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-black/5 dark:bg-white/8 hover:bg-black/10 dark:hover:bg-white/16 px-3 py-1.5 text-xs border border-black/10 dark:border-white/10 transition-colors text-foreground"
            title="Download a view-only copy of this grid"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </button>
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground text-background hover:opacity-90 px-3 py-1.5 text-xs font-medium transition-opacity"
          >
            <LogIn className="w-3.5 h-3.5" />
            Sign in
          </Link>
        </div>
      </header>

      <div
        ref={viewportRef}
        className="relative flex-1 overflow-hidden cursor-grab active:cursor-grabbing bg-transparent"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="absolute top-0 left-0"
          style={{
            transform: `scale(${cam.zoom}) translate(${-cam.x}px, ${-cam.y}px)`,
            transformOrigin: "0 0",
            willChange: "transform",
          }}
        >
          <WiresOverlay blocks={blocksMap} wires={wires} bounds={bounds} />
          {blocks.map((b) => (
            <BlockView key={b.id} block={b} />
          ))}
          {blocks.length === 0 && (
            <div className="absolute left-0 top-0 w-[600px] text-center text-foreground/40 text-sm p-8">
              This grid is empty.
            </div>
          )}
        </div>

        <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-full bg-background/70 backdrop-blur-md border border-black/10 dark:border-white/10 p-1 shadow-sm">
          <button
            type="button"
            onClick={handleZoomOut}
            className="w-7 h-7 rounded-full hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-foreground/80"
            title="Zoom out"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <span className="text-[0.6875rem] tabular-nums px-2 min-w-[3ch] text-center text-foreground/70">
            {Math.round(cam.zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={handleZoomIn}
            className="w-7 h-7 rounded-full hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-foreground/80"
            title="Zoom in"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="absolute bottom-4 left-4 text-[0.6875rem] text-foreground/30">
          Scroll to zoom · Drag to pan · Sign in to make your own grid
        </div>
      </div>
    </div>
  );
};

export default SharedGrid;
