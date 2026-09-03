// LYKN Studio — the liquid-glass workspace.
//
// A visionOS-style glass panel — the app's primary shell. The Electron main
// window loads this route over HUD vibrancy (see createMainWindow). The
// Home tab is a blank macOS-style desktop (just the sidebar over the
// wallpaper); Chat mounts the real product page in-document (inside its own
// MemoryRouter so internal navigation stays inside the panel while the window
// URL stays on /studio). Browser / Projects / Vault / Files / Calendar /
// To-dos / Settings pop up as floating windows on Home.
//
// The shell's major parts live in src/components/studio/:
//   - studioAppRegistry: which apps/sections exist and how they open
//   - studioSplitLayout: Split View geometry helpers
//   - StudioSurface: the MemoryRouter-hosted product surfaces
//   - StudioBrowserBody + agentRail/: the Browser window body and agent rail
//   - StudioDock: the bottom dock and its chats popover
// This file owns the page-level orchestration: tabs, the Home chat layer,
// desktop drops/widgets, floating windows, Split View, and browser docking.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { File as FileIcon } from "lucide-react";
import SettingsModal from "@/components/notes/SettingsModal";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  fetchLyknChatsWithContext,
  invalidateLyknChatListQueries,
} from "@/lib/lyknChat/fetchLyknChatsWithContext";
import { createNewChat } from "@/lib/chat/chatThreadsClient";
import { STUDIO_OPEN_TAB_EVENT } from "@/lib/studioTabs";
import { subscribeLyknChatsChanged } from "@/lib/lyknChat/chatsChanged";
import { isDarkTheme, readSavedTheme } from "@/lib/theme";
import { readAppearance, subscribeAppearance } from "@/lib/appearance";
import { isDesktopShell } from "@/lib/webAppAccess";
import StudioHoverTips from "@/components/StudioHoverTips";
import { openLyknChat } from "@/components/macdock/DockContextMenu";
import { STUDIO_HIDE_BROWSER_EVENT } from "@/lib/lyknChat/openInStudioBrowser";
import InstalledAppFrame from "@/components/macdesktop/InstalledAppFrame";
import {
  OPEN_APP_EVENT,
  appIdFromWindowId,
  appWindowId,
  appWindowUrl,
  isAppInstallAvailable,
  listInstalledApps,
  onAppsChanged,
} from "@/lib/apps/installApp";
import { appIconFor } from "@/lib/apps/appIcon";
import { stashAppEdit } from "@/lib/apps/editApp";
import {
  DesktopFolders,
  FilesWidget,
  VaultFolderWidget,
  useHomeWidgetOn,
  useWelcomeWidgetSync,
} from "@/components/macdesktop/DesktopWidgets";
import { useWelcomeDesignSync } from "@/lib/welcomeDesignPrefs";
import { syncDisplayTopInset } from "@/lib/displayTopInset";
import { useDesktopVisibility } from "@/components/macdesktop/desktopVisibility";
import {
  DesktopLayerProvider,
  useDesktopIconVars,
  useMeasuredLayer,
} from "@/components/macdesktop/desktopGrid";
import { movablePaths, normalizeDir } from "@/components/macfiles/filesDrag";
import { describeFilesError } from "@/components/macfiles/errors";
import { addDesktopDrops } from "@/lib/macDesktopSync";
import { moveFilesInto, placeDesktopIcons } from "@/components/macdesktop/fileDrop";
import { useDragState, useDropZone } from "@/lib/drag/dragEngine";
import {
  DesktopSelectProvider,
  moveDesktopGroup,
  shiftPositions,
} from "@/components/macdesktop/desktopSelect";
import DesktopAppWindow from "@/components/macdesktop/DesktopAppWindow";
import FileWindowContent from "@/components/files/FileWindowContent";
import { fileSourceName } from "@/lib/files/fileSource";
import {
  closeFileWindow,
  isFileWindowId,
  listFileWindows,
  OPEN_FILE_WINDOW_EVENT,
  subscribeFileWindows,
} from "@/lib/files/fileWindows";
import HomeChatBar from "@/components/macdesktop/HomeChatBar";
import StudioPop from "@/components/macdesktop/StudioPop";
import StudioSplit from "@/components/macdesktop/StudioSplit";
import StudioUpdateBanners from "@/components/desktop/StudioUpdateBanners";
import MacDesktopMirror from "@/components/macdesktop/MacDesktopMirror";
import WidgetCanvas from "@/components/macdesktop/WidgetCanvas";
import StudioSurface, { StudioChatPane } from "@/components/studio/StudioSurface";
import { BOTS_TOGGLE_ACTIVITY, BotsActivityButton } from "@/components/bots/BotsPage";
import StudioBrowserBody from "@/components/studio/StudioBrowserBody";
import {
  BROWSER_CHROME_HEIGHT,
  BROWSER_VIEW_RADIUS,
} from "@/components/studio/browserPaneLayout";
import StudioDock from "@/components/studio/StudioDock";
import {
  FROST_PANEL,
  SECTIONS,
  SETTINGS_VIEWS,
  SPLIT_APPS,
  STUDIO_DOCK_HIDEABLE,
  WINDOW_APPS,
  loadHiddenDockIds,
  saveHiddenDockIds,
  stripQueryParam,
} from "@/components/studio/studioAppRegistry";
import { parseSettingsDeepLink } from "@/lib/settingsDeepLink";
import {
  hiddenSplitIndex,
  splitCells,
  splitColumnOf,
  splitHasApp,
  splitSibling,
  splitSpan,
  visibleSplitIndexes,
} from "@/components/studio/studioSplitLayout";

