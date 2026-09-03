import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ImagePlus, Monitor, Trash2 } from 'lucide-react';

import { Slider } from '@/components/ui/slider';
import { WALLPAPER_BLUR_MAX, WALLPAPER_DIM_MAX } from '@/lib/appearance';

/**
 * Wallpaper section of Settings › Appearance. The "From macOS" grid and the
 * photo buttons are desktop-only: those images are enumerated and converted by
 * the main process, since the wallpapers Apple ships are HEIC and Chromium
 * won't render them. In a browser only the app's own backdrop is available.
 */

const TILE =
  'relative h-[52px] w-full overflow-hidden rounded-[12px] border transition-all ' +
  'data-[selected=true]:ring-2 data-[selected=true]:ring-[hsl(var(--lykn-accent))] ' +
  'border-black/10 dark:border-white/15 hover:scale-[1.02]';

const ACTION =
  'lg-stepper flex h-8 items-center gap-2 rounded-[10px] px-3 text-[12.5px] font-medium ' +
  'text-black/80 dark:text-white/85 disabled:opacity-40';

function bridge() {
  return typeof window === 'undefined' ? null : window.lykn || null;
}

function Tile({ label, title, selected, pending, onClick, style, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-selected={selected}
      title={title || label}
      aria-label={label}
      aria-pressed={selected}
      className={`${TILE} ${pending ? 'bg-black/[0.06] dark:bg-white/[0.08]' : ''}`}
      style={style}
    >
      {children}
      <span
        className={`absolute inset-x-0 bottom-0 truncate px-1.5 pb-1 pt-3 text-[10px] font-medium ${
          pending
            ? 'text-black/45 dark:text-white/45'
            : 'bg-gradient-to-t from-black/60 to-transparent text-white'
        }`}
      >
        {label}
      </span>
    </button>
  );
}

/* How many system wallpapers show before "Show all" — with the Default tile in
 * front of them, that's two full rows of the grid. */
const SYSTEM_PREVIEW_COUNT = 7;
/* Thumbnails are one sips pass each; a few at a time fills the grid quickly
 * without pinning a core. */
const THUMB_WORKERS = 4;

const megabytes = (bytes) => `${Math.max(1, Math.round((bytes || 0) / 1e6))} MB`;

/* Percent while Apple's master downloads, then a beat of "…" for the convert. */
function progressLabel(progress, id) {
  if (progress?.id !== id || progress?.phase !== 'downloading') return '…';
  const { received = 0, total = 0 } = progress;
  return total ? `${Math.min(99, Math.round((received / total) * 100))}%` : '…';
}

