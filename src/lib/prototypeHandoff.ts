// Shared utilities for the landing prototype → main-app handoff.
//
// When a guest visits `/landing-prototype` and the AI learns something
// about them, the prototype writes the resulting neuron(s) to
// localStorage. The Synthesis Layer, sidebar, and vault all read from
// here so the rest of the app can render in a stripped-down "preview"
// state — no demo grids, no demo vault cards, no fake projects — until
// the user signs up.

export const PROTOTYPE_NEURONS_LS_KEY = "lykn_prototype_neurons";
export const PROTOTYPE_CHAT_LS_KEY = "lykn_prototype_chat";

// Set to "1" while the visitor is in the synthesis-layer "tour" — i.e.
// they clicked Get Started on the wake screen and were dropped into a
// pre-populated synthesis layer with sample neurons (NOT real neurons
// from a chat). The synthesis layer uses this to (a) render the welcome
// card explaining what they're looking at, (b) skip the "neuron forming"
// animation that's meant for a freshly-created real neuron, and (c)
// auto-orbit the camera for the first beat so the brain feels alive on
// arrival. Cleared the moment the visitor opens the "+" add-neuron menu
// (they've found the create-your-own affordance) or signs in / out.
export const PROTOTYPE_TOUR_MODE_LS_KEY = "lykn_prototype_tour_mode";

export interface PrototypeNeuron {
  id: string;
  kind: "identity" | "focus" | "goal" | "style";
  text: string;
  /**
   * Brief 1-sentence "why this became a neuron" supplied by the model
   * during the landing chat. Surfaced in the Synthesis Layer detail
   * panel so each neuron explains itself. Older sessions persisted
   * before this field existed will simply omit it.
   */
  reason?: string;
  /**
   * Which synthesis-layer category this neuron belongs to. Added when
   * the new "+" menu started letting guests author beliefs, concepts,
   * tags, etc. in addition to facts — without this we'd have to
   * collapse everything into the AI Learned cluster (the only
   * category the legacy chat-derived prototypes ever populated).
   * Older prototypes that pre-date this field simply omit it and
   * default-route to AI Learned, preserving the legacy walkthrough.
   */
  neuronType?: "fact" | "belief" | "concept" | "tag" | "perspective";
  /**
   * Per-type structured payload. Stashes every optional field the
   * unified neuron composer collects (rationale / story / additional
   * notes) so the preview brain can echo the user's full input back
   * at them inside the DetailPanel before they sign in.
   *
   *   • rationale → the composer's "Why" field (also the existing
   *                 lykn_beliefs.rationale column for signed-in users)
   *   • story     → the composer's "Story" field (long-form body;
   *                 maps to notes.content for perspectives + to
   *                 metadata.story for everything else server-side)
   *   • title     → only used for Perspectives, where the prototype
   *                 neuron's `text` is the story body and `title` is
   *                 the separate single-line headline
   *   • notes     → the composer's "Additional information" field;
   *                 maps to metadata.notes server-side
   *
   * Older prototypes that pre-date any of these fields simply omit
   * them; downstream consumers must handle absence gracefully.
   */
  extra?: {
    rationale?: string;
    story?: string;
    title?: string;
    notes?: string;
  };
  /**
   * 1-based index of this neuron in the order it was created. Lets
   * downstream surfaces show "1st neuron", "2nd neuron", etc. without
   * having to rethread the original order.
   */
  ordinal?: number;
  createdAt?: number;
}

export interface PrototypeChatTurn {
  role: "user" | "ai";
  content: string;
}

// Persist a fresh list of prototype neurons back to localStorage and
// notify same-window listeners. Kept tiny + side-effect-only so callers
// can compose it with whatever state shape they already use.
export const writePrototypeNeurons = (next: PrototypeNeuron[]): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROTOTYPE_NEURONS_LS_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private-mode errors
  }
};

