import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import { openFileWindow } from "@/lib/files/fileWindows";
import type { FileMedia } from "@/lib/files/fileSource";

function mediaFor(artifact: ChatArtifact): FileMedia {
  if (artifact.kind === "image") return "image";
  if (artifact.kind === "video") return "video";
  return "html";
}

function mimeFor(media: FileMedia): string | null {
  if (media === "html") return "text/html";
  if (media === "image") return "image/png";
  if (media === "video") return "video/mp4";
  return null;
}

/** Open an already-made build in a movable file window with take-to-chat. */
export function openArtifactFileWindow(artifact: ChatArtifact): string {
  const media = mediaFor(artifact);
  let url = String(artifact.previewUrl || artifact.downloadUrl || "").trim();
  if (!url && artifact.srcDoc) {
    url = URL.createObjectURL(
      new Blob([artifact.srcDoc], { type: "text/html;charset=utf-8" }),
    );
  }
  return openFileWindow({
    name: artifact.title || "Artifact",
    url: url || undefined,
    mime: mimeFor(media),
    media,
    artifact,
  });
}
