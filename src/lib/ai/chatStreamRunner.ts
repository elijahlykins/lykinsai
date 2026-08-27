// Send/stream stage of the chat send pipeline: fetch the SSE stream (with
// paywall + downgrade handling), consume it (text deltas, tool_call events,
// sources, served-model), and drive the client-side typewriter. Extracted
// VERBATIM from chatSendOrchestrator.ts (C3B decomposition, see
// docs/REFACTOR_LOG.md) minus the dead canvas block-write branches.
//
// Client-side stream state has ONE owner: the per-send `streamRefs` cursor
// the engine mints for each send. This module is the only writer during a
// stream; the engine's handleStopAi and the orchestrator's post-process
// commit are the only other touch points.
import { toast } from "@/components/ui/use-toast";
import {
  stripModelTruncationNoteFromStream,
} from "@/lib/ai/responseText";
import { stripToolSyntaxFromStream } from "@/lib/ai/toolSyntaxStrip";
import { finalizeResearchReport } from "@/lib/ai/researchReportFinalize";
import { stripStreamingActionJson } from "@/lib/ai/actionJsonRescue";
import { toolRunningStatus } from "@/lib/ai/toolStatusVerbs";
import { isLocalModeAvailable, getLocalModeCached } from "@/lib/localMode";
import { executeAwaitingLocalTool } from "@/lib/ai/localToolExecutor";
import { persistInstructionPrompt } from "@/lib/voice/tuneInstructions";
import { AI_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import {
  emitProjectsChanged,
  projectIdFromToolResult,
  shouldEmitProjectsChanged,
} from "@/lib/synthesis/projectLiveSync";
import {
  userRequestedVaultSurface,
  userRequestedVaultDisplay,
} from "@/lib/ai/vaultSurfaceGate";
import { openStudioTab } from "@/lib/studioTabs";
import { openLyknMediaPop } from "@/lib/lyknMediaPop";
import { openInstalledApp } from "@/lib/apps/installApp";
import type { ChatNeuronAttachment } from "@/lib/lyknChat/chatTurnTypes";
import type { ChatSendParams } from "@/lib/ai/chatSendOrchestrator";

// node_id prefixes lykn_loadNeuron uses to discriminate which store the
// neuron lives in. Mirrors the same set the tool handler accepts and is
// also what ChatNeuronCard renders per-kind layouts for.
const LOAD_NEURON_KINDS = new Set(["vault", "belief", "fact", "concept"]);

// Show a one-shot toast when the server downgrades the model. The server
// annotates responses with `X-Model-Downgraded: from->to` whenever the caller
// requests a model locked behind their plan. Toast once per session per pair
// to avoid spamming chatty users.
const notifiedDowngrades = new Set<string>();

export function maybeNotifyModelDowngrade(res: Response | null | undefined) {
  if (!res) return;
  const header = res.headers.get("x-model-downgraded");
  if (!header || notifiedDowngrades.has(header)) return;
  notifiedDowngrades.add(header);
  const [from, to] = header.split("->");
  try {
    toast({
      title: "Using a free model for now",
      description: `${from?.trim() || "That model"} needs a higher plan, so we used ${to?.trim() || "a free model"} instead.`,
    });
  } catch { /* toast unavailable */ }
}

/**
 * Mirrors the post-stream `extractSourceLinks` but runs against the LIVE
 * streaming buffer so the typewriter view doesn't pre-emptively chop the
 * tail of a reply at the first `\nSources:\n` line. The post-stream
 * `extractSourceLinks` only strips the tail when it actually contains
 * citation links (markdown `[title](url)` or numbered URLs); the streaming
 * view used to strip unconditionally with `replace(/\n+(?:Sources?|References?):?\s*\n[\s\S]*$/i, "")`,
 * which silently truncated long replies the moment the model wrote
 * "Sources:" or "References:" on its own line — even when the next
 * paragraph wasn't a citation list. That looked to the user like the
 * model "got cut off after a few sentences" right up until the
 * post-process commit fired.
 */
function stripTrailingSourcesBlockIfHasLinks(text: string): string {
  const sm = text.match(/\n+(?:Sources?|References?):?[ \t]*\n([\s\S]*?)$/i);
  if (!sm) return text;
  const block = String(sm[1] || "");
  // Markdown citation links — `[title](https://...)`.
  if (/\[[^\]]+\]\(https?:\/\/[^\s)]+\)/.test(block)) {
    return text.slice(0, sm.index ?? 0).trimEnd();
  }
  // Numbered citation list — `1. https://...`.
  if (/(?:^|\n)\s*\d+\.\s*https?:\/\/\S+/.test(block)) {
    return text.slice(0, sm.index ?? 0).trimEnd();
  }
  return text;
}

