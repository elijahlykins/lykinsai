"use strict";

const path = require("node:path");
const ownedBrowserAct = require("../ownedBrowserAct.cjs");
const workDestination = require("../../lib/agentWorkDestination.cjs");

/**
 * Mail compose/share routing in the agent host.
 * Browser execution still goes through TaskRuntime → BrowserExecutor.
 */
function createMailRouting(host) {
  const userDataPath = () => host.userDataPath;
  const paintBrowseDone = (...a) => host.paintBrowseDone(...a);
  const emitProgress = (...a) => host.emitProgress(...a);
  const sendToAgentChannels = (...a) => host.sendToAgentChannels(...a);
  const showBrowserWindow = (...a) => host.showBrowserWindow?.(...a);
  const syncAgentBrowserTabs = (...a) => host.syncAgentBrowserTabs(...a);
  const offerSendApprovalChoice = (...a) => host.offerSendApprovalChoice(...a);
  const offerAgentQuestion = (...a) => host.offerAgentQuestion(...a);
  const getLiveTabUrl = (...a) => host.getLiveTabUrl(...a);
  const runBrowserTaskViaExecutor = (...a) => host.runBrowserTaskViaExecutor(...a);
  const historyForPlanner = (...a) => host.historyForPlanner(...a);
  const focusOverlayComposer = (...a) => host.focusOverlayComposer?.(...a);
  const pauseForUserSignIn = (...a) => host.pauseForUserSignIn(...a);
  const runAdaptiveBrowse = (...a) => host.runAdaptiveBrowse(...a);
  const finishBrowseTurn = (...a) => host.finishBrowseTurn(...a);
  const finishBrowseResult = (...a) => host.finishBrowseResult(...a);
  const latestComposedText = (...a) => host.latestComposedText(...a);
  const priorAssistantText = (...a) => host.priorAssistantText(...a);
  const priorUserGoalBeforeLatest = (...a) => host.priorUserGoalBeforeLatest(...a);
  const recentUserGoals = (...a) => host.recentUserGoals(...a);
  const rememberOpenedMail = (...a) => host.rememberOpenedMail(...a);
  const summarizeCurrentTab = (...a) => host.summarizeCurrentTab(...a);
  const askNeedsFindingFirst = (...a) => host.askNeedsFindingFirst(...a);
  const formatInboxListAnswer = (...a) => host.formatInboxListAnswer?.(...a);
  const formatOpenedEmailAnswer = (...a) => host.formatOpenedEmailAnswer?.(...a);
  const formatQuickBrowseAnswer = (...a) => host.formatQuickBrowseAnswer?.(...a);
  function shareableArtifactUrl(agent) {
    const url = String(agent.lastArtifact?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return "";
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
        return "";
      }
    } catch {
      return "";
    }
    return url;
  }

  async function materializeDeliverableFile(agent) {
    const fsSync = require("node:fs");
    const dir = path.join(userDataPath() || require("node:os").tmpdir(), "agent-sends");
    try {
      fsSync.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    const stamp = Date.now().toString(36);

    if (agent.lastImage?.url) {
      const url = String(agent.lastImage.url);
      const title = String(agent.lastImage.title || "image")
        .replace(/[^\w.\-]+/g, "_")
        .slice(0, 48) || "image";
      let ext = ".png";
      if (/\.jpe?g(\?|$)/i.test(url) || /image\/jpeg/i.test(url)) ext = ".jpg";
      else if (/\.webp(\?|$)/i.test(url)) ext = ".webp";
      else if (/\.gif(\?|$)/i.test(url)) ext = ".gif";
      const filePath = path.join(dir, `${title}-${stamp}${ext}`);
      try {
        if (/^data:image\//i.test(url)) {
          const m = url.match(/^data:image\/[\w+.-]+;base64,(.+)$/i);
          if (!m) return null;
          fsSync.writeFileSync(filePath, Buffer.from(m[1], "base64"));
        } else {
          const res = await fetch(url);
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          fsSync.writeFileSync(filePath, buf);
        }
        agent.lastDownloadedFile = { path: filePath, kind: "image", name: path.basename(filePath) };
        return agent.lastDownloadedFile;
      } catch {
        return null;
      }
    }

    if (agent.lastArtifact?.code) {
      const title = String(agent.lastArtifact.title || "artifact")
        .replace(/[^\w.\-]+/g, "_")
        .slice(0, 48) || "artifact";
      const code = String(agent.lastArtifact.code);
      const isHtml = /^\s*</.test(code) || /<\/[a-z]+>/i.test(code);
      const html = isHtml
        ? code
        : `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title></head><body><pre>${code
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</pre></body></html>`;
      const filePath = path.join(dir, `${title}-${stamp}.html`);
      try {
        fsSync.writeFileSync(filePath, html, "utf8");
        agent.lastDownloadedFile = {
          path: filePath,
          kind: "artifact",
          name: path.basename(filePath),
        };
        return agent.lastDownloadedFile;
      } catch {
        return null;
      }
    }

    if (agent.lastDownloadedFile?.path && fsSync.existsSync(agent.lastDownloadedFile.path)) {
      return agent.lastDownloadedFile;
    }
    return null;
  }

  /**
   * Download last image/artifact → Gmail compose → attach → optionally Send.
   */
  async function sendDeliverableByEmail(agent, text, gen, wc) {
    const email =
      ownedBrowserAct.extractEmailAddress?.(text) ||
      (String(text || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [])[0] ||
      "";
    if (!email) {
      return paintBrowseDone(
        agent,
        "Who should I send it to? Give me an email address.",
      );
    }

    emitProgress(agent.id, {
      status: "running",
      step: "Preparing the file to send…",
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: "Preparing the file to send…",
    });

    const file = await materializeDeliverableFile(agent);
    if (!file?.path) {
      return paintBrowseDone(
        agent,
        "I don't have an image or artifact from this chat to attach yet. Create one first, then ask me to email it.",
      );
    }

    // Review-first: a fresh "email the artifact to X" fills and attaches, then
    // pauses so the user can look it over. Only a short approval reply
    // ("send it", "looks good") releases the actual send.
    const shouldSend = looksLikeSendApprovalFollowUp(text);

    const kindLabel = file.kind === "image" ? "image" : "file";
    const subject =
      agent.lastImage?.title ||
      agent.lastArtifact?.title ||
      `LYKN ${kindLabel}`;
    // Artifacts travel as link + file: recipients get the live page when a
    // shareable URL exists, plus the attached file they can open offline.
    const artifactLink =
      file.kind === "artifact" ? shareableArtifactUrl(agent) : "";
    const body =
      `Hi,\n\nSharing the ${kindLabel} I made in LYKN` +
      (subject ? ` (“${subject}”).` : ".") +
      (artifactLink
        ? `\n\nView it live here:\n${artifactLink}\n\nThe file is also attached.`
        : "") +
      `\n\n— LYKN`;

    emitProgress(agent.id, {
      status: "running",
      step: "Opening Gmail compose…",
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: "Opening Gmail compose…",
    });

    const draft = { to: email, subject: String(subject).slice(0, 120), body };
    agent.lastMailDraft = draft;
    const composeUrl = ownedBrowserAct.resolveGmailComposeUrl(text, draft);
    showBrowserWindow?.(agent.id, { focus: false, label: agent.title || "Agent" });
    const nav = await ownedBrowserAct.navigate(wc, composeUrl);
    if (!nav.ok) {
      return paintBrowseDone(
        agent,
        `Couldn't open Gmail compose to send **${file.name}**. ${nav.error || ""}`.trim(),
      );
    }
    agent.url = nav.url || composeUrl;
    syncAgentBrowserTabs({ focusId: agent.id });
    await ownedBrowserAct.waitForDomSettle(wc, 1800);

    let filled = await ownedBrowserAct.fillGmailComposeDraft(wc, draft);
    if (!filled?.to || !filled?.body) {
      await ownedBrowserAct.waitForDomSettle(wc, 1200);
      filled = await ownedBrowserAct.fillGmailComposeDraft(wc, draft);
    }

    emitProgress(agent.id, {
      status: "running",
      step: `Attaching ${file.name}…`,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: `Attaching ${file.name}…`,
    });
    const attached = await ownedBrowserAct.attachFileToGmailCompose(wc, file.path);
    if (!attached?.ok) {
      return paintBrowseDone(
        agent,
        `Filled a Gmail draft to **${email}** and saved **${file.name}** on disk, but couldn't attach it automatically (${attached?.error || "no file input"}).\n\n` +
          `File: \`${file.path}\`\n\n` +
          `Attach it in the compose window, then say **"send"** if you want me to hit Send.`,
      );
    }

    if (shouldSend) {
      emitProgress(agent.id, {
        status: "running",
        step: "Sending…",
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Sending…" });
      const sent = await ownedBrowserAct.clickGmailSend(wc);
      if (sent?.ok) {
        agent.docShareDone = true;
        return paintBrowseDone(
          agent,
          `Emailed **${file.name}** to **${email}** (attached in Gmail).`,
        );
      }
      return paintBrowseDone(
        agent,
        `Draft ready for **${email}** with **${file.name}** attached — I couldn't click Send. Hit Send in the tab, or say **"send"** and I'll try again.`,
      );
    }

    const readyMsg =
      `Draft ready for **${email}** with **${file.name}** attached` +
      (artifactLink ? " and the live link in the body" : "") +
      `. Look it over and tell me any changes before I send it.`;
    const painted = paintBrowseDone(agent, readyMsg, { skipEnrich: true });
    offerSendApprovalChoice(agent, readyMsg);
    return painted;
  }

  /**
   * Compose/reply/revise email through the modular browser agent: the
   * communication skill + forms rules drive Gmail from live page state, and
   * the safety gate keeps Send behind explicit user intent. Replaces the
   * hardcoded compose-deep-link + selector pipeline for plain compose asks.
   */
  async function runMailComposeModular(agent, text, gen, wc, opts = {}) {
    const liveUrl = getLiveTabUrl(agent, wc) || "";
    const opened = agent.lastOpenedMail || null;
    const prior = agent.lastMailDraft || null;
    // The previous mail run stopped to ask the user something (usually "what
    // should the email say?"). This message is the ANSWER — resume the original
    // compose with the guidance folded in. Without this, "idk make it funny"
    // was read as "revise the existing draft" and the agent went hunting for a
    // draft that was never created.
    const pendingAsk0 = String(agent.pendingMailAsk?.ask || "").trim();
    agent.pendingMailAsk = null;
    // A complete new compose ask supersedes the unanswered question.
    const pendingAsk =
      pendingAsk0 && !ownedBrowserAct.looksLikeMailComposeTask?.(String(text || ""))
        ? pendingAsk0
        : "";
    const effectiveText = pendingAsk
      ? `${pendingAsk}\nAdditional guidance from the user: ${String(text || "").trim()}`
      : String(text || "");
    const composedPiece = latestComposedText(agent);
    const onMail =
      ownedBrowserAct.looksLikeSignedInMailUrl(liveUrl) ||
      !!ownedBrowserAct.isGmailComposeUrl?.(liveUrl);
    const isReply =
      ownedBrowserAct.looksLikeMailReplyTask?.(effectiveText) ||
      (!!opened &&
        /\b(that|this|the)\s+(email|message|one|thread)\b/i.test(effectiveText) &&
        /\b(draft|write|compose|reply|respond|response)\b/i.test(effectiveText));
    const isRevision =
      !pendingAsk &&
      ownedBrowserAct.looksLikeMailDraftRevision(effectiveText, {
        hasMailDraft: !!prior,
        onMail,
      });
    // "send this/it" or "send the essay/report" → deliver the piece the agent
    // just wrote, verbatim — don't let the model invent a stub body.
    // Link shares (emailing a page/video URL) specify their own body and must
    // never inherit previously composed content.
    const deicticContentAsk =
      !opts.linkShare &&
      (/\b(send|email|forward|mail)\s+(?:off\s+)?(this|it|that)\b/i.test(effectiveText) ||
        /\b(send|email|forward|mail)\b[\s\S]{0,40}\b(the|this|that|my)\s+(paper|essay|doc|document|report|article|letter|write[- ]?up)\b/i.test(
          effectiveText,
        ));
    // Attaching a file is deterministic (CDP file input) and happens AFTER the
    // modular agent has the draft filled — see the attach block below.
    const wantsAttachment =
      !!(agent.lastImage?.url || agent.lastArtifact?.code || agent.lastDownloadedFile?.path) &&
      /\b(attach|image|picture|photo|artifact|file|pdf|html|download)\b/i.test(effectiveText);

    // Gmail is the default only because it is where email lives when nobody
    // said otherwise. Whenever the user named a place — "in mailchimp", "in
    // hubspot", or a tool nobody here has heard of — that is where the work
    // happens, and the name they used is enough to find it.
    const namedDestination = workDestination.destinationFromAsk(effectiveText);
    const goalParts = [effectiveText.trim(), "", "Email task context:"];
    goalParts.push(
      namedDestination
        ? `- The user named where this happens: ${namedDestination}. Do the work there — navigate to it if the browser is elsewhere, searching for it if you do not know its address. Do NOT substitute a different app for the one they named.`
        : "- Work in Gmail (https://mail.google.com). If the browser is not on Gmail, navigate there first.",
    );
    if (ownedBrowserAct.isGmailComposeUrl?.(liveUrl)) {
      goalParts.push("- A compose window is already open on the current tab — use it; do not open a new one.");
    }
    if (isReply && (opened?.email || opened?.subject)) {
      goalParts.push(
        `- This is a REPLY to the open thread${opened.from ? ` from ${opened.from}` : ""}${
          opened.email ? ` <${opened.email}>` : ""
        }${opened.subject ? ` with subject "${opened.subject}"` : ""}. Open the thread and use its Reply button — never a blank compose.`,
      );
    }
    if (isRevision && (prior?.to || prior?.subject)) {
      goalParts.push(
        `- Revise the existing draft (to: ${prior.to || "unchanged"}, subject: "${prior.subject || "unchanged"}") in place. Keep the recipient unless the user named a new one.`,
      );
    }
    if (!isReply && deicticContentAsk && composedPiece.length >= 200) {
      goalParts.push(
        "- The user means this previously composed content. Use it as the email body verbatim (do not summarize or rewrite it):",
        "---",
        composedPiece.slice(0, 4000),
        "---",
      );
    }
    if (isRevision) {
      goalParts.push(
        "- Make the smallest targeted edits: use replace_text on the specific passages that change. Do NOT clear and retype the whole body.",
      );
    }
    goalParts.push(
      "- Fill recipient, subject, and body completely, then verify the fields actually contain the content.",
      // Picking a recipient out of contacts or past threads sends the user's
      // work to someone they never mentioned.
      "- Address this ONLY to a recipient the user named, or the thread you are replying to. If they named nobody, leave the recipient blank, finish the subject and body, and say who it still needs to go to — never choose someone from contacts, suggestions, recent mail, or memory.",
      "- Do NOT click Send unless the user's request explicitly asks to send. Otherwise leave the draft open and report it is ready.",
    );
    if (wantsAttachment) {
      goalParts.push(
        "- A file attachment will be added after the draft is complete — do NOT send under any circumstances; leave the compose window open once the fields are filled.",
      );
      // Artifact sends carry link + file: put the live link in the body too.
      const artifactLiveUrl =
        !agent.lastImage?.url && agent.lastArtifact?.code ? shareableArtifactUrl(agent) : "";
      if (artifactLiveUrl) {
        goalParts.push(
          `- Include this live link to the artifact in the email body on its own line: ${artifactLiveUrl}`,
        );
      }
    }

    showBrowserWindow?.(agent.id, { focus: false, label: agent.title || "Agent" });
    emitProgress(agent.id, {
      status: "running",
      step: isRevision ? "Updating the draft…" : isReply ? "Writing the reply…" : "Composing the email…",
      url: liveUrl,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: isRevision ? "Updating the draft…" : isReply ? "Writing the reply…" : "Composing the email…",
    });

    // Only a reply that plainly approves the send the agent just prepared
    // authorizes the committing click. A first-run compose always stops for
    // confirmation, however plainly it asked for a send — the user has not
    // seen the message yet, and this variable was computed and then never
    // used, which is why "write an email to X" sent itself. The attachment
    // flow additionally has to wait for the file, so it never pre-approves.
    const sendApproved = looksLikeSendApprovalFollowUp(text);
    const result = await runBrowserTaskViaExecutor(agent, goalParts.join("\n"), gen, wc, {
      convHistory: historyForPlanner(agent),
      maxRounds: 18,
      sendPolicy: wantsAttachment ? "ask" : sendApproved ? "approved" : "auto",
      // Send pre-approval must be judged on the user's own words only — the
      // enriched goal above mentions "Send" in its instructions. When a file
      // still has to be attached, neutralize send verbs so the agent cannot
      // pre-approve Send before the attachment exists; we click Send
      // deterministically after attaching instead.
      userAsk: wantsAttachment
        ? effectiveText.replace(/\b(send|forward)\b/gi, "prepare")
        : effectiveText,
    });
    if (!result?.ok && result?.error === "aborted") return "";

    // Attach the deliverable now that the draft is filled, then honor an
    // explicit send ask deterministically.
    let attachNote = "";
    let sentNote = "";
    let attachReadyForApproval = false;
    if (wantsAttachment && result?.ok && !result?.stuck) {
      const file = await materializeDeliverableFile(agent);
      if (file?.path) {
        sendToAgentChannels(agent.id, "lykn:agent-status", { status: `Attaching ${file.name}…` });
        const attached = await ownedBrowserAct
          .attachFileToGmailCompose(wc, file.path)
          .catch((e) => ({ ok: false, error: e?.message || String(e) }));
        if (gen !== agent.generation) return "";
        attachNote = attached?.ok
          ? `\n\nAttached **${file.name}**.`
          : `\n\nI couldn't auto-attach **${file.name}**${attached?.error ? ` (${attached.error})` : ""} — the file is saved at \`${file.path}\` so you can drag it in.`;
        if (attached?.ok && sendApproved) {
          sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Sending…" });
          const sent = await ownedBrowserAct.clickGmailSend?.(wc).catch(() => null);
          sentNote = sent?.ok
            ? "\n\n**Sent.**"
            : "\n\nEverything is filled and attached, but I couldn't click Send — hit Send in the tab or tell me to try again.";
        } else if (attached?.ok) {
          // Review-first: never auto-send a fresh compose, even an explicit
          // "send X to Y" — the user gets a look first.
          sentNote = "\n\nLook it over and tell me any changes — say \"send it\" when you're ready.";
          attachReadyForApproval = true;
        }
      } else {
        attachNote = "\n\nI couldn't find the file to attach — tell me which image or artifact you mean.";
      }
    }

    // The agent stopped to ask the user something (content, clarification) —
    // nothing was drafted. Remember the ask so the next message resumes THIS
    // compose as the answer, and do NOT record a draft that doesn't exist
    // (that misclassified the answer as a "revision" of a phantom draft).
    const waitingOnUser = !!(result?.stuck && result?.needsHelp);
    if (waitingOnUser) {
      agent.pendingMailAsk = { ask: effectiveText.slice(0, 2000), at: Date.now() };
    } else {
      // Remember the recipient so follow-up tone/subject revisions keep routing
      // here and keep the same To.
      const to =
        ownedBrowserAct.extractEmailAddress?.(effectiveText) ||
        prior?.to ||
        (isReply ? opened?.email : "") ||
        "";
      if (to) agent.lastMailDraft = { ...(agent.lastMailDraft || {}), to };
    }

    // Return keyboard focus to the glass bar (Gmail steals it during fill).
    // Never for a Bot's run: its conversation lives in the main chat, and
    // summoning Glass out of nowhere is exactly the wrong surface.
    if (!agent.headless) {
      try {
        focusOverlayComposer?.();
      } catch {
        /* ignore */
      }
    }

    const msg =
      (String(result?.answer || "").trim() ||
        "The draft is ready in Gmail — tell me if you want any changes.") +
      attachNote +
      sentNote;
    // The agent stopped on a question (subject line, missing detail, manual
    // step) — frame it as one. pendingMailAsk is already set above, so the
    // typed answer resumes THIS compose.
    if (waitingOnUser && !(result?.needsApproval || attachReadyForApproval)) {
      // effectiveText is the compose ask this question came out of — that is
      // what the user's answer resumes.
      return offerAgentQuestion(agent, msg, result?.answerOptions, { ask: effectiveText });
    }
    agent.partialText = msg;
    sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg, final: true });
    // Review pause before the final send → explicit Yes/No buttons. The
    // attach flow's "look it over" note is the same situation.
    if (result?.needsApproval || attachReadyForApproval) {
      offerSendApprovalChoice(agent, msg);
    }
    return msg;
  }

  async function runMailCompose(agent, text, gen, wc, opts = {}) {
    // Email compose/reply/revision runs through TaskRuntime -> BrowserExecutor
    // (communication skill, editing rules, send-approval gate, deterministic
    // attach). Transient retries live inside that execution. There is no
    // second compose engine.
    return runMailComposeModular(agent, text, gen, wc, opts);
  }

  function isGmailThreadUrl(url) {
    return /mail\.google\.com/i.test(String(url || "")) &&
      /(?:#|\/)(?:inbox|all|sent|drafts|starred|label\/[^/]+)\/[A-Za-z0-9]+/i.test(
        String(url || ""),
      );
  }

  async function waitForGmailThread(wc, timeoutMs = 3500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const u = wc.getURL?.() || "";
      if (isGmailThreadUrl(u)) return u;
      await ownedBrowserAct.waitForDomSettle(wc, 280);
    }
    return wc.getURL?.() || "";
  }

  async function openMailItemOnTab(agent, text, gen, wc, opts = {}) {
    emitProgress(agent.id, {
      status: "running",
      step: "Opening email…",
      url: agent.url || wc.getURL?.() || "",
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Opening email…" });
    // Ensure inbox is showing (not already a random page).
    const live = getLiveTabUrl(agent, wc) || "";
    if (!/mail\.google\.com/i.test(live) || ownedBrowserAct.looksLikeGmailPublicPage(live)) {
      try {
        const inbox = ownedBrowserAct.gmailInboxUrl();
        await ownedBrowserAct.navigate(wc, inbox);
        agent.url = wc.getURL?.() || inbox;
        syncAgentBrowserTabs({ focusId: agent.id });
      } catch {
        /* keep */
      }
    }
    const ready = await ownedBrowserAct.waitForMailReady?.(wc, { timeoutMs: 5000 });
    if (ready?.error === "sign_in_required") {
      const pause = await pauseForUserSignIn(agent, gen, wc, { context: "opening an email" });
      if (pause.blocked && !pause.cleared) return pause.message || "";
    }
    const idx = ownedBrowserAct.extractMailOpenIndex?.(text) ?? 0;
    const hint =
      ownedBrowserAct.extractQuotedTitle(text) ||
      (String(text || "").match(
        /\bfrom\s+([A-Za-z][\w.&' -]{1,60}?)(?=\s+(?:and\b|then\b|open\b|click\b|read\b|,|\.|$))/i,
      ) || [])[1] ||
      (String(text || "").match(/\bfrom\s+([A-Za-z][\w.-]{1,40})/i) || [])[1] ||
      "";
    let clicked = await ownedBrowserAct.clickGmailInboxRow?.(wc, { index: idx, hint });
    if (!clicked?.ok) {
      await ownedBrowserAct.waitForDomSettle(wc, 500);
      clicked = await ownedBrowserAct.clickGmailInboxRow?.(wc, { index: idx, hint });
    }
    // Confirm the thread actually opened — a no-op click used to leave us on inbox.
    let threadUrl = await waitForGmailThread(wc, 3200);
    if (!isGmailThreadUrl(threadUrl)) {
      emitProgress(agent.id, {
        status: "running",
        step: "Retrying email open…",
        url: agent.url,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Retrying email open…" });
      clicked = await ownedBrowserAct.clickGmailInboxRow?.(wc, { index: idx, hint });
      threadUrl = await waitForGmailThread(wc, 3200);
    }
    if (!clicked?.ok && !isGmailThreadUrl(threadUrl)) {
      // Fall back to adaptive click loop.
      return runAdaptiveBrowse(agent, text, gen, wc, opts || {});
    }
    // Click reported ok but hash never left #inbox — keep trying via adaptive.
    if (!isGmailThreadUrl(threadUrl)) {
      return runAdaptiveBrowse(agent, text, gen, wc, opts || {});
    }
    await ownedBrowserAct.waitForDomSettle(wc, 450);
    agent.url = threadUrl || wc.getURL?.() || agent.url;
    syncAgentBrowserTabs({ focusId: agent.id });
    const page = await ownedBrowserAct.getPageContextRich(wc);
    const label = clicked?.label || page.rows?.[idx] || "email";
    // Persist thread context for later steps ("draft a response for that email").
    try {
      const thread = await ownedBrowserAct.extractOpenMailThread?.(wc);
      const labelBits = String(label || "")
        .split(/\s+[—–\-]\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const email =
        thread?.email ||
        ownedBrowserAct.extractEmailAddress?.(thread?.body || "") ||
        ownedBrowserAct.extractEmailAddress?.(label) ||
        "";
      rememberOpenedMail(agent, {
        label,
        from: thread?.from || labelBits[0] || "",
        sender: thread?.from || labelBits[0] || "",
        email,
        subject: thread?.subject || labelBits[1] || "",
        body: thread?.body || "",
        url: thread?.url || agent.url || "",
      });
    } catch {
      rememberOpenedMail(agent, { label, url: agent.url || "" });
    }
    if (!isGmailThreadUrl(agent.url)) {
      const msg =
        "I opened Gmail but couldn't get into the email thread. Ask me to open the first email again.";
      if (opts.silent) return msg;
      return paintBrowseDone(agent, msg);
    }
    // Sub-step for reply drafting — keep context, don't paint a finished Glass turn.
    if (opts.silent) {
      return `Opened email${label ? `: ${label}` : ""}`;
    }
    // Finish from the scrape immediately — don't wait on a summary model call.
    return finishBrowseResult(agent, text, gen, wc, {
      page,
      url: agent.url,
      label,
      forceQuick: true,
      suppressDone: !!opts.suppressDone,
    });
  }

  async function actOnCurrentTab(agent, text, gen, wc, inPageUrl, opts = {}) {
    const currentUrl = getLiveTabUrl(agent, wc);
    agent.url = currentUrl;
    showBrowserWindow?.(agent.id, { focus: false, label: agent.title || "Agent" });
    syncAgentBrowserTabs({ focusId: agent.id });

    // Download last image/artifact to disk (no email).
    if (
      /\b(download|save)\b.{0,40}\b(it|this|that|the\s+(image|picture|photo|artifact|file|html|pdf))\b/i.test(
        text,
      ) ||
      /\b(download|save)\b.{0,20}\b(image|picture|artifact|file)\b/i.test(text)
    ) {
      if (agent.lastImage?.url || agent.lastArtifact?.code) {
        emitProgress(agent.id, {
          status: "running",
          step: "Saving file…",
          skill: "browse",
        });
        const file = await materializeDeliverableFile(agent);
        if (file?.path) {
          return paintBrowseDone(
            agent,
            `Saved **${file.name}** here:\n\`${file.path}\`\n\nSay **email it to you@domain.com** and I'll attach & send it.`,
          );
        }
      }
    }

    // Share-the-open-page asks stay on this tab (Share dialog), never Gmail compose.
    // Sending an agent-made image/artifact goes through Gmail attach instead.
    const sendDeliverable =
      ownedBrowserAct.looksLikeSendDeliverableAsk?.(text) &&
      !!(agent.lastImage?.url || agent.lastArtifact?.code || agent.lastDownloadedFile?.path);
    if (sendDeliverable) {
      return sendDeliverableByEmail(agent, text, gen, wc);
    }
    // "Share this with bob@x.com" means the page in front of the user. Two
    // things have to be true before that reading is safe, and neither was
    // checked: the open page has to BE something worth sending, and the ask
    // has to be about it rather than about something the agent still has to go
    // and find.
    //
    // Both failed together in a real run. The user asked to verify a Drive
    // folder existed and send it; the tab was on google.com; the runtime froze
    // "the current page" into an email body before any browsing happened, and
    // the agent dutifully emailed a link to google.com. The thing to send was
    // not knowable until the folder had been found.
    const linkWorthSharing =
      !!currentUrl &&
      /^https?:\/\//i.test(currentUrl) &&
      !ownedBrowserAct.looksLikeMarketingOrHomeUrl?.(currentUrl, "") &&
      !ownedBrowserAct.isPlaceholderAgentUrl?.(currentUrl);
    const sharesCurrentPage =
      !ownedBrowserAct.looksLikeSignedInMailUrl(currentUrl) &&
      !/mail\.google\.com/i.test(currentUrl || "") &&
      linkWorthSharing &&
      !askNeedsFindingFirst(text) &&
      ownedBrowserAct.looksLikeShareCurrentPageAsk?.(text);
    // The in-page Share dialog flow only exists on document editors (Docs,
    // Notion, Figma, Canva, Drive). Sharing any OTHER page (YouTube video,
    // article, product) to an email means: email them the link via Gmail.
    if (
      sharesCurrentPage &&
      !ownedBrowserAct.looksLikeCanvasEditorUrl?.(currentUrl) &&
      !/drive\.google\.com/i.test(currentUrl || "")
    ) {
      // Sharing the agent-built artifact itself → recipients should get the
      // link AND the actual file, so route through the attach flow instead of
      // a link-only email.
      const artifactUrl = String(agent.lastArtifact?.url || "").trim();
      const onArtifactPage =
        !!agent.lastArtifact?.code &&
        ((artifactUrl && currentUrl && currentUrl === artifactUrl) ||
          /^data:|^lykn-artifact:/i.test(String(currentUrl || "")));
      if (onArtifactPage) {
        return sendDeliverableByEmail(agent, text, gen, wc);
      }
      const pageUrl = String(agent.url || currentUrl || wc?.getURL?.() || "").trim();
      const pageTitle = String(agent.lastBrowseTitle || wc?.getTitle?.() || "").trim();
      const shareRecipients = (String(text || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).join(", ");
      // Deliberately NOT phrased as "send it/this" — that wording triggers the
      // "email my previously composed content verbatim" path, which pasted the
      // agent's own chat summary into the email body.
      const mailAsk =
        `${String(text || "").trim()}\n` +
        `Send a Gmail email${shareRecipients ? ` to ${shareRecipients}` : ""}. ` +
        `The ENTIRE body is: one short friendly sentence introducing the link, then this link on its own line: ${pageUrl}` +
        `${pageTitle ? ` (the page is titled "${pageTitle}")` : ""}. ` +
        `Nothing else goes in the body — no summaries, reports, or extra sections.`;
      return runMailCompose(agent, mailAsk, gen, wc, { linkShare: true });
    }
    const onMailTab =
      ownedBrowserAct.looksLikeSignedInMailUrl(currentUrl) ||
      /mail\.google\.com/i.test(currentUrl || "") ||
      !!ownedBrowserAct.isGmailComposeUrl?.(currentUrl);
    const mailRevisionHere = ownedBrowserAct.looksLikeMailDraftRevision(text, {
      hasMailDraft: !!agent.lastMailDraft,
      onMail: onMailTab,
    });
    if (
      !sharesCurrentPage &&
      !ownedBrowserAct.namesNonMailVenue?.(text) &&
      (ownedBrowserAct.looksLikeMailComposeTask(text) ||
        ownedBrowserAct.looksLikePasteIntoCompose(text) ||
        (mailRevisionHere && (onMailTab || !!agent.lastMailDraft)))
    ) {
      return runMailCompose(agent, text, gen, wc);
    }

    // Open first / Nth email on the live Gmail tab — no slow LLM click loop.
    if (
      ownedBrowserAct.looksLikeOpenMailItem?.(text) &&
      (ownedBrowserAct.looksLikeSignedInMailUrl(currentUrl) ||
        /mail\.google\.com/i.test(currentUrl || ""))
    ) {
      return openMailItemOnTab(agent, text, gen, wc, opts);
    }

    // "click that link" / "open the subscribe button" on the current page.
    if (
      /\b(click|open|tap|press|follow)\b.{0,48}\b(link|button|here|that|this|it)\b/i.test(text) &&
      currentUrl &&
      !ownedBrowserAct.looksLikeOpenSearchResult(text)
    ) {
      const hint =
        ownedBrowserAct.extractQuotedTitle(text) ||
        (String(text || "").match(
          /\b(?:click|open|tap|press|follow)\s+(?:on\s+|the\s+)?["“]?(.+?)["”]?\s*$/i,
        ) || [])[1] ||
        "";
      if (hint || /\b(first|top)\s+link\b/i.test(text)) {
        emitProgress(agent.id, {
          status: "running",
          step: hint ? `Clicking “${String(hint).slice(0, 40)}”…` : "Clicking link…",
          url: currentUrl,
          skill: "browse",
        });
        sendToAgentChannels(agent.id, "lykn:agent-status", {
          status: hint ? `Clicking “${String(hint).slice(0, 40)}”…` : "Clicking link…",
        });
        const clicked = await ownedBrowserAct.clickInPageByHint?.(wc, {
          hint: hint || "",
          index: 0,
        });
        if (clicked?.ok) {
          await ownedBrowserAct.waitForDomSettle(wc, 500);
          agent.url = wc.getURL?.() || clicked.href || agent.url;
          syncAgentBrowserTabs({ focusId: agent.id });
          const page = await ownedBrowserAct.getPageContext(wc);
          const msg =
            `Clicked **${clicked.label || hint || "link"}**` +
            (agent.url ? `\n\n${agent.url}` : "") +
            `\n\nPage title: ${page.title || "page"}`;
          return finishBrowseTurn(agent, msg, {
            goal: text,
            url: agent.url,
            title: page.title || "",
            pageText: page.text || "",
          });
        }
      }
    }

    // "check my drafts" on Gmail → open the Drafts label, then summarize.
    if (ownedBrowserAct.looksLikeMailDraftsReview?.(text)) {
      const draftsUrl =
        ownedBrowserAct.resolveInPageTargetUrl(text, currentUrl) ||
        ownedBrowserAct.gmailDraftsUrl?.() ||
        "https://mail.google.com/mail/u/0/#drafts";
      emitProgress(agent.id, {
        status: "running",
        step: "Opening drafts…",
        url: draftsUrl,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Opening drafts…" });
      try {
        const nav = await ownedBrowserAct.navigate(wc, draftsUrl);
        if (nav.ok) {
          agent.url = nav.url || draftsUrl;
          syncAgentBrowserTabs({ focusId: agent.id });
        }
      } catch {
        /* keep current */
      }
      return summarizeCurrentTab(agent, text, gen, wc);
    }

    // YouTube (etc.) results: click the named / first video instead of chat-refusing.
    if (
      currentUrl &&
      ownedBrowserAct.looksLikeOpenSearchResult(text) &&
      (/youtube\.com|youtu\.be/i.test(currentUrl) || /[?&]search_query=|\/results\?/i.test(currentUrl))
    ) {
      const prior = priorAssistantText(agent);
      const hint =
        ownedBrowserAct.extractQuotedTitle(text) ||
        ownedBrowserAct.extractQuotedTitle(prior) ||
        "";
      const wantFirst =
        /\b(first|one of these|any|a video|top)\b/i.test(text) ||
        /\bclick on one\b/i.test(text);
      emitProgress(agent.id, {
        status: "running",
        step: hint ? `Opening “${hint.slice(0, 40)}”…` : "Opening a result…",
        url: currentUrl,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: hint ? `Opening “${hint.slice(0, 40)}”…` : "Opening a result…",
      });
      const clicked = await ownedBrowserAct.clickSearchResultOnPage(wc, {
        hint,
        index: wantFirst || !hint ? 0 : 0,
      });
      if (clicked?.ok) {
        await ownedBrowserAct.waitForDomSettle(wc, 1600);
        agent.url = wc.getURL?.() || clicked.href || agent.url;
        syncAgentBrowserTabs({ focusId: agent.id });
        const title = clicked.title || hint || "video";
        const msg =
          `Opened **${title}** in this agent's browser` +
          (agent.url ? `\n\n## Link\n${agent.url}` : "");
        return finishBrowseTurn(agent, msg, {
          goal: text,
          url: agent.url,
          title,
        });
      }
      // Fall through to adaptive browse if DOM click missed.
    }

    if (inPageUrl) {
      emitProgress(agent.id, {
        status: "running",
        step: "Opening page on this site…",
        url: inPageUrl,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: "Opening page on this site…",
      });
      const nav = await ownedBrowserAct.navigate(wc, inPageUrl);
      if (nav.ok) {
        agent.url = nav.url || inPageUrl;
        syncAgentBrowserTabs({ focusId: agent.id });
        // "go to the sign in page" — deep link is enough; don't burn a click loop.
        if (
          /\b(sign[- ]?in|log[- ]?in|login|sign[- ]?up|register)\b/i.test(text) &&
          !/\b(click|fill|type|submit|enter|password|email)\b/i.test(text)
        ) {
          await ownedBrowserAct.waitForDomSettle(wc, 1000);
          const page = await ownedBrowserAct.getPageContext(wc);
          const title = page.title || wc.getTitle?.() || "page";
          const opened = agent.url || inPageUrl;
          const msg =
            `Opened **${opened}** in this agent tab.\n\n` +
            `Page title: ${title}\n\n` +
            `You can sign in here — tell me when you're done or what to do next.`;
          agent.partialText = msg;
          sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
          return msg;
        }
      }
      // Fall through to adaptive click if deep-link nav failed.
    }

    // Share asks: click Share → type email → Send with a deterministic path
    // first. Vision planners keep narrating this without landing the clicks.
    // Review-first: this deterministic path clicks Send itself, so it only
    // runs when the message is the user's approval of a prepared share; a
    // fresh share ask goes through the modular agent, which fills the dialog
    // and pauses for the user's OK before the final click.
    if (sharesCurrentPage && looksLikeSendApprovalFollowUp(text) && ownedBrowserAct.sharePageWithEmail) {
      emitProgress(agent.id, {
        status: "running",
        step: "Opening Share…",
        url: agent.url || currentUrl,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Opening Share…" });
      const shared = await ownedBrowserAct.sharePageWithEmail(wc, { ask: text });
      if (gen !== agent.generation) return "";
      agent.url = wc.getURL?.() || agent.url || currentUrl;
      // Finish when Share succeeded (toast verified OR soft: Send clicked + dialog closed).
      if (shared?.ok && !shared.stuck) {
        return paintBrowseDone(agent, shared.message || `Shared with ${shared.email}.`);
      }
      emitProgress(agent.id, {
        status: "running",
        step: "Finishing share — entering email and sending…",
        url: agent.url,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: "Finishing share — entering email and sending…",
      });
    }

    emitProgress(agent.id, {
      status: "running",
      step: "Working on this page…",
      url: agent.url || currentUrl,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Working on this page…" });
    const tabCtx = {
      priorGoal: priorUserGoalBeforeLatest(agent),
      priorAssistant: priorAssistantText(agent),
      recentUserGoals: recentUserGoals(agent, 6),
      lastBrowseQuery: agent.lastBrowseQuery || "",
      currentUrl: currentUrl || agent.url || "",
      priorUrl: agent.lastBrowseUrl || "",
      pageTitle: agent.lastBrowseTitle || "",
      forceContinuation: !!opts?.fromSuggestion || !!agent._fromSuggestion,
    };
    let adaptiveGoal =
      ownedBrowserAct.composeAdaptiveBrowseGoal?.(text, tabCtx) ||
      ownedBrowserAct.expandDeicticFollowUp?.(text, tabCtx) ||
      text;
    if (sharesCurrentPage) {
      const recipients = (String(text || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).join(", ");
      adaptiveGoal =
        `Share the OPEN document with ${recipients || "the person the user named"} via this page's Share dialog. ` +
        `VERIFY each step: (1) Share dialog open, (2) type ${recipients || "their email"} into Add people until the chip shows, ` +
        `(3) click the dialog's blue Send / Send invite button ONLY, (4) confirm invitation-sent text. ` +
        `CRITICAL: After the email chip appears, NEVER click Cancel, Close, Done, Discard, the X, or outside the dialog — ` +
        `that discards the invite. NEVER re-click the top toolbar Share button (it closes the dialog). ` +
        `Only Send inside the dialog finishes the task. ` +
        `Ask: ${String(text || "").trim().slice(0, 180)}`;
    }
    const result = await runAdaptiveBrowse(agent, text, gen, wc, {
      ...(opts || {}),
      adaptiveGoal,
      conversationHistory: historyForPlanner(agent),
      returnRaw: !!sharesCurrentPage,
      maxRounds: sharesCurrentPage ? 22 : opts?.maxRounds,
    });
    if (sharesCurrentPage && result && typeof result === "object") {
      const recipients = (String(text || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []);
      let pageText = "";
      try {
        const page = await ownedBrowserAct.getPageContext(wc);
        pageText = `${page.title || ""}\n${page.text || ""}`;
      } catch {
        /* ignore */
      }
      const pageComplete = recipients.length
        ? recipients.every((e) =>
            ownedBrowserAct.pageShowsShareInviteComplete?.(pageText, e),
          )
        : ownedBrowserAct.pageShowsShareInviteComplete?.(pageText);
      const historyComplete = ownedBrowserAct.historyShowsShareSendDone?.(
        result.history || [],
        recipients,
      );
      const dialogStillOpen = ownedBrowserAct.pageShowsShareDialogOpen?.(pageText);
      // Success if page shows invite-sent / post-send UI, OR we already typed+Sent
      // and the invite dialog is gone (a follow-up screen is fine).
      const verifiedShare =
        result.ok &&
        (pageComplete ||
          result.satisfiedEarly ||
          (historyComplete && !dialogStillOpen) ||
          (historyComplete && pageComplete));
      if (verifiedShare) {
        return paintBrowseDone(
          agent,
          result.answer ||
            `Shared with **${recipients[0] || "the recipient"}** from this page.`,
        );
      }
      // Incomplete — honest stuck message, never "Share step finished."
      // But if the adaptive loop already produced a success answer, prefer that.
      if (
        result.ok &&
        !result.stuck &&
        /\bshared with\b/i.test(String(result.answer || ""))
      ) {
        return paintBrowseDone(agent, result.answer);
      }
      return paintBrowseDone(
        agent,
        result.answer ||
          `I couldn't finish sharing${recipients[0] ? ` with **${recipients[0]}**` : ""} — ` +
            `the invite is not confirmed yet. The Share dialog may still be open in the tab. ` +
            `Tell me to continue and I'll keep going.`,
      );
    }
    return result;
  }

  return {
    shareableArtifactUrl,
    materializeDeliverableFile,
    sendDeliverableByEmail,
    runMailComposeModular,
    runMailCompose,
    isGmailThreadUrl,
    waitForGmailThread,
    openMailItemOnTab,
    actOnCurrentTab,
  };
}

module.exports = { createMailRouting };
