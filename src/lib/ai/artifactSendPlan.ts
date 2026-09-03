// Build / refine / discuss intent classification for a chat send turn.
//
// Decides, from the user's words and the open artifact panel, whether this
// turn should surgically REFINE the open artifact, DISCUSS it read-only, or
// commission something fresh — and what composer mode actually ships to the
// server. Extracted verbatim from useChatEngine.handleChatSend (chat engine
// decomposition Wave 1, see docs/REFACTOR_LOG.md).
//
// IMPORTANT: the ~25 derived booleans below are interdependent and several
// are documented as mirrors of server-side logic ("keep in sync with
// server.js", "Mirror server isFreshWebappBuildAsk"). Do not simplify,
// combine, or reorder conditions — precedence is behavior.
//
// This function is PURE: no refs, no React state, no side effects. The two
// side effects the original block performed (forgetting the linked app on a
// fresh commission, and the "starting fresh" console log) stay at the call
// site in useChatEngine, driven by the returned values.
import type { ComposerMode } from "@/hooks/useChatEngine";
import { type ChatArtifact, isEditableArtifact } from "@/lib/ai/chatArtifacts";
import {
  isExplicitNewAppAsk,
  isInsistFreshBuildAsk,
  isOpenArtifactReferenceAsk,
  isRedesignAsk,
  isTypedNewDeliverableAsk,
  isVagueBuildAsk,
} from "@/lib/ai/artifactBuildIntent";
import { detectImageAsk } from "@/lib/ai/studioModeIntent";

export interface ArtifactSendPlanInput {
  /** The user's message text for this turn. */
  text: string;
  /** "+" menu capability mode armed for this send. */
  sendMode: ComposerMode;
  /** Board id the send streams into (pre-trim; trimmed internally). */
  streamChatId: string;
  /** Artifact open in the preview panel (activeArtifactRef.current). */
  editArtifact: ChatArtifact | null;
  /** studioModeInstructionsRef?.current — sticky mode system prompt. */
  studioModeInstructions: string | undefined;
  /** Attachments riding this send (only type/url are read). */
  sentAttachments: Array<{ type?: string; url?: string }>;
  /** This board's snapshot aiThread (for prior-generated-image detection). */
  aiThread: Array<{ role: "user" | "assistant"; content: string }> | undefined;
  /** artifactAppRef lookup for this chat — installed app the chat edits. */
  linkedAppId: string | undefined;
}

export interface ArtifactSendPlan {
  /** Create/Build armed for this turn (after sticky-conversation demotion). */
  createArmed: boolean;
  typedNewDeliverableAsk: boolean;
  insistFreshBuildAsk: boolean;
  /** Builder tool the "+" → Create kind maps to ("" when none). */
  createToolName: string;
  openTemplateRestyleAsk: boolean;
  buildModeFresh: boolean;
  /** Ship the open artifact for surgical edits this turn. */
  refiningOpenArtifact: boolean;
  /** Ship a read-only stub of the open artifact (Chat mode discussion). */
  discussOpenArtifact: boolean;
  /** Composer mode that actually goes to the server for this turn. */
  effectiveComposerMode: ComposerMode;
}