// Append a guest-built neuron to localStorage and return the new list.
// Used by the synthesis-layer "+" menu when an unauthenticated visitor
// creates their first (free) neuron: we don't have a backend to
// persist to, but we do want the neuron to live in the preview brain
// until they sign in and we can sync it up. The ordinal is recomputed
// off the current list length so consecutive guest neurons (if we ever
// allow more than one) stay numbered correctly.
export const appendPrototypeNeuron = (n: Omit<PrototypeNeuron, "ordinal" | "createdAt"> & { ordinal?: number; createdAt?: number }): PrototypeNeuron[] => {
  const current = readPrototypeNeurons();
  const ordinal = n.ordinal ?? current.length + 1;
  const createdAt = n.createdAt ?? Date.now();
  const next = [...current, { ...n, ordinal, createdAt }];
  writePrototypeNeurons(next);
  return next;
};

export const readPrototypeNeurons = (): PrototypeNeuron[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROTOTYPE_NEURONS_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (n): n is PrototypeNeuron =>
        n &&
        typeof n === "object" &&
        typeof n.text === "string" &&
        n.text.length > 0,
    );
  } catch {
    return [];
  }
};

export const readPrototypeChat = (): PrototypeChatTurn[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROTOTYPE_CHAT_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is PrototypeChatTurn =>
        m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "ai") &&
        typeof m.content === "string" &&
        m.content.length > 0,
    );
  } catch {
    return [];
  }
};

// Lightweight check — true when the visitor has at least one neuron in
// localStorage from the landing prototype. Use this to gate any "preview
// mode" UI that should hide demo content while in the handoff.
export const hasPrototypeNeurons = (): boolean => {
  return readPrototypeNeurons().length > 0;
};

/* ------------------------------------------------------------------ */
/*  Synthesis-layer tour mode                                          */
/* ------------------------------------------------------------------ */

export const readPrototypeTourMode = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PROTOTYPE_TOUR_MODE_LS_KEY) === "1";
  } catch {
    return false;
  }
};

export const writePrototypeTourMode = (on: boolean): void => {
  if (typeof window === "undefined") return;
  try {
    if (on) {
      window.localStorage.setItem(PROTOTYPE_TOUR_MODE_LS_KEY, "1");
    } else {
      window.localStorage.removeItem(PROTOTYPE_TOUR_MODE_LS_KEY);
    }
  } catch {
    // ignore quota / private-mode errors
  }
};

// Arm the synthesis-layer tour. The tour itself is pre-populated NOT
// with sample neurons but with the five top-level "containers" of the
// brain (Chats, Vault, AI Learned, Beliefs, Concepts) — see
// `forceCategoryIds` in SynthesisLayer.tsx. We deliberately do NOT
// seed any individual neurons: the visitor should see the SHAPE of
// their future workspace, not a fake populated brain claiming to know
// things about them. Returns true when the flag was actually flipped
// (false if a real session is already in progress, in which case the
// tour overlay would lie about an already-populated layer).
export const seedTourNeurons = (): boolean => {
  if (typeof window === "undefined") return false;
  if (readPrototypeNeurons().length > 0) return false;
  writePrototypeTourMode(true);
  return true;
};

/* ------------------------------------------------------------------ */
/*  Walkthrough step state                                             */
/* ------------------------------------------------------------------ */

// Linear walkthrough the prototype guides a fresh visitor through:
//   "synthesis" — first neuron created on the landing page; the sidebar
//                 surfaces with the Synthesis Layer button glowing.
//   "vault"     — user has just seen the neuron form in the synthesis
//                 layer; the sidebar reopens with the Connections
//                 button glowing (route is /vault, sidebar label is
//                 "Connections" — the page now combines Connections +
//                 Vault as the two halves of long-term memory).
//   "grid"      — user has read the Connections intro; the sidebar
//                 reopens with the Chat button glowing as the third +
//                 final surface in the guided tour. The /app route
//                 ships with the canvas unplugged (GRID_DISABLED), so
//                 this step is purely a chat surface — the storage
//                 key stays spelled "grid" only to keep the linear
//                 step machinery (writePrototypeStep, sidebar glows,
//                 model defaults) untouched.
//   "done"      — walkthrough nudges are dismissed (e.g. user has
//                 read the chat intro, or signed in).
export type PrototypeStep = "synthesis" | "vault" | "grid" | "done";

