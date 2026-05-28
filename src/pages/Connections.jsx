import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";

import { useAuth } from "@/lib/SupabaseAuth";
import ConnectionsAppGrid from "@/components/connections/ConnectionsAppGrid";
import CustomAgentsSection from "@/components/connections/CustomAgentsSection";
import VaultConnectionsToggle from "@/components/connections/VaultConnectionsToggle";
import {
  isPrototypeWalkthroughComplete,
  isWalkthroughLockActive,
  PROTOTYPE_STEP_EVENT,
  readPrototypeStep,
  writePrototypeStep,
} from "@/lib/prototypeHandoff";

// Connections page is the "app store" for LYKN — one unified grid of
// every connectable thing (AI tools + input tools) with a filter
// dropdown at the top, mirroring the Vault page's toolbar. Click any
// tile to connect / manage that app.
//
// The Vault ↔ Connections toggle is rendered as fixed chrome in the
// top-right corner so it stays anchored to the same screen position
// when toggling between /vault and /connections. Inline placement
// would visibly shift between the two pages because their content
// widths and centering can differ slightly.
//
// The companion surface is the Vault page's bottom dock, which shows
// the user's currently-connected apps so they can manage from there
// without switching pages.
//
// Walkthrough welcome card: third leg of the guided tour. The arrow
// at the bottom of the typewriter card advances the prototype step
// to "grid" (the chat surface) and navigates to /app, where
// OmniaGrid's own intro picks up. We mirror VaultNew's intro
// shape/cadence so the three cards (synthesis → vault → connections)
// read as a single chapter — same dark glass, same right-edge
// pinning, same arrow-driven hand-off — instead of three visually
// unrelated overlays.
export default function Connections() {
  const { user } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const onConnectionsRoute = pathname.startsWith("/connections");

  const [introShown, setIntroShown] = useState(false);
  const [introText, setIntroText] = useState("");
  const [introDone, setIntroDone] = useState(false);
  const introStartedRef = useRef(false);
  const isMountedRef = useRef(true);
  const typingTimerRef = useRef(null);
  const typingCancelRef = useRef(false);

  // Walkthrough lockdown gate — drives whether the top-right
  // Vault ↔ Connections toggle pill is allowed to render. Kept in
  // sync with same-tab `PROTOTYPE_STEP_EVENT` and cross-tab `storage`
  // events so the pill re-appears the moment the visitor finishes the
  // tour or signs in.
  const [walkthroughStepForLock, setWalkthroughStepForLock] = useState(() =>
    typeof window === "undefined" ? null : readPrototypeStep(),
  );
  useEffect(() => {
    const sync = () => setWalkthroughStepForLock(readPrototypeStep());
    window.addEventListener(PROTOTYPE_STEP_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PROTOTYPE_STEP_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    const dismissIfDone = () => {
      if (!isPrototypeWalkthroughComplete()) return;
      typingCancelRef.current = true;
      if (typingTimerRef.current) {
        window.clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      setIntroShown(false);
    };
    dismissIfDone();
    window.addEventListener(PROTOTYPE_STEP_EVENT, dismissIfDone);
    window.addEventListener("storage", dismissIfDone);
    return () => {
      window.removeEventListener(PROTOTYPE_STEP_EVENT, dismissIfDone);
      window.removeEventListener("storage", dismissIfDone);
    };
  }, []);
  const isPrototypeWalkthroughLocked = isWalkthroughLockActive(
    user?.id ?? null,
    walkthroughStepForLock,
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (user?.id) return;
    if (isPrototypeWalkthroughComplete()) return;
    // VaultConnectionsShell keeps BOTH /vault and /connections mounted
    // simultaneously (so the in-page toggle feels instant), which means
    // this component mounts the moment a visitor lands on /vault — long
    // before they're actually looking at the connections grid. If we
    // started typing on mount, the entire animation would play
    // invisibly behind the vault card and the user would arrive on
    // /connections to find a card with its arrow already lit. Gating
    // on `pathname.startsWith("/connections")` defers the intro until
    // the connections subtree is actually visible.
    if (!onConnectionsRoute) return;
    // One-shot per component lifetime — once the typewriter has run,
    // toggling back to /vault and forward to /connections doesn't
    // re-arm it (the user already saw the orientation card).
    if (introStartedRef.current) return;
    introStartedRef.current = true;

    const fullText =
      "This is your Connections page, where you wire LYKN into the AI tools you already use.\n\n" +
      "Connect ChatGPT, Claude, Gemini, Grok, and the rest, and every conversation you have with them gets grounded in your synthesis layer, so any AI you talk to answers as something custom-built for you, not a stranger trained on everyone.\n\n" +
      "Use LYKN outside of LYKN, right inside the interfaces you already live in.";

    const openTimer = window.setTimeout(() => {
      if (!isMountedRef.current) return;
      setIntroShown(true);
      setIntroText("");
      setIntroDone(false);
    }, 600);

    const startTypingTimer = window.setTimeout(() => {
      if (!isMountedRef.current) return;
      const words = fullText.split(" ").filter(Boolean);
      let i = 0;
      let current = "";
      const tick = () => {
        if (!isMountedRef.current) return;
        if (typingCancelRef.current) {
          setIntroText(fullText);
          setIntroDone(true);
          return;
        }
        current += (i === 0 ? "" : " ") + words[i];
        i += 1;
        setIntroText(current);
        if (i < words.length) {
          typingTimerRef.current = window.setTimeout(tick, 28);
        } else {
          typingTimerRef.current = null;
          setIntroDone(true);
        }
      };
      tick();
    }, 1100);

    return () => {
      window.clearTimeout(openTimer);
      window.clearTimeout(startTypingTimer);
      if (typingTimerRef.current) {
        window.clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onConnectionsRoute]);

  const dismissIntro = useCallback(() => {
    typingCancelRef.current = true;
    if (typingTimerRef.current) {
      window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    setIntroShown(false);
  }, []);

  const advanceToChat = useCallback(() => {
    dismissIntro();
    // Hand off to OmniaGrid's intro. We only bump the step forward if
    // the walkthrough is still earlier than "grid" — if the visitor
    // has already cycled through (e.g. they came back to /connections
    // from /app), we don't want to clobber a "done" state and replay
    // the chat intro.
    const cur = readPrototypeStep();
    if (cur === "synthesis" || cur === "vault") {
      writePrototypeStep("grid");
    }
    nav("/app");
  }, [dismissIntro, nav]);

  return (
    <>
      {/* Walkthrough lockdown: hide the Vault ↔ Connections pill while
          the visitor is being forced through the linear tour. See
          VaultNew.jsx for the matching gate on the vault side. */}
      {!isPrototypeWalkthroughLocked && (
        <div className="fixed top-3 left-0 right-0 z-[70] px-3 flex items-center justify-end pointer-events-none">
          <div className="pointer-events-auto">
            <VaultConnectionsToggle active="connections" />
          </div>
        </div>
      )}
      <main
        className="relative z-20 mx-auto w-full px-4 sm:px-6 lg:px-8 pt-16 pb-16"
        style={{ maxWidth: "1560px" }}
      >
        {/* Unified app-store grid: AI tools (Claude, ChatGPT, Cursor,
            …) and input tools (Gmail, Notion, Slack, …) as a single
            wall of same-shape tiles. The first two tiles in the AI
            Tools section are the universal "any MCP client" and
            "bring-your-own REST agent" cards — same visual treatment
            as every other tile, just pinned to the top so the honest
            "you only need ONE token" framing leads the page. See
            ConnectionsAppGrid for the universal-tile + subgroup
            mechanics. */}
        <ConnectionsAppGrid user={user} />
        {/* Bring-your-own outbound webhook registry. Sibling to the
            hero's "Build with the API" card — the hero is the discovery
            path ("here's your bearer + code snippets") and this section
            is the lifecycle path ("here are the agents you registered,
            pause / edit / delete"). Kept at the bottom so the page reads
            top-to-bottom as: connect → feed → push. */}
        <CustomAgentsSection user={user} />
      </main>

      {/* Walkthrough welcome card — mirrors the synthesis-layer + vault
          intro cards so the three-step tour reads as one continuous
          chapter. Pinned to the right edge (same as the vault intro)
          and pointer-events-none on the wrapper so the connection grid
          stays interactive underneath; the card re-enables pointer
          events for its own controls. */}
      {introShown && walkthroughStepForLock !== "done" && (
        <div className="fixed right-6 top-20 z-[9995] w-[min(88vw,18rem)]">
          <div
            className="pointer-events-auto relative rounded-2xl bg-[rgba(15,15,18,0.78)] backdrop-blur-md border border-white/10 px-4 py-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
            style={{
              animation:
                "vaultIntroCardIn 360ms cubic-bezier(0.22,1,0.36,1) both",
            }}
          >
            {/* Dismiss button intentionally removed — the walkthrough
                is a forced flow for guests, and the only way past the
                connections card is the arrow → /app hand-off (or
                signing in, which unmounts the card). See the matching
                comment on the synthesis-layer welcome card. */}
            <p className="text-[0.8rem] leading-relaxed text-white/80 whitespace-pre-wrap min-h-[7rem] pr-4">
              {introText}
              {!introDone && (
                <span aria-hidden="true" className="lykn-wake-cursor">
                  |
                </span>
              )}
            </p>
            {introDone && (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={advanceToChat}
                  className="rounded-full bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/40 text-blue-100 hover:text-white p-1.5 transition-colors"
                  aria-label="Next: Chat"
                  title="Next: Chat"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
