import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";
import GlassBackdrop from "@/components/landing/GlassBackdrop";
import LandingHeader from "@/components/landing/LandingHeader";
import "./GlassLanding.css";
import "./DownloadLykn.css";

// Copy sitting directly on the backdrop blends toward white as the wandering
// blue glow passes behind it (same treatment as the pricing page).
const MIX_TEXT_SELECTORS = [".dlp-tag", ".dlp-meta"];

// Direct download of the latest signed builds. electron-builder publishes to
// the public releases-only repo (see electron-builder.json "publish") with
// version-less artifact names, so these "latest" URLs always resolve to the
// newest build without the site needing to know the version.
const MAC_DOWNLOAD_URL =
  "https://github.com/elijahlykins/lykn-releases/releases/latest/download/LYKN.dmg";
const WIN_DOWNLOAD_URL =
  "https://github.com/elijahlykins/lykn-releases/releases/latest/download/LYKN-Setup.exe";

// Flip on after Windows code signing ships a production-ready installer.
const WINDOWS_DOWNLOAD_ENABLED = false;

// The rotating tail of the tagline: "Your AI for <word>". Cycles forever.
const ROTATE_WORDS = [
  "research",
  "development",
  "image gen",
  "ads",
  "project management",
  "writing",
  "design",
  "coding",
  "marketing",
  "data analysis",
  "presentations",
  "note-taking",
  "planning",
  "brainstorming",
  "everything",
];

type PlatformGuess = "mac" | "win" | "other";

function guessPlatform(): PlatformGuess {
  if (typeof navigator === "undefined") return "mac";
  const probe = `${(navigator as any).userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
  if (/(windows|win32|win64)/.test(probe)) return "win";
  if (/(linux|android|cros)/.test(probe)) return "other";
  // iPadOS reports MacIntel with touch — treat as other (no DMG).
  if (/ipad|iphone|ipod/.test(probe)) return "other";
  return "mac";
}

/** The Apple logo glyph for the Mac download button. */
function AppleGlyph() {
  return (
    <svg viewBox="0 0 384 512" fill="currentColor" aria-hidden="true">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

/** Windows logo mark for the Windows download button. */
function WindowsGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 5.5 10.5 4.4v7.1H3V5.5zm8.2-1.3L21 2.7v8.8h-9.8V4.2zM3 13.1h7.5v7.1L3 19.1v-6zm8.2 0H21v8.8l-9.8-1.4v-7.4z" />
    </svg>
  );
}

/** "Download LYKN" (/download) — poster shot with OS-aware primary CTA and
    the other desktop build as a secondary link. */
export default function DownloadLykn() {
  const navigate = useNavigate();
  const [platform] = useState<PlatformGuess>(guessPlatform);
  // Current + previous word so the swap can cross-fade: the old word slides
  // up and out while the new one slides up into place.
  const [words, setWords] = useState({ cur: 0, prev: -1 });

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // Advance the tagline word on a loop for as long as the page sits open.
  useEffect(() => {
    const id = setInterval(
      () =>
        setWords(({ cur }) => ({
          cur: (cur + 1) % ROTATE_WORDS.length,
          prev: cur,
        })),
      2200,
    );
    return () => clearInterval(id);
  }, []);

  // The swap container eases its width to fit each new word (rather than the
  // line snapping wider/narrower), measured off the incoming word.
  const wordRef = useRef<HTMLSpanElement>(null);
  const [wordW, setWordW] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (wordRef.current) setWordW(wordRef.current.offsetWidth);
  }, [words.cur]);

  const primaryIsWin = WINDOWS_DOWNLOAD_ENABLED && platform === "win";
  const showWinComingSoon = !WINDOWS_DOWNLOAD_ENABLED && platform === "win";
  const showDesktopNote = platform === "other";

  return (
    <div className="glass-land dlp">
      <LandingHeader onBrandClick={() => navigate("/")} />

      {/* The shared glass backdrop, same look and feel as the pricing page —
          the orb rises in from the bottom edge instead of dropping from the
          top, then wanders the same serpentine path. */}
      <GlassBackdrop
        mixTextSelectors={MIX_TEXT_SELECTORS}
        wander
        startAtBottom
      />

      <main className="dlp-stage">
        {/* Centered copy in the upper third, like the reference poster. */}
        <section className="dlp-copy">
          <img
            src={lyknLogo}
            alt="LYKN"
            className="dlp-brand"
            draggable={false}
          />
          <p className="dlp-tag">
            Your AI for{" "}
            <span
              className="dlp-tag-swap"
              style={wordW == null ? undefined : { width: wordW }}
            >
              {words.prev >= 0 && (
                <span
                  className="dlp-tag-word dlp-tag-word--out"
                  key={`out-${ROTATE_WORDS[words.prev]}`}
                  aria-hidden="true"
                >
                  {ROTATE_WORDS[words.prev]}
                </span>
              )}
              {/* Keyed so each word remounts and replays the slide-in. */}
              <span
                className="dlp-tag-word"
                key={ROTATE_WORDS[words.cur]}
                ref={wordRef}
              >
                {ROTATE_WORDS[words.cur]}
              </span>
            </span>
          </p>

          <div className="dlp-actions">
            {primaryIsWin ? (
              <>
                <a className="dlp-btn" href={WIN_DOWNLOAD_URL}>
                  <WindowsGlyph />
                  Download for Windows
                </a>
                <a className="dlp-btn dlp-btn--secondary" href={MAC_DOWNLOAD_URL}>
                  <AppleGlyph />
                  Download for Mac
                </a>
              </>
            ) : (
              <>
                <a className="dlp-btn" href={MAC_DOWNLOAD_URL}>
                  <AppleGlyph />
                  Download for Mac
                </a>
                {WINDOWS_DOWNLOAD_ENABLED ? (
                  <a className="dlp-btn dlp-btn--secondary" href={WIN_DOWNLOAD_URL}>
                    <WindowsGlyph />
                    Download for Windows
                  </a>
                ) : null}
              </>
            )}
          </div>

          <p className="dlp-meta">
            {primaryIsWin
              ? "Free to start · Windows 10 and later · 64-bit"
              : "Free to start · macOS 12 and later · Apple silicon & Intel"}
          </p>
          {showWinComingSoon && (
            <p className="dlp-meta" style={{ marginTop: 8 }}>
              Windows desktop is coming soon — use LYKN in your browser at
              lykn.io for now.
            </p>
          )}
          {showDesktopNote && (
            <p className="dlp-meta" style={{ marginTop: 8 }}>
              {WINDOWS_DOWNLOAD_ENABLED
                ? "Desktop builds are for Mac and Windows — on this device, use LYKN in your browser at lykn.io."
                : "The desktop app is available for Mac — on this device, use LYKN in your browser at lykn.io."}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