// Pure-function helper for "is this visitor currently locked inside the
// guided walkthrough?" Lives next to the storage keys so components in
// any tree (sidebar, vault dock, top-of-page toggles, etc.) can answer
// the question without duplicating the gate logic.
//
// Callers pass `userId` from `useAuth()` so we don't have to thread the
// Supabase client into this module. Signed-in visitors are never
// locked; a `null` userId on its own isn't enough either — we also
// require the visitor to have actually entered the linear tour (step
// is set to one of the in-progress values). That keeps the rest of
// the app fully interactive for guests who haven't started the
// onboarding (e.g. someone landing directly on `/login`).
export const isWalkthroughLockActive = (
  userId: string | null | undefined,
  step: PrototypeStep | null,
): boolean => {
  if (userId) return false;
  return step === "synthesis" || step === "vault" || step === "grid";
};

export const PROTOTYPE_STEP_LS_KEY = "lykn_prototype_step";

// Session-scoped one-shot flag — set the first time the vault types
// out its LYKN intro chat for a guest in the prototype walkthrough,
// so refreshing /vault doesn't keep replaying it. Cleared by
// LandingPrototype whenever the walkthrough resets, so a brand-new
// first neuron always re-arms the intro for the next vault visit.
export const PROTO_VAULT_INTRO_SS_KEY = "lykn_prototype_vault_intro_played";

// Same idea as PROTO_VAULT_INTRO_SS_KEY but for the chat surface (`/app`)
// — stamped the first time the visitor clicks Finish on the chat
// walkthrough card, so a refresh of `/app` doesn't replay the tour.
// The key was bumped to `_v2` when the old chat-rail intro was
// replaced with a typewriter card: the old version stamped this key
// at the START of the intro (to avoid mid-typing replay on refresh),
// while the new version stamps it on Finish — same key, opposite
// semantics. Bumping makes the cutover clean and means any old
// sessions still in a tab automatically re-see the new tour beat.
export const PROTO_GRID_INTRO_SS_KEY = "lykn_prototype_grid_intro_played_v2";

// Same-window listeners (sidebar in particular) need a way to react to
// step changes without waiting for a `storage` event — those only fire
// across tabs. This event is dispatched by `writePrototypeStep`.
export const PROTOTYPE_STEP_EVENT = "lykn_prototype_step_changed";

export const readPrototypeStep = (): PrototypeStep | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROTOTYPE_STEP_LS_KEY);
    if (raw === "synthesis" || raw === "vault" || raw === "grid" || raw === "done") {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
};

export const writePrototypeStep = (step: PrototypeStep | null): void => {
  if (typeof window === "undefined") return;
  try {
    if (step === null) {
      window.localStorage.removeItem(PROTOTYPE_STEP_LS_KEY);
    } else {
      window.localStorage.setItem(PROTOTYPE_STEP_LS_KEY, step);
    }
    window.dispatchEvent(new CustomEvent(PROTOTYPE_STEP_EVENT, { detail: { step } }));
  } catch {
    // ignore quota / private-mode errors
  }
  // Walkthrough → default model coupling. We want the LYKN Fast
  // Reasoning tier selected through the guided walkthrough (so paid
  // users get a meatier preview reply), then drop onto LYKN Lite once
  // the tour finishes so casual follow-ups stay cheap. Each transition
  // only fires once because writePrototypeStep guards against same-step
  // writes upstream — see e.g. VaultNew's `step === "synthesis"` check.
  applyWalkthroughDefaultModel(step);
};

/* ------------------------------------------------------------------ */
/*  Default-model coupling                                              */
/*                                                                      */
/*  Side effect of `writePrototypeStep`: keeps the model picker's       */
/*  default in sync with the user's progress through the walkthrough.   */
/*  Lives next to the storage keys so all the walkthrough plumbing is   */
/*  in one file.                                                        */
/* ------------------------------------------------------------------ */
const SETTINGS_LS_KEY = "lykinsai_settings";
const SETTINGS_CHANGED_EVENT = "lykinsai_settings_changed";

// Per-step default model. Keep ids in sync with `MODEL_GROUPS` in
// `src/lib/modelCatalog.js` — anything written here must be a value the
// picker can render or the trigger will fall back to its placeholder.
//
// Connections + chat stay on LYKN Fast Reasoning so the guided
// walkthrough shows off real reasoning depth. Once the tour finishes
// we drop the user onto LYKN Lite (free-tier default) so every casual
// question after the tour stays cheap.
const STEP_DEFAULT_MODEL: Partial<Record<PrototypeStep, string>> = {
  vault: "lykn-fast",
  grid: "lykn-fast",
  done: "lykn-lite",
};