export function resolveArtifactSendPlan(input: ArtifactSendPlanInput): ArtifactSendPlan {
  const { text, sendMode, streamChatId, editArtifact, sentAttachments } = input;

  const artifactChatId = String(editArtifact?.sourceChatId || "").trim();
  const thisChatId = String(streamChatId || "").trim();
  // Only refine artifacts tagged to THIS board. Untagged / other-chat
  // panel state must not force edits or strip Build on a fresh chat.
  const artifactBelongsHere =
    !!editArtifact && !!thisChatId && artifactChatId === thisChatId;
  // Installed app this chat edits ("Edit in Build mode" seed or the chat's
  // remembered app link). Needed up front: it decides whether "make the app
  // …" wording is an edit of THAT app or a fresh commission.
  const installedAppEditId =
    String(editArtifact?.installedAppId || input.linkedAppId || "").trim();
  const appEditChat = artifactBelongsHere && !!installedAppEditId;
  const stickyModeInstructions = String(input.studioModeInstructions || "");
  const stickyBuildMode =
    stickyModeInstructions.includes("The user is in Build mode");
  const stickyImagineMode =
    sendMode === "image" && stickyModeInstructions.includes("The user is in Imagine mode");
  let isBuildMode = sendMode === "create:webapp";
  const hasAttachedImage = sentAttachments.some(
    (a) => (a.type || "").toLowerCase() === "image" && !!a.url,
  );
  // Build mode with an open same-kind artifact → refine (edits) by default.
  // Fresh rebuild only on clear new-commission / redesign / reference-image
  // signals. Regular chat never starts a new build from wording alone —
  // Create/Build must be armed (server also enforces this).
  let createArmed =
    typeof sendMode === "string" && sendMode.startsWith("create:");
  // "make the app darker" names THE open build — an edit, not a commission.
  // With a same-chat build attached, only indefinite phrasing ("build me a
  // quiz app") commissions fresh; and in an installed-app edit chat even
  // that stays an edit while the ask references the open app without
  // explicitly asking for another one. Keep in sync with
  // server/ai/chatStream.routes.js (typedDeliverableCommission).
  const typedDeliverableCommission =
    isTypedNewDeliverableAsk(text, {
      excludeDefiniteReferences: artifactBelongsHere,
    }) &&
    !(appEditChat && isOpenArtifactReferenceAsk(text) && !isExplicitNewAppAsk(text));
  const typedNewDeliverableAsk = createArmed && typedDeliverableCommission;
  const insistFreshBuildAsk = createArmed && isInsistFreshBuildAsk(text);
  const regularChatBuildAsk =
    !createArmed &&
    (typedDeliverableCommission || isInsistFreshBuildAsk(text));
  const redesignAsk = isRedesignAsk(text);
  // Edit/add asks against an open artifact — keep in sync with server.js.
  // Length cap is soft: longer "add X and fix Y" messages still refine.
  const looksLikeSurgicalTweak =
    text.trim().length < 400 &&
    /\b(?:fix|change|update|tweak|adjust|add|make|rename|remove|delete|patch|bug|typo|font|colou?r|theme|move|replace|swap|hide|show|enable|disable|increase|decrease|darken|brighten|dim|mute|darker|lighter|brighter|edit|improve|polish|wire|connect|implement|insert|extend|expand|shorten|widen|narrow|resize|restyle|reword|rewrite|correct|repair)\b/i.test(
      text,
    ) &&
    !redesignAsk &&
    !typedNewDeliverableAsk &&
    !insistFreshBuildAsk;
  // Sticky Build / Imagine pages are conversational modes, not automatic
  // tool buttons. Questions and general discussion stay in chat; only a
  // clear commission or mutation request arms the matching generator.
  const normalizedModeAsk = text.trim();
  const discussionQuestion =
    /^(?:what|why|how|when|where|who|which|should|would|could|can|is|are|do|does|did|has|have|tell\s+me|explain|describe|discuss|help\s+me\s+understand|give\s+me\s+advice|make\s+sense)\b/i.test(
      normalizedModeAsk,
    );
  const directCreateQuestion =
    /^(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?(?:make|build|create|generate|design|draw|add|apply|give|put|change|update|edit|fix|format|style|organize|reorder|group|align|center|bold|italicize|underline|highlight|adjust|tweak|dim|darken|brighten|remove|replace|redesign|rebuild|restyle|turn|set)\b/i.test(
      normalizedModeAsk,
    );
  const imperativeModeAction =
    /^(?:(?:ok|okay|now|then|also|please|and|let['’]s)\s*[,—-]?\s*)*(?:make|build|create|generate|design|draw|add|apply|give|put|change|update|edit|fix|format|style|organize|reorder|group|align|center|bold|italicize|underline|highlight|adjust|tweak|dim|darken|brighten|remove|replace|redesign|rebuild|restyle|turn|set|redo|reimagine|render)\b/i.test(
      normalizedModeAsk,
    );
  // Natural edit requests are often phrased as a desired end state rather
  // than an imperative: "every note should have a heading", "the button
  // needs to be smaller", "I want the sidebar darker".
  const desiredStateModeAction =
    artifactBelongsHere &&
    (/\b(?:should|needs? to|must)\s+(?:be|have|show|use|include|display|look|feel|read|say|contain)\b/i.test(
      normalizedModeAsk,
    ) ||
      /\b(?:i want|i need|i(?:'|’)d like|i would like)\b/i.test(normalizedModeAsk));
  const bareBuildBrief =
    /^(?:(?:an?|the|my|another|new)\s+)?(?:web ?app|web ?site|site|landing ?page|dashboard|app|game|tool|calculator|prototype|widget|quiz|tracker|form|simulator|pitch ?deck|slide ?deck|presentation|spread ?sheet|flow ?chart|diagram|chart|study ?guide|work ?sheet)\b/i.test(
      normalizedModeAsk,
    );
  const hasPriorGeneratedImage = (input.aiThread || []).some(
    (message) =>
      message.role === "assistant" &&
      /!\[[^\]]*\]\(https?:\/\/[^)]+\)/i.test(String(message.content || "")),
  );
  const vagueBuildAsk = isVagueBuildAsk(text);
  const directBuildAction =
    !vagueBuildAsk &&
    directCreateQuestion &&
    (typedNewDeliverableAsk ||
      artifactBelongsHere ||
      bareBuildBrief ||
      /\b(?:make|build|create|generate|design|draw|code|render)\b/i.test(
        normalizedModeAsk,
      ));
  const buildModeAction =
    !vagueBuildAsk &&
    (directBuildAction ||
    desiredStateModeAction ||
    (!discussionQuestion &&
      (typedNewDeliverableAsk ||
        insistFreshBuildAsk ||
        (artifactBelongsHere &&
          (redesignAsk || looksLikeSurgicalTweak || imperativeModeAction)) ||
        (!artifactBelongsHere &&
          imperativeModeAction &&
          /\b(?:make|build|create|generate|design|draw|code|render)\b/i.test(
            normalizedModeAsk,
          )) ||
        bareBuildBrief)));
  // The composer chip is cleared after every send and re-armed by the
  // Studio view on the next render. A fast follow-up can therefore arrive
  // with sendMode="none" even though the user is still in Build and is
  // clearly asking to mutate the open artifact.
  const buildSessionEditTurn =
    stickyBuildMode && buildModeAction && artifactBelongsHere;
  const imageRefinementAsk =
    /^(?:(?:ok|okay|now|then|also|and)\s*[,—-]?\s*)*(?:same\b|another\b|again\b|darker\b|lighter\b|brighter\b|more\b|less\b|try\b|redo\b)/i.test(
      normalizedModeAsk,
    );
  const imagineModeAction =
    (directCreateQuestion &&
      (detectImageAsk(normalizedModeAsk) ||
        hasAttachedImage ||
        hasPriorGeneratedImage ||
        /\b(?:make|create|generate|design|draw|paint|illustrate|render|reimagine)\b/i.test(
          normalizedModeAsk,
        ))) ||
    (!discussionQuestion &&
      (detectImageAsk(normalizedModeAsk) ||
        (imperativeModeAction &&
          (hasAttachedImage ||
            hasPriorGeneratedImage ||
            /\b(?:make|create|generate|design|draw|paint|illustrate|render|reimagine)\b/i.test(
              normalizedModeAsk,
            ))) ||
        (imageRefinementAsk && hasPriorGeneratedImage) ||
        (hasAttachedImage &&
          /\b(?:like this|same style|use this|based on this|recreate|reimagine|transform)\b/i.test(
            normalizedModeAsk,
          ))));
  const stickyBuildConversation = stickyBuildMode && !buildModeAction;
  const stickyImagineConversation = stickyImagineMode && !imagineModeAction;
  if (stickyBuildConversation) {
    createArmed = false;
    isBuildMode = false;
  }
  const referenceRebuildAsk =
    /\b(?:exact(?:ly)?\s+clone|identical|1\s*:\s*1|recreate|clone\s+(?:this|that|it)|(?:look|make)\s+(?:it\s+)?(?:just\s+)?like\s+this|full\s+rewrite)\b/i.test(
      text,
    ) &&
    (hasAttachedImage || artifactBelongsHere);
  // Mirror server isFreshWebappBuildAsk — open Super Coin Dash must not
  // ride along on "build me a copy of minecraft like this".
  const makingVerb =
    /\b(?:make|build|create|generate|design|code|write|whip up|mock up|put together)\b/i.test(
      text,
    );
  const webappNoun =
    /\b(?:games?(?! ?plan)|apps?|web ?apps?|mini[- ]?apps?|sandbox(?:es)?|simulators?|minecraft|voxel|platformers?|shooters?|rpg|first[- ]?person|\b3d\b|three\.?js)\b/i.test(
      text,
    );
  const copyOfWebapp =
    /\bcopy of\b[^.!?\n]{0,80}\b(?:minecraft|games?(?! ?plan)|apps?|sandbox(?:es)?|voxel|platformers?|world)\b/i.test(
      text,
    );
  const referencePhrase =
    /\b(?:like this|like that|from this|based on this|from the (?:image|screenshot|picture|reference)|as shown|in the (?:image|screenshot|picture))\b/i.test(
      text,
    );
  const differentDeliverable =
    /\b(?:different|brand[- ]?new|entirely new|fresh|whole new|completely new)\s+(?:game|app|build|artifact|world)\b/i.test(
      text,
    );
  const visualOverhaulAsk = redesignAsk;
  // Map "+" → Create kinds early so open-panel refine can gate fresh-webapp.
  const CREATE_TOOL_BY_KIND: Record<string, string> = {
    deck: "lykn_build_template",
    study: "lykn_build_react_artifact",
    document: "lykn_write_document",
    worksheet: "lykn_build_react_artifact",
    spreadsheet: "lykn_build_spreadsheet",
    chart: "lykn_generate_chart",
    diagram: "lykn_generate_diagram",
    webapp: "lykn_build_react_artifact",
    video: "lykn_render_video",
  };
  const createKind =
    typeof sendMode === "string" && sendMode.startsWith("create:")
      ? sendMode.slice("create:".length)
      : "";
  const createToolName = CREATE_TOOL_BY_KIND[createKind] || "";
  const openToolName = String(editArtifact?.toolName || "");
  const sameCreateBuilder =
    !!createToolName && !!openToolName && createToolName === openToolName;
  const broadFreshWebappAsk =
    differentDeliverable ||
    (makingVerb && (webappNoun || copyOfWebapp)) ||
    (hasAttachedImage && makingVerb && referencePhrase) ||
    (hasAttachedImage && (webappNoun || copyOfWebapp) && referencePhrase);
  // With the same-kind artifact open, "make the game harder" / "build a
  // settings panel" must refine — only force fresh on clear NEW commissions.
  const freshWebappAsk =
    createArmed &&
    (artifactBelongsHere && sameCreateBuilder
      ? differentDeliverable ||
        copyOfWebapp ||
        (hasAttachedImage &&
          (referencePhrase || webappNoun) &&
          (makingVerb || referencePhrase)) ||
        (makingVerb &&
          (webappNoun || copyOfWebapp) &&
          /\b(?:new|another|different|separate|from scratch|start over|brand[- ]?new)\b/i.test(
            text,
          ))
      : broadFreshWebappAsk);
  // "make it look just like Castle Crashers" with an open game = full
  // rebuild, not a surgical refine (which rejects full_rewrite and dies).
  const openReactRebuildAsk =
    visualOverhaulAsk &&
    artifactBelongsHere &&
    String(editArtifact?.toolName || "") === "lykn_build_react_artifact";
  // A visual overhaul of an installed app is still an edit of THAT app.
  // Keep its source + installedAppId attached so the server can authorize
  // a full rewrite and the returned artifact keeps the Update target.
  // Clear new-commission signals below still win for explicit requests
  // for another/different app. (installedAppEditId is computed up top.)
  // An installed app remains the edit target for this chat even if the UI
  // is currently showing Chat instead of Build. Explicit mutation asks
  // should update that app; questions still take the discuss-only path.
  const installedAppEditTurn =
    !!installedAppEditId &&
    artifactBelongsHere &&
    buildModeAction &&
    !differentDeliverable &&
    !insistFreshBuildAsk;
  const inPlaceInstalledAppRebuild =
    openReactRebuildAsk &&
    !!installedAppEditId &&
    !differentDeliverable &&
    !insistFreshBuildAsk;
  // Style rematch of the OPEN deck — still send activeArtifact so the
  // server can authorize full_rewrite; do NOT treat as a brand-new build.
  const openTemplateRestyleAsk =
    visualOverhaulAsk &&
    artifactBelongsHere &&
    String(editArtifact?.toolName || "") === "lykn_build_template" &&
    !typedNewDeliverableAsk &&
    !insistFreshBuildAsk;
  // Clear new-build signals only. When Build is armed AND the same-kind
  // artifact is already open, prefer refine — do NOT treat every non-short
  // ask as a fresh rebuild (that was wiping add/edit requests).
  const clearFreshBuildIntent =
    referenceRebuildAsk ||
    freshWebappAsk ||
    openReactRebuildAsk ||
    insistFreshBuildAsk ||
    (typedNewDeliverableAsk && artifactBelongsHere && !looksLikeSurgicalTweak) ||
    differentDeliverable;
  const buildModeFresh =
    clearFreshBuildIntent ||
    (isBuildMode &&
      !artifactBelongsHere &&
      (hasAttachedImage || !looksLikeSurgicalTweak)) ||
    (isBuildMode &&
      artifactBelongsHere &&
      !sameCreateBuilder &&
      (hasAttachedImage || !looksLikeSurgicalTweak)) ||
    (isBuildMode &&
      artifactBelongsHere &&
      sameCreateBuilder &&
      hasAttachedImage &&
      (referenceRebuildAsk || freshWebappAsk || referencePhrase));
  // Thread the open panel for context / edits / style rematches.
  // Build / Create armed → refine open panel with edits. A clear mutation
  // request in the sticky Build session or installed-app edit chat also
  // stays armed across turns.
  // Otherwise Chat mode (composer none) remains discuss-only.
  const artifactEditArmed =
    createArmed || buildSessionEditTurn || installedAppEditTurn;
  const refiningOpenArtifact =
    artifactEditArmed &&
    artifactBelongsHere &&
    isEditableArtifact(editArtifact) &&
    !insistFreshBuildAsk &&
    !regularChatBuildAsk &&
    !differentDeliverable &&
    (inPlaceInstalledAppRebuild ||
      (!buildModeFresh &&
        !openReactRebuildAsk &&
        (openTemplateRestyleAsk ||
          ((sameCreateBuilder || buildSessionEditTurn || installedAppEditTurn) &&
            (looksLikeSurgicalTweak ||
              isBuildMode ||
              (!typedNewDeliverableAsk && !freshWebappAsk))))));
  // With builders unarmed for this turn, let the model talk about the
  // open artifact without shipping edits / ARTIFACT_OPEN instructions.
  const discussOpenArtifact =
    !artifactEditArmed &&
    !refiningOpenArtifact &&
    artifactBelongsHere &&
    !!editArtifact;
  const effectiveComposerMode =
    stickyBuildConversation || stickyImagineConversation
      ? "none"
      : refiningOpenArtifact &&
          typeof sendMode === "string" &&
          sendMode.startsWith("create:") &&
          sameCreateBuilder &&
          (looksLikeSurgicalTweak || isBuildMode)
        ? "none"
        : sendMode;

  return {
    createArmed,
    typedNewDeliverableAsk,
    insistFreshBuildAsk,
    createToolName,
    openTemplateRestyleAsk,
    buildModeFresh,
    refiningOpenArtifact,
    discussOpenArtifact,
    effectiveComposerMode,
  };
}
