/**
 * An installed app, running inside a desktop window.
 *
 * The app is real code on its own `lykn-app://` origin, so it can't just be
 * rendered into this page — it needs its own origin for storage and its own
 * preload for the bridge. A <webview> is the only embed that keeps both: an
 * <iframe> would drop the preload (subframes don't run one) and take the app's
 * database with it. Main pins the preload and partition in `will-attach-webview`,
 * so nothing here can weaken them.
 *
 * Because the guest is composited in the page rather than painted over it, the
 * window drags, resizes, and animates like every other one on the desktop — no
 * geometry has to be mirrored into the main process the way the Browser's
 * native views do.
 */

import { useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { onAppsChanged } from "@/lib/apps/installApp";

export default function InstalledAppFrame({ appId, url }) {
  const ref = useRef(null);
  const [state, setState] = useState("loading");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const onLoad = () => setState("ready");
    // A failed subresource reports here too, and would wipe out an app that is
    // otherwise running; only the main document going missing is a real failure.
    const onFail = (e) => {
      if (e.isMainFrame === false) return;
      // -3 is ABORTED, which is what a superseded navigation looks like.
      if (e.errorCode === -3) return;
      setState("failed");
      setDetail(e.errorDescription || `error ${e.errorCode}`);
    };
    const onGone = (e) => {
      setState("failed");
      setDetail(e?.reason === "crashed" ? "the app crashed" : e?.reason || "the app stopped");
    };

    el.addEventListener("did-finish-load", onLoad);
    el.addEventListener("did-fail-load", onFail);
    el.addEventListener("render-process-gone", onGone);
    el.addEventListener("crashed", onGone);
    return () => {
      el.removeEventListener("did-finish-load", onLoad);
      el.removeEventListener("did-fail-load", onFail);
      el.removeEventListener("render-process-gone", onGone);
      el.removeEventListener("crashed", onGone);
    };
  }, [appId]);

  const reload = () => {
    setState("loading");
    setDetail("");
    const el = ref.current;
    // A crashed guest has no page left to reload — reloading the tag's src is
    // what actually brings one back.
    if (el) el.src = url;
  };

  // Editing the app in Build mode reinstalls it under the same id, so a window
  // left open would otherwise keep running the previous build.
  useEffect(() => {
    return onAppsChanged((payload) => {
      if (payload?.action !== "install" || payload?.id !== appId) return;
      const el = ref.current;
      if (!el) return;
      setState("loading");
      try {
        el.reloadIgnoringCache();
      } catch {
        el.src = url;
      }
    });
  }, [appId, url]);

  return (
    <div className="relative h-full w-full bg-white dark:bg-[#1c1c1e]">
      <webview
        ref={ref}
        src={url}
        // eslint-disable-next-line react/no-unknown-property
        partition={`persist:lykn-app-${appId}`}
        className="h-full w-full"
        style={{ display: "flex" }}
      />
      {state === "loading" ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-white dark:bg-[#1c1c1e]">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-black/15 border-t-black/50 dark:border-white/15 dark:border-t-white/60" />
        </div>
      ) : null}
      {state === "failed" ? (
        <div className="absolute inset-0 grid place-items-center bg-white px-6 text-center dark:bg-[#1c1c1e]">
          <div>
            <p className="text-[13px] font-medium text-black/80 dark:text-white/85">
              This app stopped running
            </p>
            {detail ? (
              <p className="mt-1 text-[12px] text-black/50 dark:text-white/45">{detail}</p>
            ) : null}
            <button
              type="button"
              onClick={reload}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-[12px] text-black/75 transition-colors hover:bg-black/10 dark:bg-white/10 dark:text-white/80 dark:hover:bg-white/15"
            >
              <RotateCw className="h-3.5 w-3.5" />
              Reload
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
