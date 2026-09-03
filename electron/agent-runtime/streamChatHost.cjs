"use strict";

/**
 * Non-executor chat delivery host. Streams a model reply for conversational
 * and summary turns. Does not own Task terminal state.
 */
function createStreamChatHost(host) {
  async function streamChat(agent, text, attachments, skill, gen, opts = {}) {
    const {
      getAuthToken,
      referencesCurrentScreen,
      askMentionsLiveSiteHost,
      resolvePageContextWebContents,
      ownedBrowserAct,
      artifactBuildIntent,
      looksLikeArtifactConversion,
      looksLikeDeliverableEdit,
      priorAssistantText,
      getKnownSheetText,
      isMainAgent,
      formatRosterForMain,
      AGENT_MODE_STEP_DOCTRINE,
      getMainLinkedBrowserId,
      getBrowsingContext,
      sendToAgentChannels,
      emitProgress,
      apiBase,
      readStreamResponse,
      stripInlineWantMeSuggestions,
    } = host;
    const mainLinkedBrowserId = typeof getMainLinkedBrowserId === "function"
      ? getMainLinkedBrowserId()
      : "";
    if (opts.signal?.aborted) throw new Error("Task aborted.");
    const token = await getAuthToken().catch(() => null);
    if (!token) {
      throw new Error("Sign in to LYKN first. Open the main LYKN window and log in, then try again.");
    }
    const questionsOnly = !!opts.questionsOnly;
    const isLive = () =>
      questionsOnly ? gen === agent.askGeneration : gen === agent.generation;
    // browse-summary must not reuse prior "please sign in" turns — they override the scrape.
    // Browser-rail questions use their own thread so Bot work never mixes in.
    const history = questionsOnly
      ? (Array.isArray(agent.askHistory) ? agent.askHistory : []).slice(-12)
      : skill === "browse-summary"
        ? []
        : agent.history.slice(-12);
    const textLimit =
      skill === "browse-summary" ||
      skill === "build" ||
      skill === "report-edit" ||
      skill === "research"
        ? 14000
        : 4000;
    let effectiveText = String(text || "");

    // Live page awareness. Conversational turns always get the open page as
    // context. Deliverable turns (report/artifact/image) get it as SOURCE
    // MATERIAL when the ask references the current screen ("based on this
    // page", "report on what I'm looking at"). Best-effort; never blocks.
    let livePageBlock = "";
    const deliverableSkill =
      skill === "build" || skill === "research" || skill === "report-edit" || skill === "image";
    const screenSourced =
      deliverableSkill &&
      // Multi-step plans: a deliverable step right after a browse step is
      // always about what the browse landed on ("check my ads → create a report").
      (!!opts.forceScreenSourced ||
        referencesCurrentScreen(text, {
          hasPriorDeliverable: !!(agent.lastResearchReport || agent.lastArtifact?.code),
        }) ||
        askMentionsLiveSiteHost(text, agent.url));
    // A live tab in this chat is the DEFAULT source for report/artifact asks —
    // the user should not have to say "based on this page" for a report to use
    // the data on their screen. Explicit references just make it primary.
    // (Edits/conversions of an existing deliverable and image gen are excluded —
    // those already have their own source.)
    const livePageDefault =
      !screenSourced &&
      (skill === "research" || skill === "build") &&
      !(skill === "build" && (agent.lastArtifact?.code || agent.lastResearchReport));
    // Headless agents (Bots) must not read the user's open page — they aren't
    // connected to the browser, so their answers come from the conversation.
    // Browser-rail questions still ground on the tab even when a Bot owns it.
    if ((skill === "general" || screenSourced || livePageDefault) && (!agent.headless || questionsOnly)) {
      try {
        const wc = resolvePageContextWebContents(agent);
        if (wc && !wc.isDestroyed?.()) {
          const page = await ownedBrowserAct.getPageContext(wc);
          const url = String(page?.url || wc.getURL?.() || "").trim();
          if (url && !ownedBrowserAct.isPlaceholderAgentUrl(url)) {
            const pageTitle = String(page?.title || wc.getTitle?.() || "").slice(0, 160);
            const pageQuestionAsk =
              skill === "general" &&
              (!!ownedBrowserAct.looksLikePageQuestionAsk?.(text) ||
                !!ownedBrowserAct.looksLikeCasualConversation?.(text) ||
                /\b(screen|page|tab|here|looking at)\b/i.test(String(text || "")));
            const pageText = String(page?.text || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(
                0,
                screenSourced ? 12000 : livePageDefault || pageQuestionAsk ? 10000 : 2500,
              );
            // Markers must match Glass stream persona (PAGE CONTENT / FULL_PAGE)
            // or the model will claim it can't see the screen.
            livePageBlock = [
              pageQuestionAsk || skill === "general"
                ? "[PAGE CONTENT — this IS their open browser tab right now. Answer from it. Never say you can't see their screen, lack page contents, or need a screenshot — the text below is the screen.]"
                : screenSourced
                  ? "[PAGE CONTENT — PRIMARY source for this deliverable. Do not ignore it or research something else instead.]"
                  : "[PAGE CONTENT — open browser tab. Prefer this when the ask is about the page or its data.]",
              `URL: ${url}`,
              pageTitle ? `Title: ${pageTitle}` : "",
              pageText
                ? `--- FULL PAGE TEXT ---\n${pageText}\n--- END FULL PAGE ---`
                : "(Little extractable DOM text — still answer from URL/title and visible chrome; do not claim you lack screen access.)",
            ]
              .filter(Boolean)
              .join("\n");
          }
        }
      } catch {
        /* page context is best-effort */
      }
    }
    const redesignOpenArtifact =
      skill === "build" &&
      !!agent.lastArtifact?.code &&
      artifactBuildIntent.isRedesignAsk(text);
    const refiningArtifact =
      skill === "build" &&
      !!agent.lastArtifact?.code &&
      !redesignOpenArtifact &&
      !looksLikeArtifactConversion(text) &&
      !artifactBuildIntent.isTypedNewDeliverableAsk(text) &&
      (looksLikeDeliverableEdit(text) || agent.lastDeliverableKind === "artifact");

    if (skill === "report-edit" && agent.lastResearchReport) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[Prior research report OPEN in this agent's tab — apply the user's edits and return the FULL updated report in markdown. ` +
        `Do NOT start a new deep-research crawl. Do NOT tell the user you cannot edit it.]\n\n` +
        String(agent.lastResearchReport).slice(0, 11000);
    } else if (skill === "build" && redesignOpenArtifact) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[An interactive artifact is OPEN — the user asked for a FULL visual/palette restyle or redesign. ` +
        `Rewrite the artifact completely (full_rewrite) to match their ask. Keep the same content/structure where possible, ` +
        `but replace the entire color system / look. Do NOT do a tiny surgical patch. Do NOT say the refine guard blocked you.]\n`;
    } else if (skill === "build" && refiningArtifact) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[An interactive artifact is OPEN in this agent's tab. Apply the user's edits to THAT artifact via the refine/build tool. ` +
        `Do NOT start unrelated research. Do NOT say you cannot edit it.]\n`;
    } else if (skill === "build" && agent.lastResearchReport && !screenSourced) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[Prior research report from THIS agent — convert THIS content into an interactive artifact/webapp. ` +
        `Do NOT run new deep research. Do NOT write another markdown report. ` +
        `You MUST call the React artifact / Create tool and produce a live presentation UI now.]\n\n` +
        String(agent.lastResearchReport).slice(0, 11000);
      if (agent.url || agent.lastBrowseQuery) {
        effectiveText +=
          `\n\n[Visual inspo from the previous browse step` +
          (agent.url ? `: ${agent.url}` : "") +
          (agent.lastBrowseQuery ? ` (searched “${agent.lastBrowseQuery}”)` : "") +
          `. Match that aesthetic (colors, layout cues) in the presentation.]`;
      }
    } else if (skill === "build" && looksLikeArtifactConversion(text) && !screenSourced) {
      const prior = priorAssistantText(agent);
      if (prior && prior.length > 200) {
        effectiveText =
          `${effectiveText}\n\n` +
          `[Prior assistant content from THIS agent — convert into an interactive artifact/webapp. ` +
          `Do NOT run new deep research.]\n\n` +
          prior.slice(0, 11000);
      }
    } else if (skill === "image" && agent.lastImage?.url) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[Prior generated image in this agent: ${agent.lastImage.url}. Regenerate/edit with lykn_generate_image; keep continuity with that image when asked.]\n`;
    } else if (skill === "research" && livePageBlock) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[When the open page's data is the source: write a complete, well-structured markdown report from THAT data — ` +
        `clear headings, key figures, and GitHub-flavored markdown tables where numbers exist. ` +
        `Each table MUST be multiline (header row, then a |---| separator row, then one data row per line) — ` +
        `never smash an entire table onto one line. Prefer a simple Metric | Result table for KPIs so a chart can render. ` +
        `Never invent numbers: use only figures visible in the page content, and note explicitly when something ` +
        `the user asked about is not shown on screen.]`;
    }

    // Sheets canvas scrapes look empty — always attach remembered grid contents.
    const knownSheet =
      String(agent.lastSheetText || "").trim() ||
      (ownedBrowserAct.looksLikeGoogleSheetsUrl?.(agent.url)
        ? getKnownSheetText(agent)
        : "");
    if (
      knownSheet.length > 20 &&
      (ownedBrowserAct.looksLikeGoogleSheetsUrl?.(agent.url) ||
        ownedBrowserAct.looksLikeOrganizeSheetAsk?.(text) ||
        ownedBrowserAct.looksLikePasteIntoSheets?.(text) ||
        agent.lastDeliverableKind === "sheets")
    ) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[IMPORTANT: This agent's Google Sheet ALREADY has data` +
        (agent.lastSheetSource ? ` (from ${agent.lastSheetSource})` : "") +
        `. Sheets is canvas-based so page scrapes often look blank — ` +
        `NEVER say the sheet is empty/blank. Organize/edit using this content:]\n\n` +
        knownSheet.slice(0, 10000);
    }

    const clipped = effectiveText.slice(0, textLimit);
    const openKind = String(agent.lastDeliverableKind || "").trim();
    const hasOpenDeliverable =
      (openKind === "artifact" && !!agent.lastArtifact?.code) ||
      (openKind === "report" && !!agent.lastResearchReport) ||
      (openKind === "image" && !!agent.lastImage?.url) ||
      !!agent.lastArtifact?.code ||
      !!agent.lastResearchReport ||
      !!agent.lastImage?.url;
    const openLabel =
      openKind === "artifact" || (!openKind && agent.lastArtifact?.code)
        ? `artifact${agent.lastArtifact?.title ? ` (“${agent.lastArtifact.title}”)` : ""}`
        : openKind === "report" || (!openKind && agent.lastResearchReport)
          ? "research report"
          : openKind === "image" || (!openKind && agent.lastImage?.url)
            ? "generated image"
            : "artifact, report, or image";
    const editCapabilityNote = hasOpenDeliverable
      ? `This agent's tab currently has an open ${openLabel}. You have full edit capability on it — ` +
        `apply changes in place (tools / rewrite) and reload that same tab. ` +
        `Never claim you cannot edit it, and never ask them to switch Create/Build/Research modes.\n`
      : "";

    const toolDraft = !!opts.toolDraft;
    const toolDraftVenue = String(opts.toolDraftVenue || "").trim();
    const softChat = skill === "general" && !toolDraft;
    // Polar-style tab awareness: casual chat knows what tabs/agents are open
    // (current tab already arrives via PAGE CONTENT).
    let softChatTabsNote = "";
    if (softChat && !isMainAgent(agent)) {
      try {
        const roster = String(formatRosterForMain() || "").trim();
        if (roster) {
          softChatTabsNote =
            `Open agent tabs right now (context only — mention when relevant, don't recite):\n${roster}\n`;
        }
      } catch {
        /* roster is best-effort */
      }
    }
    const botSoftChatPrompt =
      !questionsOnly && softChat && agent.headless && agent.botProfile
        ? [
            `You are ${agent.botProfile.name || "the user's Bot"}${
              agent.botProfile.role ? `, their ${agent.botProfile.role}` : ""
            } - a standing teammate inside LYKN.`,
            agent.botProfile.persona
              ? `Working style the user gave you:\n${agent.botProfile.persona}`
              : "",
            "Stay in this Bot identity. Do not introduce yourself unless they ask who you are.",
            "Small talk and one-fact answers stay short. A write-up, briefing, comparison, or anything they will keep is a formatted markdown report: title, short summary, headed sections, lists or a table, sources when you have them. Longer is better than a teaser.",
            "Do not call tools, invent a plan, or announce work for this reply-only turn.",
            "Never silently broaden the user's request or offer unrelated follow-up work.",
            `User: ${clipped}`,
          ]
            .filter(Boolean)
            .join("\n\n")
        : "";
    const botPolicy = agent.botProfile?.modelPolicy || { mode: "lykn" };
    const requestedModel = botPolicy.mode === "my_setup"
      ? "lykn-setup"
      : botPolicy.mode === "model" && botPolicy.modelId
        ? botPolicy.modelId
        : "lykn";
    const body = {
      model: requestedModel,
      modelPolicy: {
        mode: botPolicy.mode || "lykn",
        routeId: botPolicy.routeId || null,
        modelId: botPolicy.modelId || null,
        botId: agent.botProfile?.id || null,
      },
      botId: agent.botProfile?.id || null,
      intent: "ask",
      text: clipped,
      prompt: toolDraft
        ? `You are LYKN Agent Mode drafting plain text to paste into ${toolDraftVenue || "an already-open external tool"}.\n` +
          `The tool is ALREADY open. Output ONLY the requested body (essay, table TSV, outline, brief).\n` +
          `Never mention Build mode, Create mode, Glass, the + menu, or asking the user to resend.\n` +
          `No preamble. No code fences. No meta commentary.\n\n` +
          `Request:\n${clipped}`
        : skill === "browse-summary"
          ? `You are LYKN Agent Mode — a helpful coworker wrapping up browser work.\n` +
            `${AGENT_MODE_STEP_DOCTRINE}\n` +
            `Use ONLY the page content in the user message. Ignore any instinct to ask for sign-in ` +
            `unless that message explicitly says the tab is a login form with no inbox data.\n` +
            `Always explain what you found in plain language (don't dump raw UI chrome). ` +
            `Actively teach: what the page/dashboard means, what matters, and what is optional. ` +
            `Structure replies as: ## What I did → ## Link → ## Summary. ` +
            `Do NOT include “Want me to…” / follow-up questions — those appear in the UI above the chat bar. ` +
            `Never finish with only “What next?” or a one-line “Opened X”.\n\n` +
            `User:\n${clipped}`
          : isMainAgent(agent)
            ? `You are LYKN’s pinned Main agent — the orchestrator for Agent Mode.\n` +
              `${AGENT_MODE_STEP_DOCTRINE}\n` +
              `You manage sub-agents. Each sub-agent owns its own browser tab and runs research/build/browse work.\n` +
              `Live roster:\n${formatRosterForMain()}\n` +
              (mainLinkedBrowserId
                ? `Currently watching browser/tab for sub-agent id ${mainLinkedBrowserId.slice(0, 8)}.\n`
                : `No browser linked yet — the user can click a sub-agent browser tab while chatting with you.\n`) +
              `You are the chief of staff. Do the work yourself when you already can, especially a folder or file listing they attached, or "what's in this". ` +
              `Delegate only specialist work you cannot finish (implement / refactor / debug a codebase, or a long browser/tab loop).\n` +
              `When the user wants work done in a browser/tab, DELEGATE to that sub-agent. Do not pretend you browsed yourself.\n` +
              `When they want an EXISTING research report put into an open Google Sheet, that is a combine action ` +
              `(has_report + sheets on the roster) — never start a new research crawl for that.\n` +
              `When they name an external tool as the venue (“in PowerPoint”, “in Google Sheets”, “in Canva”), ` +
              `create inside that tool — not as a LYKN artifact. Plain “create me a presentation/budget” with no tool name → artifact.\n` +
              `To delegate, include exactly one marker on its own line:\n` +
              `[[lykn_delegate:SUB_AGENT_TITLE_OR_ID|clear instructions for that agent]]\n` +
              `Example: [[lykn_delegate:Agent 1|search pinterest for good incognito icons]]\n` +
              `You may also say “this browser” / “this tab” when a linked browser is set.\n` +
              `After the marker, tell the user you STARTED that sub-agent and what it is doing now ` +
              `(e.g. "Started Agent 1 — it's searching Pinterest for icons. I'll report back when it finishes."). ` +
              `Never stay silent after delegating.\n` +
              `You are ALREADY in Agent Mode — never tell them to switch modes.\n\n` +
              `User: ${clipped}`
            : questionsOnly
              ? `You are LYKN answering a question in the browser sidebar.\n` +
                `Answer the question. Do not operate the page, click, navigate, fill forms, send mail, or start a task.\n` +
                `When [PAGE CONTENT] / FULL PAGE TEXT is in the prompt, that IS the open tab — answer from it.\n` +
                `Never say you don't have the page or need a screenshot when PAGE CONTENT is present.\n` +
                `If they asked you to do something on the web rather than answer a question, say you can talk about what's on screen, and that a Bot can do the work.\n` +
                `Do NOT invent a working plan, call tools, or include “Want me to…” follow-up questions.\n\n` +
                `User: ${clipped}`
            : softChat
              ? botSoftChatPrompt ||
                (`You are LYKN — a sharp, friendly teammate chatting in the browser sidebar. ` +
                `Do not introduce yourself unless they ask who you are. Just answer.\n` +
                `You are also a real browser agent: when the user asks, you can open sites, click, type, fill forms, ` +
                `and complete multi-step tasks in their tabs — but only when they ask for work, never during chat.\n` +
                `Have a normal conversation. When [PAGE CONTENT] / FULL PAGE TEXT is in the prompt, that IS what is on their screen — ` +
                `answer from it, and reference what they're looking at naturally when it's relevant to the conversation.\n` +
                `Never say you don't have the page, can't see the screen, or need them to paste/screenshot — if PAGE CONTENT is present, you already have it.\n` +
                `Do NOT invent a working plan, step list, or browse/click loop for a chat message.\n` +
                `Do NOT call tools, navigate, click, or announce that you are "starting agent mode".\n` +
                `If they ask who you are or what you can do: you chat about anything, answer questions about the open tab, ` +
                `and take over the browser for real tasks (open pages, click buttons, type, fill forms, research, multi-step workflows) whenever they ask.\n` +
                `Answer like a human coworker: clear, concise, opinionated when asked, grounded in the page when relevant.\n` +
                `Small talk and general questions are fine — just reply.\n` +
                `Do NOT include “Want me to…” / follow-up questions — those appear in the UI above the chat bar.\n\n` +
                (softChatTabsNote ? `${softChatTabsNote}\n` : "") +
                `User: ${clipped}`)
            : `You are LYKN Agent Mode — a desktop cowork agent that researches, builds, browses, and edits deliverables.\n` +
              `Skill: ${skill}.\n` +
              `${AGENT_MODE_STEP_DOCTRINE}\n` +
              `You are ALREADY in Agent Mode. Never tell the user to switch modes, open Create/Build/Research, ` +
              `use a + menu, or resend in another composer mode — those UI paths are not available here. ` +
              `Just complete the task now (use tools / deep research / image gen when needed).\n` +
              `When you finish, explain what you did and what it means (What I did → Link → Summary when browsing). ` +
              `Do NOT include “Want me to…” / follow-up questions — those appear in the UI above the chat bar. ` +
              `Be a helpful teammate — not a silent tool that only says “Done”.\n` +
              editCapabilityNote +
              (skill === "build" && redesignOpenArtifact
                ? `FULL RESTYLE the open React artifact now (neutral/grayscale/palette swap = full_rewrite). Do not say a refine guard blocked you.\n`
                : "") +
              (skill === "build" && refiningArtifact
                ? `Refine the open React artifact surgically (or full rewrite if they ask for a redesign).\n`
                : "") +
              (skill === "build" && !refiningArtifact && !redesignOpenArtifact
                ? `Build what they asked for now with the React artifact / Create tool (app, page, deck, presentation, dashboard, calculator, quiz, tracker, form, interactive tool, etc.). ` +
                  `Produce a live UI deliverable — not an essay about how to build it, and never tell them to switch to Build/Create.\n`
                : "") +
              (skill === "report-edit"
                ? `Return the full updated markdown report only — it will replace the open report tab.\n`
                : "") +
              (skill === "image"
                ? `Use the image generation tool now. Never tell the user to switch to image mode. ` +
                  `After the image is generated, give a short confirmation only — do NOT search or dump Vault notes.\n`
                : "") +
              `\nUser: ${clipped}`,
      useTools:
        !softChat && skill !== "browse-summary" && skill !== "report-edit" && !toolDraft,
      overlayAsk: true,
      // Keep agentMode on for owned-browser chat so we don't get Glass
      // "arm Build" digressions; softChat only changes the prompt + tools.
      agentMode: true,
      ownedBrowser: true,
      ...(toolDraft ? { toolDraft: true } : {}),
      ...(Array.isArray(history) && history.length ? { conversation: history } : {}),
      ...(skill === "research"
        ? screenSourced && livePageBlock
          ? {
              // Screen-sourced report: write from the open page's data — a web
              // crawl would sideline the user's actual numbers.
              composerMode: "research",
              deepResearch: false,
              skipWebSearch: true,
              forceWebSearch: false,
              useTools: false,
            }
          : livePageDefault && livePageBlock
            ? {
                // Live tab attached as the default source — allow search as a
                // supplement, but don't force a crawl over the page data.
                composerMode: "research",
                deepResearch: false,
                skipWebSearch: false,
                forceWebSearch: false,
              }
            : {
                composerMode: "research",
                deepResearch: true,
                skipWebSearch: false,
                forceWebSearch: true,
              }
        : skill === "build"
          ? refiningArtifact || redesignOpenArtifact
            ? {
                composerMode: "create:webapp",
                // Surgical refine OR explicit palette/redesign (server treats redesign asks as full_rewrite).
                skipWebSearch: true,
                forceWebSearch: false,
                deepResearch: false,
                useTools: true,
                activeArtifact: {
                  toolName: agent.lastArtifact.toolName || "lykn_build_react_artifact",
                  title: agent.lastArtifact.title || "Artifact",
                  code: agent.lastArtifact.code,
                },
              }
            : {
                composerMode: "create:webapp",
                forceArtifact: true,
                artifactType: "webapp",
                // Sighted fresh builds skip search — their content comes from
                // the conversation or the open page. A headless Bot build has
                // no page and may be the task's ONLY pass over the topic
                // ("research X and turn it into a deck" is one build call, no
                // report first), so it must be allowed to ground itself; the
                // server's enrichment classifier still decides whether this
                // brief actually needs the web. A report already produced
                // this task IS the content — keep search off then.
                skipWebSearch: !agent.headless || !!agent.lastResearchReport,
                forceWebSearch: false,
                deepResearch: false,
              }
          : skill === "report-edit"
            ? {
                skipWebSearch: true,
                forceWebSearch: false,
                deepResearch: false,
                useTools: false,
              }
            : skill === "image"
              ? {
                  forceImage: true,
                  useTools: true,
                  skipWebSearch: true,
                  forceWebSearch: false,
                  deepResearch: false,
                }
          : skill === "browse-summary"
            ? {
                // Owned-tab summary only — no Serper "sources" that look like a fake browse.
                skipWebSearch: true,
                forceWebSearch: false,
                useTools: false,
              }
            : {
                skipWebSearch: false,
                forceWebSearch: /\b(search|latest|news|research|find)\b/i.test(text),
              }),
    };

    // Private browsing-habits context (from Chrome sync). Folded into the
    // system side of the prompt so the agent is *aware* of what the user
    // usually does — never surfaced to the user as a report/turn.
    try {
      const bc = typeof getBrowsingContext === "function" ? getBrowsingContext() : "";
      if (bc && typeof body.prompt === "string") {
        body.prompt =
          `Private background on this user (from their browser history — for your awareness only; ` +
          `do NOT repeat it back, list it, or write a report about it unless they explicitly ask):\n${bc}\n\n` +
          body.prompt;
      }
    } catch {
      /* context is best-effort */
    }
    // Prepend live page context so it's the freshest thing the model sees.
    if (livePageBlock && typeof body.prompt === "string") {
      body.prompt = `${livePageBlock}\n\n${body.prompt}`;
    }

    const atts = Array.isArray(attachments) ? attachments : [];
    const imageUrls = atts.filter((a) => a?.kind === "image" && a.dataUrl).map((a) => a.dataUrl);
    if (imageUrls.length) body.imageUrls = imageUrls;
    // Text attachments (documents, folder listings, extracted files) ride
    // inline — same as the Glass overlay path — or the turn ships nothing
    // but a filename. Appended to the prompt, not effectiveText, so the
    // per-skill text clip above can't truncate the user's own ask away.
    const textAtts = atts.filter((a) => a?.kind === "text" && a.text);
    if (textAtts.length && typeof body.prompt === "string") {
      body.prompt +=
        "\n\nAttached files (sent by the user with this request — use their contents):\n" +
        textAtts
          .map((a) => `--- ${a.name || "file"} ---\n${String(a.text).slice(0, 8000)}`)
          .join("\n\n");
    }

    const send = (channel, payload) => {
      if (!isLive()) return;
      sendToAgentChannels(
        agent.id,
        channel,
        questionsOnly ? { ...(payload || {}), ask: true } : payload,
      );
    };

    emitProgress(agent.id, {
      status: "running",
      step:
        skill === "report-edit"
          ? "Editing report…"
          : redesignOpenArtifact
            ? "Restyling artifact…"
            : refiningArtifact
              ? "Editing artifact…"
              : skill === "image"
                ? "Editing image…"
                : "Thinking…",
      skill,
      ...(questionsOnly ? { ask: true } : {}),
    });
    send("lykn:agent-status", {
      status:
        skill === "report-edit"
          ? "Editing report…"
          : redesignOpenArtifact
            ? "Restyling artifact…"
            : refiningArtifact
              ? "Editing artifact…"
              : skill === "image"
                ? "Editing image…"
                : "Thinking…",
    });

    const res = await fetch(`${apiBase}/api/ai/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal || agent.abort?.signal,
    });

    const suppressDone = !!opts.suppressDone;
    const mapSend = (channel, payload) => {
      // Remap overlay stream channels → agent channels. Always stash partial
      // text/status on the agent so switching back can restore the in-flight turn.
      if (channel === "lykn:answer-delta") {
        // Stream the growing summary into Glass so wrap-up never looks frozen
        // on a bare "Writing output…" spinner with no text.
        let text = String(payload?.text || "");
        // Suggestions live above the chat bar — never paint inline Want me to… mid-stream.
        if (skill === "browse-summary" || skill === "browse" || skill === "general") {
          text = stripInlineWantMeSuggestions(text);
        }
        if (questionsOnly) {
          agent.askPartialText = text;
          agent.askStep =
            text.length > 80
              ? `Writing… (${text.length.toLocaleString()} chars)`
              : "Thinking…";
        } else {
          agent.partialText = text;
        }
        const n = text.length;
        const status =
          n > 80
            ? `Writing output… (${n.toLocaleString()} chars)`
            : String((questionsOnly ? agent.askStep : agent.step) || "Working…").trim() || "Working…";
        if (!questionsOnly) agent.step = status;
        send("lykn:agent-status", { status });
        send("lykn:agent-delta", {
          text,
          status,
          writing: true,
          chars: n,
        });
      } else if (channel === "lykn:answer-status") {
        const status = String(payload?.status || "").trim();
        if (status) {
          if (questionsOnly) agent.askStep = status;
          else agent.step = status;
        }
        send("lykn:agent-status", payload);
      } else if (channel === "lykn:answer-sources") send("lykn:agent-sources", payload);
      else if (channel === "lykn:answer-error") send("lykn:agent-error", payload);
      else if (channel === "lykn:answer-done") {
        // Multi-step runs must NOT finalize the Glass turn between steps —
        // that looked like a finished reply + a duplicate user prompt.
        if (suppressDone) {
          const status = String(agent.step || "Working on next step…").trim();
          send("lykn:agent-status", { status });
        } else {
          // Land the streamed summary immediately so Glass isn't stuck on
          // "Writing output…" until the outer agent-done event.
          const text = String(agent.partialText || "").trim();
          if (text) {
            send("lykn:agent-delta", { text, final: true });
          }
          send("lykn:agent-status", {
            status: String(agent.step || "Finishing…").trim() || "Finishing…",
          });
        }
      } else send(channel, payload);
    };

    const accumulated = await readStreamResponse(res, mapSend, {
      // Image/build turns must not surface random vault cards after the deliverable.
      allowVaultSurface:
        skill !== "image" &&
        skill !== "build" &&
        skill !== "browse-summary" &&
        skill !== "report-edit" &&
        /\b(?:vault|saved|what\s+(?:have|did)\s+i\s+save|from\s+my\s+(?:notes?|vault))\b/i.test(
          String(text || ""),
        ),
      agentMode: true,
      agentId: agent.id,
      onAgentDeliverable: (d) => {
        if (!isLive() || !d) return;
        if (d.kind === "artifact" && d.code) {
          agent.lastArtifact = {
            toolName: d.toolName || "lykn_build_react_artifact",
            title: d.title || "Artifact",
            code: d.code,
            url: d.url || agent.lastArtifact?.url || "",
          };
          agent.lastDeliverableKind = "artifact";
        } else if (d.kind === "image" && d.url) {
          agent.lastImage = { url: d.url, title: d.title || "Generated image" };
          agent.lastDeliverableKind = "image";
        }
      },
    });
    if (!isLive()) return "";
    return stripInlineWantMeSuggestions(accumulated);
  }

  return { streamChat };
}

module.exports = { createStreamChatHost };