export default function WallpaperSettings({ appearance, onChange }) {
  // Whatever image the main process currently holds, and where it came from.
  const [photo, setPhoto] = useState('');
  const [photoId, setPhotoId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // The wallpapers macOS ships, plus their thumbnails keyed by id.
  const [systemPapers, setSystemPapers] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [showAllSystem, setShowAllSystem] = useState(false);
  // { id, phase, received, total } while a master downloads from Apple.
  const [progress, setProgress] = useState(null);
  const canUsePhoto = !!bridge()?.backgroundSet;

  useEffect(() => {
    const b = bridge();
    if (!b?.backgroundGet) return undefined;
    let cancelled = false;
    b.backgroundGet()
      .then((r) => {
        if (cancelled || !r?.ok) return;
        setPhoto(r.dataUrl || '');
        setPhotoId(r.id || '');
      })
      .catch(() => {});
    const off = b.onBackgroundChanged?.((p) => {
      setPhoto(p?.dataUrl || '');
      setPhotoId(p?.id || '');
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // The system wallpapers: names first (cheap), then thumbnails trickling in so
  // the grid paints immediately on a cold cache.
  useEffect(() => {
    const b = bridge();
    if (!b?.backgroundSystemList) return undefined;
    let cancelled = false;
    (async () => {
      const list = await b.backgroundSystemList().catch(() => null);
      if (cancelled || !list?.ok || !list.items?.length) return;
      setSystemPapers(list.items);
      const queue = [...list.items];
      const fill = async () => {
        while (!cancelled) {
          const item = queue.shift();
          if (!item) return;
          const res = await b.backgroundSystemThumb(item.id).catch(() => null);
          if (cancelled) return;
          if (res?.ok && res.dataUrl) {
            setThumbs((current) => ({ ...current, [item.id]: res.dataUrl }));
          }
        }
      };
      await Promise.all(Array.from({ length: THUMB_WORKERS }, fill));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const off = bridge()?.onBackgroundProgress?.((p) => {
      setProgress(p?.phase === 'done' || p?.phase === 'error' ? null : p);
    });
    return () => off?.();
  }, []);

  // The main process owns the image and broadcasts it back, so a successful
  // pick needs nothing here beyond clearing the busy state.
  const photoAction = useCallback(
    (run, kind) => async () => {
      setError('');
      setBusy(kind);
      try {
        const result = await run();
        if (result?.canceled) return;
        if (!result?.ok) {
          setError("That image couldn't be loaded. Try a different one.");
        }
      } catch {
        setError("That image couldn't be loaded. Try a different one.");
      } finally {
        setBusy('');
      }
    },
    [],
  );

  const choosePhoto = photoAction(async () => {
    const b = bridge();
    const picked = await b.backgroundPickFile();
    if (!picked?.ok) return picked;
    return b.backgroundSet({ path: picked.path });
  }, 'file');

  const applyMacWallpaper = photoAction(
    () => bridge().backgroundSet({ source: 'wallpaper' }),
    'wallpaper',
  );

  const applySystemWallpaper = (paper) => {
    if (busy) return; // a download/conversion is already running; let it finish
    setError('');
    setBusy(paper.id);
    bridge()
      .backgroundSystemApply(paper.id)
      .then((res) => {
        if (res?.ok) {
          // The master is cached now, so the download badge is stale.
          setSystemPapers((current) =>
            current.map((p) => (p.id === paper.id ? { ...p, needsDownload: false } : p)),
          );
          return;
        }
        setError(
          res?.error === 'offline'
            ? `${paper.name} has to download from Apple, and there's no connection right now.`
            : `Couldn't load ${paper.name}. Try another wallpaper.`,
        );
      })
      .catch(() => setError(`Couldn't load ${paper.name}. Try another wallpaper.`))
      .finally(() => {
        setBusy('');
        setProgress(null);
      });
  };

  const removePhoto = async () => {
    setError('');
    setBusy('clear');
    try {
      await bridge().backgroundClear?.();
    } catch {
      /* the tile below just stays until the next load */
    } finally {
      setBusy('');
    }
  };

  const visibleSystem = showAllSystem
    ? systemPapers
    : systemPapers.slice(0, SYSTEM_PREVIEW_COUNT);

  return (
    <div className="space-y-4">
      <div>
        {systemPapers.length > SYSTEM_PREVIEW_COUNT ? (
          <div className="mb-1.5 flex justify-end">
            <button
              type="button"
              onClick={() => setShowAllSystem((v) => !v)}
              className="text-[11px] font-medium text-black/45 hover:text-black dark:text-white/40 dark:hover:text-white"
            >
              {showAllSystem ? 'Show less' : `Show all ${systemPapers.length}`}
            </button>
          </div>
        ) : null}
        <div className="grid grid-cols-4 gap-2">
          {/* The app's own backdrop, or a photo of the user's own. One of
              Apple's is stored as that same photo, so while one is in use this
              tile falls back to offering the built-in backdrop. */}
          <Tile
            label={photo && !photoId ? 'My photo' : 'Default'}
            selected={!photoId}
            onClick={removePhoto}
            style={
              photo && !photoId
                ? { backgroundImage: `url(${photo})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                : { background: 'linear-gradient(155deg, #23262c 0%, #0e1013 100%)' }
            }
          />
          {visibleSystem.map((paper) => {
            const thumb = thumbs[paper.id];
            const working = busy === paper.id;
            return (
              <Tile
                key={paper.id}
                label={paper.name}
                title={
                  paper.needsDownload
                    ? `${paper.name} - ${megabytes(paper.sizeBytes)} download from Apple`
                    : paper.name
                }
                selected={photoId === paper.id}
                pending={!thumb}
                onClick={() => applySystemWallpaper(paper)}
                style={
                  thumb
                    ? {
                        backgroundImage: `url(${thumb})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }
                    : undefined
                }
              >
                {/* Not on this Mac yet — macOS shows the same hint. */}
                {paper.needsDownload && !working ? (
                  <ArrowDownToLine
                    className="absolute right-1 top-1 h-3 w-3 text-white/85 drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
                    aria-hidden
                  />
                ) : null}
                {working ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-[10px] font-semibold tabular-nums text-white">
                    {progressLabel(progress, paper.id)}
                  </span>
                ) : null}
              </Tile>
            );
          })}
        </div>
        {visibleSystem.some((paper) => paper.needsDownload) ? (
          <p className="mt-1.5 text-[11px] leading-snug text-black/40 dark:text-white/35">
            Marked wallpapers download from Apple the first time you pick one, the same way
            System Settings does.
          </p>
        ) : null}
      </div>

      {canUsePhoto ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={choosePhoto} disabled={!!busy} className={ACTION}>
            <ImagePlus className="h-3.5 w-3.5 opacity-70" />
            {busy === 'file' ? 'Loading…' : 'Choose a photo…'}
          </button>
          <button type="button" onClick={applyMacWallpaper} disabled={!!busy} className={ACTION}>
            <Monitor className="h-3.5 w-3.5 opacity-70" />
            {busy === 'wallpaper' ? 'Syncing…' : 'Use my Mac wallpaper'}
          </button>
          {photo ? (
            <button type="button" onClick={removePhoto} disabled={!!busy} className={ACTION}>
              <Trash2 className="h-3.5 w-3.5 opacity-70" />
              Remove photo
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] leading-snug text-black/40 dark:text-white/35">
          Open LYKN on your Mac to use one of your own photos as the wallpaper.
        </p>
      )}

      {error ? (
        <p className="text-[11px] leading-snug text-red-500 dark:text-red-400">{error}</p>
      ) : null}

      <div className="lykn-settings-grid gap-4" style={{ '--lykn-settings-grid-min': '196px' }}>
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-medium text-black/80 dark:text-white/80">Dim</span>
            <span className="text-[12px] text-black/40 dark:text-white/40">
              {appearance.wallpaperDim}%
            </span>
          </div>
          <Slider
            aria-label="Wallpaper dim"
            min={0}
            max={WALLPAPER_DIM_MAX}
            step={5}
            value={[appearance.wallpaperDim]}
            onValueChange={([next]) => onChange({ wallpaperDim: next })}
          />
        </div>
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-medium text-black/80 dark:text-white/80">Blur</span>
            <span className="text-[12px] text-black/40 dark:text-white/40">
              {appearance.wallpaperBlur ? `${appearance.wallpaperBlur}px` : 'Off'}
            </span>
          </div>
          <Slider
            aria-label="Wallpaper blur"
            min={0}
            max={WALLPAPER_BLUR_MAX}
            step={2}
            value={[appearance.wallpaperBlur]}
            onValueChange={([next]) => onChange({ wallpaperBlur: next })}
          />
        </div>
      </div>
    </div>
  );
}
