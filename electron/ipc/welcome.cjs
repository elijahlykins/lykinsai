"use strict";

function registerWelcomeIpc(d) {
  const {
    app, BrowserWindow, WebContentsView, shell, globalShortcut, Menu, ipcMain,
    desktopCapturer, screen, systemPreferences, dialog, nativeImage, clipboard,
    Tray, session, Notification, powerMonitor, nativeTheme, protocol,
    net: electronNet,
  } = d.electron;
  const path = d.node.path;
  const { pathToFileURL } = d.node.url;
  const fs = d.node.fs;
  const fsSync = d.node.fsSync;
  const crypto = d.node.crypto;
  const http = d.node.http;
  const { execFile } = d.node.childProcess;
  const { IS_MAC, IS_WIN, GLASS_FALLBACK, APP_URL, APP_ORIGIN, API_BASE } = d.env;
  const localStore = d.localStore;
  const macFiles = d.macFiles;
  const chromeSync = d.chromeSync;
  const localSystem = d.localSystem;
  const appDock = d.appDock;
  const localApprovals = d.localApprovals;
  const ownedBrowserAct = d.ownedBrowserAct;
  const agentRecentVisits = d.agentRecentVisits;
  const { broadcastToAllWindows } = require("../services/initializeElectronServices.cjs");
  const overlayConstants = d.constants;
  const {
    OVERLAY_WIDTH, OVERLAY_MIN_HEIGHT, OVERLAY_BUBBLE, MENU_WIDTH, MENU_GAP,
    MENU_MIN_HEIGHT, MENU_MAX_HEIGHT, PICKER_WIDTH, PICKER_MIN_HEIGHT, PICKER_MAX_HEIGHT,
  } = overlayConstants;
  const createMainWindow = (...a) => d.createMainWindow(...a);
  const deliverAuthTokensToRenderer = (...a) => d.deliverAuthTokensToRenderer(...a);
  const mintDesktopAuthUrl = (...a) => d.mintDesktopAuthUrl(...a);
  const setLoginItemEnabled = (...a) => d.setLoginItemEnabled(...a);
  const signInWelcomeAccount = (...a) => d.signInWelcomeAccount(...a);
  const welcomeSupabaseAuthCreds = (...a) => d.welcomeSupabaseAuthCreds(...a);

  // "Get started" on the essentials page: apply the chosen options. The
  // renderer then completes the walkthrough in the same window.
  ipcMain.handle("lykn:welcome-get-started", (_e, opts = {}) => {
    if (opts.login) {
      setLoginItemEnabled(true);
    }
    if (opts.defaultBrowser) {
      try {
        app.setAsDefaultProtocolClient("http");
        app.setAsDefaultProtocolClient("https");
      } catch (e) {
        console.warn("[welcome] default browser:", e?.message);
      }
    }
    if (opts.dock && IS_MAC && app.isPackaged) {
      // Pin the .app to the Dock (persistent-apps plist + Dock restart).
      // Packaged only — in dev this would pin the bare Electron binary.
      try {
        const appBundle = path.resolve(process.execPath, "..", "..", "..");
        if (appBundle.endsWith(".app")) {
          const entry =
            `<dict><key>tile-data</key><dict><key>file-data</key><dict>` +
            `<key>_CFURLString</key><string>${appBundle}</string>` +
            `<key>_CFURLStringType</key><integer>0</integer>` +
            `</dict></dict></dict>`;
          execFile("defaults", ["write", "com.apple.dock", "persistent-apps", "-array-add", entry], (err) => {
            if (!err) execFile("killall", ["Dock"], () => {});
          });
        }
      } catch (e) {
        console.warn("[welcome] dock pin:", e?.message);
      }
    }
    return { ok: true };
  });

  // Past the reveal, drop from screen-saver level to a normal window. The
  // window still covers the screen; it just stops pinning itself.
  ipcMain.on("lykn:welcome-stage", (_e, stage) => {
    if (Number(stage) < 2) return;
    if (!d.welcomeWindow || d.welcomeWindow.isDestroyed()) return;
    d.welcomeWindow.setAlwaysOnTop(false);
    d.welcomeWindow.setVisibleOnAllWorkspaces(false);
    // The reveal used showInactive; from here on it's a real form window.
    d.welcomeWindow.focus();
  });

  ipcMain.handle("lykn:welcome-signup", async (_e, { email, password } = {}) => {
    const normalizedEmail = String(email || "").trim();
    const secret = String(password || "");
    try {
      const response = await fetch(`${API_BASE}/api/auth/signup-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, password: secret }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.ok) {
        return { ok: false, error: result?.error || "Could not create account." };
      }
      d.welcomeSignupSecret = { email: normalizedEmail, password: secret };
      return { ok: true };
    } catch (error) {
      console.warn("[welcome] signup:", error?.message || error);
      return { ok: false, error: "Couldn't reach LYKN. Check your connection and try again." };
    }
  });

  ipcMain.handle("lykn:welcome-signin", async (_e, { email, password } = {}) => {
    const creds = welcomeSupabaseAuthCreds();
    if (!creds) return { ok: false, error: "Sign-in is unavailable. Check your connection and try again." };
    try {
      const response = await fetch(`${creds.url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: creds.key },
        body: JSON.stringify({ email: String(email || "").trim(), password: String(password || "") }),
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok || !session?.access_token || !session?.refresh_token) {
        return { ok: false, error: session?.error_description || "Incorrect email or password." };
      }
      deliverAuthTokensToRenderer(session.access_token, session.refresh_token);
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't reach LYKN. Check your connection and try again." };
    }
  });

  // "Continue with Google": Google blocks OAuth in embedded windows, so the
  // round-trip runs in the system browser via /desktop-auth — the same flow
  // the main app uses. The session comes back through the loopback handoff
  // and deliverAuthTokensToRenderer pings the walkthrough to advance.
  ipcMain.handle("lykn:welcome-google", () => {
    const url = mintDesktopAuthUrl(`${APP_ORIGIN}/desktop-auth`);
    void shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("lykn:welcome-resend", async (_e, { email } = {}) => {
    try {
      const response = await fetch(`${API_BASE}/api/auth/signup-resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(email || "").trim() }),
      });
      const result = await response.json().catch(() => ({}));
      return response.ok && result?.ok
        ? { ok: true }
        : { ok: false, error: result?.error || "Could not resend code." };
    } catch {
      return { ok: false, error: "Couldn't reach LYKN. Check your connection and try again." };
    }
  });

  ipcMain.handle("lykn:welcome-verify", async (_e, { email, code } = {}) => {
    try {
      const response = await fetch(`${API_BASE}/api/auth/signup-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(email || "").trim(), code: String(code || "").trim() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result?.ok) {
        return { ok: false, error: result?.error || "Could not verify code." };
      }
      await signInWelcomeAccount();
      return { ok: true };
    } catch (error) {
      console.warn("[welcome] verify:", error?.message || error);
      return { ok: false, error: "Couldn't reach LYKN. Check your connection and try again." };
    }
  });

  // Import stage: Chromium browsers whose sessions can be securely synced.
  ipcMain.handle("lykn:welcome-browsers", () => {
    if (IS_MAC) {
      return chromeSync.detectBrowsers().map((browser) => ({
        id: browser.id,
        name: browser.name,
        profiles: chromeSync.listProfiles(browser).map((p) => ({
          dir: p.dir,
          name: p.name,
        })),
      }));
    }
    return [];
  });

  const welcomeProfileFile = () =>
    path.join(app.getPath("userData"), "welcome-profile.json");

  const readWelcomeProfile = () => {
    try {
      const profile = JSON.parse(fsSync.readFileSync(welcomeProfileFile(), "utf8"));
      return profile && typeof profile === "object" ? profile : {};
    } catch {
      return {};
    }
  };

  // Welcome-profile writes are merges — each stage adds what it learned.
  const mergeWelcomeProfile = (patch) => {
    const file = welcomeProfileFile();
    let profile = {};
    try {
      profile = JSON.parse(fsSync.readFileSync(file, "utf8"));
    } catch {
      /* fresh profile */
    }
    try {
      fsSync.writeFileSync(file, JSON.stringify({ ...profile, ...patch }, null, 2), "utf8");
    } catch (e) {
      console.warn("[welcome] profile store:", e?.message);
    }
  };

  // Import stage "Next": remember the chosen source browser — the actual
  // import runs later, once that feature lands.
  ipcMain.handle("lykn:welcome-import", (_e, browser) => {
    if (browser && typeof browser === "object") {
      mergeWelcomeProfile({
        importBrowser: String(browser.id || browser.browser || ""),
        importProfileDir: String(browser.profileDir || ""),
      });
    } else {
      mergeWelcomeProfile({ importBrowser: String(browser || "") });
    }
    return { ok: true };
  });

  // Logins stage: the user wants saved passwords brought over too.
  ipcMain.handle("lykn:welcome-import-logins", (_e, wanted) => {
    mergeWelcomeProfile({ importLogins: !!wanted });
    return { ok: true };
  });

  // Studio Mac dock pins — which local apps the user keeps on the dock strip.
  ipcMain.handle("lykn:mac-dock-pins-get", () => {
    try {
      const file = path.join(app.getPath("userData"), "welcome-profile.json");
      const profile = JSON.parse(fsSync.readFileSync(file, "utf8"));
      return { ok: true, pins: Array.isArray(profile.macDockPins) ? profile.macDockPins : [] };
    } catch {
      return { ok: true, pins: [] };
    }
  });
  ipcMain.handle("lykn:mac-dock-pins-set", (_e, { pins } = {}) => {
    const clean = (Array.isArray(pins) ? pins : [])
      .map((p) => String(p || ""))
      .filter(Boolean)
      .slice(0, 30);
    mergeWelcomeProfile({ macDockPins: clean });
    return { ok: true, pins: clean };
  });

  // Mac sync stage: persist the synced-folders allowlist and switch Local
  // Mode on — this is the consent moment for LYKN reading local files.
  ipcMain.handle("lykn:welcome-macsync", (_e, { syncAll, folders } = {}) => {
    const userData = app.getPath("userData");
    const cleanFolders = (Array.isArray(folders) ? folders : [])
      .map((f) => String(f || "").trim())
      .filter(Boolean)
      .slice(0, 100);
    const next = localSystem.writeMacSync(userData, {
      syncAll: syncAll === true,
      syncedFolders: syncAll === true ? [] : cleanFolders,
    });
    localSystem.writeLocalMode(userData, true);
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send("lykn:local-mode-changed", { enabled: true });
          win.webContents.send("lykn:mac-sync-changed", {
            enabled: true,
            syncAll: next.syncAll,
            syncedFolders: next.syncedFolders,
          });
        }
      } catch (_) {}
    }
    mergeWelcomeProfile({ macSync: { syncAll: next.syncAll, folders: next.syncedFolders } });
    return { ok: true };
  });

  // ── Studio background — synced from the Mac ───────────────────────────────
  // The user picks any image (or their current macOS wallpaper) and it becomes
  // the Studio backdrop. Everything is normalized to a JPEG in userData via
  // `sips` because macOS wallpapers are usually HEIC, which Chromium can't
  // render. Renderers get data URLs; live changes broadcast to all windows.
  const studioBgFile = () => path.join(app.getPath("userData"), "studio-background.jpg");
  const bgDataUrl = (file) => {
    try {
      const buf = fsSync.readFileSync(file);
      return buf.length ? "data:image/jpeg;base64," + buf.toString("base64") : "";
    } catch {
      return "";
    }
  };
  // maxPx 0 converts without resampling — sips would otherwise upscale sources
  // that are already smaller than the target.
  const bgConvert = (src, dest, maxPx) =>
    new Promise((resolve) => {
      execFile(
        "sips",
        [
          "-s", "format", "jpeg",
          "-s", "formatOptions", "85",
          ...(maxPx ? ["--resampleHeightWidthMax", String(maxPx)] : []),
          src,
          "--out", dest,
        ],
        { timeout: 15_000 },
        (err) => resolve(!err)
      );
    });
  const runBgOsa = (script) =>
    new Promise((resolve) => {
      execFile("osascript", ["-e", script], { timeout: 5000 }, (err, stdout) =>
        resolve(err ? "" : String(stdout || "").trim())
      );
    });
  const currentWallpaperPath = async () => {
    // System Events first; Finder as fallback (dynamic wallpapers sometimes
    // only answer through one of the two).
    const scripts = [
      'tell application "System Events" to get picture of current desktop',
      'tell application "Finder" to get POSIX path of (desktop picture as alias)',
    ];
    for (const script of scripts) {
      const out = await runBgOsa(script);
      if (out && fsSync.existsSync(out)) {
        try {
          if (fsSync.statSync(out).isFile()) return out;
        } catch (_) {}
      }
    }
    return "";
  };
  const broadcastBackground = (dataUrl, srcPath = "", id = "") => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send("lykn:background-changed", { dataUrl, path: srcPath, id });
        }
      } catch (_) {}
    }
  };
  ipcMain.handle("lykn:background-get", () => {
    // Which source produced it, so the wallpaper picker can mark its tile.
    const profile = readWelcomeProfile();
    return {
      ok: true,
      dataUrl: bgDataUrl(studioBgFile()),
      path: profile.studioBackgroundPath || "",
      id: profile.studioBackgroundId || "",
    };
  });

  // ── The wallpapers macOS ships (System Settings › Wallpaper) ──────────────
  // Apple keeps them in three places, so we read all three:
  //   • full-size stills sitting in /System/Library/Desktop Pictures
  //   • Solid Colors — tiny flat PNGs in a subfolder
  //   • everything else (Big Sur, Catalina, Ventura, the hello set…), which
  //     ships as a .madesktop stub whose only local image is a ~214px
  //     thumbnail. Those masters live in Apple's MobileAsset catalog and are
  //     fetched on demand, which is exactly what System Settings does when you
  //     click one.
  // Grid thumbnails always come from local files, so browsing needs no network.
  const SYSTEM_WALLPAPER_ROOT = "/System/Library/Desktop Pictures";
  const SYSTEM_THUMB_DIR = path.join(SYSTEM_WALLPAPER_ROOT, ".thumbnails");
  const DESKTOP_ASSET_CATALOG =
    "/System/Library/AssetsV2/com_apple_MobileAsset_DesktopPicture/com_apple_MobileAsset_DesktopPicture.xml";
  const WALLPAPER_EXT_RE = /\.(heic|heif|jpe?g|png|tiff?)$/i;
  const MIN_STILL_BYTES = 8 * 1024; // filters stub/preview art, not solid colors

  const wallpaperLabel = (file) => file.replace(WALLPAPER_EXT_RE, "");
  const wallpaperId = (name) =>
    crypto.createHash("sha1").update(String(name)).digest("hex").slice(0, 16);
  const wallpaperCacheFile = (id) =>
    path.join(app.getPath("userData"), "wallpaper-cache", `${id}.jpg`);

  /** id -> item, rebuilt by the list handler. The thumbnail and apply handlers
   *  resolve an id through this, so the renderer never hands us a path to read
   *  or a URL to fetch. */
  let systemWallpapers = new Map();

  const readWallpaperDir = async (dir, group, minBytes = MIN_STILL_BYTES) => {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return []; // folder doesn't exist on this macOS version
    }
    const items = [];
    for (const name of names) {
      if (name.startsWith(".") || !WALLPAPER_EXT_RE.test(name)) continue;
      if (/thumbnail/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (!stat.isFile() || stat.size < minBytes) continue;
      } catch {
        continue;
      }
      items.push({
        name: wallpaperLabel(name),
        group,
        source: full,
        thumbSource: full,
        thumbMax: 480,
      });
    }
    return items;
  };

  /* The catalog is an XML plist of flat dicts. plutil can't convert it to JSON
   * (it holds <data> checksums), and a plist library isn't worth shipping for
   * one file, so scan the Assets array directly. */
  const parseAssetCatalog = (xml) => {
    const keyed = xml.indexOf("<key>Assets</key>");
    if (keyed < 0) return [];
    const arrayStart = xml.indexOf("<array>", keyed);
    const arrayEnd = xml.indexOf("</array>", arrayStart);
    if (arrayStart < 0 || arrayEnd < 0) return [];
    const assets = [];
    for (const block of xml.slice(arrayStart, arrayEnd).matchAll(/<dict>([\s\S]*?)<\/dict>/g)) {
      const fields = {};
      const pair =
        /<key>([^<]+)<\/key>\s*(?:<(string|integer|real|data)>([\s\S]*?)<\/\2>|<(true|false)\s*\/>)/g;
      for (const m of block[1].matchAll(pair)) {
        fields[m[1]] = m[4] ? m[4] === "true" : m[3].trim();
      }
      assets.push(fields);
    }
    return assets;
  };

  const readCatalogWallpapers = async () => {
    let xml = "";
    try {
      xml = await fs.readFile(DESKTOP_ASSET_CATALOG, "utf8");
    } catch {
      return []; // no catalog: only the on-disk wallpapers are offered
    }
    const items = [];
    for (const asset of parseAssetCatalog(xml)) {
      const name = asset.DesktopPictureID || "";
      const base = asset.__BaseURL || "";
      const rel = asset.__RelativePath || "";
      if (!name || !base || !rel) continue;
      const thumbSource = path.join(SYSTEM_THUMB_DIR, `${name}.heic`);
      items.push({
        name,
        group: "pictures",
        url: `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`,
        sizeBytes: Number(asset._DownloadSize) || 0,
        // Apple's SHA-1 of the zip, so a bad object can't become a wallpaper.
        sha1:
          asset._MeasurementAlgorithm === "SHA-1" && asset._Measurement
            ? Buffer.from(asset._Measurement.replace(/\s+/g, ""), "base64").toString("hex")
            : "",
        thumbSource: fsSync.existsSync(thumbSource) ? thumbSource : "",
      });
    }
    return items;
  };

  const buildSystemWallpapers = async () => {
    // Solid colors are tiny by nature (a 128px flat PNG), hence the lower floor.
    const [pictures, colors, remote] = await Promise.all([
      readWallpaperDir(SYSTEM_WALLPAPER_ROOT, "pictures"),
      readWallpaperDir(path.join(SYSTEM_WALLPAPER_ROOT, "Solid Colors"), "colors", 0),
      readCatalogWallpapers(),
    ]);

    // Newer releases tuck a few full-size stills (e.g. Sonoma Horizon) inside
    // the hidden .wallpapers bundle alongside the .mov versions.
    const bundled = [];
    const bundleRoot = path.join(SYSTEM_WALLPAPER_ROOT, ".wallpapers");
    try {
      for (const dir of await fs.readdir(bundleRoot)) {
        bundled.push(
          ...(await readWallpaperDir(path.join(bundleRoot, dir), "pictures", 512 * 1024)),
        );
      }
    } catch {
      /* no bundle on this macOS version */
    }

    // Local first: a wallpaper already on disk needs no download, and several
    // (the iMac colors, Sonoma) appear in both places.
    const byName = new Map();
    for (const item of [...pictures, ...bundled, ...colors, ...remote]) {
      if (!byName.has(item.name)) byName.set(item.name, item);
    }
    // Colors last, pictures alphabetical — one grid, like System Settings.
    const ordered = [...byName.values()].sort((a, b) =>
      a.group === b.group
        ? a.name.localeCompare(b.name, undefined, { numeric: true })
        : a.group === "colors"
          ? 1
          : -1,
    );
    systemWallpapers = new Map(
      ordered.map((item) => [wallpaperId(item.name), { ...item, id: wallpaperId(item.name) }]),
    );
    return systemWallpapers;
  };

  const systemWallpaperById = async (id) => {
    if (!systemWallpapers.size) await buildSystemWallpapers();
    return systemWallpapers.get(String(id || "")) || null;
  };

  ipcMain.handle("lykn:background-system-list", async () => {
    const map = await buildSystemWallpapers();
    return {
      ok: true,
      items: [...map.values()]
        // A wallpaper with neither a local file nor a thumbnail has nothing to
        // show in the grid (light/dark variants of the dynamic sets).
        .filter((item) => item.source || item.thumbSource)
        .map((item) => ({
          id: item.id,
          name: item.name,
          group: item.group,
          needsDownload: !item.source && !fsSync.existsSync(wallpaperCacheFile(item.id)),
          sizeBytes: item.sizeBytes || 0,
        })),
    };
  });

  // Grid-sized preview, cached in userData: HEIC needs a sips pass before
  // Chromium can show it, and that pass is the slow part.
  ipcMain.handle("lykn:background-system-thumb", async (_e, id) => {
    const item = await systemWallpaperById(id);
    const src = item?.thumbSource || "";
    if (!src || !fsSync.existsSync(src)) return { ok: false, error: "no_thumbnail" };
    const cacheDir = path.join(app.getPath("userData"), "wallpaper-thumbs");
    const dest = path.join(cacheDir, `${item.id}.jpg`);
    if (!fsSync.existsSync(dest)) {
      try {
        await fs.mkdir(cacheDir, { recursive: true });
      } catch {
        /* the convert below will fail and the tile stays a placeholder */
      }
      // Apple's own preview art is already tile-sized; only full-size stills
      // need scaling down.
      if (!(await bgConvert(src, dest, item.thumbMax || 0))) {
        return { ok: false, error: "convert_failed" };
      }
    }
    return { ok: true, dataUrl: bgDataUrl(dest) };
  });

  // Stream Apple's asset zip to disk, hashing as it lands.
  const downloadWallpaperAsset = async (item, dest, onProgress) => {
    let res;
    try {
      res = await electronNet.fetch(item.url, { redirect: "follow" });
    } catch {
      return { ok: false, error: "offline" };
    }
    if (!res.ok || !res.body) return { ok: false, error: `http_${res.status || 0}` };
    const total = Number(res.headers.get("content-length")) || item.sizeBytes || 0;
    const hash = crypto.createHash("sha1");
    const handle = await fs.open(dest, "w");
    let received = 0;
    let lastTick = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await handle.write(value);
        received += value.byteLength;
        const now = Date.now();
        if (now - lastTick > 200) {
          lastTick = now;
          onProgress(received, total);
        }
      }
    } finally {
      await handle.close();
    }
    if (item.sha1 && hash.digest("hex") !== item.sha1) {
      return { ok: false, error: "checksum_mismatch" };
    }
    return { ok: true };
  };

  /** Unpack the asset and return its largest image — the master still sits at
   *  AssetData/<name>.heic, but the layout is Apple's to change. */
  const extractWallpaperImage = async (zipFile, dir) => {
    await new Promise((resolve) => {
      // ditto, not unzip: it's the tool that understands Apple's archives.
      execFile("ditto", ["-x", "-k", zipFile, dir], { timeout: 120_000 }, () => resolve());
    });
    let best = null;
    const walk = async (current, depth) => {
      if (depth > 3) return;
      let entries = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!WALLPAPER_EXT_RE.test(entry.name)) continue;
        try {
          const stat = await fs.stat(full);
          if (!best || stat.size > best.size) best = { path: full, size: stat.size };
        } catch {
          /* skip unreadable entries */
        }
      }
    };
    await walk(dir, 0);
    return best?.path || "";
  };

  ipcMain.handle("lykn:background-system-apply", async (e, id) => {
    const item = await systemWallpaperById(id);
    if (!item) return { ok: false, error: "unknown_wallpaper" };
    const send = (payload) => {
      try {
        if (!e.sender.isDestroyed()) {
          e.sender.send("lykn:background-progress", { id: item.id, ...payload });
        }
      } catch (_) {}
    };
    let workDir = "";
    try {
      if (item.source) {
        send({ phase: "applying" });
        if (!(await bgConvert(item.source, studioBgFile(), 2560))) {
          send({ phase: "error" });
          return { ok: false, error: "convert_failed" };
        }
      } else {
        // Downloaded masters are converted once and kept as a ready backdrop,
        // so picking the same wallpaper again never re-downloads 30MB.
        const cached = wallpaperCacheFile(item.id);
        if (!fsSync.existsSync(cached)) {
          workDir = path.join(app.getPath("temp"), `lykn-wallpaper-${item.id}`);
          await fs.rm(workDir, { recursive: true, force: true });
          await fs.mkdir(workDir, { recursive: true });
          const zip = path.join(workDir, "asset.zip");
          send({ phase: "downloading", received: 0, total: item.sizeBytes || 0 });
          const got = await downloadWallpaperAsset(item, zip, (received, total) =>
            send({ phase: "downloading", received, total }),
          );
          if (!got.ok) {
            send({ phase: "error" });
            return got;
          }
          send({ phase: "applying" });
          const image = await extractWallpaperImage(zip, path.join(workDir, "asset"));
          if (!image) {
            send({ phase: "error" });
            return { ok: false, error: "asset_empty" };
          }
          await fs.mkdir(path.dirname(cached), { recursive: true });
          if (!(await bgConvert(image, cached, 2560))) {
            send({ phase: "error" });
            return { ok: false, error: "convert_failed" };
          }
        } else {
          send({ phase: "applying" });
        }
        fsSync.copyFileSync(cached, studioBgFile());
      }
      const dataUrl = bgDataUrl(studioBgFile());
      mergeWelcomeProfile({
        studioBackground: "system",
        studioBackgroundPath: item.source || "",
        studioBackgroundId: item.id,
      });
      broadcastBackground(dataUrl, item.source || "", item.id);
      send({ phase: "done" });
      return { ok: true, dataUrl };
    } catch (err) {
      send({ phase: "error" });
      return { ok: false, error: err?.message || "apply_failed" };
    } finally {
      if (workDir) fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  // Small preview of the user's current macOS wallpaper (welcome stage card).
  ipcMain.handle("lykn:background-wallpaper-preview", async () => {
    const src = await currentWallpaperPath();
    if (!src) return { ok: false, error: "wallpaper_unavailable" };
    const tmp = path.join(app.getPath("temp"), "lykn-bg-wallpaper-preview.jpg");
    if (!(await bgConvert(src, tmp, 640))) return { ok: false, error: "convert_failed" };
    return { ok: true, dataUrl: bgDataUrl(tmp) };
  });
  // Native image picker; returns the chosen path plus a small preview.
  ipcMain.handle("lykn:background-pick-file", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      title: "Choose a background image",
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "heic", "heif", "webp", "tiff", "gif", "bmp"] },
      ],
    });
    if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
    const src = res.filePaths[0];
    const tmp = path.join(app.getPath("temp"), "lykn-bg-pick-preview.jpg");
    const preview = (await bgConvert(src, tmp, 640)) ? bgDataUrl(tmp) : "";
    return { ok: true, path: src, dataUrl: preview };
  });
  // Persist: source is "wallpaper" or an explicit image path.
  ipcMain.handle("lykn:background-set", async (_e, { source, path: srcPath } = {}) => {
    const src =
      source === "wallpaper" ? await currentWallpaperPath() : String(srcPath || "");
    if (!src || !fsSync.existsSync(src)) return { ok: false, error: "source_missing" };
    if (!(await bgConvert(src, studioBgFile(), 2560))) {
      return { ok: false, error: "convert_failed" };
    }
    const dataUrl = bgDataUrl(studioBgFile());
    mergeWelcomeProfile({
      studioBackground: source === "wallpaper" ? "wallpaper" : "custom",
      // Kept so the wallpaper picker can highlight the tile in use — the
      // converted JPEG itself says nothing about where it came from.
      studioBackgroundPath: src,
      studioBackgroundId: "",
    });
    broadcastBackground(dataUrl, src);
    return { ok: true, dataUrl };
  });
  ipcMain.handle("lykn:background-clear", () => {
    try {
      fsSync.unlinkSync(studioBgFile());
    } catch (_) {}
    mergeWelcomeProfile({
      studioBackground: "",
      studioBackgroundPath: "",
      studioBackgroundId: "",
    });
    broadcastBackground("");
    return { ok: true };
  });

  // Widgets stage: which widgets the Home desktop shows. The studio keeps
  // widget state in its own settings, so the picks travel with a stamp — the
  // renderer applies them once and later Settings edits stay put.
  const readHomeWidgets = () => {
    try {
      const file = path.join(app.getPath("userData"), "welcome-profile.json");
      const profile = JSON.parse(fsSync.readFileSync(file, "utf8"));
      const widgets =
        profile.homeWidgets && typeof profile.homeWidgets === "object"
          ? profile.homeWidgets
          : {};
      return { ok: true, widgets, stamp: Number(profile.homeWidgetsStamp) || 0 };
    } catch {
      return { ok: true, widgets: {}, stamp: 0 };
    }
  };
  ipcMain.handle("lykn:home-widgets-get", () => readHomeWidgets());
  ipcMain.handle("lykn:welcome-widgets", (_e, widgets = {}) => {
    const clean = {};
    for (const [id, on] of Object.entries(widgets || {})) {
      if (/^[a-zA-Z]{1,40}$/.test(id)) clean[id] = on === true;
    }
    const stamp = Date.now();
    mergeWelcomeProfile({ homeWidgets: clean, homeWidgetsStamp: stamp });
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send("lykn:home-widgets-changed", { widgets: clean, stamp });
        }
      } catch (_) {}
    }
    return { ok: true };
  });

  // Apps stage: the user's favorite apps as ready-made hot links for the
  // browser — { id, name, url, icon } each.
  ipcMain.handle("lykn:welcome-apps", (_e, apps) => {
    const clean = (Array.isArray(apps) ? apps : [])
      .filter((a) => a && typeof a === "object")
      .map((a) => ({
        id: String(a.id || "").slice(0, 100),
        name: String(a.name || "").slice(0, 80),
        url: String(a.url || ""),
        icon: String(a.icon || ""),
      }))
      .filter((a) => a.name && /^https:\/\//.test(a.url) && (!a.icon || /^https:\/\//.test(a.icon)))
      .slice(0, 24);
    mergeWelcomeProfile({ favoriteApps: clean, hotLinks: clean });
    return { ok: true };
  });

  // Privacy stage: tracker blocking + content-data sharing choices.
  ipcMain.handle("lykn:welcome-privacy", (_e, privacy = {}) => {
    mergeWelcomeProfile({
      blockTrackers: !!privacy.blockTrackers,
      shareContentData: !!privacy.shareContentData,
    });
    return { ok: true };
  });

  // Make LYKN Yours: theme, response, and chat-color picks. IDs match
  // Settings › Appearance / Assistant (`src/lib/appearance.js`).
  const WELCOME_ACCENTS = new Set([
    "snow", "sand", "sage", "mist", "ocean",
    "periwinkle", "orchid", "clay", "graphite",
  ]);
  const WELCOME_INKS = new Set([
    "default", "accent", "white", "ivory", "silver", "graphite", "charcoal",
    "blue", "sky", "teal", "green", "yellow", "orange", "red", "pink", "purple",
    "navy", "forest", "crimson", "rust", "plum",
  ]);
  const sanitizeWelcomeDesign = (prefs = {}) => {
    const patch = {};
    if (WELCOME_ACCENTS.has(prefs.accent)) patch.accent = prefs.accent;
    // Older walkthroughs stored a hex swatch — keep it so a mid-upgrade
    // profile still writes, but the renderer only applies named ids.
    if (typeof prefs.accent === "string" && /^#[0-9a-f]{6}$/i.test(prefs.accent)) {
      patch.accent = prefs.accent;
    }
    if (["dark", "light", "system", "auto"].includes(prefs.appearance)) {
      patch.appearance = prefs.appearance === "auto" ? "system" : prefs.appearance;
    }
    if (["concise", "medium", "detailed"].includes(prefs.responseLength)) {
      patch.responseLength = prefs.responseLength;
    }
    if (typeof prefs.userPrompt === "string") patch.userPrompt = prefs.userPrompt.slice(0, 1500);
    if (WELCOME_INKS.has(prefs.chatUserTextColor)) patch.chatUserTextColor = prefs.chatUserTextColor;
    if (WELCOME_INKS.has(prefs.chatBubbleColor)) patch.chatBubbleColor = prefs.chatBubbleColor;
    if (WELCOME_INKS.has(prefs.chatAiTextColor)) patch.chatAiTextColor = prefs.chatAiTextColor;
    if (["small", "default", "large", "xlarge"].includes(prefs.chatUserTextSize)) {
      patch.chatUserTextSize = prefs.chatUserTextSize;
    }
    if (["small", "default", "large", "xlarge"].includes(prefs.chatAiTextSize)) {
      patch.chatAiTextSize = prefs.chatAiTextSize;
    }
    if (["small", "default", "large", "xlarge"].includes(prefs.chatBarSize)) {
      patch.chatBarSize = prefs.chatBarSize;
    }
    if (["tail", "round", "pill", "rectangle", "leaf"].includes(prefs.chatBubbleShape)) {
      patch.chatBubbleShape = prefs.chatBubbleShape;
    }
    if (["soft", "rectangle", "slate", "leaf"].includes(prefs.chatBarShape)) {
      patch.chatBarShape = prefs.chatBarShape;
    }
    if (["arrow", "arrowRight", "plane", "return", "chevron", "sparkle"].includes(prefs.chatSendIcon)) {
      patch.chatSendIcon = prefs.chatSendIcon;
    }
    if (["default", "circle", "squircle", "rounded", "square"].includes(prefs.chatSendShape)) {
      patch.chatSendShape = prefs.chatSendShape;
    }
    return patch;
  };
  const readWelcomeDesign = () => {
    try {
      const profile = readWelcomeProfile();
      return {
        ok: true,
        stamp: Number(profile.welcomeDesignStamp) || 0,
        prefs: {
          accent: profile.accent,
          appearance: profile.appearance,
          responseLength: profile.responseLength,
          userPrompt: profile.userPrompt,
          chatUserTextColor: profile.chatUserTextColor,
          chatBubbleColor: profile.chatBubbleColor,
          chatAiTextColor: profile.chatAiTextColor,
          chatUserTextSize: profile.chatUserTextSize,
          chatAiTextSize: profile.chatAiTextSize,
          chatBarSize: profile.chatBarSize,
          chatBubbleShape: profile.chatBubbleShape,
          chatBarShape: profile.chatBarShape,
          chatSendIcon: profile.chatSendIcon,
          chatSendShape: profile.chatSendShape,
        },
      };
    } catch {
      return { ok: true, stamp: 0, prefs: {} };
    }
  };
  const broadcastWelcomeDesign = (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send("lykn:welcome-design-changed", payload);
        }
      } catch (_) {}
    }
  };
  ipcMain.handle("lykn:welcome-design-get", () => readWelcomeDesign());
  ipcMain.handle("lykn:welcome-prefs", (_e, prefs = {}) => {
    const patch = sanitizeWelcomeDesign(prefs);
    const stamp = Date.now();
    mergeWelcomeProfile({ ...patch, welcomeDesignStamp: stamp });
    broadcastWelcomeDesign({ prefs: { ...readWelcomeDesign().prefs }, stamp });
    return { ok: true };
  });

  // Done with the welcome stages. The studio has been loading hidden behind
  // the walkthrough since launch (createMainWindow boots
  // /studio?glass=1&walkthrough=1 and the walkthrough sign-in hands it the
  // session live) — DON'T reload it here: a reload restarts the whole app
  // boot and the reveal lands on the app's own loading screen. Just wait for
  // the existing load to settle (20s worst case), keep the loader up for at
  // least one full spinner cycle, then fade out — the closed handler reveals
  // the already-rendered studio.
  ipcMain.handle("lykn:welcome-finish", async () => {
    // The finish-stage logo reveal (lyknReveal*) runs a 4.5s cycle — never
    // fade out before one full pass, even if the studio is already ready.
    const MIN_LOADER_MS = 4650;
    const loaderShownAt = Date.now();
    try {
      const wc = d.mainWindow && !d.mainWindow.isDestroyed() ? d.mainWindow.webContents : null;
      if (wc && (wc.isLoading() || !wc.getURL())) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 20000);
          wc.once("did-finish-load", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (wc) {
        d.welcomeStudioPreloaded = true;
        console.log("[welcome] finish: revealing", wc.getURL() || "(no url)");
      }
    } catch {
      /* reveal whatever we have */
    }
    const hold = MIN_LOADER_MS - (Date.now() - loaderShownAt);
    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
    if (d.welcomeWindow && !d.welcomeWindow.isDestroyed()) {
      try {
        await d.welcomeWindow.webContents.executeJavaScript(
          'document.body.classList.add("leaving")',
          true,
        );
      } catch {
        /* fade is cosmetic */
      }
      setTimeout(() => {
        if (d.welcomeWindow && !d.welcomeWindow.isDestroyed()) d.welcomeWindow.close();
      }, 520);
    }
    return { ok: true };
  });

  ipcMain.on("lykn:welcome-open-privacy", () => {
    void shell.openExternal(`${APP_ORIGIN}/privacy`);
  });

  ipcMain.on("lykn:welcome-open-terms", () => {
    void shell.openExternal(`${APP_ORIGIN}/terms`);
  });
}

module.exports = { registerWelcomeIpc };
