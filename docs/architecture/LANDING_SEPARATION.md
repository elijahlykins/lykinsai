# Landing site separation

The public LYKN marketing site now has a standalone local repository:

`~/Desktop/LYKN Landing`

That project is independently installable and buildable.
It is not a git worktree of this repository.

## Current production state

Production still serves landing and the product app from this repository.

Do not delete landing-only code from this repo until:

1. The standalone landing repository is on GitHub.
2. Its own deployment is live.
3. The landing domain points at that deployment.
4. The product app remains reachable on its own host.

Until then, landing code here is temporary duplication.

## Landing-owned files still in this repo

These can be removed from the main app after DNS/deployment cutover, if they are no longer imported by product routes:

- `src/pages/GlassLanding.tsx` and `src/pages/GlassLanding.css`
- `src/pages/Pricing.jsx`
- `src/pages/DownloadLykn.tsx` and `src/pages/DownloadLykn.css`
- `src/pages/News.tsx`
- `src/pages/Templates.tsx` and `src/pages/Templates.css`
- `src/pages/CapabilityPage.tsx` and `src/pages/CapabilityPage.css`
- `src/components/landing/*`
- Marketing routes in `src/App.jsx` (`/`, `/landing`, `/glass`, `/pricing`, `/download`, `/news`, `/templates`, `/product/:capId`)

Legal pages (`/privacy`, `/terms`, `/cookies`, `/dpa`, `/support`) are also copied into the landing repo.
Confirm whether the product app still needs in-app copies before deleting them here.

Shared libraries such as `src/lib/pricing-config.js`, `src/lib/desktopHotkey.ts`, and `src/lib/analytics.js` are used by the product app too.
Do not delete those with the landing pages.
