// Landing-page localStorage keys (LandingPrototype only) and post-signup
// connect onboarding. App routes require auth — no guest handoff into the
// product.

export const PROTOTYPE_NEURONS_LS_KEY = "lykn_prototype_neurons";
export const PROTOTYPE_CHAT_LS_KEY = "lykn_prototype_chat";

export const CONNECT_ONBOARDING_DONE_LS_KEY = "lykn_connect_onboarding_done";

export const isConnectOnboardingDone = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CONNECT_ONBOARDING_DONE_LS_KEY) === "1";
  } catch {
    return false;
  }
};

export const markConnectOnboardingDone = (): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONNECT_ONBOARDING_DONE_LS_KEY, "1");
  } catch {
    // ignore quota / private-mode errors
  }
};

/** Wipe landing prototype + legacy guest session keys on sign-out. */
export const clearPrototypeState = (): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PROTOTYPE_NEURONS_LS_KEY);
    window.localStorage.removeItem(PROTOTYPE_CHAT_LS_KEY);
    window.localStorage.removeItem(CONNECT_ONBOARDING_DONE_LS_KEY);
    window.localStorage.removeItem("lykn_prototype_step");
  } catch {
    // ignore
  }
  try {
    window.sessionStorage.removeItem("lykn_prototype_vault_intro_played");
    window.sessionStorage.removeItem("lykn_prototype_grid_intro_played_v2");
    window.sessionStorage.removeItem("lykn_post_tour_guest_chat_count");
    window.sessionStorage.removeItem("lykn_guest_chat_session_count");
    window.sessionStorage.removeItem("lykn_wake_chat_preview_send_count");
    window.sessionStorage.removeItem("lykn_guest_chat_board_id");
    window.sessionStorage.removeItem("lykn_guest_chat_v1");
    window.sessionStorage.removeItem("lykn_prototype_grid_chat_v1");
  } catch {
    // ignore
  }
};