export type ChatStreamResult = {
  accumulated: string;
  servedModel: string | null;
  generatedImageUrl: string | null;
  streamedSources: { title: string; url: string }[];
};

/**
 * Create the stream fetcher for one send. `fetchStream` POSTs the request
 * body to `/api/ai/stream` and returns the Response when it is a live SSE
 * stream, null otherwise. Paywall (402) responses stash the upgrade copy —
 * read it with `getPaywallText` — and model-downgrade headers toast once
 * per turn.
 */
export function createChatStreamFetcher(args: {
  apiBase: string;
  requestBody: unknown;
  abortController: AbortController;
}): { fetchStream: () => Promise<Response | null>; getPaywallText: () => string | null } {
  const { apiBase, requestBody, abortController } = args;
  let notifiedModelDowngrade = false;
  // 402 = the free credit allowance is spent (or a lapsed subscription).
  // Not transient — retrying or falling back to /api/ai/invoke would hit the
  // same wall, so we surface the upgrade message instead of the generic
  // connection-trouble text.
  let paywallText: string | null = null;
  const fetchStream = async (): Promise<Response | null> => {
    try {
      const timeout = setTimeout(() => abortController.abort(), 120000);
      const res = await fetch(`${apiBase}/api/ai/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      });
      clearTimeout(timeout);
      if (res.status === 402) {
        const data = await res.json().catch(() => ({}));
        paywallText =
          String((data as { error?: string })?.error || "").trim() ||
          "You've used all your free credits. Upgrade your plan to keep going.";
        return null;
      }
      // The server swaps to a cheaper model for out-of-tier requests; tell
      // the user so they know why they got a different answer than expected.
      // Only once per turn — a silent retry shouldn't double-toast.
      if (!notifiedModelDowngrade) {
        maybeNotifyModelDowngrade(res);
        notifiedModelDowngrade = true;
      }
      if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) {
        return res;
      }
      return null;
    } catch {
      return null;
    }
  };
  return { fetchStream, getPaywallText: () => paywallText };
}

export async function runChatStream(
  p: ChatSendParams,
  streamRes: Response,
  promptId: string,
  userText: string,
): Promise<ChatStreamResult> {
  const { state, streamRefs } = p;
  const reader = streamRes.body?.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let servedModel: string | null = null;
  // Deep research: the server emits the full source list (every page it
  // searched/read) as an early SSE event, before the report text streams.
  let streamedSources: { title: string; url: string }[] = [];
  // Image generated this turn (lykn_generate_image → done). The URL is
  // appended to the conversation-memory entry (NOT the visible bubble, which
  // renders the image via the artifact card) so the server's follow-up
  // detector can see "the last assistant turn produced an image" and re-force
  // the tool on "do the same but…" edits.
  let generatedImageUrl: string | null = null;
  let firstToken = true;
  let sseBuffer = "";
  let serverErrorMsg = "";
  // Deterministic backstop: only let the agent render a VAULT item as a
  // card in the chat when the user actually asked to see it this turn (or
  // confirmed a surfacing offer). The model is told the same thing in the
  // prompt, but this guarantees no random saved item gets embedded.
  // With Local Mode on, ambiguous "pull in the images" asks are treated as
  // local-file requests — vault cards then need an explicit saved/vault
  // mention.
  const allowVaultSurface = userRequestedVaultSurface(
    userText,
    p.aiThread,
    isLocalModeAvailable() && getLocalModeCached(),
  );
  // Whether to auto-pop the full embedded document reader for a vault item
  // this turn (strict subset of the surface gate above). When false the card
  // still renders; the user pulls it up with one tap.
  const autoOpenVaultViewer = userRequestedVaultDisplay(userText, p.aiThread);
  // 90s inactivity for normal chat. Research reports can pause between
  // continue hops / long writes — match the server's longToolTurn window.
  const STREAM_INACTIVITY_MS = p.composerMode === "research" ? 240000 : 90000;

  if (reader) {
    let inactivityTimer = setTimeout(() => { reader.cancel(); p.abortController.abort(); }, STREAM_INACTIVITY_MS);
    try {
      let stopReading = false;
      while (!stopReading) {
        const { done, value } = await reader.read();
        if (done) {
          sseBuffer += decoder.decode(undefined, { stream: false });
          break;
        }
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => { reader.cancel(); p.abortController.abort(); }, STREAM_INACTIVITY_MS);
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") { stopReading = true; break; }
          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              if (import.meta.env.DEV) console.error('SSE error:', parsed.error);
              // Stash the server's message but DO NOT wipe accumulated
              // text. If the user already saw paragraphs render, blowing
              // them away with "something went wrong" is a worse UX than
              // keeping the partial reply (and the server's mid-stream
              // errors are usually transient — overload, downgrade, etc.).
              serverErrorMsg = String(parsed.error || "").trim() || "stream_error";
              continue;
            }
            if (parsed.status) { state.setChatStatusText(String(parsed.status)); continue; }
            if (Array.isArray(parsed.sources)) {
              // Deep-research source list — patch onto the in-flight message
              // immediately so the Studio research rail fills in while the
              // report is still streaming.
              const list = (parsed.sources as any[])
                .filter((s) => s && typeof s.url === "string" && s.url)
                .map((s) => ({ title: String(s.title || "Source"), url: String(s.url) }));
              if (list.length) {
                streamedSources = list;
                state.setChatMessages((prev) =>
                  prev.map((m) => (m.id === promptId ? { ...m, sources: list } : m)),
                );
              }
              continue;
            }
            if (parsed.served_model && typeof parsed.served_model === "string") {
              servedModel = parsed.served_model.trim() || null;
              continue;
            }
            if (parsed.tool_call && typeof parsed.tool_call === "object") {
              // Agent-loop tool call event from server (chat-agent-loop.js).
              // We update the in-flight assistant message's `toolCalls`
              // array in place — the same `id` arrives twice (running →
              // done|error) so we look up by id and patch the existing
              // entry rather than pushing a duplicate.
              const tc = parsed.tool_call as {
                id: string;
                name: string;
                args?: Record<string, unknown>;
                status: "running" | "done" | "error" | "awaiting_client" | "awaiting_approval";
                result?: any;
                error?: string;
                latencyMs?: number;
                localStreamId?: string;
              };
              const now = Date.now();
              // Local Mode: the server can't run file/terminal tools, so it
              // asks the desktop client to. Run it here (with approval for
              // risky actions) and post the result back so the turn resumes.
              const isInFlightLocal =
                tc.status === "awaiting_client" || tc.status === "awaiting_approval";
              if (tc.status === "awaiting_client") {
                void (async () => {
                  const { API_BASE_URL: localApiBase } = await import("@/lib/api-config");
                  await executeAwaitingLocalTool(
                    {
                      id: tc.id,
                      name: tc.name,
                      args: tc.args,
                      localStreamId: tc.localStreamId,
                    },
                    localApiBase,
                  );
                })();
              }
              // When a `lykn_loadNeuron` or `lykn_loadNeurons` call lands
              // with ok:true we want each loaded neuron to render as a
              // real card in the chat (not just as a pill). Build the
              // attachments up front so the setChatMessages updater
              // below can push them onto the same message in a single
              // pass.
              //
              //   • lykn_loadNeuron  → one card from `tc.result`
              //   • lykn_loadNeurons → one card per entry in
              //                        `tc.result.results[]` whose
              //                        per-entry `ok` is true and `kind`
              //                        is recognised. The batch tool
              //                        guarantees each entry is the same
              //                        shape the single tool returns, so
              //                        the card renderer doesn't need to
              //                        branch on which tool fed it.
              const newAttachments: ChatNeuronAttachment[] = [];
              if (
                tc.status === "done"
                && tc.result
                && typeof tc.result === "object"
                && tc.result.ok === true
              ) {
                // Vault items render only when the user asked to see them
                // this turn; belief/fact/concept neurons are never gated.
                const kindAllowed = (kind: string) =>
                  LOAD_NEURON_KINDS.has(kind) && (kind !== "vault" || allowVaultSurface);
                if (
                  tc.name === "lykn_loadNeuron"
                  && kindAllowed(String(tc.result.kind))
                ) {
                  newAttachments.push({
                    id: tc.id,
                    payload: tc.result,
                    addedAt: now,
                    autoOpen:
                      String(tc.result.kind) === "vault" && autoOpenVaultViewer,
                  });
                } else if (
                  tc.name === "lykn_loadNeurons"
                  && Array.isArray(tc.result.results)
                ) {
                  // Suffix the tool_call id with the per-entry index so
                  // the dedupe key stays unique across the batch — every
                  // entry needs its own React key + persistence slot.
                  tc.result.results.forEach((entry: any, i: number) => {
                    if (
                      entry
                      && entry.ok === true
                      && kindAllowed(String(entry.kind))
                    ) {
                      newAttachments.push({
                        id: `${tc.id}#${i}`,
                        payload: entry,
                        addedAt: now,
                        // Only the FIRST vault item in a batch auto-opens, so a
                        // multi-result load doesn't stack modals on top of each
                        // other. The rest render as cards the user can pull up.
                        autoOpen:
                          String(entry.kind) === "vault"
                          && autoOpenVaultViewer
                          && !newAttachments.some(
                            (a) => a.payload?.kind === "vault" && a.autoOpen,
                          ),
                      });
                    }
                  });
                }
              }
              state.setChatMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== promptId) return m;
                  const existing = Array.isArray(m.toolCalls) ? m.toolCalls : [];
                  const idx = existing.findIndex((e) => e.id === tc.id);
                  // Dedupe neuron attachments by id — the same `done`
                  // event won't fire twice in normal flow, but a
                  // defensive check costs nothing and prevents double-
                  // cards if the server ever re-emits. For batch loads
                  // we union all NEW entries that aren't already there.
                  const existingNeurons = Array.isArray(m.aiNeurons) ? m.aiNeurons : [];
                  const haveIds = new Set(existingNeurons.map((n) => n.id));
                  const additions = newAttachments.filter((n) => !haveIds.has(n.id));
                  const neuronsNext = additions.length
                    ? [...existingNeurons, ...additions]
                    : existingNeurons;
                  if (idx === -1) {
                    return {
                      ...m,
                      toolCalls: [
                        ...existing,
                        {
                          id: tc.id,
                          name: tc.name,
                          args: tc.args || {},
                          status: tc.status,
                          result: tc.result,
                          error: tc.error,
                          latencyMs: tc.latencyMs,
                          startedAt: now,
                          finishedAt:
                            tc.status === "running" || isInFlightLocal ? undefined : now,
                        },
                      ],
                      aiNeurons: neuronsNext,
                    };
                  }
                  const merged = [...existing];
                  merged[idx] = {
                    ...merged[idx],
                    name: tc.name || merged[idx].name,
                    args: tc.args || merged[idx].args,
                    status: tc.status,
                    result: tc.result !== undefined ? tc.result : merged[idx].result,
                    error: tc.error !== undefined ? tc.error : merged[idx].error,
                    latencyMs: tc.latencyMs ?? merged[idx].latencyMs,
                    finishedAt:
                      tc.status === "running" || isInFlightLocal
                        ? merged[idx].finishedAt
                        : now,
                  };
                  return { ...m, toolCalls: merged, aiNeurons: neuronsNext };
                }),
              );
              // Give the user a soft status line while tools run so the
              // bubble doesn't sit silent during a multi-hop loop. Narrate
              // the ACTIVITY in plain English ("Building the template…",
              // "Creating the image…") instead of leaking the raw tool name.
              if (tc.status === "running") {
                state.setChatStatusText(toolRunningStatus(tc.name, tc.args));
              } else if (tc.status === "awaiting_client") {
                state.setChatStatusText(toolRunningStatus(tc.name, tc.args));
              } else if (tc.status === "awaiting_approval") {
                state.setChatStatusText("Waiting for your approval…");
              } else if (
                shouldEmitProjectsChanged(tc.name, tc.status, tc.result)
              ) {
                emitProjectsChanged({
                  userId: p.identity.userId,
                  projectId: projectIdFromToolResult(tc.name, tc.result),
                });
              }
              // Remember the image generated this turn for conversation memory
              // (feeds the server's image-follow-up detector next turn).
              if (
                tc.status === "done"
                && tc.name === "lykn_generate_image"
                && tc.result
                && typeof tc.result === "object"
                && typeof (tc.result as { image_url?: string }).image_url === "string"
                && /^https?:\/\//.test((tc.result as { image_url: string }).image_url)
              ) {
                generatedImageUrl = (tc.result as { image_url: string }).image_url;
              }
              // Self-tuning: when the assistant rewrites the user's own custom
              // instructions (tone / behavior), persist the new text into their
              // settings so it sticks, shows up in Settings → Display for manual
              // editing, and rides along on future requests via getAiPrefs.
              if (
                tc.status === "done"
                && tc.name === "lykn_update_assistant_instructions"
                && tc.result
                && typeof tc.result === "object"
                && (tc.result as { ok?: boolean }).ok === true
              ) {
                const r = tc.result as { scope?: string; instructions?: string };
                const text = typeof r.instructions === "string" ? r.instructions.trim() : "";
                if (text) {
                  persistInstructionPrompt(r.scope === "voice" ? "voice" : "chat", text);
                }
              }
              // Settings is a window in the shell, so the server tool only
              // settles which pane was meant — opening it happens here, the
              // same split local_open_path uses to land the user in Files.
              if (
                tc.status === "done"
                && tc.name === "lykn_open_settings"
                && tc.result
                && typeof tc.result === "object"
                && (tc.result as { ok?: boolean }).ok === true
              ) {
                const section = (tc.result as { section?: string }).section;
                openStudioTab("settings", typeof section === "string" ? section : undefined);
              }
              // Same split for the pages and the apps the user built: the
              // server worked out WHICH one was meant, opening it happens here.
              if (
                tc.status === "done"
                && tc.name === "lykn_open_app"
                && tc.result
                && typeof tc.result === "object"
                && (tc.result as { ok?: boolean }).ok === true
              ) {
                const r = tc.result as { kind?: string; id?: string; src?: string | null; label?: string };
                if (typeof r.id === "string" && r.id) {
                  if (r.kind === "installed") void openInstalledApp(r.id);
                  else if (r.kind === "drive") {
                    // A specific file/image/artifact: the universal preview pop.
                    // Opening the Finder window is for the drive or a folder.
                    if (r.id !== "drive") {
                      openLyknMediaPop({
                        type: "vault-note",
                        noteId: r.id,
                        title: typeof r.label === "string" ? r.label : undefined,
                      });
                    } else {
                      openStudioTab("vault", r.src || "/vault?pane=drive");
                    }
                  } else openStudioTab(r.id, r.src || undefined);
                }
              }
              continue;
            }
            if (parsed.t) {
              if (firstToken) {
                // Build / Create turns: don't clobber the cycling "Designing
                // the build…" lane with a generic "Responding…" — the long
                // wait is still ahead (tool args streaming).
                const mode = String(p.composerMode || "");
                if (!mode.startsWith("create:")) {
                  state.setChatStatusText("Responding...");
                }
                firstToken = false;
                streamRefs.streamDisplayedLenRef.current = 0;
                streamRefs.streamTargetTextRef.current = "";
                streamRefs.streamPromptIdRef.current = promptId;
              }
              accumulated += parsed.t;
              // Hide any "_…response truncated. Ask 'continue' for the
              // rest._" style note the model may emit at the tail — the
              // system prompt forbids it, but some models still do it, and
              // we'd rather strip it than ever flash it on screen.
              const accumulatedForView = stripToolSyntaxFromStream(
                stripModelTruncationNoteFromStream(
                  accumulated,
                ),
              );
              const visibleText = stripStreamingActionJson(
                stripTrailingSourcesBlockIfHasLinks(accumulatedForView).replace(/\s*\[TAG_NOTES:[^\]]*\]/g, "")
              ).trimEnd();
              streamRefs.streamTargetTextRef.current = visibleText;
              // The typing animation only ADVANCES `streamDisplayedLenRef`,
              // so if a leaked envelope flashed characters into the bubble
              // and was then stripped (visibleText shrank), the chat message
              // would keep showing the stale leaked prefix until `accumulated`
              // grew long enough for the animation to overwrite it. Snap
              // displayedLen back to the new (shorter) target length and push
              // the corrected partial so the leak vanishes immediately.
              if (streamRefs.streamDisplayedLenRef.current > visibleText.length) {
                streamRefs.streamDisplayedLenRef.current = visibleText.length;
                const pid = streamRefs.streamPromptIdRef.current;
                if (pid) {
                  state.setChatMessages((prev) =>
                    prev.map((m) => (m.id === pid ? { ...m, aiResponse: visibleText } : m)),
                  );
                }
              }
              if (!streamRefs.streamTypingRafRef.current) {
                const typeTick = () => {
                  const target = streamRefs.streamTargetTextRef.current;
                  const cur = streamRefs.streamDisplayedLenRef.current;
                  if (cur < target.length) {
                    const behind = target.length - cur;
                    const step = Math.max(2, Math.min(6, Math.ceil(behind / 6)));
                    streamRefs.streamDisplayedLenRef.current = Math.min(cur + step, target.length);
                    const partial = target.substring(0, streamRefs.streamDisplayedLenRef.current);
                    const pid = streamRefs.streamPromptIdRef.current;
                    if (pid) {
                      state.setChatMessages((prev) =>
                        prev.map((m) => (m.id === pid ? { ...m, aiResponse: partial } : m)),
                      );
                    }
                    if (!streamRefs.chatUserScrolledUpRef.current) {
                      const el = streamRefs.chatScrollRef.current;
                      if (el) {
                        streamRefs.chatProgrammaticScrollRef.current = true;
                        el.scrollTop = el.scrollHeight;
                      }
                    }
                    streamRefs.streamTypingRafRef.current = window.setTimeout(typeTick, 18);
                  } else {
                    streamRefs.streamTypingRafRef.current = null;
                  }
                };
                streamRefs.streamTypingRafRef.current = window.setTimeout(typeTick, 18);
              }
            }
          } catch {}
        }
      }
      // Drain ALL leftover lines from the SSE buffer, not just the last
      // one. Gemini's stream sometimes ends without a trailing newline
      // after the final `data: {...}` event AND can leave more than one
      // un-newlined line in the buffer when the connection closes mid-
      // chunk. Without this, the last sentence(s) of a reply silently
      // disappear and the user sees a cut-off message.
      if (sseBuffer.trim()) {
        for (const line of sseBuffer.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.t) accumulated += parsed.t;
            if (parsed.error && !serverErrorMsg) serverErrorMsg = String(parsed.error || "stream_error");
          } catch {}
        }
        sseBuffer = "";
      }
      // CRITICAL: update the typing animation's target to the full drained
      // accumulated text. Without this, `streamTargetTextRef` would still
      // hold the PRE-drain visible text (last in-stream chunk only). The
      // typing animation runs at ~2-6 chars / 18ms, so for any reply long
      // enough that the animation hasn't caught up at stream-end (which is
      // every reply), the animation keeps firing AFTER post-process commits
      // the full text — and each tick overwrites the committed message
      // with `target.substring(0, displayedLen)`. Animation stops when it
      // catches up to the stale target, leaving the user staring at a
      // truncated reply (the visible bug: "server finished, UI cut off").
      // Updating the target here lets the animation finish typing the
      // ENTIRE final reply, then stop cleanly so the post-process commit
      // sticks.
      try {
        const finalAccumulatedForView = stripToolSyntaxFromStream(
          stripModelTruncationNoteFromStream(
            accumulated,
          ),
        );
        const finalVisibleText = finalizeResearchReport(
          stripStreamingActionJson(
            stripTrailingSourcesBlockIfHasLinks(finalAccumulatedForView)
              .replace(/\s*\[TAG_NOTES:[^\]]*\]/g, "")
          ),
        ).trimEnd();
        streamRefs.streamTargetTextRef.current = finalVisibleText;
      } catch {}
    } catch {
      if (!accumulated.trim()) accumulated = AI_TEMPORARY_FAILURE_TEXT;
    } finally {
      clearTimeout(inactivityTimer);
    }
  }

  // If the server reported an error AND we got nothing usable back,
  // surface a friendly message. If we already streamed real content,
  // keep it — the partial reply is far more useful than a generic
  // "something went wrong". The server-side cross-provider chain has
  // already tried every available model on the user's behalf by the
  // time we reach this branch, so the copy never tells the user to
  // switch models — they have nothing further they could pick.
  if (serverErrorMsg && !accumulated.trim()) {
    accumulated = AI_TEMPORARY_FAILURE_TEXT;
  }
  return { accumulated, servedModel, generatedImageUrl, streamedSources };
}
