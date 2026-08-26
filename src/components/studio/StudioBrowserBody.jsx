// Body of the floating Browser window — the surface the main process docks
// the native agent-browser views onto, the skeleton/screenshot stand-ins for
// the moments those views can't paint, and the agent rail beside them.
import { useEffect, useRef, useState } from "react";
import BrowserMark from "@/components/macdesktop/BrowserMark";
import StudioAgentRail from "@/components/studio/agentRail/StudioAgentRail";

/* The window frame is rounded 1.25rem (20px) and the views below are inset by
 * one 6px resize grip, so their corners have to curve that much tighter to sit
 * concentric with the frame's. Reported to the main process, which wears it on
 * the native views. */
export const BROWSER_VIEW_RADIUS = 14;
// Mirrors AGENT_STAGE_CHROME_DEFAULT in electron/main.cjs — how much room the
// native tab strip + nav row take above the page. The stage reports its real
// height (a favourites row makes it taller) and that arrives with the shot.
export const BROWSER_CHROME_HEIGHT = 82;
// Long enough to cover the slowest way the window leaves (DesktopAppWindow's
// 260ms peek slide; close and minimize are quicker) and no longer, so the
// browser's last picture is gone by the time it comes back.
const LEAVE_SHOT_MS = 320;

/** Stand-in for the browser while its native views can't paint: the window's
 *  open animation, and the moment after, before they first dock. Deliberately
 *  identical every time — the alternative, the browser as it last looked, made
 *  every open animate over different content and the handover to the live
 *  views read as a glitch. Geometry mirrors electron/agent-stage.html so the
 *  strip, the nav row and the seam below them land where the real ones will. */
function StudioBrowserSkeleton({ chromeHeight }) {
  return (
    <div aria-hidden className="absolute inset-0 flex flex-col overflow-hidden bg-white">
      <div
        className="flex flex-none flex-col border-b border-black/[0.08] bg-[#f3f2f0]"
        style={{ height: chromeHeight }}
      >
        {/* Tab strip: traffic lights, then the one open tab. */}
        <div className="flex h-[42px] flex-none items-center gap-2 pl-[13px] pr-2">
          <div className="h-3 w-3 flex-none rounded-full bg-black/[0.09]" />
          <div className="h-3 w-3 flex-none rounded-full bg-black/[0.09]" />
          <div className="h-3 w-3 flex-none rounded-full bg-black/[0.09]" />
          <div className="ml-1 flex h-[30px] w-[190px] flex-none items-center gap-[7px] rounded-lg bg-white px-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.08),0_2px_8px_rgba(0,0,0,0.06)]">
            <div className="h-3.5 w-3.5 flex-none rounded-[3px] bg-black/[0.08]" />
            <div className="h-2 flex-1 rounded-full bg-black/[0.07]" />
          </div>
        </div>
        {/* Nav row: round icon buttons, then the omnibox. */}
        <div className="flex h-10 flex-none items-center gap-1 px-2.5">
          <div className="h-7 w-7 flex-none rounded-full bg-black/[0.05]" />
          <div className="h-7 w-7 flex-none rounded-full bg-black/[0.05]" />
          <div className="h-7 w-7 flex-none rounded-full bg-black/[0.05]" />
          <div className="ml-1 h-7 flex-1 rounded-full bg-black/[0.05]" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
        <div className="h-12 w-12 rounded-2xl bg-black/[0.05]" />
        <div className="h-11 w-[min(460px,66%)] rounded-full bg-black/[0.05]" />
      </div>
    </div>
  );
}

/** Body of the floating Browser window: the surface the main process docks
 *  the native agent-browser views onto (tab strip, toolbar and page all
 *  render inside `hostRef`'s rect), with the agent rail beside it. The window
 *  frame supplies the card, so this fills it edge to edge. */
export default function StudioBrowserBody({
  hostRef,
  desktop,
  shot,
  docked,
  chromeHeight,
  homeChatLive,
  homeView,
  name,
  onAttachedBarChange,
}) {
  // The picture is strictly for leaving: the native views can't be scaled or
  // faded, so they step aside and this animates out in their place. It has to
  // expire with the animation that needed it, though. A window that leaves by
  // minimizing (or by the dock icon, or a peek) never unmounts, so it comes
  // back still holding the picture — and showing it then puts a stale, scaled
  // still of the browser on screen, ahead of the skeleton, ahead of the live
  // page. Three states deep, and the first two read as a blurry flash. Coming
  // back is the skeleton and nothing else.
  const [leaving, setLeaving] = useState(false);
  const wasDocked = useRef(false);
  useEffect(() => {
    if (docked) {
      wasDocked.current = true;
      setLeaving(false);
      return undefined;
    }
    // Undocked without ever having been docked: this window is opening, not
    // going anywhere.
    if (!wasDocked.current) return undefined;
    wasDocked.current = false;
    setLeaving(true);
    const t = setTimeout(() => setLeaving(false), LEAVE_SHOT_MS);
    return () => clearTimeout(t);
  }, [docked]);
  const showShot = leaving && !!(shot && (shot.chrome || shot.page));
  const showSkeleton = desktop && !showShot;
  return (
    // The native views paint above the page and would swallow the pointer, so
    // they're inset by the width of the frame's resize grips (6px) all round —
    // the tab strip runs to the top edge here, with no title bar above it.
    <div className="flex h-full w-full p-1.5">
      <div
        ref={hostRef}
        // Matching the native views' own rounding, so the frame's background
        // (not the underlay) shows through the curve of all four corners.
        className="relative min-w-0 flex-1 overflow-hidden"
        style={{ borderRadius: BROWSER_VIEW_RADIUS }}
      >
        {/* Underlay for the sliver of time before the native views paint. It
            matches the page they'll show rather than announcing itself: any
            mark or copy here reads as a placeholder screen flashing up in
            front of the browser. The web preview has no views at all, so that
            is the one case that does explain itself. */}
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-white text-black/45">
          {!desktop && (
            <>
              <BrowserMark className="h-9 w-9" />
              <p className="max-w-sm text-center text-sm">
                The LYKN browser is available in the desktop app.
              </p>
            </>
          )}
        </div>
        {showSkeleton && <StudioBrowserSkeleton chromeHeight={chromeHeight} />}
        {/* The browser as it last looked, standing in for the native views
            while the window closes, minimizes or slides out of the way — they
            can't be scaled or faded, so they leave and this animates in their
            place. The seam matches the layout's, chrome height and all. */}
        {showShot && (
          <div
            aria-hidden
            className="absolute inset-0 flex flex-col overflow-hidden bg-white"
          >
            {shot.chrome && (
              <img
                src={shot.chrome}
                alt=""
                draggable={false}
                style={{ height: shot.chromeHeight }}
                className="w-full flex-none object-cover object-top"
              />
            )}
            {shot.page && (
              <img
                src={shot.page}
                alt=""
                draggable={false}
                className="min-h-0 w-full flex-1 object-cover object-top"
              />
            )}
          </div>
        )}
      </div>
      <StudioAgentRail
        desktop={desktop}
        homeChatLive={homeChatLive}
        homeView={homeView}
        name={name}
        visible={docked}
        onAttachedBarChange={onAttachedBarChange}
      />
    </div>
  );
}
