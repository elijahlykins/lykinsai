import { useCallback, useEffect, useState } from "react";

const EMPTY = {
  currentVersion: "",
  pendingVersion: "",
  downloading: false,
  ready: false,
  packaged: false,
};

function desktopBridge() {
  if (typeof window === "undefined") return null;
  return window.lykn || null;
}

export function useDesktopUpdate() {
  const [status, setStatus] = useState(EMPTY);

  useEffect(() => {
    const lykn = desktopBridge();
    if (!lykn?.desktop) return undefined;
    let cancelled = false;
    if (typeof lykn.updateStatus === "function") {
      void lykn.updateStatus()
        .then((next) => {
          if (!cancelled && next && typeof next === "object") setStatus({ ...EMPTY, ...next });
        })
        .catch(() => {});
    }
    const off = lykn.onUpdateStatus?.((next) => {
      if (next && typeof next === "object") setStatus({ ...EMPTY, ...next });
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const install = useCallback(async () => {
    const lykn = desktopBridge();
    if (typeof lykn?.installUpdate !== "function") return { ok: false };
    return lykn.installUpdate();
  }, []);

  return {
    ...status,
    desktop: Boolean(desktopBridge()?.desktop),
    install,
  };
}