export default function Studio() {
  const { user } = useAuth();
  const desktop = isDesktopShell();
  const studioRootRef = useRef(null);
  // Desktop shell IS the vibrancy Studio window now (main window loads
  // /studio?glass=1). Keep treating desktop as glass even if a client-side
  // nav drops the query param. On the web we only go transparent with ?glass=1.
  const glassWindow = useMemo(() => {
    if (desktop) return true;
    try {
      return new URLSearchParams(window.location.search).get("glass") === "1";
    } catch {
      return false;
    }
  }, [desktop]);

  const [tab, setTab] = useState("dashboard");
  // Home doubles as the chat page: sending from the desktop chat bar layers
  // the warm chat surface over the wallpaper. Leaving Home and coming back
  // restores that conversation. Clicking Home while already on Home dismisses
  // it to the clean desktop.
  const [homeChat, setHomeChat] = useState(false);
  // Whether the surfaced conversation actually has content (chat turns /
  // Imagine batches) — the rounded bar stays centered on fresh mode pages
  // and only docks to the bottom once this flips on.
  const [homeChatLive, setHomeChatLive] = useState(false);
  // Which mode page the chat surface is on — Imagine brings its own full
  // prompt bar (aspect ratios, reference images), so the rounded home bar
  // steps aside while it's up.
  const [homeView, setHomeView] = useState("chat");
  // Browser rail open: keep the Home LyknChat engine mounted so rail sends
  // have a live board. Do not hide the desktop chat bar — Home and the
  // browser rail are independent composers.
  const [railAttachedOpen, setRailAttachedOpen] = useState(false);
  // The desktop's widgets live in their own layout (position and size per
  // widget); the walkthrough's picks are seeded into it on first run. The
  // Files and Vault desktop folders are still plain on/offs, because they're
  // icons rather than widgets.
  useWelcomeWidgetSync();
  useWelcomeDesignSync();
  const [{ hideFolders }] = useDesktopVisibility();
  const showFilesWidget = useHomeWidgetOn("files") && !hideFolders;
  const showVaultFolder = useHomeWidgetOn("vaultFolder") && !hideFolders;

  // Dropping a file on the wallpaper puts it on the real Desktop folder, which
  // is what MacDesktopMirror shows — so it lands where it was dropped rather
  // than needing a separate notion of "LYKN's desktop".
  const [desktopFolder, setDesktopFolder] = useState("");
  const [dropNote, setDropNote] = useState("");
  const dropNoteTimer = useRef(null);
  const desktopLayerRef = useRef(null);

  useEffect(() => {
    window.lykn?.macFsHome?.()
      .then((r) => {
        if (r?.ok) setDesktopFolder(r.desktop || "");
      })
      .catch(() => {});
    return () => clearTimeout(dropNoteTimer.current);
  }, []);

  const showDropNote = (text) => {
    setDropNote(text);
    clearTimeout(dropNoteTimer.current);
    dropNoteTimer.current = setTimeout(() => setDropNote(""), 3400);
  };

  /**
   * The wallpaper. Two things can land here and they're told apart by whether
   * the drag started on the desktop:
   *
   *  - an icon already on Home is being rearranged, so the whole selection
   *    keeps its formation and stops exactly where it was let go;
   *  - something dragged out of a Files window arrives, which means a real
   *    move into the Desktop folder — and then its new icon is parked at the
   *    drop point rather than filed into the next free grid slot.
   */
  const wallpaperDrop = useDropZone({
    accept: (payload) => payload.paths.length > 0 || payload.iconIds.length > 0,
    onDrop: async (payload) => {
      const box = desktopLayerRef.current?.getBoundingClientRect();
      // Where the icon's top-left goes: under whatever was following the
      // cursor, so it lands on the spot the user was aiming at rather than
      // half an icon away from it.
      const at = box
        ? {
            x: payload.x + (payload.offsetX ?? -48) - box.left,
            y: payload.y + (payload.offsetY ?? -40) - box.top,
          }
        : null;

      const rearranging = !!payload.bases && Object.keys(payload.bases).length > 0;
      if (rearranging) {
        moveDesktopGroup(
          shiftPositions(
            payload.bases,
            payload.x - payload.grabX,
            payload.y - payload.grabY,
          ),
          true,
        );
      }

      const dest = normalizeDir(desktopFolder);
      const incoming = dest ? movablePaths(payload.paths, dest) : [];
      if (!incoming.length) {
        // Already on the Desktop, dragged in from a Files window: nothing to
        // move, it just gets a new spot.
        if (!rearranging && at && payload.paths.length) {
          placeDesktopIcons(payload.paths, at.x, at.y);
        }
        return;
      }

      const result = await moveFilesInto(incoming, dest, { copy: payload.copy });
      if (result?.ok === false) {
        showDropNote(describeFilesError(result));
        return;
      }
      const landed = result?.paths || [];
      if (!landed.length) return;
      addDesktopDrops(landed);
      if (at) placeDesktopIcons(landed, at.x, at.y);
    },
  });

  const setDesktopLayer = useCallback(
    (el) => {
      desktopLayerRef.current = el;
      wallpaperDrop.ref(el);
    },
    [wallpaperDrop.ref],
  );

  // Measured once here, for every icon layer inside. Icon sizes ride down as
  // CSS variables and positions are resolved against it, so moving the window
  // to a different display re-lays the desktop out to fit.
  const desktopLayer = useMeasuredLayer(desktopLayerRef);
  useDesktopIconVars(desktopLayer);

  // The dashed "drop here" frame is for files arriving from somewhere else.
  // Shuffling icons that are already on Home shouldn't light the desktop up.
  const drag = useDragState();
  const wallpaperArmed =
    wallpaperDrop.hot && drag.dragging && drag.payload?.source !== "desktop";
  // Edit mode: widgets lift off the desktop to be moved, resized and added.
  const [widgetsEditing, setWidgetsEditing] = useState(false);
  useEffect(() => {
    const onActivity = (e) => setHomeChatLive(!!e?.detail?.active);
    const onViewChanged = (e) => setHomeView(String(e?.detail?.view || "chat"));
    window.addEventListener("lykn-chat-activity-changed", onActivity);
    window.addEventListener("lykn-studio-view-changed", onViewChanged);
    window.addEventListener("lykn-home-view", onViewChanged);
    return () => {
      window.removeEventListener("lykn-chat-activity-changed", onActivity);
      window.removeEventListener("lykn-studio-view-changed", onViewChanged);
      window.removeEventListener("lykn-home-view", onViewChanged);
    };
  }, []);
  // Embedded frames mount on first visit and stay warm after that. A widget
  // can deep-link a section (e.g. a specific chat or project) via frameSrc.
  // Chat stays warm from the first Home paint so a Bot pick / first send
  // already has a live board. Hidden until homeChat is true.
  const [visited, setVisited] = useState({ chat: true });
  const [frameSrc, setFrameSrc] = useState({});
  // Ask LYKN in the browser rail uses the same LyknChat engine as Home.
  // Mount the surface hidden so sends and the attached thread have a live
  // conversation even if the user never opened chat on the desktop first.
  useEffect(() => {
    if (!railAttachedOpen) return;
    setVisited((v) => (v.chat ? v : { ...v, chat: true }));
  }, [railAttachedOpen]);
  // Floating Home windows (Browser / Calendar / To-dos), back to front: the
  // last id is the focused one. Minimized windows stay in the list (and stay
  // mounted, so their state survives) and come back from the dock or their
  // widget. Closing the Browser window is different: it tears the session
  // down so the next press opens a fresh window.
  const [appWins, setAppWins] = useState([]);
  const [minimized, setMinimized] = useState({});
  // Apps LYKN built for this user. They open as desktop windows like the
  // built-ins, so they have to be part of the same window vocabulary — but they
  // arrive at runtime, which is why WINDOW_APPS can't be the only source.
  const [installedApps, setInstalledApps] = useState([]);
  // Split View — two Studio apps tiled left/right, macOS style.
  const [split, setSplit] = useState(null);
  const [snapHint, setSnapHint] = useState(null);
  const [fillWin, setFillWin] = useState(null);
  // Installed apps (and anything else that paints over the dock when zoomed)
  // report in here so the window layer can sit above the bottom bar.
  const [dockCover, setDockCover] = useState({});
  const coveringZoom = Object.values(dockCover).some(Boolean);
  // Clicking the bare wallpaper sweeps every window off the sides to reveal the
  // desktop, macOS style; clicking it again brings them all back.
  const [desktopPeek, setDesktopPeek] = useState(false);
  // Seeded from the saved preference, then kept in step with the document's
  // own `dark` class — Settings › Appearance and the OS (theme "system") flip
  // the theme without going through the toggle below.
  const [dark, setDark] = useState(() => isDarkTheme(readSavedTheme()));
  // Custom Studio backdrop (data URL) — synced from the Mac in the welcome
  // flow ("use my wallpaper" / any image). Empty = default gradient.
  const [bgImage, setBgImage] = useState("");
  // Wallpaper choice + dim/blur from Settings › Appearance.
  const [appearance, setAppearance] = useState(readAppearance);
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsView, setSettingsView] = useState("account");
  const settingsControls = useRef(null);
  // Dock chats popover — the LYKN icon in the bottom dock opens a panel with
  // search + the full chat history. The open flag lives here so openTab and
  // Split View can close it; the popover itself renders inside StudioDock.
  const [chatsOpen, setChatsOpen] = useState(false);
  const [hiddenDockIds, setHiddenDockIds] = useState(loadHiddenDockIds);
  const queryClient = useQueryClient();

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useQuery({
    queryKey: ["studio-rail-chats", user?.id || "guest"],
    // Prefetch for the Home "Chats" widget. The dock popover paginates the
    // full history separately so older chats stay reachable.
    enabled: !!user?.id,
    staleTime: 30_000,
    queryFn: () => fetchLyknChatsWithContext(user.id, 30),
  });

  // Chats save inside the embedded chat iframe (a sibling document), so the
  // rail and Recent Chats lists refresh off the cross-document chats-changed
  // signal — every send/auto-name/rename in Chat, Build, Imagine or Research
  // lands in the sidebar as soon as it's saved.
  useEffect(() => {
    return subscribeLyknChatsChanged(() => {
      queryClient.invalidateQueries({ queryKey: ["studio-rail-chats"] });
      queryClient.invalidateQueries({ queryKey: ["studio-chats"] });
      queryClient.invalidateQueries({ queryKey: ["studio-search-chats"] });
      invalidateLyknChatListQueries(queryClient, user?.id);
    });
  }, [queryClient, user?.id]);

  // Same behavior as the in-app sidebar's New chat: create the chat row
  // immediately, then open it (here: deep-link the embedded chat frame).
  const startNewChat = async () => {
    if (!user?.id) return;
    try {
      const { chatId } = await createNewChat(user.id);
      queryClient.invalidateQueries({ queryKey: ["studio-rail-chats"] });
      invalidateLyknChatListQueries(queryClient, user.id);
      openTab("chat", `/chat/${encodeURIComponent(chatId)}`);
    } catch {
      // Fall back to the fresh-composer state if creation fails.
      openTab("chat", `/app?nc=${Date.now()}`);
    }
  };

  const firstName = useMemo(() => {
    const meta = user?.user_metadata || {};
    const name = String(meta.full_name || meta.name || "").trim();
    if (name) return name.split(/\s+/)[0];
    const email = String(user?.email || "").trim();
    if (!email) return "there";
    const prefix = email.split("@")[0];
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }, [user]);

  useEffect(() => {
    document.documentElement.classList.add("lykn-studio-mode");
    document.body.classList.add("lykn-studio-mode");
    const prevTitle = document.title;
    document.title = "LYKN Studio";
    return () => {
      document.documentElement.classList.remove("lykn-studio-mode");
      document.body.classList.remove("lykn-studio-mode");
      document.title = prevTitle;
    };
  }, []);

  // Fullscreen — Studio takes over the whole UI, so the glass window can fill
  // the screen. Toggled from outside the page (native traffic lights, the app
  // menu, the OS); tracked here because the layout has to clear the notch and
  // run the panes to the window's edges.
  // Measure before paint so the Chat / Build / Imagine / Research pill
  // starts below the camera instead of jumping after first frame.
  useLayoutEffect(() => {
    syncDisplayTopInset();
  }, []);
  useEffect(() => {
    const applyHost = (payload) => {
      setFullscreen(!!payload?.fullscreen);
      syncDisplayTopInset(payload);
    };
    if (window.lykn?.onStudioFullscreen) {
      let cancelled = false;
      window.lykn
        .getStudioFullscreen?.()
        .then((res) => {
          if (!cancelled) applyHost(res);
        })
        .catch(() => {});
      const off = window.lykn.onStudioFullscreen((p) => applyHost(p));
      return () => {
        cancelled = true;
        off?.();
      };
    }
    const onChange = () => {
      setFullscreen(!!document.fullscreenElement);
      syncDisplayTopInset();
    };
    onChange();
    window.addEventListener("resize", onChange);
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      document.removeEventListener("fullscreenchange", onChange);
    };
  }, []);

  // The agent browser is native Electron views, not a web page, so the main
  // process docks them over the body of the floating Browser window (left of
  // the agent rail). Report that body's window-relative rect and keep it fresh
  // as the window is dragged, resized, zoomed, or the rail collapses.
  const [browserHostEl, setBrowserHostEl] = useState(null);
  const browserHostRef = useCallback((node) => {
    setBrowserHostEl((prev) => (prev === node ? prev : node));
  }, []);
  const sendBrowserBounds = useRef(null);
  // Stable so the window frame's geometry effect doesn't re-fire every render.
  const reportBrowserBounds = useCallback(() => sendBrowserBounds.current?.(), []);
  // Native views paint above the whole renderer, so they may only be on screen
  // while the window itself is: Home tab, open, not minimized, at rest, and not
  // swept aside by a desktop peek (a CSS transform can't carry them off with
  // the frame, so they undock for the duration instead).
  //
  // At rest has to be something the frame states, not the absence of a report:
  // on the first render after the window opens it hasn't said anything yet, and
  // reading that silence as "at rest" docked the views for one commit and
  // undocked them on the next, re-parenting the whole browser an extra time on
  // every single open.
  const [browserSettled, setBrowserSettled] = useState(false);
  const onBrowserAnimating = useCallback((busy) => setBrowserSettled(!busy), []);
  const browserOpen = appWins.includes("browser");
  const splitHasBrowser = splitHasApp(split, "browser");
  // Full-screen Browser hides the dock, macOS style. The native page already
  // paints over the strip, but the window's React parts (the agent rail) sit
  // under the dock's z-30 — so without this the dock pokes through into the
  // rail and swallows its clicks. The window reports false on restore AND on
  // unmount, and the checks below bring the dock back for minimize/peek,
  // where the user needs it to get the window back.
  const [browserZoomed, setBrowserZoomed] = useState(false);
  const dockHidden =
    browserZoomed &&
    (splitHasBrowser || browserOpen) &&
    !minimized.browser &&
    !desktopPeek &&
    tab === "dashboard";
  // A split pane is at rest the moment it mounts. Waiting on the hidden
  // floating frame's settle clock left the native page on the old rect, then
  // undocked it — the glitch instead of a snap.
  const browserDocked = splitHasBrowser
    ? tab === "dashboard" && !desktopPeek
    : tab === "dashboard" &&
      browserOpen &&
      !minimized.browser &&
      browserSettled &&
      !desktopPeek &&
      !split;
  useEffect(() => {
    // A closed window reports nothing, so its last word was "at rest" — clear
    // it, or the next open would dock before the frame has been placed.
    if (!browserOpen) {
      setBrowserSettled(false);
      return;
    }
    // The views can only dock once the frame has settled and been measured, so
    // start the browser loading the moment it's asked for: by then there's a
    // painted page to reveal rather than a cold tab.
    window.lykn?.warmStudioBrowser?.();
  }, [browserOpen]);
  useLayoutEffect(() => {
    if (!window.lykn?.setStudioBrowser) return undefined;
    if (!browserDocked) {
      sendBrowserBounds.current = null;
      window.lykn.setStudioBrowser({ open: false });
      return undefined;
    }
    const el = browserHostEl;
    // Floating ↔ split remounts the host. Closing the dock here parks the
    // page off-screen and reveals it again — that's the glitch. Hold the
    // last rect until the new pane is measured, then snap.
    if (!el) return undefined;
    const send = () => {
      const r = el.getBoundingClientRect();
      // Mid-open the window hasn't been measured yet; a zero rect would park
      // the views off-stage and blank the browser.
      if (r.width < 1 || r.height < 1) return;
      window.lykn.setStudioBrowser({
        open: true,
        radius: BROWSER_VIEW_RADIUS,
        bounds: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      });
    };
    // Dragging the window moves the host without resizing it, so the window
    // frame reports its geometry here too (see onGeometry below).
    sendBrowserBounds.current = send;
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener("resize", send);
    return () => {
      sendBrowserBounds.current = null;
      ro.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [browserDocked, browserHostEl, railAttachedOpen]);

  // The picture the window animates over while its native views are away (see
  // StudioBrowserBody). Main refreshes it as the browser changes and keeps the
  // last one after the views leave, so closing has something to fly out with
  // and the next open something to fly back in.
  const [browserShot, setBrowserShot] = useState(null);
  // The stage's real chrome height rides along with the picture. The skeleton
  // needs it too, and needs it after the picture has been set aside, so it's
  // kept apart — starting on the default the stage itself starts on.
  const [browserChromeH, setBrowserChromeH] = useState(BROWSER_CHROME_HEIGHT);
  useEffect(() => {
    if (!window.lykn?.onStudioBrowserShot) return undefined;
    return window.lykn.onStudioBrowserShot((p) => {
      if (!p?.ok) return;
      setBrowserShot(p);
      if (p.chromeHeight > 0) setBrowserChromeH(p.chromeHeight);
    });
  }, []);

  // The Browser window has no React title bar: its tab strip is the title bar,
  // and it lives in a native view that paints above the renderer. The traffic
  // lights and the drag there run in that view and come back through the main
  // process as window controls for the frame.
  const browserControls = useRef(null);
  const splitRef = useRef(null);
  const splitActionsRef = useRef({});
  splitRef.current = split;
  useEffect(() => {
    if (!window.lykn?.onStudioWindowControl) return undefined;
    return window.lykn.onStudioWindowControl(({ action, dx, dy } = {}) => {
      const current = splitRef.current;
      const browserIndex = splitCells(current).indexOf("browser");
      if (browserIndex >= 0) {
        if (action === "close") splitActionsRef.current.closePane?.(browserIndex);
        else if (action === "zoom" || action === "minimize") {
          splitActionsRef.current.fillPane?.(browserIndex);
        } else if (action === "tile-quad") {
          splitActionsRef.current.tile?.("browser", "quad");
        }
        return;
      }
      const c = browserControls.current;
      if (!c) return;
      if (action === "close") c.close();
      else if (action === "minimize") c.minimize();
      else if (action === "zoom") c.zoom();
      else if (action === "tile-left") splitActionsRef.current.tile?.("browser", "left");
      else if (action === "tile-right") splitActionsRef.current.tile?.("browser", "right");
      else if (action === "tile-quad") splitActionsRef.current.tile?.("browser", "quad");
      else if (action === "drag-start") {
        focusAppWindow("browser");
        c.dragStart();
      } else if (action === "drag-move") c.dragBy(Number(dx) || 0, Number(dy) || 0);
      else if (action === "drag-end") c.dragEnd();
    });
  }, []);

  // Artifact "Open" / a chat link routes the URL into the Studio browser
  // and docks that window. The side chat stays closed until Ask LYKN or
  // AI Mode - bot work and opened tabs must not pop it open.
  useEffect(() => {
    const onShowBrowser = (event) => {
      setTab("dashboard");
      focusAppWindow("browser");
      const d = event?.detail || {};
      if (d.openRail) {
        const agentId = String(d.agentId || "").trim();
        try {
          window.lykn?.agentChatSet?.({ open: true, agentId: agentId || undefined });
        } catch {
          /* Ask LYKN / AI Mode still open the rail from chrome */
        }
      }
    };
    window.addEventListener("lykn-studio-show-browser", onShowBrowser);
    const onHideBrowser = () => {
      // Yellow-minimize: park the frame and keep every tab alive so a Bot
      // (or a LYKN-opened page) is still there when that chat comes back.
      setMinimized((m) => (m.browser ? m : { ...m, browser: true }));
    };
    window.addEventListener(STUDIO_HIDE_BROWSER_EVENT, onHideBrowser);
    // "Ask AI" in the Mac Files surface hands the prompt to the chat surface
    // and fires this so the Studio flips to the Chat tab.
    const onOpenChat = (event) => {
      // Chat lives on Home now — surface the conversation over the desktop.
      if (event?.detail?.forceHome) setSplit(null);
      setTab("dashboard");
      setHomeChat(true);
      setVisited((v) => (v.chat ? v : { ...v, chat: true }));
      const vaultPayload = event?.detail?.vaultPayload;
      const src = event?.detail?.src;
      // A vault attach targets the conversation already on screen. The chat
      // surface stays warm from the first Home paint, so re-keying frameSrc
      // here would remount the whole MemoryRouter and stomping homeView would
      // kick an active Imagine / Build / Research session back to plain Chat
      // (mode pill and page both). Deliver the payload to the live surface
      // instead and leave the mode session alone.
      if (src && !vaultPayload) {
        setFrameSrc((f) => (f.chat === src ? f : { ...f, chat: src }));
      }
      const dismissApp = event?.detail?.dismissApp;
      if (dismissApp) setMinimized((m) => ({ ...m, [dismissApp]: true }));
      if (vaultPayload) {
        // React commits the Home chat before the next frame. Delivering the
        // payload then handles both an already-mounted chat and a fresh mount;
        // sessionStorage remains the reload-safe fallback.
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            window.dispatchEvent(
              new CustomEvent("lykn-chat-vault-add", { detail: vaultPayload }),
            );
          });
        });
      }
    };
    window.addEventListener("lykn-studio-open-chat", onOpenChat);
    return () => {
      window.removeEventListener("lykn-studio-show-browser", onShowBrowser);
      window.removeEventListener(STUDIO_HIDE_BROWSER_EVENT, onHideBrowser);
      window.removeEventListener("lykn-studio-open-chat", onOpenChat);
    };
  }, []);

  // Custom backdrop — load once, then follow live changes (welcome flow or
  // settings can swap it while the studio is open).
  useEffect(() => {
    const b = typeof window !== "undefined" ? window.lykn : null;
    if (!b?.backgroundGet) return;
    let cancelled = false;
    b.backgroundGet()
      .then((r) => {
        if (!cancelled && r?.ok) setBgImage(r.dataUrl || "");
      })
      .catch(() => {});
    const off = b.onBackgroundChanged?.((p) => setBgImage(p?.dataUrl || ""));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => subscribeAppearance(setAppearance), []);

  // Bring a floating window to the front (opening it if it isn't up yet).
  const focusAppWindow = (id) => {
    setAppWins((w) => (w[w.length - 1] === id ? w : [...w.filter((x) => x !== id), id]));
    setMinimized((m) => (m[id] ? { ...m, [id]: false } : m));
    // Reaching for a window ends the desktop peek — otherwise it would open
    // swept off-screen with nothing to show for the click.
    setDesktopPeek(false);
  };

  const closeAppWindow = (id) => {
    setAppWins((w) => w.filter((x) => x !== id));
    setMinimized((m) => (m[id] ? { ...m, [id]: false } : m));
    setFillWin((f) => (f === id ? null : f));
    setDockCover((m) => (m[id] ? { ...m, [id]: false } : m));
    // Drop the deep link so the next open starts on the page's own entry.
    setFrameSrc((f) => (f[id] ? { ...f, [id]: undefined } : f));
    // A file window is only ever this one frame, so closing it retires the
    // registry row too — otherwise the same file could never be re-opened.
    if (isFileWindowId(id)) closeFileWindow(id);
    // Red traffic light: the window unmounts AND the native session dies.
    // Yellow minimize only hides the frame and keeps the tabs.
    if (id === "browser") {
      setBrowserShot(null);
      void window.lykn?.closeStudioBrowser?.();
    }
  };

  // ── Files opened as windows. Whoever asks — the Files browser, a desktop
  // icon, the chat, the AI — dispatches through the file-window registry and
  // the desktop claims it here, so a photo from the Mac and a photo LYKN drew
  // land in the same kind of frame as the Browser and the installed apps.
  const [fileWins, setFileWins] = useState(listFileWindows);
  useEffect(() => subscribeFileWindows(() => setFileWins(listFileWindows())), []);

  useEffect(() => {
    const onOpenFile = (e) => {
      const id = e?.detail?.id;
      if (!id) return;
      e.preventDefault();
      setTab("dashboard");
      setSplit(null);
      focusAppWindow(id);
    };
    window.addEventListener(OPEN_FILE_WINDOW_EVENT, onOpenFile);
    return () => window.removeEventListener(OPEN_FILE_WINDOW_EVENT, onOpenFile);
  }, []);

  // A window closed through the registry rather than through its own red light
  // would otherwise leave a frame here with no file behind it.
  useEffect(() => {
    setAppWins((w) =>
      w.filter((id) => !isFileWindowId(id) || fileWins.some((f) => f.id === id)),
    );
  }, [fileWins]);

  useEffect(() => {
    if (!isAppInstallAvailable()) return undefined;
    const load = () => void listInstalledApps().then(setInstalledApps);
    load();
    // Installing happens in this window, but removing can happen in Settings in
    // another one; main broadcasts either way.
    return onAppsChanged(load);
  }, []);

  // The same shape WINDOW_APPS holds, so every window path can treat an
  // installed app as just another app window.
  const installedWindowApps = useMemo(() => {
    const out = {};
    for (const app of installedApps) {
      out[appWindowId(app.id)] = {
        label: app.name,
        icon: appIconFor(app.icon, app.id),
        width: 900,
        height: 660,
        appId: app.id,
        installed: true,
      };
    }
    return out;
  }, [installedApps]);

  const windowAppFor = useCallback(
    (id) => {
      if (!id) return null;
      if (isFileWindowId(id)) {
        const entry = fileWins.find((w) => w.id === id);
        if (!entry) return null;
        return {
          label: fileSourceName(entry.source),
          icon: FileIcon,
          width: 860,
          height: 640,
          file: entry.source,
        };
      }
      return WINDOW_APPS[id] || installedWindowApps[id] || null;
    },
    [installedWindowApps, fileWins],
  );

  // Opening an app from the dock, Settings, or a chat all arrive here; claiming
  // the event is what keeps it on the desktop instead of in a window of its own.
  useEffect(() => {
    const onOpen = (e) => {
      const id = e?.detail?.id;
      if (!id) return;
      e.preventDefault();
      setTab("dashboard");
      setSplit(null);
      focusAppWindow(appWindowId(id));
    };
    window.addEventListener(OPEN_APP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_APP_EVENT, onOpen);
  }, []);

  // An app removed while its window is open would otherwise leave a frame with
  // nothing behind it.
  useEffect(() => {
    setAppWins((w) =>
      w.filter((id) => {
        const appId = appIdFromWindowId(id);
        return !appId || installedApps.some((a) => a.id === appId);
      }),
    );
  }, [installedApps]);

  const prepareSplitApp = (id) => {
    if (!id) return;
    if (windowAppFor(id)) {
      setAppWins((w) => (w.includes(id) ? w : [...w, id]));
      setMinimized((m) => (m[id] ? { ...m, [id]: false } : m));
    } else if (id === "chat") {
      setVisited((v) => (v.chat ? v : { ...v, chat: true }));
    } else {
      setVisited((v) => (v[id] ? v : { ...v, [id]: true }));
    }
  };

  const enterSplit = (next) => {
    const layout = next.layout === 4 ? 4 : 2;
    let cells =
      Array.isArray(next.cells) && next.cells.length
        ? [...next.cells]
        : [next.left || null, next.right || null];
    while (cells.length < layout) cells.push(null);
    cells = cells.slice(0, layout);
    cells.forEach(prepareSplitApp);
    setTab("dashboard");
    setHomeChat(false);
    setDesktopPeek(false);
    setChatsOpen(false);
    setSnapHint(null);
    setFillWin(null);
    const focusRaw = next.focus;
    const focus =
      typeof focusRaw === "number"
        ? focusRaw
        : focusRaw === "right"
          ? 1
          : 0;
    setSplit({
      layout,
      cells,
      span: layout === 4 ? splitSpan(next) : null,
      vRatio: Number.isFinite(next.vRatio)
        ? next.vRatio
        : Number.isFinite(next.ratio)
          ? next.ratio
          : 0.5,
      hRatio: Number.isFinite(next.hRatio) ? next.hRatio : 0.5,
      focus: Math.max(0, Math.min(cells.length - 1, focus)),
    });
  };

  const tileWindow = (id, side) => {
    if (side === "quad") {
      if (split) {
        const cells = [...splitCells(split)];
        while (cells.length < 4) cells.push(null);
        if (!cells.includes(id)) {
          const empty = cells.findIndex((c) => !c);
          if (empty >= 0) cells[empty] = id;
          else cells[typeof split.focus === "number" ? split.focus : 0] = id;
        }
        enterSplit({
          ...split,
          layout: 4,
          span: null,
          cells: cells.slice(0, 4),
          focus: Math.max(0, cells.indexOf(id)),
        });
        return;
      }
      const others = appWins.filter((w) => w !== id && !minimized[w]);
      enterSplit({
        layout: 4,
        cells: [id, others[0] || null, others[1] || null, others[2] || null],
        focus: 0,
      });
      return;
    }
    const others = appWins.filter((w) => w !== id && !minimized[w]);
    const partner = others.length ? others[others.length - 1] : null;
    if (side === "left") enterSplit({ layout: 2, cells: [id, partner], focus: 0 });
    else enterSplit({ layout: 2, cells: [partner, id], focus: 1 });
  };

  const expandSplitQuad = () => {
    if (!split) return;
    const cells = [...splitCells(split)];
    while (cells.length < 4) cells.push(null);
    enterSplit({ ...split, layout: 4, span: null, cells: cells.slice(0, 4) });
  };

  const exitSplit = (keepId) => {
    setSplit(null);
    setSnapHint(null);
    if (!keepId) {
      setFillWin(null);
      return;
    }
    if (windowAppFor(keepId)) {
      setTab("dashboard");
      focusAppWindow(keepId);
      setFillWin(keepId);
      return;
    }
    setFillWin(null);
    if (keepId === "chat") {
      setTab("dashboard");
      setHomeChat(true);
      setVisited((v) => (v.chat ? v : { ...v, chat: true }));
      return;
    }
    setTab(keepId);
    setVisited((v) => (v[keepId] ? v : { ...v, [keepId]: true }));
  };

  const closeSplitPane = (index) => {
    if (!split) return;
    const cells = [...splitCells(split)];
    const closedId = cells[index] || null;
    const dismissingPicker = !closedId;
    cells[index] = null;
    const remaining = cells.filter(Boolean);

    if (remaining.length <= 1) {
      if (closedId && windowAppFor(closedId) && closedId !== remaining[0]) {
        closeAppWindow(closedId);
      }
      exitSplit(remaining[0] || null);
      return;
    }

    if ((split.layout || 2) === 4) {
      const closedCol = splitColumnOf(index);
      const span = splitSpan(split);
      if (!span) {
        enterSplit({
          ...split,
          layout: 4,
          span: closedCol,
          cells,
          focus: splitSibling(index),
        });
        return;
      }
      if (span === closedCol) {
        if (dismissingPicker) {
          const other =
            closedCol === "left"
              ? [cells[1] || null, cells[3] || null]
              : [cells[0] || null, cells[2] || null];
          const leftover = other.filter(Boolean);
          if (leftover.length <= 1) {
            exitSplit(leftover[0] || null);
            return;
          }
          enterSplit({
            layout: 2,
            cells: other,
            vRatio: split.vRatio,
            hRatio: split.hRatio,
            focus: 0,
          });
          return;
        }
        const slots = closedCol === "left" ? [0, 2] : [1, 3];
        slots.forEach((i) => {
          cells[i] = null;
        });
        const leftover = cells.filter(Boolean);
        if (leftover.length <= 1) {
          if (closedId && windowAppFor(closedId) && closedId !== leftover[0]) {
            closeAppWindow(closedId);
          }
          exitSplit(leftover[0] || null);
          return;
        }
        enterSplit({
          ...split,
          layout: 4,
          span,
          cells,
          focus: slots[0],
        });
        return;
      }
      enterSplit({
        layout: 2,
        cells: [cells[0] || cells[2] || null, cells[1] || cells[3] || null],
        vRatio: split.vRatio,
        hRatio: split.hRatio,
        focus: closedCol === "left" ? 0 : 1,
      });
      return;
    }

    if (closedId && windowAppFor(closedId) && closedId !== remaining[0]) {
      closeAppWindow(closedId);
    }
    exitSplit(remaining[0] || null);
  };

  const fillSplitPane = (index) => {
    if (!split) return;
    const cells = splitCells(split);
    const id = cells[index] || null;
    if (id) {
      exitSplit(id);
      return;
    }
    exitSplit(visibleSplitIndexes(split).map((i) => cells[i]).find(Boolean) || null);
  };

  const pickSplitApp = (index, id) => {
    const cells = [...splitCells(split)];
    const from = cells.indexOf(id);
    if (from >= 0 && from !== index) {
      cells[from] = cells[index];
      cells[index] = id;
    } else {
      cells[index] = id;
    }
    enterSplit({ ...split, cells, focus: index });
  };

  const openBeside = (id) => {
    if (split) {
      const cells = [...splitCells(split)];
      const visible = visibleSplitIndexes(split);
      const existing = cells.indexOf(id);
      if (existing >= 0 && visible.includes(existing)) {
        setSplit((s) => (s ? { ...s, focus: existing } : s));
        return;
      }
      const empty = visible.find((i) => !cells[i]);
      if (empty != null) {
        cells[empty] = id;
        enterSplit({ ...split, cells, focus: empty });
        return;
      }
      if ((split.layout || 2) === 2) {
        enterSplit({
          ...split,
          layout: 4,
          span: null,
          cells: [cells[0] || null, cells[1] || null, id, null],
          focus: 2,
        });
        return;
      }
      const hidden = hiddenSplitIndex(split);
      if (hidden >= 0) {
        cells[hidden] = id;
        enterSplit({ ...split, layout: 4, span: null, cells, focus: hidden });
        return;
      }
      const focus = typeof split.focus === "number" ? split.focus : 0;
      cells[focus] = id;
      enterSplit({ ...split, cells, focus });
      return;
    }
    const current =
      tab !== "dashboard"
        ? tab
        : homeChat
          ? "chat"
          : appWins.filter((w) => !minimized[w]).at(-1) || null;
    if (current && current !== id) {
      enterSplit({ layout: 2, cells: [current, id], focus: 1 });
    } else {
      enterSplit({ layout: 2, cells: [id, null], focus: 0 });
    }
  };

  const setSplitRatio = useCallback((patch) => {
    setSplit((s) => {
      if (!s) return s;
      if (typeof patch === "number") return { ...s, vRatio: patch };
      return { ...s, ...patch };
    });
  }, []);

  splitActionsRef.current = {
    tile: tileWindow,
    closePane: closeSplitPane,
    fillPane: fillSplitPane,
  };

  const openTab = (id, src) => {
    setChatsOpen(false);
    // Files is not its own app any more — it's the Vault window with a folder
    // picked in the sidebar. Translate the old callers (dock button, desktop
    // icon, and the desktop mirror's /files?path=… deep link) into that, ahead
    // of the split-view branch so it holds there too.
    if (id === "files") {
      const deep = /[?&]path=([^&]+)/.exec(String(src || ""));
      openTab("vault", deep ? `/vault?loc=${deep[1]}` : "/vault?pane=files");
      return;
    }
    if (id === "dashboard" && split) {
      setSplit(null);
    } else if (split && id !== "dashboard") {
      if (id === "settings" && SETTINGS_VIEWS.includes(src)) setSettingsView(src);
      else if (src) setFrameSrc((f) => (f[id] === src ? f : { ...f, [id]: src }));
      openBeside(id);
      return;
    }
    // Calendar / To-dos / Vault / Settings / Browser are app windows on the
    // desktop: land on Home and pop the window up over it rather than swapping
    // the whole stage. Settings `src` names a section to land on (the desktop
    // menu's Edit Widgets / Show View Options open Display).
    if (windowAppFor(id)) {
      setTab("dashboard");
      if (id === "settings") {
        if (SETTINGS_VIEWS.includes(src)) setSettingsView(src);
        else if (!appWins.includes("settings")) setSettingsView("account");
      } else if (src) {
        setFrameSrc((f) => (f[id] === src ? f : { ...f, [id]: src }));
      } else if (id === "vault") {
        // Dock / desktop icon is browsing, not the chat-bar attach picker.
        setFrameSrc((f) => {
          const cur = f.vault;
          if (!cur) return f;
          const next = stripQueryParam(cur, "pick");
          try {
            sessionStorage.removeItem("lykn_vault_pick_for_chat");
          } catch {
            /* ignore */
          }
          return next === cur ? f : { ...f, vault: next };
        });
      }
      focusAppWindow(id);
      return;
    }
    // The old Chat page is gone — every chat open (dock popover, search,
    // widgets, the home bar itself) lands on Home with the chat surface
    // layered over the desktop.
    if (id === "chat") {
      setTab("dashboard");
      setHomeChat(true);
      setVisited((v) => (v.chat ? v : { ...v, chat: true }));
      if (src) setFrameSrc((f) => (f.chat === src ? f : { ...f, chat: src }));
      return;
    }
    setTab(id);
    if (id === "dashboard") {
      // Already on Home: dismiss the conversation to the clean desktop.
      // Coming back from another tab keeps the chat where you left it.
      if (tab === "dashboard") setHomeChat(false);
      return;
    }
    setVisited((v) => (v[id] ? v : { ...v, [id]: true }));
    if (src) setFrameSrc((f) => (f[id] === src ? f : { ...f, [id]: src }));
  };

  // Surfaces outside the studio tree ask for a tab by name rather than routing
  // to it. Through a ref so the listener can be installed once and still see
  // the current openTab.
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;
  const closeAppWindowRef = useRef(closeAppWindow);
  closeAppWindowRef.current = closeAppWindow;
  useEffect(() => {
    try {
      const view = parseSettingsDeepLink(window.location.search, SETTINGS_VIEWS);
      if (view) openTabRef.current("settings", view);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    const onOpenTab = (e) => {
      const { id, src } = e.detail || {};
      if (!id) return;
      e.preventDefault(); // tells the caller not to fall back to a route
      openTabRef.current(id, src);
    };
    const onCloseApp = (e) => {
      const id = e?.detail?.id;
      if (id) closeAppWindowRef.current(id);
    };
    window.addEventListener(STUDIO_OPEN_TAB_EVENT, onOpenTab);
    window.addEventListener("lykn-studio-close-app", onCloseApp);
    return () => {
      window.removeEventListener(STUDIO_OPEN_TAB_EVENT, onOpenTab);
      window.removeEventListener("lykn-studio-close-app", onCloseApp);
    };
  }, []);

  /**
   * Take an installed app back into Build mode.
   *
   * Hands over the app id and nothing else. The chat attaches the source so
   * the next message can patch it — it does not open the live app, or a
   * preview of it. Reading the source belongs to the chat surface: doing it
   * here meant the click had to wait out a round-trip before anything was
   * handed over, and a failed one left the user on an empty chat with no
   * explanation.
   *
   * The stash is written before the surface opens so a cold mount finds it
   * without depending on the event arriving after the listener is up.
   */
  const handleEditApp = (app) => {
    if (!app?.id) return;
    stashAppEdit({ appId: app.id, name: app.name || "" });
    openTab("chat", `/app?nc=${Date.now()}`);
  };

  const handleNavItem = (item, e) => {
    if (item.id === "dashboard" && split) {
      setSplit(null);
      setTab("dashboard");
      return;
    }
    if (e?.altKey && item.id !== "dashboard") {
      openBeside(item.id);
      return;
    }
    if (split && item.id !== "dashboard") {
      openBeside(item.id);
      return;
    }
    // The dock toggles an app window: clicking the front one tucks it away.
    const front = appWins[appWins.length - 1] === item.id && !minimized[item.id];
    if (WINDOW_APPS[item.id] && front && tab === "dashboard") {
      setMinimized((m) => ({ ...m, [item.id]: true }));
      return;
    }
    openTab(item.id);
  };

  const navActive = (item) => {
    if (split) return splitHasApp(split, item.id);
    if (WINDOW_APPS[item.id]) {
      return tab === "dashboard" && appWins.includes(item.id) && !minimized[item.id];
    }
    return item.action === "tab" && tab === item.id;
  };

  const hideFromDock = (id) => {
    setHiddenDockIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      saveHiddenDockIds(next);
      return next;
    });
  };
  const keepInDock = (id) => {
    setHiddenDockIds((prev) => {
      const next = prev.filter((x) => x !== id);
      saveHiddenDockIds(next);
      return next;
    });
  };

  const dockMenuFor = (item) => {
    const winOpen = !!WINDOW_APPS[item.id] && appWins.includes(item.id);
    const rows = [{ label: "Open", onClick: () => openTab(item.id) }];
    if (winOpen) {
      rows.push({ label: "Close", onClick: () => closeAppWindow(item.id) });
    }
    if (STUDIO_DOCK_HIDEABLE.has(item.id)) {
      const hidden = hiddenDockIds.includes(item.id);
      rows.push(
        { separator: true },
        hidden
          ? { label: "Keep in Dock", onClick: () => keepInDock(item.id) }
          : { label: "Remove from Dock", onClick: () => hideFromDock(item.id) },
      );
    }
    rows.push(
      { separator: true },
      { label: "Chat with LYKN", onClick: () => openLyknChat() },
    );
    return rows;
  };

  const minimizedFileWins = fileWins.filter(
    (entry) => appWins.includes(entry.id) && minimized[entry.id],
  );

  const wallpaperDim = appearance.wallpaperDim / 100;
  const wallpaperBlur = appearance.wallpaperBlur;

  return (
    <div
      ref={studioRootRef}
      className="fixed inset-0 overflow-hidden font-sans text-black/85 dark:text-white/85"
    >
      <StudioHoverTips rootRef={studioRootRef} />
      {/* Backdrop: the wallpaper picked in Settings › Appearance — one of
          Apple's, or any photo — else the app's own. A wallpaper carries a
          scrim (Appearance › Dim) so the chrome stays readable, and an optional
          blur. Otherwise: Glass (dark) in the vibrancy window stays transparent
          so the desktop blurs through; everywhere else — including Neutral,
          which is the regular opaque UI with no glass at all — we paint our own
          solid backdrop. */}
      {bgImage ? (
        <div aria-hidden className="absolute inset-0 overflow-hidden">
          <img
            src={bgImage}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
            style={{
              filter: wallpaperBlur ? `blur(${wallpaperBlur}px)` : undefined,
              // Blur samples past the edges; scale up so it can't feather into
              // a pale border around the desktop.
              transform: wallpaperBlur ? "scale(1.06)" : undefined,
            }}
          />
          <div
            className="absolute inset-0"
            style={{
              background: dark
                ? `rgba(10,11,14,${wallpaperDim})`
                : `rgba(236,236,235,${wallpaperDim * 0.67})`,
            }}
          />
        </div>
      ) : (
        (!glassWindow || !dark) && (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              // Neutral is the regular app background — flat, no glass.
              background: dark
                ? "radial-gradient(120% 90% at 20% 0%, #2a2d36 0%, #17181d 55%, #0c0d10 100%)"
                : "#ececeb",
            }}
          />
        )
      )}

      <div
        // Padding snaps with the window resize — animating it against
        // macOS simple-fullscreen makes chrome lag behind the frame.
        className={`relative z-10 flex h-full flex-col items-center ${
          // Fullscreen covers the whole display, so the top row must clear
          // the camera notch / menu-bar strip for this display
          // (`--lykn-display-top-inset`, measured from the work area).
          // Split View hides the dock and runs panes to the bottom edge.
          fullscreen ? "lykn-studio-fs-pad px-2 pb-2" : split ? "px-5 pb-2 pt-4" : "px-5 pb-4 pt-4"
        }`}
      >
        {/* ── Main glass panel ── */}
        <div
          className={`flex w-full flex-1 min-h-0 items-stretch ${
            fullscreen ? "max-w-full" : "max-w-[1240px]"
          }`}
        >
          {/* Center panel. On Home it's fully transparent — a blank macOS-style
              desktop where only the wallpaper shows through. Every other tab
              gets the frost card; embedded section frames paint their own
              opaque app background inside it. */}
          <div className="relative flex-1 min-w-0 overflow-hidden">
            {/* Home desktop widgets — always mounted so closing a stage app
                can reveal them instead of snapping the wallpaper back in.
                They stay put during a home conversation (homeChat) — the
                transparent chat surface simply layers over them. */}
            <div
              ref={setDesktopLayer}
              className={`lykn-studio-desktop absolute inset-0 ${
                tab === "dashboard" && !split ? "" : "is-dimmed"
              } ${wallpaperArmed ? "lykn-desktop-drop" : ""}`}
              aria-hidden={tab !== "dashboard" || !!split}
            >
                <DesktopLayerProvider layer={desktopLayer}>
                <DesktopSelectProvider>
                {/* Behind the widgets: right-click for the desktop context
                    menu (New Folder, Open LYKN Glass, open a folder/page);
                    folders drag around like real desktop icons. */}
                <DesktopFolders
                  onOpen={openTab}
                  onEmptyClick={() => setDesktopPeek((p) => !p)}
                  onEditWidgets={() => setWidgetsEditing(true)}
                />
                {/* The real Mac desktop, mirrored on top of the folder layer
                    when Settings → Display → Sync my Desktop is on. */}
                <MacDesktopMirror onOpen={openTab} />
                {/* Widgets: each one wherever the user parked it, at the size
                    they chose. Hold one (or right-click → Edit Widgets) to
                    rearrange. */}
                <WidgetCanvas
                  userId={user?.id}
                  onOpen={openTab}
                  editing={widgetsEditing}
                  onEditingChange={setWidgetsEditing}
                />
                {/* Free-floating desktop icon — drag it anywhere; the spot
                    sticks. It positions against this panel (offsetParent). */}
                {showFilesWidget && <FilesWidget onOpen={openTab} />}
                {showVaultFolder && <VaultFolderWidget onOpen={openTab} />}
                {/* Only speaks up when a drop needs explaining — it failed, or
                    it just turned the Desktop mirror on. */}
                {dropNote && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-28 flex justify-center">
                    <span className="rounded-full bg-black/65 px-3.5 py-1.5 text-[0.75rem] text-white/90 shadow-lg backdrop-blur">
                      {dropNote}
                    </span>
                  </div>
                )}
                <StudioUpdateBanners
                  onOpenAccount={() => openTab("settings", "account")}
                />
                </DesktopSelectProvider>
                </DesktopLayerProvider>
            </div>
            {/* Chat is NOT in this list — it's hosted full-bleed over the
                whole desktop (below, outside this inset panel) so no panel
                edges/corners ever show around a home conversation. */}
            <StudioPop
              open={tab !== "dashboard" && !split}
              stay
              // The card itself stays click-through: every section is mounted
              // in here at once and `.lykn-studio-page.is-active` hands hits to
              // whichever one is showing. Taking them at this level instead
              // would put a sheet of glass over the inactive pages.
              hit={false}
              className={`absolute inset-0 overflow-hidden rounded-[2.2rem] shadow-[0_24px_80px_rgba(0,0,0,0.28)] ${FROST_PANEL}`}
            >
              {SECTIONS.filter(
                (s) =>
                  s.src &&
                  s.id !== "chat" &&
                  visited[s.id] &&
                  !(split && splitHasApp(split, s.id)),
              ).map(({ id, src }) => (
                <div
                  key={id}
                  className={`lykn-studio-page absolute inset-0 h-full w-full overflow-y-auto scrollbar-hide ${
                    tab === id ? "is-active" : ""
                  }`}
                  // The transform makes this wrapper the containing block for
                  // position:fixed INSIDE the page (toolbars, docks, overlays),
                  // so they anchor to the panel exactly like the old iframe
                  // viewport instead of floating over the studio rail/chrome.
                  style={{ transform: "translateZ(0)" }}
                >
                  <StudioSurface entry={frameSrc[id] || src} />
                </div>
              ))}
            </StudioPop>

          </div>
        </div>

        {/* ── Home chat layer — the chat surface hosted full-bleed over the
            entire desktop (window-anchored, NOT inside the inset panel, so
            no panel edges or corners show). Warm once visited; hidden on
            other tabs and on the idle desktop. --mobile-tabbar-clear lifts
            the chat's content above the dock + rounded bar. ── */}
        {visited.chat && !splitHasApp(split, "chat") && (
          <StudioPop
            open={tab === "dashboard" && homeChat && !splitHasApp(split, "chat")}
            stay
            hit={false}
            className="lykn-home-chat-host absolute inset-0 z-20 overflow-hidden"
            // The pop transform is the containing block for position:fixed
            // inside the chat page. no-drag punches the live chat out of the
            // desktop's window-drag region — otherwise its buttons lose clicks
            // to the drag region. Only while live, so the idle desktop still
            // drags by the wallpaper.
            style={{
              WebkitAppRegion:
                tab === "dashboard" && homeChat ? "no-drag" : undefined,
              "--mobile-tabbar-clear": "8.75rem",
            }}
          >
            <StudioSurface entry={frameSrc.chat || "/app"} />
          </StudioPop>
        )}
        {/* ── Home app windows — Browser / Calendar / To-dos / Settings as
            floating macOS-style windows over the desktop (and over a live
            conversation).
            Window-anchored like the chat layer, over the home chat bar / mode
            pill / welcome headline (z-22) but under the dock (z-30) so the
            chrome always stays clickable — unless a zoomed
            installed app is covering the dock, in which case this layer lifts
            above the strip. The layer itself is click-through; only the
            windows take pointer events. Windows stay mounted on other tabs so
            their state (and any open form) survives a trip to Projects and
            back. ── */}
        {appWins.length > 0 && (
          <div
            className={`pointer-events-none absolute inset-0 ${
              coveringZoom ? "z-[35]" : "z-[25]"
            }`}
          >
            {appWins.map((id, i) => {
              const app = windowAppFor(id);
              // An app uninstalled from another window can leave its id here
              // for the render between the broadcast and the state catching up.
              if (!app) return null;
              return (
                <DesktopAppWindow
                  key={id}
                  title={app.label}
                  icon={app.icon}
                  storageKey={`lykn_app_window:${id}`}
                  width={app.width}
                  height={app.height}
                  cascade={i}
                  z={i + 1}
                  active={i === appWins.length - 1}
                  hidden={tab !== "dashboard" || !!split}
                  minimized={!!minimized[id]}
                  peeked={desktopPeek}
                  fill={fillWin === id}
                  onFillEnd={() => setFillWin((f) => (f === id ? null : f))}
                  onFocus={() => focusAppWindow(id)}
                  onMinimize={() => setMinimized((m) => ({ ...m, [id]: true }))}
                  onClose={() => closeAppWindow(id)}
                  onTile={(side) => tileWindow(id, side)}
                  onSnapHint={setSnapHint}
                  // Browser tab strip and Settings sidebar each draw their
                  // own traffic lights and drag the frame through `controls`.
                  chromeless={!!(app.native || app.chromeless)}
                  titleTrailing={
                    id === "bots" ? (
                      <BotsActivityButton
                        onClick={() =>
                          window.dispatchEvent(new Event(BOTS_TOGGLE_ACTIVITY))
                        }
                      />
                    ) : null
                  }
                  controls={
                    app.native
                      ? browserControls
                      : id === "settings"
                        ? settingsControls
                        : undefined
                  }
                  // Zoomed, the Browser, Projects, and installed apps fill
                  // over the dock. Native Browser views already paint above
                  // every React layer; Projects and installed apps render
                  // in-page, so the window layer lifts above the dock while
                  // they're zoomed. The Browser also hides the dock itself
                  // so its z-30 cannot poke through the agent rail.
                  zoomCoversDock={
                    !!(app.native || app.installed || app.file || id === "projects")
                  }
                  onZoomChange={
                    app.native
                      ? setBrowserZoomed
                      : app.installed || app.file || id === "projects"
                        ? (on) =>
                            setDockCover((m) =>
                              m[id] === on ? m : { ...m, [id]: on },
                            )
                        : undefined
                  }
                  // Dragging moves the native browser views with the frame.
                  onGeometry={app.native ? reportBrowserBounds : undefined}
                  // …and the frame's open/close/minimize animations park them
                  // until it settles (CSS can't scale a native view).
                  onAnimating={app.native ? onBrowserAnimating : undefined}
                >
                  {split ? null : app.file ? (
                    <FileWindowContent
                      source={app.file}
                      onAskedLykn={() => closeAppWindow(id)}
                    />
                  ) : app.installed ? (
                    <InstalledAppFrame appId={app.appId} url={appWindowUrl(app.appId)} />
                  ) : app.native ? (
                    <StudioBrowserBody
                      hostRef={browserHostRef}
                      desktop={desktop}
                      shot={browserShot}
                      docked={browserDocked}
                      chromeHeight={browserChromeH}
                      railOpen={railAttachedOpen}
                      onAttachedBarChange={setRailAttachedOpen}
                    />
                  ) : id === "settings" ? (
                    <SettingsModal
                      embedded
                      isOpen
                      initialView={settingsView}
                      onClose={() => {
                        if (typeof settingsControls.current?.close === "function") {
                          settingsControls.current.close();
                        } else {
                          closeAppWindow("settings");
                        }
                      }}
                      windowControls={settingsControls}
                    />
                  ) : (
                    <StudioSurface entry={frameSrc[id] || app.src} windowed />
                  )}
                </DesktopAppWindow>
              );
            })}
          </div>
        )}
        {snapHint && !split && (
          <div
            aria-hidden
            className={`lykn-split-snap lykn-split-snap-${snapHint}`}
          />
        )}
        {split && (
          <StudioSplit
            split={split}
            apps={SPLIT_APPS}
            onFocus={(index) => setSplit((s) => (s ? { ...s, focus: index } : s))}
            onClosePane={closeSplitPane}
            onFill={fillSplitPane}
            onPick={pickSplitApp}
            onRatio={setSplitRatio}
            onExpandQuad={expandSplitQuad}
            renderApp={(id) => {
              if (id === "browser") {
                return (
                  <StudioBrowserBody
                    hostRef={browserHostRef}
                    desktop={desktop}
                    shot={browserShot}
                    docked={browserDocked}
                    chromeHeight={browserChromeH}
                    railOpen={railAttachedOpen}
                    onAttachedBarChange={setRailAttachedOpen}
                  />
                );
              }
              if (id === "settings") {
                const index = splitCells(split).indexOf("settings");
                return (
                  <SettingsModal
                    embedded
                    isOpen
                    initialView={settingsView}
                    onClose={() => closeSplitPane(index >= 0 ? index : 0)}
                  />
                );
              }
              const win = windowAppFor(id);
              if (win?.installed) {
                return <InstalledAppFrame appId={win.appId} url={appWindowUrl(win.appId)} />;
              }
              if (win?.src) {
                return <StudioSurface entry={frameSrc[id] || win.src} windowed />;
              }
              if (id === "chat") {
                return (
                  <StudioChatPane
                    entry={frameSrc.chat || "/app"}
                    live={homeChatLive}
                    view={homeView}
                    onOpen={openTab}
                    name={user ? firstName : ""}
                  />
                );
              }
              const section = SECTIONS.find((s) => s.id === id);
              if (section?.src) {
                return <StudioSurface entry={frameSrc[id] || section.src} />;
              }
              return (
                <div className="flex h-full items-center justify-center px-6 text-sm text-black/45 dark:text-white/45">
                  This app can’t open in Split View.
                </div>
              );
            }}
          />
        )}
        {/* Rounded chat bar + idle mode pill — window-anchored siblings of
            the chat layer so idle and live states line up exactly. Voice
            Mode is a popup, so this bar stays put. Imagine shares this
            bar with the other modes so typed text and attachments stay. */}
        {tab === "dashboard" &&
          !split &&
          !coveringZoom && (
          <HomeChatBar
            active={homeChat}
            live={homeChatLive}
            surfaceView={homeView}
            onOpen={openTab}
            name={user ? firstName : ""}
          />
        )}

        {/* ── Bottom dock — the studio sidebar, macOS style. Hidden in Split
            View and while a zoomed installed app covers this strip. Under a
            full-screen Browser it slides away rather than unmounting so the
            desktop layout (and every window's offsetParent box) never reflows. ── */}
        <StudioDock
          user={user}
          dark={dark}
          desktop={desktop}
          hidden={dockHidden}
          split={split}
          coveringZoom={coveringZoom}
          chatsOpen={chatsOpen}
          setChatsOpen={setChatsOpen}
          startNewChat={startNewChat}
          openTab={openTab}
          homeChat={homeChat}
          setHomeChat={setHomeChat}
          hiddenDockIds={hiddenDockIds}
          keepInDock={keepInDock}
          navActive={navActive}
          handleNavItem={handleNavItem}
          dockMenuFor={dockMenuFor}
          handleEditApp={handleEditApp}
          appWins={appWins}
          closeAppWindow={closeAppWindow}
          focusAppWindow={focusAppWindow}
          minimizedFileWins={minimizedFileWins}
        />
      </div>
    </div>
  );
}