const applyWalkthroughDefaultModel = (step: PrototypeStep | null): void => {
  if (typeof window === "undefined" || step === null) return;
  const nextModel = STEP_DEFAULT_MODEL[step];
  if (!nextModel) return;
  try {
    const raw = window.localStorage.getItem(SETTINGS_LS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && parsed.aiModel === nextModel) {
      // Already on the right model — don't churn the event listeners.
      return;
    }
    const next = { ...(parsed || {}), aiModel: nextModel };
    window.localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
    // `storage` only fires cross-tab, so dispatch a synthetic same-tab
    // notification too — VaultNew listens to both.
    window.dispatchEvent(new Event("storage"));
  } catch {
    // ignore JSON / quota / private-mode errors
  }
};

/* ------------------------------------------------------------------ */
/*  Guest chat session cap                                              */
/*                                                                      */
/*  Hard ceiling on the number of LLM calls a guest can make from a    */
/*  single browser session. Server-side per-IP limits already apply,   */
/*  but a session-scoped client check makes the abuse path obvious to  */
/*  the user (clear in-chat sign-in nudge) and stops us from even      */
/*  hitting the network past the cap. Bypassable by clearing storage   */
/*  or using a private window — that's fine, the server limits catch   */
/*  those cases. Defense in depth.                                     */
/* ------------------------------------------------------------------ */
export const GUEST_CHAT_SESSION_CAP = 12;
export const GUEST_CHAT_SESSION_COUNT_KEY = "lykn_guest_chat_session_count";

export const readGuestChatCount = (): number => {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.sessionStorage.getItem(GUEST_CHAT_SESSION_COUNT_KEY);
    const n = parseInt(raw || "0", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
};

export const incrementGuestChatCount = (): number => {
  if (typeof window === "undefined") return 0;
  const next = readGuestChatCount() + 1;
  try {
    window.sessionStorage.setItem(GUEST_CHAT_SESSION_COUNT_KEY, String(next));
  } catch {
    // ignore (private mode, quota, etc.)
  }
  return next;
};

export const guestChatCapReached = (): boolean =>
  readGuestChatCount() >= GUEST_CHAT_SESSION_CAP;

/* ------------------------------------------------------------------ */
/*  Walkthrough reset                                                   */
/*                                                                      */
/*  Wipes every prototype-handoff localStorage / sessionStorage key so   */
/*  the next page load behaves like a brand-new visitor — empty          */
/*  Synthesis Layer, no demo grid, no "Vault intro played" one-shots,    */
/*  guest chat counter back to zero. Used by `signOut` so logging out    */
/*  feels like "starting from the beginning" instead of dropping the     */
/*  user back into a half-finished walkthrough.                          */
/* ------------------------------------------------------------------ */
export const clearPrototypeState = (): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PROTOTYPE_NEURONS_LS_KEY);
    window.localStorage.removeItem(PROTOTYPE_CHAT_LS_KEY);
    window.localStorage.removeItem(PROTOTYPE_STEP_LS_KEY);
    window.localStorage.removeItem(PROTOTYPE_TOUR_MODE_LS_KEY);
  } catch {
    // ignore quota / private-mode errors
  }
  try {
    window.sessionStorage.removeItem(PROTO_VAULT_INTRO_SS_KEY);
    window.sessionStorage.removeItem(PROTO_GRID_INTRO_SS_KEY);
    window.sessionStorage.removeItem(GUEST_CHAT_SESSION_COUNT_KEY);
  } catch {
    // ignore
  }
  // Notify same-window listeners (sidebar walkthrough nudges) that step
  // state just changed back to "no session yet".
  try {
    window.dispatchEvent(
      new CustomEvent(PROTOTYPE_STEP_EVENT, { detail: { step: null } }),
    );
  } catch {
    // ignore
  }
};

// Stable id for the synthetic "First Conversation" grid generated from
// the landing-prototype chat. Treated as a demo-grid id by `demoGrids.js`
// so it flows through OmniaGrid + useBoardPersistence's existing demo path
// (no Supabase reads/writes, no auth required) — making it behave like a
// real grid in the app instead of a custom one-off page.
export const PROTOTYPE_FIRST_CHAT_BOARD_ID = "__prototype_first_chat__";

