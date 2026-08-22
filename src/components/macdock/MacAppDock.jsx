import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pin, PinOff, Search } from "lucide-react";
import StudioPop from "@/components/macdesktop/StudioPop";
import { DockContextMenu, openLyknChat } from "@/components/macdock/DockContextMenu";
import { quitMacApp } from "@/lib/macApps";

/**
 * Mac app strip for the Studio bottom dock: the user's installed applications,
 * launchable from inside LYKN, with macOS-style running indicators. Renders
 * nothing outside the desktop shell.
 *
 * Strip = pinned apps + running apps (deduped), capped; "⋯" opens a popover
 * with every installed app, search, and pin toggles. Clicking an icon
 * launches the app as a normal macOS window. Right-click opens, quits,
 * pins/unpins, or hands the app to LYKN chat.
 */

const STRIP_CAP = 8;

function bridge() {
  const b = typeof window !== "undefined" ? window.lykn : null;
  return b && typeof b.macAppsList === "function" ? b : null;
}

function AppIcon({ app: a, running, frontmost, onClick, onContextMenu, size = "h-7 w-7" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={a.name}
      aria-label={`Open ${a.name}`}
      className="relative flex flex-col items-center justify-center rounded-lg p-0.5 transition-transform hover:scale-110 active:scale-95"
    >
      {a.icon ? (
        <img src={a.icon} alt="" draggable={false} className={`${size} rounded-[22%]`} />
      ) : (
        <span
          className={`${size} flex items-center justify-center rounded-[22%] bg-white/20 text-[0.7rem] font-semibold text-white/85`}
        >
          {a.name.slice(0, 1)}
        </span>
      )}
      <span
        className={`absolute -bottom-0.5 h-1 w-1 rounded-full transition-opacity ${
          frontmost ? "bg-sky-400" : "bg-white/80 dark:bg-white/70"
        } ${running ? "opacity-100" : "opacity-0"}`}
      />
    </button>
  );
}

