import {
  GUEST_CHAT_SESSION_CAP,
  guestChatCapReached,
  isPrototypeFirstChatBoardId,
} from "@/lib/prototypeHandoff";

export { GUEST_CHAT_SESSION_CAP, guestChatCapReached };

export const GUEST_SIGN_IN_REQUIRED_EVENT = "lykn_guest_signin_required";

export const GUEST_CHAT_BOARD_ID_KEY = "lykn_guest_chat_board_id";

export type GuestSignInReason = "chat" | "new_chat" | "second_chat";

const SUBTITLES: Record<GuestSignInReason, string> = {
  chat: `Sign in to keep chatting — you've used your ${GUEST_CHAT_SESSION_CAP} free preview messages.`,
  new_chat: "Sign in to start another chat and save your work.",
  second_chat: "Sign in to open another chat — one free preview chat per visit.",
};

/** Full-screen sign-in blocker (SignInActionBlocker) for guests. */
export function requestGuestSignIn(reason: GuestSignInReason = "chat"): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(GUEST_SIGN_IN_REQUIRED_EVENT, { detail: { reason } }),
    );
  } catch {
    // ignore
  }
}

export function guestSubtitleForReason(reason: GuestSignInReason): string {
  return SUBTITLES[reason] ?? SUBTITLES.chat;
}

/** Stable id for the single guest preview chat (stored per browser tab). */
export function getOrCreateGuestChatBoardId(): string {
  if (typeof window === "undefined") {
    return "__guest_preview__";
  }
  try {
    const existing = window.sessionStorage.getItem(GUEST_CHAT_BOARD_ID_KEY);
    if (existing && typeof existing === "string" && existing.length > 0) {
      return existing;
    }
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(GUEST_CHAT_BOARD_ID_KEY, id);
    return id;
  } catch {
    return "__guest_preview__";
  }
}

/** Guests may only use `/app` or their one preview board (plus walkthrough demo). */
export function isGuestAllowedBoardRoute(boardId: string | undefined | null): boolean {
  if (!boardId) return true;
  if (isPrototypeFirstChatBoardId(boardId)) return true;
  return boardId === getOrCreateGuestChatBoardId();
}

export function clearGuestChatLimitState(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(GUEST_CHAT_BOARD_ID_KEY);
  } catch {
    // ignore
  }
}
