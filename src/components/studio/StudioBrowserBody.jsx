// Body of the floating Browser window — the surface the main process docks
// the native agent-browser views onto, the skeleton/screenshot stand-ins for
// the moments those views can't paint, and the agent rail beside them.
import { useEffect, useRef, useState } from "react";
import BrowserMark from "@/components/macdesktop/BrowserMark";
import StudioAgentRail from "@/components/studio/agentRail/StudioAgentRail";
import {
  BROWSER_CHROME_HEIGHT,
  BROWSER_TAB_STRIP_HEIGHT,
  BROWSER_VIEW_RADIUS,
} from "@/components/studio/browserPaneLayout";
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
        <div
          className="flex flex-none items-center gap-2 pl-[13px] pr-2"
          style={{ height: BROWSER_TAB_STRIP_HEIGHT }}
        >
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
  // Window is still on the desktop, but another window is in front. Native
  // views can't sit behind React, so they undock and this still stands in.
  frozen = false,
  chromeHeight = BROWSER_CHROME_HEIGHT,
  railOpen = false,
  onAttachedBarChange,
}) {
  // The picture stands in whenever native views can't paint: the window's
  // open animation, a close/minimize/peek, and the moment another window is
  // in front (views undock so that window can come forward). Coming back from
  // minimize still uses the skeleton, not this picture — a stale scaled
  // still of the browser would flash ahead of the live page.
  const [leaving, setLeaving] = useState(false);
  const wasDocked = useRef(false);
  useEffect(() => {
    if (docked) {
      wasDocked.current = true;
      setLeaving(false);
      return undefined;
    }
    // Another window is in front: keep the last picture, and leave the
    // "was docked" bit so a later minimize or peek can still play the leaving shot.
    if (frozen) return undefined;
    // Undocked without ever having been docked: this window is opening, not
    // going anywhere.
    if (!wasDocked.current) return undefined;
    wasDocked.current = false;
    setLeaving(true);
    const t = setTimeout(() => setLeaving(false), LEAVE_SHOT_MS);
    return () => clearTimeout(t);
  }, [docked, frozen]);
  const showShot = (leaving || frozen) && !!(shot && (shot.chrome || shot.page));
  const showSkeleton = desktop && !showShot;
  return (
    // The native views paint above the page and would swallow the pointer, so
    // they're inset by the width of the frame's resize grips (6px) all round —
    // the tab strip runs to the top edge here, with no title bar above it.
    <div className="flex h-full w-full p-1.5">
      <div
        className="lykn-browser-pane flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[#f3f2f0]"
        style={{ borderRadius: BROWSER_VIEW_RADIUS }}
      >
        <div
          ref={hostRef}
          // Chrome and the page both wear the frame curve. Open rail: left
          // corners only, so the pane meets the chat on a straight edge.
          className="relative min-w-0 flex-1 overflow-hidden"
          style={{
            borderRadius: railOpen
              ? `${BROWSER_VIEW_RADIUS}px 0 0 ${BROWSER_VIEW_RADIUS}px`
              : BROWSER_VIEW_RADIUS,
          }}
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
        {/* Electron clips native views with ONE uniform radius, so their right
            corners still curve when the rail is open. Back the corner notches
            with the chrome / page colors so the right edge reads flush against
            the chat instead of showing curved gaps. */}
        {railOpen && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 flex flex-col"
            style={{ width: BROWSER_VIEW_RADIUS }}
          >
            <div className="flex-none bg-[#f3f2f0]" style={{ height: chromeHeight }} />
            <div className="min-h-0 flex-1 bg-white" />
          </div>
        )}
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
          chromeHeight={chromeHeight}
          onAttachedBarChange={onAttachedBarChange}
        />
      </div>
    </div>
  );
}