export default function MacAppDock() {
  const api = useMemo(() => bridge(), []);
  const [apps, setApps] = useState([]);
  const [pins, setPins] = useState([]);
  const [running, setRunning] = useState([]);
  const [frontmost, setFrontmost] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState(null);
  const popRef = useRef(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .macAppsList()
      .then((r) => {
        if (!cancelled && r?.ok) setApps(r.apps || []);
      })
      .catch(() => {});
    api
      .macDockPinsGet()
      .then((r) => {
        if (!cancelled && r?.ok) setPins(r.pins || []);
      })
      .catch(() => {});
    const applySnapshot = (snap) => {
      if (!snap?.ok && !Array.isArray(snap?.running)) return;
      setRunning(snap.running || []);
      setFrontmost(snap.frontmost || "");
    };
    api.macAppsRunning().then(applySnapshot).catch(() => {});
    const off = api.onMacAppsRunning?.(applySnapshot);
    api.macAppsWatch?.(true);
    return () => {
      cancelled = true;
      off?.();
      api.macAppsWatch?.(false);
    };
  }, [api]);

  // Close the popover on outside click.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [moreOpen]);

  const closeMenu = useCallback(() => setMenuFor(null), []);

  if (!api) return null;

  const runningSet = new Set(running.map((n) => n.toLowerCase()));
  const isRunning = (a) => runningSet.has(a.name.toLowerCase());
  const isFrontmost = (a) => frontmost && a.name.toLowerCase() === frontmost.toLowerCase();

  const byPath = new Map(apps.map((a) => [a.path, a]));
  const pinned = pins.map((p) => byPath.get(p)).filter(Boolean);
  const runningUnpinned = apps.filter((a) => isRunning(a) && !pins.includes(a.path));
  const strip = [...pinned, ...runningUnpinned].slice(0, STRIP_CAP);

  const launch = (a) => {
    void api.macAppLaunch(a.path).catch(() => {});
  };
  const togglePin = (a) => {
    const next = pins.includes(a.path) ? pins.filter((p) => p !== a.path) : [...pins, a.path];
    setPins(next);
    void api.macDockPinsSet(next).catch(() => {});
  };
  const menuItems = (a) => {
    const pinnedHere = pins.includes(a.path);
    const rows = [{ label: "Open", onClick: () => launch(a) }];
    if (isRunning(a)) {
      rows.push({ label: "Quit", onClick: () => quitMacApp(a) });
    }
    rows.push(
      { separator: true },
      {
        label: pinnedHere ? "Remove from Dock" : "Keep in Dock",
        onClick: () => togglePin(a),
      },
      { separator: true },
      { label: "Chat with LYKN", onClick: () => openLyknChat() },
    );
    return rows;
  };

  const q = query.trim().toLowerCase();
  const filtered = q ? apps.filter((a) => a.name.toLowerCase().includes(q)) : apps;

  if (!apps.length) return null;

  return (
    <div className="relative flex items-center gap-0.5 pl-1">
      <span className="mx-1 h-5 w-px bg-black/15 dark:bg-white/15" aria-hidden />
      {strip.map((a) => (
        <div key={a.path} className="relative">
          <AppIcon
            app={a}
            running={isRunning(a)}
            frontmost={isFrontmost(a)}
            onClick={() => {
              setMenuFor(null);
              launch(a);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMoreOpen(false);
              setMenuFor((id) => (id === a.path ? null : a.path));
            }}
          />
          <DockContextMenu
            open={menuFor === a.path}
            onClose={closeMenu}
            align="center"
            items={menuItems(a)}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          setMenuFor(null);
          setMoreOpen((v) => !v);
        }}
        title="All applications"
        aria-label="All applications"
        className={`ml-0.5 flex h-7 w-7 items-center justify-center rounded-full text-[0.85rem] font-semibold transition-colors ${
          moreOpen
            ? "bg-black/85 text-white dark:bg-white dark:text-black"
            : "text-black/55 hover:bg-black/10 dark:text-white/60 dark:hover:bg-white/15"
        }`}
      >
        &#8943;
      </button>

      <StudioPop
        ref={popRef}
        open={moreOpen}
        origin="100% 100%"
        className="lg-menu absolute bottom-full right-0 z-50 mb-3 w-72 p-2"
      >
          <div className="mb-1.5 flex items-center gap-2 rounded-xl bg-black/[0.05] px-2.5 py-1.5 dark:bg-white/[0.08]">
            <Search className="h-3.5 w-3.5 shrink-0 text-black/45 dark:text-white/45" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your apps…"
              className="w-full bg-transparent text-[0.8rem] text-black/85 outline-none placeholder:text-black/40 dark:text-white/90 dark:placeholder:text-white/40"
            />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {filtered.map((a) => (
              <div
                key={a.path}
                className="group flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
              >
                <button
                  type="button"
                  onClick={() => {
                    launch(a);
                    setMoreOpen(false);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  {a.icon ? (
                    <img src={a.icon} alt="" draggable={false} className="h-6 w-6 rounded-[22%]" />
                  ) : (
                    <span className="flex h-6 w-6 items-center justify-center rounded-[22%] bg-black/10 text-[0.65rem] font-semibold dark:bg-white/20">
                      {a.name.slice(0, 1)}
                    </span>
                  )}
                  <span className="truncate text-[0.8rem] font-medium text-black/85 dark:text-white/90">
                    {a.name}
                  </span>
                  {isRunning(a) && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/90" title="Running" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => togglePin(a)}
                  title={pins.includes(a.path) ? "Unpin from dock" : "Pin to dock"}
                  aria-label={pins.includes(a.path) ? `Unpin ${a.name}` : `Pin ${a.name}`}
                  className={`shrink-0 rounded-md p-1 transition-opacity ${
                    pins.includes(a.path)
                      ? "text-sky-500 opacity-100"
                      : "text-black/45 opacity-0 group-hover:opacity-100 dark:text-white/45"
                  }`}
                >
                  {pins.includes(a.path) ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
                </button>
              </div>
            ))}
            {!filtered.length && (
              <p className="px-2 py-3 text-center text-[0.75rem] text-black/45 dark:text-white/45">
                No apps match &ldquo;{query}&rdquo;
              </p>
            )}
          </div>
      </StudioPop>
    </div>
  );
}
