import { makeAttId } from "@/lib/lyknChat/chatAttachmentInput";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";
import type { SlashAppOption } from "./slashAppQuery";

export function focusedAttachmentFromSlashApp(option: SlashAppOption): FocusedChatAttachment {
  const logo = option.source === "connected" ? String(option.logoUrl || "") : "";
  return {
    id: makeAttId(),
    type: "app",
    url: logo,
    name: option.name,
    mime: "",
    size: 0,
    vaultTitle: option.name,
    appSource: option.source,
    appId: option.id,
    catalogId: option.catalogId,
    localPath: option.path,
    logoUrl: logo || undefined,
  };
}

export function homeBarAppChip(option: SlashAppOption) {
  return {
    id: option.id,
    kind: "app",
    name: option.name,
    source: option.source,
    appId: option.id,
    path: option.path || "",
    catalogId: option.catalogId || "",
    logoUrl: option.source === "connected" ? option.logoUrl || "" : "",
  };
}

export function overlayAppChip(option: SlashAppOption) {
  return {
    kind: "app",
    name: option.name,
    source: option.source,
    appId: option.id,
    path: option.path || "",
    catalogId: option.catalogId || "",
    logoUrl: option.source === "connected" ? option.logoUrl || "" : "",
  };
}
