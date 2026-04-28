# Save to LYKN — Browser Extension

A tiny MV3 extension that adds a "Save to LYKN" toolbar button and right‑click
menu to Chrome / Edge / Brave / Arc / Opera. It is **stateless** — it never
holds any auth tokens. It simply opens a tab at:

```
{LYKN_BASE}/share?url=<encoded URL>&title=<encoded title>
```

The LYKN SPA's `/share` route then uses the user's existing logged‑in session
to call `saveLinkToVault()` and route them back to `/vault`.

## What it does

- **Toolbar click** → opens a popup with the active tab's URL and a
  "Save to Vault" button.
- **Right‑click on a page** → "Save this page to LYKN".
- **Right‑click on a link** → "Save link to LYKN".
- **Right‑click on an image** → "Save image to LYKN".
- **Right‑click on a video** → "Save video to LYKN".

The destination URL is configurable in **Options** so you can point it at
`http://localhost:5173` during development or your production Vercel domain
in normal use.

## Installing during development

1. **Generate the icons (one‑time):**
   - Open `icons/generate-icons.html` in a browser.
   - Click each "Download" button and save each PNG into `icons/` next to
     `icon.svg` so you end up with `icon-16.png`, `icon-32.png`,
     `icon-48.png`, `icon-128.png`.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select this folder
   (`extensions/save-to-lykn`).
5. Pin the extension icon to the toolbar.
6. Click the icon → **Settings** and set the LYKN base URL:
   - Production: `https://lykn.io`
   - Local dev: `http://localhost:5173`

## How a save flows

```
[ Chrome tab on instagram.com/p/xyz ]
              │
              │ user clicks toolbar icon → "Save to Vault"
              ▼
[ background.js opens new tab at LYKN_BASE/share?url=... ]
              │
              ▼
[ /share route in LYKN SPA ]
   • If signed out → /login (with returnTo=/share?url=...)
   • If signed in → calls saveLinkToVault({ userId, url })
              │
              ▼
[ Existing pipeline ]
   • /api/unfurl produces oEmbed (IG / TikTok / FB / X / YouTube)
   • notes row inserted with source = "<platform>_drop"
   • Vault opens, new card appears
```

## Why no OAuth in the extension

We deliberately don't authenticate inside the extension. Every save piggybacks
on the user's existing browser session at `lykn.io`. That means:

- No tokens stored in extension storage.
- No CORS / preflight surface.
- New auth flows on the web app automatically apply to the extension.
- If the user is signed out, they hit the same login screen they already know.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest (permissions, icons, action, options page) |
| `background.js` | Service worker: context menus + toolbar handler + base URL resolution |
| `popup.html` / `popup.js` | Toolbar popup UI |
| `options.html` / `options.js` | Settings page (base URL config) |
| `icons/icon.svg` | Source SVG icon |
| `icons/generate-icons.html` | One‑off helper to rasterise the SVG into PNGs |

## Future enhancements

- Optional content‑script injection on Instagram / Pinterest / X to add a
  small "Save to LYKN" button next to the platform's own save / bookmark
  control.
- Toast notification on successful save without opening a new tab (would
  require the extension to talk directly to the LYKN backend with a token).
