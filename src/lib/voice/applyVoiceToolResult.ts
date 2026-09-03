/**
 * Client-side effects after a Voice tool returns: put generated work on
 * screen, open LYKN pages/settings, refresh project lists.
 */
import { openLyknMediaPop } from "@/lib/lyknMediaPop";
import { openStudioTab } from "@/lib/studioTabs";
import { emitProjectsChanged } from "@/lib/synthesis/projectLiveSync";

type VoiceDisplay = {
  kind?: string;
  url?: string;
  title?: string;
  media?: "image" | "video" | "audio" | "pdf" | "file";
  html?: string;
};

export function applyVoiceDisplay(display: unknown): void {
  if (!display || typeof display !== "object") return;
  const d = display as VoiceDisplay & { ok?: boolean; kind?: string };
  if (d.kind === "vault" && d.ok) {
    openLyknMediaPop({ type: "vault-payload", payload: display });
    return;
  }
  if (d.kind === "url" && typeof d.url === "string" && d.url) {
    openLyknMediaPop({
      type: "url",
      url: d.url,
      title: typeof d.title === "string" ? d.title : undefined,
      kind: d.media,
    });
    return;
  }
  if (d.kind === "html" && typeof d.html === "string" && d.html) {
    const blob = new Blob([d.html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    openLyknMediaPop({
      type: "url",
      url,
      title: typeof d.title === "string" ? d.title : "Document",
      kind: "file",
    });
  }
}

export async function applyVoiceToolClientEffects(
  name: string,
  output: Record<string, unknown>,
): Promise<void> {
  const display = output.display;
  if (display) {
    try { applyVoiceDisplay(display); } catch { /* ignore */ }
    try { delete output.display; } catch { /* ignore */ }
  }

  if (name === "open_settings" && output.ok !== false) {
    const section = typeof output.section === "string" ? output.section : undefined;
    openStudioTab("settings", section);
    return;
  }

  if (name === "open_app" && output.ok !== false && typeof output.id === "string" && output.id) {
    const kind = typeof output.kind === "string" ? output.kind : "";
    const src = typeof output.src === "string" ? output.src : undefined;
    const label = typeof output.label === "string" ? output.label : undefined;
    const folder = typeof output.folder === "string" ? output.folder : undefined;
    if (kind === "installed") {
      try {
        const { openInstalledApp } = await import("@/lib/apps/installApp");
        void openInstalledApp(output.id);
      } catch { /* ignore */ }
      return;
    }
    if (kind === "drive") {
      if (output.id !== "drive") {
        try {
          const { openAiDriveItem } = await import("@/lib/vault/openAiDriveItem");
          void openAiDriveItem({ noteId: output.id, title: label, folder });
        } catch { /* ignore */ }
      } else {
        openStudioTab("vault", src || "/vault?pane=drive");
      }
      return;
    }
    openStudioTab(output.id, src);
    return;
  }

  if (
    (name === "create_project" || name === "set_active_project" || name === "add_to_project")
    && output.ok !== false
  ) {
    const project = output.project as { id?: string } | undefined;
    emitProjectsChanged({
      projectId: typeof project?.id === "string" ? project.id : null,
    });
  }
}
