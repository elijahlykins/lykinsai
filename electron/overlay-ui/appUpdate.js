export function attachAppUpdate({ reportHeight } = {}) {
  const el = document.getElementById("app-update");
  const titleEl = document.getElementById("app-update-title");
  const bodyEl = document.getElementById("app-update-body");
  const restartEl = document.getElementById("app-update-restart");
  if (!el || !window.lyknOverlay) return;

  function hide() {
    el.hidden = true;
    el.classList.remove("show");
    reportHeight?.();
  }

  function show(status) {
    const ready = Boolean(status?.ready);
    const downloading = Boolean(status?.downloading);
    if (!ready && !downloading) {
      hide();
      return;
    }
    const version = String(status?.pendingVersion || "").trim();
    if (titleEl) {
      titleEl.textContent = ready
        ? (version ? `LYKN ${version} is ready` : "LYKN update ready")
        : "Downloading update";
    }
    if (bodyEl) {
      bodyEl.textContent = ready
        ? "Restart to install. Your work is saved."
        : "This stays in the background.";
    }
    if (restartEl) restartEl.hidden = !ready;
    el.hidden = false;
    el.classList.add("show");
    reportHeight?.();
  }

  async function refresh() {
    if (typeof window.lyknOverlay.updateStatus !== "function") return;
    try {
      show(await window.lyknOverlay.updateStatus());
    } catch (_) {
      /* overlay can still run without updater IPC */
    }
  }

  restartEl?.addEventListener("click", () => {
    if (typeof window.lyknOverlay.installUpdate === "function") {
      void window.lyknOverlay.installUpdate();
    }
  });

  window.lyknOverlay.onUpdateStatus?.(show);
  window.lyknOverlay.onShown?.(() => {
    void refresh();
  });
  void refresh();
}