export const isPrototypeFirstChatBoardId = (id: unknown): boolean =>
  typeof id === "string" && id === PROTOTYPE_FIRST_CHAT_BOARD_ID;

interface PromptMessageLike {
  id: string;
  role: "user";
  content: string;
  aiResponse?: string;
  kind: "prompt";
}

interface AiThreadTurn {
  role: "user" | "assistant";
  content: string;
}

// Fold the prototype chat (an array of {role: "user"|"ai", content}) into
// the shape OmniaGrid's chat rail expects: each user turn becomes one
// PromptMessage, with the next assistant turn (if any) inlined as
// `aiResponse`. Consecutive turns from the same role are concatenated so
// the grouping stays clean.
function foldChatIntoPrompts(turns: PrototypeChatTurn[]): {
  chatMessages: PromptMessageLike[];
  aiThread: AiThreadTurn[];
} {
  const chatMessages: PromptMessageLike[] = [];
  const aiThread: AiThreadTurn[] = [];

  let i = 0;
  let promptCounter = 0;
  while (i < turns.length) {
    const turn = turns[i];
    if (turn.role === "user") {
      let userText = turn.content;
      let j = i + 1;
      while (j < turns.length && turns[j].role === "user") {
        userText += "\n\n" + turns[j].content;
        j += 1;
      }
      let aiText: string | undefined;
      if (j < turns.length && turns[j].role === "ai") {
        aiText = turns[j].content;
        let k = j + 1;
        while (k < turns.length && turns[k].role === "ai") {
          aiText += "\n\n" + turns[k].content;
          k += 1;
        }
        j = k;
      }
      promptCounter += 1;
      chatMessages.push({
        id: `proto-prompt-${promptCounter}`,
        role: "user",
        content: userText,
        aiResponse: aiText,
        kind: "prompt",
      });
      aiThread.push({ role: "user", content: userText });
      if (aiText) aiThread.push({ role: "assistant", content: aiText });
      i = j;
    } else {
      // Assistant turn with no preceding user prompt — surface it as an
      // unattached AI prompt so it isn't lost from the transcript.
      let aiText = turn.content;
      let j = i + 1;
      while (j < turns.length && turns[j].role === "ai") {
        aiText += "\n\n" + turns[j].content;
        j += 1;
      }
      promptCounter += 1;
      chatMessages.push({
        id: `proto-prompt-${promptCounter}`,
        role: "user",
        content: "(LYKN)",
        aiResponse: aiText,
        kind: "prompt",
      });
      aiThread.push({ role: "assistant", content: aiText });
      i = j;
    }
  }

  return { chatMessages, aiThread };
}

const EMPTY_NOTES_DOC = { type: "doc", content: [{ type: "paragraph" }] };

// Build a board snapshot that OmniaGrid can render as if the prototype
// chat were a real saved grid. The snapshot intentionally has no canvas
// blocks — the conversation lives in the chat rail, which `applySnapshot`
// auto-opens whenever `chatMessages.length > 0`.
export const buildPrototypeFirstChatSnapshot = (): {
  title: string;
  version: number;
  blocks: Record<string, never>;
  blockOrder: string[];
  camera: { x: number; y: number; zoom: number };
  gridSize: number;
  wireConnections: never[];
  chatMessages: PromptMessageLike[];
  aiThread: AiThreadTurn[];
  notesPages: { id: string; title: string; content: typeof EMPTY_NOTES_DOC }[];
} => {
  const turns = readPrototypeChat();
  const { chatMessages, aiThread } = foldChatIntoPrompts(turns);

  return {
    title: "First Conversation",
    version: 2,
    blocks: {},
    blockOrder: [],
    // Empty board — let `applySnapshot`'s empty-board branch center the
    // camera on its own (it sets a viewport-anchored camera for empty
    // grids), so we don't have to compute one here.
    camera: { x: 0, y: 0, zoom: 1 },
    gridSize: 24,
    wireConnections: [],
    chatMessages,
    aiThread,
    notesPages: [
      { id: "proto-notes-page-1", title: "Page 1", content: EMPTY_NOTES_DOC },
    ],
  };
};
