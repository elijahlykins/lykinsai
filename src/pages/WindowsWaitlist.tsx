import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import lyknLogoMark from "@/assets/FINAL/LYKN-LOGO-B-Open/SVG/LYKN-Logo-Primary-B-Open-BLACK.svg";
import LandingHeader from "@/components/landing/LandingHeader";
import { LyknWordmark } from "@/components/landing/LyknWordmark";
import { useLandingLightTheme } from "@/components/landing/useLandingLightTheme";
import { API_BASE_URL } from "@/lib/api-config";
import "./GlassLanding.css";
import "@/components/landing/landingIcy.css";
import "./DownloadLykn.css";
import "./WindowsWaitlist.css";

const JOINED_KEY = "lykn.windowsWaitlist.joined";
const WAITLIST_SEED = 2365;
const MAC_DOWNLOAD_URL =
  "https://github.com/elijahlykins/lykn-releases/releases/latest/download/LYKN.dmg";

function AppleGlyph() {
  return (
    <svg viewBox="0 0 384 512" fill="currentColor" aria-hidden="true">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

function readJoined(): boolean {
  try {
    return window.localStorage.getItem(JOINED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberJoined() {
  try {
    window.localStorage.setItem(JOINED_KEY, "1");
  } catch {
    /* private mode */
  }
}

function formatCount(n: number) {
  return n.toLocaleString("en-US");
}

/** /windows — coming-soon waitlist for the Windows desktop app. */
export default function WindowsWaitlist() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [total, setTotal] = useState(WAITLIST_SEED);

  useLandingLightTheme();

  useEffect(() => {
    window.scrollTo(0, 0);
    setJoined(readJoined());
    let cancelled = false;
    fetch(`${API_BASE_URL}/api/waitlist/windows`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const n = Number(data?.count);
        if (Number.isFinite(n) && n >= WAITLIST_SEED) setTotal(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || joined) return;
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE_URL}/api/waitlist/windows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, website: honeypot }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (res.status === 429) {
          setError("Too many tries. Give it a minute and try again.");
        } else {
          setError("Couldn't join right now. Try again in a moment.");
        }
        return;
      }
      rememberJoined();
      setJoined(true);
      const n = Number(data.count);
      if (Number.isFinite(n) && n >= WAITLIST_SEED) {
        setTotal(n);
      } else if (data.created) {
        setTotal((prev) => prev + 1);
      }
    } catch {
      setError("Couldn't reach LYKN. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-land dlp">
      <LandingHeader onBrandClick={() => navigate("/")} />

      <main className="dlp-stage">
        <section className="dlp-copy">
          <span
            className="dlp-brand"
            role="img"
            aria-label="LYKN"
            style={{ ["--dlp-mark" as string]: `url("${lyknLogoMark}")` }}
          />
          <h1 className="dlp-tag" aria-label="LYKN is coming to Windows">
            <LyknWordmark decorative /> is coming to Windows
          </h1>

          {joined ? (
            <p className="dlp-bar dlp-bar--done" role="status">
              You're on the waitlist
            </p>
          ) : (
            <form className="dlp-form" onSubmit={onSubmit} noValidate>
              <div className="dlp-hp" aria-hidden="true">
                <label htmlFor="wl-website">Website</label>
                <input
                  id="wl-website"
                  name="website"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>
              <div className="dlp-bar">
                <label className="dlp-sr" htmlFor="wl-email">
                  Enter your email to join the Windows waitlist
                </label>
                <input
                  id="wl-email"
                  className="dlp-bar-input"
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="Enter your email to join the Windows waitlist"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                  required
                />
                <button className="dlp-bar-join" type="submit" disabled={busy}>
                  {busy ? "Joining…" : "Join"}
                </button>
              </div>
              {error ? (
                <p className="dlp-form-error" role="alert">
                  {error}
                </p>
              ) : null}
            </form>
          )}

          <p className="dlp-count">Total waitlist {formatCount(total)}</p>

          <a className="dlp-btn" href={MAC_DOWNLOAD_URL}>
            <AppleGlyph />
            Download for Mac
          </a>
        </section>
      </main>
    </div>
  );
}
