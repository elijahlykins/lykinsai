import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import GeneratedImage from "@/components/lyknChat/GeneratedImage";
import { MEDIA_POP_FRAME, MEDIA_POP_PANEL } from "@/components/lyknChat/LyknMediaPop";
import {
  BRUSH_SIZE_DEFAULT,
  BRUSH_SIZE_MAX,
  BRUSH_SIZE_MIN,
  brushPx,
  classifyStroke,
  clampBrushSize,
  exportLumaMask,
  finalizeClickPath,
  hasMaskInk,
  isNearPoint,
  paintClickVertices,
  paintMaskStrokes,
  snapThreshold,
  type MaskPoint,
  type MaskStroke,
} from "@/lib/chat/imagineMask";

export type ImagineMaskCanvasHandle = {
  hasMask: () => boolean;
  exportLuma: () => string | null;
  clear: () => void;
};

const DRAG_PX = 7;

function newStrokeId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `msk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function eventPoint(el: HTMLElement, e: PointerEvent | React.PointerEvent): MaskPoint | null {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return null;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

const OVERLAY = {
  fill: "rgba(56, 189, 248, 0.34)",
  stroke: "rgba(255, 255, 255, 0.92)",
};

const LIVE = {
  fill: "rgba(56, 189, 248, 0.18)",
  stroke: "rgba(255, 255, 255, 0.95)",
};

type ImagineMaskCanvasProps = {
  src: string;
  alt: string;
  onMaskChange?: (hasMask: boolean) => void;
};

const ImagineMaskCanvas = forwardRef<ImagineMaskCanvasHandle, ImagineMaskCanvasProps>(
  function ImagineMaskCanvas({ src, alt, onMaskChange }, ref) {
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const strokesRef = useRef<MaskStroke[]>([]);
    const liveDrawRef = useRef<MaskPoint[]>([]);
    const clickPathRef = useRef<MaskPoint[]>([]);
    const drawingRef = useRef(false);
    const pointerStartRef = useRef<{ x: number; y: number; pt: MaskPoint } | null>(null);
    const hoverRef = useRef<MaskPoint | null>(null);
    const [brushSize, setBrushSize] = useState(BRUSH_SIZE_DEFAULT);
    const brushRef = useRef(brushSize);
    brushRef.current = brushSize;
    const [hasMask, setHasMask] = useState(false);
    const [placing, setPlacing] = useState(false);

    const announce = useCallback(
      (strokes: MaskStroke[], liveDots = clickPathRef.current) => {
        const next = hasMaskInk(strokes) || liveDots.length > 0;
        setHasMask(next);
        setPlacing(liveDots.length > 0);
        onMaskChange?.(next);
      },
      [onMaskChange],
    );

    const paint = useCallback(() => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w < 2 || h < 2) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const size = brushRef.current;
      paintMaskStrokes(ctx, w, h, strokesRef.current, OVERLAY);

      const dots = clickPathRef.current;
      if (dots.length) {
        const hover = hoverRef.current;
        const closable =
          dots.length >= 3 && hover != null && isNearPoint(dots[0], hover, snapThreshold(size));
        const preview = hover && !closable ? [...dots, hover] : dots;
        paintMaskStrokes(
          ctx,
          w,
          h,
          [{ id: "click", points: preview, closed: closable, width: size }],
          LIVE,
        );
        paintClickVertices(ctx, w, h, dots, { closable: dots.length >= 3 });
      }

      const live = liveDrawRef.current;
      if (live.length >= 2) {
        paintMaskStrokes(
          ctx,
          w,
          h,
          [
            {
              id: "live",
              points: live,
              closed: classifyStroke(live)?.closed === true,
              width: size,
            },
          ],
          LIVE,
        );
      }

      const hover = hoverRef.current;
      if (hover && !drawingRef.current) {
        const r = brushPx(size, w, h) / 2;
        ctx.beginPath();
        ctx.arc(hover.x * w, hover.y * h, r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hover.x * w, hover.y * h, r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }, []);

    useEffect(() => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const ro = new ResizeObserver(() => paint());
      ro.observe(wrap);
      paint();
      return () => ro.disconnect();
    }, [paint, src]);

    useEffect(() => {
      paint();
    }, [brushSize, paint]);

    useEffect(() => {
      strokesRef.current = [];
      liveDrawRef.current = [];
      clickPathRef.current = [];
      drawingRef.current = false;
      pointerStartRef.current = null;
      hoverRef.current = null;
      announce([]);
      paint();
    }, [src, announce, paint]);

    const pushStroke = useCallback(
      (points: MaskPoint[], closed: boolean) => {
        if (!points.length) return;
        strokesRef.current = [
          ...strokesRef.current,
          { id: newStrokeId(), points, closed, width: brushRef.current },
        ];
        announce(strokesRef.current);
        paint();
      },
      [announce, paint],
    );

    const commitClickPath = useCallback(
      (forceClose: boolean) => {
        const dots = clickPathRef.current;
        if (!dots.length) return;
        const kind = forceClose && dots.length >= 3 ? { closed: true } : finalizeClickPath(dots, brushRef.current);
        clickPathRef.current = [];
        if (kind) pushStroke(dots, kind.closed);
        else {
          announce(strokesRef.current);
          paint();
        }
      },
      [announce, paint, pushStroke],
    );

    const placeDot = useCallback(
      (pt: MaskPoint) => {
        const dots = clickPathRef.current;
        if (dots.length >= 3 && isNearPoint(dots[0], pt, snapThreshold(brushRef.current))) {
          clickPathRef.current = [];
          pushStroke(dots, true);
          return;
        }
        clickPathRef.current = [...dots, pt];
        announce(strokesRef.current, clickPathRef.current);
        paint();
      },
      [announce, paint, pushStroke],
    );

    const onPointerDown = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.button !== 0) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const pt = eventPoint(canvas, e);
        if (!pt) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        pointerStartRef.current = { x: e.clientX, y: e.clientY, pt };
        drawingRef.current = false;
        liveDrawRef.current = [];
      },
      [],
    );

    const onPointerMove = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const pt = eventPoint(canvas, e);
        hoverRef.current = pt;
        const start = pointerStartRef.current;
        if (start && !drawingRef.current) {
          const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
          if (dist > DRAG_PX) {
            if (clickPathRef.current.length) commitClickPath(false);
            drawingRef.current = true;
            liveDrawRef.current = [start.pt];
          }
        }
        if (drawingRef.current && pt) {
          const last = liveDrawRef.current[liveDrawRef.current.length - 1];
          if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= 0.004) {
            liveDrawRef.current = [...liveDrawRef.current, pt];
          }
        }
        paint();
      },
      [commitClickPath, paint],
    );

    const onPointerUp = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        const start = pointerStartRef.current;
        pointerStartRef.current = null;
        try {
          canvasRef.current?.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        if (drawingRef.current) {
          const kind = classifyStroke(liveDrawRef.current);
          if (kind) pushStroke(liveDrawRef.current, kind.closed);
          liveDrawRef.current = [];
          drawingRef.current = false;
          paint();
          return;
        }
        if (start) placeDot(start.pt);
      },
      [paint, placeDot, pushStroke],
    );

    const onPointerLeave = useCallback(() => {
      hoverRef.current = null;
      paint();
    }, [paint]);

    const onDoubleClick = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        if (clickPathRef.current.length >= 2) commitClickPath(clickPathRef.current.length >= 3);
      },
      [commitClickPath],
    );

    const undo = useCallback(() => {
      if (clickPathRef.current.length) {
        clickPathRef.current = clickPathRef.current.slice(0, -1);
        announce(strokesRef.current, clickPathRef.current);
        paint();
        return;
      }
      if (!strokesRef.current.length) return;
      strokesRef.current = strokesRef.current.slice(0, -1);
      announce(strokesRef.current);
      paint();
    }, [announce, paint]);

    const clear = useCallback(() => {
      if (!strokesRef.current.length && !clickPathRef.current.length && !liveDrawRef.current.length) {
        return;
      }
      strokesRef.current = [];
      liveDrawRef.current = [];
      clickPathRef.current = [];
      drawingRef.current = false;
      pointerStartRef.current = null;
      announce([]);
      paint();
    }, [announce, paint]);

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        if (e.key === "Escape" && clickPathRef.current.length) {
          e.preventDefault();
          e.stopPropagation();
          clickPathRef.current = [];
          announce(strokesRef.current);
          paint();
          return;
        }
        if (e.key === "Enter" && clickPathRef.current.length) {
          e.preventDefault();
          commitClickPath(clickPathRef.current.length >= 3);
          return;
        }
        const undoKey = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey;
        if (undoKey) {
          e.preventDefault();
          undo();
        }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
    }, [announce, commitClickPath, paint, undo]);

    const exportStrokes = useCallback((): MaskStroke[] => {
      const live = clickPathRef.current;
      if (!live.length) return strokesRef.current;
      const kind = finalizeClickPath(live, brushRef.current) || { closed: false };
      return [...strokesRef.current, { id: "export-live", points: live, closed: kind.closed, width: brushRef.current }];
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        hasMask: () => hasMaskInk(exportStrokes()),
        exportLuma: () => {
          const img = wrapRef.current?.querySelector("img");
          let w = img?.naturalWidth || 1024;
          let h = img?.naturalHeight || 1024;
          const max = 2048;
          if (Math.max(w, h) > max) {
            const scale = max / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          return exportLumaMask(w, h, exportStrokes());
        },
        clear,
      }),
      [clear, exportStrokes],
    );

    const showTools = hasMask || placing;

    return (
      <div ref={wrapRef} className="relative max-h-full max-w-full select-none">
        <GeneratedImage src={src} alt={alt} draggable={false} className={`${MEDIA_POP_FRAME} block`} />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
          style={{ cursor: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onDoubleClick}
        />
        <div
          className={`absolute bottom-2.5 left-2.5 flex items-center gap-1 ${showTools ? "" : "pointer-events-none opacity-0"}`}
        >
          <button
            type="button"
            onClick={undo}
            className={`flex h-8 w-8 items-center justify-center rounded-full ${MEDIA_POP_PANEL}`}
            title="Undo last point or stroke"
            aria-label="Undo last point or stroke"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={clear}
            className={`flex h-8 w-8 items-center justify-center rounded-full ${MEDIA_POP_PANEL}`}
            title="Clear mask"
            aria-label="Clear mask"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <div
          className={`absolute bottom-2.5 right-2.5 flex items-center gap-2 rounded-full px-2.5 py-1.5 ${MEDIA_POP_PANEL}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span
            className="block shrink-0 rounded-full bg-black/45 dark:bg-white/55"
            style={{ width: 5, height: 5 }}
            aria-hidden
          />
          <input
            type="range"
            min={BRUSH_SIZE_MIN}
            max={BRUSH_SIZE_MAX}
            step={0.005}
            value={brushSize}
            onChange={(e) => setBrushSize(clampBrushSize(Number(e.target.value)))}
            className="h-1 w-[4.5rem] cursor-pointer appearance-none rounded-full bg-black/15 accent-black dark:bg-white/20 dark:accent-white sm:w-24"
            title="Pencil size"
            aria-label="Pencil size"
          />
          <span
            className="block shrink-0 rounded-full bg-black/55 dark:bg-white/70"
            style={{ width: 11, height: 11 }}
            aria-hidden
          />
        </div>
      </div>
    );
  },
);

export default ImagineMaskCanvas;
