// useLoadInGreeting owns the load-in greeting lifecycle on the chat page:
// consuming the sessionStorage payload stashed by the trigger (seeding the
// board with LYKN's typed-out "what's been happening" recap), and the
// stale-greeting refresh that re-fetches the payload and overlays it onto a
// board whose only turn is the greeting — including the placeholder-upgrade
// typewriter. Extracted verbatim from src/pages/LyknChat.tsx (LyknChat
// decomposition phase, see docs/REFACTOR_LOG.md).
import { useCallback, useEffect, useRef } from "react";
import { fetchLoadInUpdatesMessage } from "@/lib/synthesis/loadInUpdates";
import type { PromptMessage } from "@/lib/lyknChat/chatTurnTypes";

export function useLoadInGreeting({
  user,
  chatId,
  routeChatId,
  chatMessages,
  chatMessagesRef,
  setChatMessages,
  setChatRailOpen,
  setChatRailVisible,
}: {
  user: {
    id?: string;
    email?: string;
    user_metadata?: { full_name?: string; name?: string };
  } | null;
  chatId: string | null;
  routeChatId: string | null | undefined;
  chatMessages: PromptMessage[];
  chatMessagesRef: React.MutableRefObject<PromptMessage[]>;
  setChatMessages: React.Dispatch<React.SetStateAction<PromptMessage[]>>;
  setChatRailOpen: (open: boolean) => void;
  setChatRailVisible: (visible: boolean) => void;
}) {
  const loadInGreetingSeededRef = useRef<Set<string>>(new Set());

  // Load-in greeting (consume half — paired with the trigger effect
  // further up). Once useLyknChatPersistence has hydrated the brand-new
  // board, look for a sessionStorage entry stashed by the trigger and
  // seed the chat with LYKN's "what's been happening / approvals /
  // project updates" recap.
  useEffect(() => {
    if (!routeChatId) return;
    if (!user?.id) return;
    // `chatId === routeChatId` is the cleanest signal we have for
    // "hydration of this board is complete and chatMessages was just
    // reset to []" — `useLyknChatPersistence` sets chatId synchronously
    // alongside the reset, so observing the match means we're safe to
    // append without racing the reset.
    if (chatId !== routeChatId) return;
    if (loadInGreetingSeededRef.current.has(routeChatId)) return;

    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(`lykn:loadInGreeting:${routeChatId}`);
    } catch {
      // ignore
    }
    if (!raw) return;

    type LoadInAction = NonNullable<PromptMessage["aiResponseActions"]>[number];
    type LoadInSection = NonNullable<PromptMessage["aiResponseSections"]>[number];
    type LoadInStats = PromptMessage["aiResponseStats"];
    let parsed: {
      message?: string;
      actions?: LoadInAction[];
      sections?: LoadInSection[];
      stats?: LoadInStats;
      greetingName?: string;
    } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    const message = String(parsed?.message || "").trim();
    const actions: LoadInAction[] = Array.isArray(parsed?.actions)
      ? parsed.actions
      : [];
    const sections: LoadInSection[] = Array.isArray(parsed?.sections)
      ? parsed.sections
      : [];
    const stats: LoadInStats = parsed?.stats || undefined;
    const greetingNameForPanel = String(parsed?.greetingName || "").trim() || undefined;
    try {
      sessionStorage.removeItem(`lykn:loadInGreeting:${routeChatId}`);
    } catch {
      // ignore
    }
    if (!message) return;
    loadInGreetingSeededRef.current.add(routeChatId);

    // Match the existing typewriter-intro pattern: a tiny synthetic
    // "Catch me up" user prompt sits above LYKN's recap as the
    // `aiResponse` of that prompt (PromptMessage.role is hard-typed to
    // "user", every reply belongs to a prompt). We then progressively
    // populate `aiResponse` word-by-word so the user sees LYKN typing
    // out the update in real time — same cadence as the other in-app
    // intros. Action buttons (`aiResponseActions`) are attached at the
    // end of the type-out so they don't pop in mid-stream.
    const promptId = `loadin-intro-${Date.now()}`;
    const timeouts: number[] = [];

    // Tokenise on whitespace BUT keep the whitespace tokens in the
    // array so spaces / newlines accumulate naturally as we slice.
    const words = message.split(/(\s+)/);
    // Bigger messages need to type a touch faster so the user isn't
    // staring at a half-rendered list for 20s. We scale step time
    // inversely to length, clamped to a tight band.
    // Cadence scales with length so multi-category recaps don't take
    // forever. Bands roughly target a 6–10s total type-out regardless
    // of how rich the user's day was.
    const baseStepMs =
      words.length > 600
        ? 6
        : words.length > 400
          ? 9
          : words.length > 220
            ? 14
            : words.length > 120
              ? 20
              : 26;

    timeouts.push(
      window.setTimeout(() => {
        setChatRailOpen(true);
        setChatRailVisible(true);
        setChatMessages((prev) =>
          prev.length > 0
            ? prev
            : [
                {
                  id: promptId,
                  role: "user",
                  // No synthetic user prompt — the load-in greeting is
                  // an unprompted assistant briefing. `kind` flags this
                  // turn so the renderer hides the user bubble and
                  // skips the "AI Response" collapsible wrapper.
                  content: "",
                  aiResponse: "",
                  kind: "load-in-greeting",
                  // Attach the dashboard stats immediately so the
                  // right-side briefing panel animates in alongside the
                  // type-out, not as a last-tick pop-in.
                  aiResponseStats: stats,
                  ...(greetingNameForPanel
                    ? ({ greetingName: greetingNameForPanel } as any)
                    : {}),
                },
              ],
        );

        let i = 0;
        const tick = () => {
          i += 1;
          const partial = words.slice(0, i).join("");
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === promptId ? { ...m, aiResponse: partial } : m,
            ),
          );
          if (i < words.length) {
            timeouts.push(window.setTimeout(tick, baseStepMs));
          } else if (sections.length > 0 || actions.length > 0) {
            // Reveal the section blocks (and the legacy flat action
            // strip, for any consumer that still reads it) one tick
            // after the last word lands so the transition reads as
            // "LYKN finished, here's what you can do next" rather
            // than buttons popping in simultaneously with the final
            // period.
            timeouts.push(
              window.setTimeout(() => {
                setChatMessages((prev) =>
                  prev.map((m) =>
                    m.id === promptId
                      ? {
                          ...m,
                          aiResponseSections:
                            sections.length > 0 ? sections : undefined,
                          aiResponseActions:
                            sections.length > 0
                              ? undefined
                              : actions.length > 0
                                ? actions
                                : undefined,
                        }
                      : m,
                  ),
                );
              }, 240),
            );
          }
        };
        tick();
      }, 250),
    );

    return () => {
      for (const t of timeouts) window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeChatId, user?.id, chatId]);

  // Stale-greeting refresh: any time we land on a board whose ONLY
  // chat turn is a `load-in-greeting` (i.e. the user hasn't typed
  // anything yet — they just came back to a board that was minted
  // purely to host the welcome recap), re-fetch the load-in payload
  // and rewrite the assistant turn in place. The URL stays stable,
  // but the user always sees up-to-the-minute activity instead of
  // whatever was persisted on the previous visit.
  //
  // We guard tightly to avoid clobbering legitimate state:
  //   • `chatId === routeChatId` — wait for hydration to settle.
  //   • Exactly one message, role=user, kind="load-in-greeting".
  //   • One refresh per board id per session (ref-tracked).
  //   • `mintedThisSession` flag short-circuits the freshly-minted
  //     case so we don't double-fetch right after the trigger seeds
  //     a brand-new board.
  const loadInGreetingRefreshedRef = useRef<Set<string>>(new Set());

  // Timeout ids for the in-place greeting refresh typewriter. Mirrors the
  // consume effect's cleanup: without this, switching chats (or leaving the
  // page) mid-animation keeps firing setChatMessages against the wrong board.
  const greetingRefreshTimeoutsRef = useRef<number[]>([]);
  useEffect(() => {
    return () => {
      for (const t of greetingRefreshTimeoutsRef.current) window.clearTimeout(t);
      greetingRefreshTimeoutsRef.current = [];
    };
  }, [routeChatId]);

  // Reusable refresher used by both the on-mount effect below and the
  // inline user-sections composer in the chat surface. Re-fetches the
  // greeting payload and overlays it onto the single load-in-greeting
  // message in-place (no remount, no URL change). Returns a no-op if
  // the chat isn't currently sitting on a load-in greeting.
  //
  // When the current message is the "Catching you up…" placeholder
  // (i.e. we're upgrading a freshly-minted greeting board on first
  // load, not refreshing an already-shown one), we replay the same
  // word-by-word type-out animation the consume effect uses so the
  // briefing fades into view instead of snapping in all at once.
  const refreshLoadInGreetingInPlace = useCallback(async () => {
    if (!user?.id) return;
    const emailName = String(user?.email || "").split("@")[0].trim();
    const fullName = String(
      user?.user_metadata?.full_name || user?.user_metadata?.name || "",
    ).trim();
    const firstName = fullName ? fullName.split(/\s+/)[0] : "";
    const greetingName = firstName || emailName || null;
    let payload: Awaited<ReturnType<typeof fetchLoadInUpdatesMessage>> | null =
      null;
    try {
      payload = await fetchLoadInUpdatesMessage({ greetingName });
    } catch {
      payload = null;
    }
    if (!payload) return;

    // Sniff whether we're overlaying a placeholder vs. refreshing a
    // briefing the user has already been reading. Placeholder text is
    // always "Catching you up…" / "Catching you up, <name>…" — short
    // and ends in an ellipsis.
    let isPlaceholder = false;
    let targetMsgId: string | null = null;
    {
      // Read via the ref instead of a side-effecting setState updater —
      // updaters must stay pure (StrictMode runs them twice), and by this
      // point (post-await) the ref mirrors the latest committed state.
      const currentMsgs = chatMessagesRef.current || [];
      if (currentMsgs.length === 1 && currentMsgs[0].kind === "load-in-greeting") {
        const cur = currentMsgs[0];
        const txt = String(cur.aiResponse || "").trim();
        isPlaceholder = txt.startsWith("Catching you up") && txt.endsWith("…");
        targetMsgId = cur.id;
      }
    }

    if (!isPlaceholder) {
      // Already-shown briefing → instant overlay, no animation.
      setChatMessages((prev) => {
        if (prev.length !== 1) return prev;
        const cur = prev[0];
        if (cur.kind !== "load-in-greeting") return prev;
        return [
          {
            ...cur,
            aiResponse: payload!.message,
            aiResponseSections:
              (payload!.sections && payload!.sections.length > 0)
                ? payload!.sections
                : undefined,
            aiResponseActions:
              (!payload!.sections || payload!.sections.length === 0) &&
              payload!.actions && payload!.actions.length > 0
                ? payload!.actions
                : undefined,
            aiResponseStats: payload!.stats,
            ...(greetingName ? ({ greetingName } as any) : {}),
          },
        ];
      });
      return;
    }

    // Placeholder upgrade → clear the placeholder, attach the
    // dashboard stats immediately, then type out the real message
    // word-by-word using the same cadence as the consume effect.
    if (!targetMsgId) return;
    const words = payload.message.split(/(\s+)/);
    const baseStepMs =
      words.length > 600
        ? 6
        : words.length > 400
          ? 9
          : words.length > 220
            ? 14
            : words.length > 120
              ? 20
              : 26;
    setChatMessages((prev) =>
      prev.map((m) =>
        m.id === targetMsgId
          ? {
              ...m,
              aiResponse: "",
              aiResponseSections: undefined,
              aiResponseActions: undefined,
              aiResponseStats: payload!.stats,
              ...(greetingName ? ({ greetingName } as any) : {}),
            }
          : m,
      ),
    );
    let i = 0;
    const tick = () => {
      i += 1;
      const partial = words.slice(0, i).join("");
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === targetMsgId ? { ...m, aiResponse: partial } : m,
        ),
      );
      if (i < words.length) {
        greetingRefreshTimeoutsRef.current.push(
          window.setTimeout(tick, baseStepMs),
        );
      } else if (
        (payload!.sections && payload!.sections.length > 0) ||
        (payload!.actions && payload!.actions.length > 0)
      ) {
        greetingRefreshTimeoutsRef.current.push(
          window.setTimeout(() => {
            setChatMessages((prev) =>
              prev.map((m) =>
                m.id === targetMsgId
                  ? {
                      ...m,
                      aiResponseSections:
                        payload!.sections && payload!.sections.length > 0
                          ? payload!.sections
                          : undefined,
                      aiResponseActions:
                        payload!.sections && payload!.sections.length > 0
                          ? undefined
                          : payload!.actions && payload!.actions.length > 0
                            ? payload!.actions
                            : undefined,
                    }
                  : m,
              ),
            );
          }, 240),
        );
      }
    };
    tick();
  }, [user?.id, user?.email, user?.user_metadata]);

  useEffect(() => {
    if (!routeChatId) return;
    if (!user?.id) return;
    if (chatId !== routeChatId) return;
    if (chatMessages.length !== 1) return;
    const only = chatMessages[0];
    if (!only || only.kind !== "load-in-greeting") return;
    let mintedThisSession = false;
    try {
      mintedThisSession =
        sessionStorage.getItem("lykn:loadInGreetingMintedThisSession") === "1";
    } catch {
      /* ignore */
    }
    if (mintedThisSession && loadInGreetingSeededRef.current.has(routeChatId)) {
      // The trigger+consume pair already populated this board with
      // fresh data on the mint cycle — don't double-fetch.
      return;
    }
    if (loadInGreetingRefreshedRef.current.has(routeChatId)) return;
    loadInGreetingRefreshedRef.current.add(routeChatId);
    void refreshLoadInGreetingInPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeChatId, user?.id, chatId, chatMessages]);

  return { refreshLoadInGreetingInPlace };
}
