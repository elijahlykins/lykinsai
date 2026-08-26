// ============================================================================
// server/routes/desktop.routes.js — Electron desktop / Glass browser agent
// ============================================================================
// Extracted verbatim from server.js (Wave 3 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.
//
// This wave moves route registration + the desktop-exclusive helper belt
// only. Agent capability contracts, browser-agent behavior, model proxying,
// and security gates are untouched.
//
// getBrowserControlProvider / pickBrowserControlModel are exported at module
// level because the server.js bootstrap banner logs the active browser-control
// provider/model at startup. They read process.env at call time, so import
// order relative to dotenv does not matter.

import { callStructured, resolveAgentStageModel } from '../../lib/agentModelProviders.js';
import { runHoloGrounding } from '../../lib/holo/grounding.js';
import { runHoloBrowserStep } from '../../lib/holo/browserAgent.js';
import { runScreenReader, formatScreenBriefForHolo } from '../../lib/holo/screenReader.js';
import { runBrowserTaskReport } from '../../lib/holo/browserReport.js';
import { resolveOrdinalDomClick, parseOrdinalFromIntent } from '../../lib/holo/ordinalIntent.js';
import {
  getOrCreateSession,
  logAiUsage,
  estimateTokens,
  extractOpenAIUsage,
} from '../../usageTracking.js';

export function getBrowserControlProvider() {
  const pref = String(process.env.BROWSER_CONTROL_PROVIDER || 'auto').trim().toLowerCase();
  if (pref === 'openai') return 'openai';
  if (pref === 'holo' || pref === 'hcompany' || pref === 'hai') return 'holo';
  // auto: prefer Holo when configured — it's trained for GUI agents / computer use.
  if (process.env.HAI_API_KEY) return 'holo';
  return 'openai';
}

export function pickBrowserControlModel(_hasImage) {
  if (getBrowserControlProvider() === 'holo') {
    return String(process.env.BROWSER_CONTROL_HOLO_MODEL || 'holo3-1-35b-a3b').trim();
  }
  // Fallback for this browser-pipeline path: keep nano (cheap). Overlay
  // chat itself routes `lykn` → gpt-5.6-terra via LYKN_ROUTED_MODELS.
  return process.env.OPENAI_API_KEY ? 'gpt-4.1-nano' : 'gpt-4o-mini';
}

/**
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons from server.js: auth +
 *   app-access middleware, the shared aiLimiter, supabaseAdmin client, and
 *   the server-local sha256/memCache helpers (memCache('chat-name') must
 *   resolve to the same registry the rest of the server uses).
 */
export function registerDesktopRoutes(app, {
  requireAuth,
  requireAppAccess,
  aiLimiter,
  supabaseAdmin,
  sha256,
  memCache,
}) {
  // ──────────────────────────────────────────────────
  // Desktop overlay — list recent app chats for the ⌘L "Past chats" menu.
  // Returns lightweight rows (title + preview) from lykn_chats + snapshots.
  // ──────────────────────────────────────────────────
  const DEFAULT_CHAT_TITLES = new Set(['New Chat', 'Untitled board', '']);

  function desktopChatStateFromRow(row) {
    const rel = row?.lykn_chat_states;
    if (Array.isArray(rel)) return rel[0]?.state ?? null;
    if (rel && typeof rel === 'object') return rel.state ?? null;
    return null;
  }

  function desktopSnapshotHasContext(state) {
    if (!state || typeof state !== 'object') return false;
    const chatMessages = Array.isArray(state.chatMessages) ? state.chatMessages : [];
    if (chatMessages.length) return true;
    const aiThread = Array.isArray(state.aiThread) ? state.aiThread : [];
    if (aiThread.length) return true;
    const blocks = state.blocks && typeof state.blocks === 'object' ? state.blocks : {};
    const blockOrder = Array.isArray(state.blockOrder) ? state.blockOrder : Object.keys(blocks);
    return blockOrder.some((id) => {
      const b = blocks[String(id)];
      if (!b || typeof b !== 'object') return false;
      const data = b.data && typeof b.data === 'object' ? b.data : {};
      const content = String(data.content ?? data.body ?? b.content ?? '').trim();
      return content.length > 0;
    });
  }

  function desktopChatPreview(state) {
    if (!state || typeof state !== 'object') return '';
    const chatMessages = Array.isArray(state.chatMessages) ? state.chatMessages : [];
    for (let i = chatMessages.length - 1; i >= 0; i -= 1) {
      const m = chatMessages[i];
      const text = String(m?.content || m?.aiResponse || '').trim();
      if (text) return text.slice(0, 140);
    }
    const aiThread = Array.isArray(state.aiThread) ? state.aiThread : [];
    for (let i = aiThread.length - 1; i >= 0; i -= 1) {
      const m = aiThread[i];
      const text = String(m?.content || '').trim();
      if (text) return text.slice(0, 140);
    }
    return '';
  }

  function desktopChatTitle(row, state) {
    const title = String(row?.title || '').trim();
    if (title && !DEFAULT_CHAT_TITLES.has(title)) return title;
    const chatMessages = Array.isArray(state?.chatMessages) ? state.chatMessages : [];
    for (const m of chatMessages) {
      const text = String(m?.content || '').trim();
      if (text) return text.slice(0, 72);
    }
    return title || 'New Chat';
  }

  function userWantsSearchOrType(intent) {
    return /search( for| up)?|look up|look for|google|find (info|information|out about)|type into|type in|enter .+ (into|in)|fill in|query for/i.test(
      String(intent || '').toLowerCase(),
    );
  }

  function userWantsVisionClick(intent) {
    return /click (on |the )?(image|picture|photo|thumbnail|icon|graphic)|find (the |a )?(image|picture|photo|one that|one with|one showing)|select (the |a )?(image|picture|photo)|looks like|that shows|showing a|with (a |the )?(cat|dog|bird|face|person|logo|map|chart|diagram)|visual/i.test(
      String(intent || '').toLowerCase(),
    );
  }

  function userWantsComplexTask(intent) {
    return (
      wantsMultiQuestion(intent) ||
      userWantsVisionClick(intent) ||
      /multiple|several|all of them|each one|one by one|keep going|step by step|go through|find .+ and (click|complete|finish|do|take|answer|fill)|click on (all|each|every)|then (click|type|fill|submit|open|answer|complete)|and then |after that|share .{0,40}with|invite .{0,40}@|fill (out|in)|compose|draft and send/i.test(
        String(intent || '').toLowerCase(),
      )
    );
  }

  function summarizeTaskProgress(completedSteps, intent) {
    const steps = Array.isArray(completedSteps) ? completedSteps : [];
    const checks = countChecksCompleted(steps);
    const parts = [];
    if (wantsMultiQuestion(intent) && checks > 0) {
      parts.push(`${checks} question(s) checked so far — keep going until the exercise is fully complete`);
    }
    const imageClicks = steps.filter(
      (s) => s?.ok && s.type === 'click' && /image|picture|photo|thumbnail/i.test(String(s.label || '')),
    ).length;
    if (userWantsVisionClick(intent) && imageClicks > 0) {
      parts.push(`${imageClicks} image target(s) clicked so far`);
    }
    if (parts.length) return parts.join('. ') + '.';
    return '';
  }

  function wantsMultiQuestion(intent) {
    return /all questions|each question|every question|another question|next question|second question|go through|go to the (new|next) screen|then go to|and then (go|answer)|complete (it|the|this|that)|finish (it|the|this|that)|complete the (quiz|exercise|practice|lesson|thing|entire)|finish the (quiz|exercise|practice|lesson|thing|entire)|whole (quiz|exercise|practice|thing)|entire (quiz|exercise|practice|thing)|run out of questions|until you run out|until (there are )?no more|do this until|keep going through|next page.*until|until done|until finished|submit it and then|answer.*submit.*then|work\s+through|solve (the |this |every |all )?(quiz|exercise|problem|questions?)|take (the |this |a )?(quiz|test|exam)|fill (out|in) (the |this )?(form|quiz|survey)|every (question|step|item)|do (the |this )?(entire|whole|full)/i.test(
      String(intent || '').toLowerCase(),
    );
  }

  function pageShowsExerciseComplete(text) {
    return /you('ve| have) (finished|completed)|great work|nice work|way to go|unit complete|lesson complete|practice complete|exercise complete|all done|no more questions|course challenge complete|mastery|congratulations|keep practicing|review lesson|points earned|skill (mastered|completed)|show summary|you got \d|100%|perfect score|end of (the )?(quiz|exercise|practice)|quiz complete|test complete|submitted successfully|response recorded|thank you for (completing|submitting)/i.test(
      String(text || ''),
    );
  }

  function countChecksCompleted(completedSteps) {
    return (Array.isArray(completedSteps) ? completedSteps : []).filter(
      (s) => s?.ok && /^check(\s|$|\b)/i.test(String(s?.label || '')),
    ).length;
  }

  function filterCatalogForIntent(catalog, intent, pageText) {
    // General agent: never strip elements based on task type. A general task may
    // need to click nav, log in, open a menu, fill a form, pick an option, etc.
    // We only reorder likely targets (e.g. the search box) to the front so the
    // planner sees them first. The planner reads the whole screen and decides.
    const list = Array.isArray(catalog) ? catalog : [];
    return prioritizeCatalogForIntent(list, intent);
  }

  function prioritizeCatalogForIntent(catalog, intent) {
    const list = Array.isArray(catalog) ? catalog : [];
    if (!userWantsSearchOrType(intent)) return list;
    const searchFirst = [];
    const rest = [];
    for (const el of list) {
      const role = String(el?.role || '').toLowerCase();
      const type = String(el?.type || '').toLowerCase();
      const label = String(el?.label || '').toLowerCase();
      if (role === 'searchbox' || role === 'combobox' || type === 'search' || /search/.test(label)) {
        searchFirst.push(el);
      } else {
        rest.push(el);
      }
    }
    return searchFirst.length ? [...searchFirst, ...rest] : list;
  }

  // Compact view of the catalog for the model: id + label + a little context, and
  // crucially NO selector. The model acts on elements by their id ("el7"), so it
  // never has to copy a long CSS selector (which it truncates/invents). This also
  // cuts a lot of prompt tokens.
  function compactCatalogForModel(catalog) {
    return (Array.isArray(catalog) ? catalog : []).map((el) => {
      const o = { id: el.id, label: String(el.label || '').slice(0, 100) };
      if (el.role) o.role = el.role;
      else if (el.tag) o.tag = el.tag;
      if (el.type) o.type = el.type;
      if (el.value) o.value = String(el.value).slice(0, 60);
      if (el.checked) o.checked = 1;
      if (el.inView === false) o.offscreen = 1;
      return o;
    });
  }

  function buildBrowserControlSystemContent({ intent, taskPlan, isFirstTurn, searchHint, complexTask, visionClick }) {
    const planSteps = complexTask ? '2–12' : '2–5';
    const firstTurnNote = isFirstTurn
      ? `\n- FIRST TURN: set taskPlan using DONE / NOW+CHECK / LATER. Detail ONLY the NOW step from what is visible on screen (${planSteps} later phases may be placeholders — do not invent off-screen buttons).`
      : '\n- EVERY TURN: rewrite taskPlan from the CURRENT screen (keep DONE, refresh NOW+CHECK from visible controls, refresh LATER as placeholders only).';
    const searchNote = searchHint
      ? `\n- Search query to type: "${searchHint}". Use a type action with that value, then press Enter. Do NOT click Search/navigation buttons in a loop.`
      : '';
    const planNote = taskPlan
      ? '\n- Follow the WORKING PLAN below — execute ONLY the NOW step. After WHAT CHANGED / NEW controls, rewrite the plan before acting. Do NOT set done:true until the entire user goal is finished.'
      : '';
    const complexNote = complexTask
      ? '\n- COMPLEX TASK: do NOT stop after one step. Set done:true ONLY when the full USER GOAL is accomplished.'
      : '';
    const visionNote = visionClick
      ? '\n- VISION / IMAGE TASK: read the SCREENSHOT carefully. Match images by appearance (not just text). Prefer img/figure elements from ELEMENTS by alt label. If no selector fits, use click_coord with x,y as 0–1000 coords (center of the target on screen).'
      : '';
    const holoNote = getBrowserControlProvider() === 'holo'
      ? '\n- You are Holo, a GUI agent model. Read the SCREENSHOT first for spatial layout, then cross-check ELEMENTS. For icons, images, or canvas targets, prefer click_coord at the visual center (0–1000) when ELEMENTS labels are ambiguous.'
      : '';

    return (
      'You are LYKN, operating the user\'s browser for them — the SAME assistant as overlay chat.\n' +
      'You can SEE the screen (screenshot) and a list of the page\'s interactive ELEMENTS.\n' +
      'Your job is general-purpose: do whatever USER GOAL says, one action at a time, the way a\n' +
      'person would. Invent the steps — users rarely spell out every click. Use PRIOR CHAT plus\n' +
      'the open page/app: short asks like "play it", "do it", "open that", or "go ahead" refer to\n' +
      'earlier turns and the software already on screen — act THERE, do not Google the pronoun.\n' +
      'For work inside ANY software/tool, follow: deep-link/create surface when possible → else\n' +
      'click through that tool\'s UI until the right working page → do the actual ask → report.\n' +
      'Multi-step plans are expected. Do NOT stop on a homepage, marketing page, or gallery.\n' +
      'Opening a homepage alone is NOT done when the goal needs search, play, create, or a click.\n' +
      'The goal can be ANYTHING — search, navigate, open a menu, fill a form, click a\n' +
      'button, log in, change a setting, add to cart, answer a question, etc. There is no single\n' +
      'use case. Read the WHOLE screen, decide the single best next action toward the goal, do it.\n\n' +
      'You get a FRESH screen read every turn. The page changes as you act, so always trust the\n' +
      'current PAGE TEXT / ELEMENTS / screenshot over any earlier plan or memory.\n' +
      'If "WHAT CHANGED" says a NEW screen loaded or lists NEW controls, treat it as a clean slate:\n' +
      'forget the previous buttons and pick the next step from the NEW controls (Send, Next,\n' +
      'Continue, Create, Save, Add people, etc.).\n' +
      'If it says NOTHING changed, your last action did nothing — try a DIFFERENT element or\n' +
      'approach (e.g. a coordinate click), do not repeat the same click.\n\n' +
      'Each turn:\n' +
      '1. VERIFY: read "WHAT CHANGED AFTER YOUR LAST ACTION". Confirm the previous click did what\n' +
      '   you intended (dialog opened, page navigated, field focused). If NEW controls appeared,\n' +
      '   your next action MUST be chosen from those / the current screen — never re-click the old\n' +
      '   button. Only set done:true when the FULL USER GOAL is finished (not merely "step worked").\n' +
      '   If nothing changed or the wrong thing happened, adjust — do not blindly continue an old plan.\n' +
      '2. reasoning: describe what is on screen NOW (especially new dialogs/buttons) and the single\n' +
      '   next natural step toward USER GOAL.\n' +
      '3. Return exactly 1 action (or 2 ONLY for a type + press Enter pair).\n' +
      '4. Set done:true ONLY when the whole USER GOAL is accomplished — not after one step of a\n' +
      '   longer task.\n\n' +
      'HOW TO ACT:\n' +
      '- Each ELEMENT has a short "id" (like "el7"). To act on an element, put its id in the action.\n' +
      '  Do NOT write CSS selectors — just the id. The ELEMENTS list is comprehensive (it INCLUDES\n' +
      '  list rows, emails, search results, table rows, cards, menu items); find the one you want by\n' +
      '  its label/role and use its id.\n' +
      '- If the target is genuinely NOT in ELEMENTS (visible in the screenshot but no matching id),\n' +
      '  use click_coord with x,y as 0–1000 normalized coordinates at the CENTER of the target.\n' +
      '  NEVER return no action — if no id fits, click_coord so you always make progress.\n' +
      '- To enter text: TYPE into the correct field (by id), then press Enter (or click submit).\n' +
      '- Dropdowns: use "select" with the option text in value. Checkboxes/radios: use "check"/"uncheck".\n' +
      '- Menus that only open on mouse-over: use "hover" on the element, then click the revealed item next turn.\n' +
      '- Keys: "press" sends a REAL key (Enter, Escape, Tab, ArrowDown, …) — use it for submitting, closing dialogs, list navigation.\n' +
      '- EDITORS (Google Docs/Slides, Notion, any writing app): you CAN edit like a person — NEVER say you cannot.\n' +
      '  Select text with "select_all" (or "shortcut" value "mod+a"), then use the app\'s toolbar/menus: e.g. to change\n' +
      '  font size in Docs, select the text, click the Font size field, type the number, press Enter.\n' +
      '  "shortcut" sends real key combos (value like "mod+b", "mod+c", "mod+shift+v"); "mod" = Cmd on Mac / Ctrl elsewhere.\n' +
      '  "copy"/"cut"/"paste"/"select_all" run the native editing commands with the system clipboard — use them to\n' +
      '  copy, paste, and duplicate content exactly like a user.\n' +
      '- SHARING: to share/send the open doc/page to someone, use the PAGE\'s own share UI — click the "Share"\n' +
      '  button (or File → Share / Invite), TYPE the recipient email into the people/invite field, pick a permission\n' +
      '  if asked, then click Send / Share / Done. Never claim you cannot share or send — the UI can do it.\n' +
      '- Click nav, tabs, menus, or links ONLY when the goal needs them.\n\n' +
      'taskPlan is a progressive WORKING PLAN (not a rigid script):\n' +
      '  DONE: verified completed steps\n' +
      '  NOW: exactly one action possible on the CURRENT screen + CHECK: expected UI result\n' +
      '  LATER: placeholders for goal phases not yet visible — never invent button names for unseen screens\n' +
      'Rewrite taskPlan every turn from WHAT CHANGED + the screenshot. Do not click randomly or dismiss dialogs.\n\n' +
      'Return ONLY JSON: {"reasoning": string, "done": boolean, "explanation": string, "actions": Action[], "taskPlan"?: string}\n' +
      'Action: {"type":"click"|"type"|"click_type"|"press"|"scroll"|"select"|"check"|"uncheck"|"hover"|"shortcut"|"select_all"|"copy"|"cut"|"paste"|"click_coord","id"?:string,"label":string,"value"?:string,"key"?:string,"delta"?:number,"x"?:number,"y"?:number}\n' +
      'Use "id" (from ELEMENTS) for click/type/press/select/check/hover. Use x,y (0–1000, center of target) only for click_coord.\n' +
      'TYPING: prefer type "click_type" with label + value (+ x,y if known) — ONE action that clicks the field then types. Never split click and type across turns.\n\n' +
      'CRITICAL:\n' +
      '- reasoning MUST come first — think, then act.\n' +
      '- If done is false, actions MUST contain 1 action (or 2 for type+Enter only).\n' +
      '- For search: TYPE into the search field, then Enter — never click random links in a loop.\n' +
      '- Reference elements by their id from ELEMENTS. Never invent CSS selectors.\n' +
      '- BE EXACT: pick the ONE element whose label/role matches the goal precisely. If several look similar,\n' +
      '  use the SCREENSHOT to disambiguate before clicking. One click per turn — the page is re-read after\n' +
      '  every action, so never chain clicks against a screen you have not seen yet.\n' +
      '- Elements with inView:false are below the fold — the click auto-scrolls to them, but when unsure what\n' +
      '  is there, scroll first and look before acting.\n' +
      '- If the last action in HISTORY did not change the page as expected, do NOT repeat it — pick a different\n' +
      '  element or a different approach.\n' +
      '- explanation: short status of what you\'re doing now.' +
      searchNote +
      planNote +
      complexNote +
      visionNote +
      holoNote +
      firstTurnNote
    );
  }



  const HOLO_API_BASE = 'https://api.hcompany.ai/v1/';

  // Unified planner call — routes to H Company (Holo3) or OpenAI depending on env.
  // Holo is OpenAI-compatible but expects enable_thinking + reasoning_effort for
  // agent-style planning. Returns { ok, data, provider, model } or { ok:false, ... }.
  async function callBrowserControlPlanner({ messages, temperature = 0.15, maxTokens = 900 }) {
    const provider = getBrowserControlProvider();
    const model = pickBrowserControlModel(true);

    if (provider === 'holo') {
      const apiKey = process.env.HAI_API_KEY;
      if (!apiKey) return { ok: false, status: 503, error: 'HAI_API_KEY not set' };
      const res = await fetch(`${HOLO_API_BASE}chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          temperature: Math.max(temperature, 0.2),
          max_tokens: maxTokens,
          reasoning_effort: 'medium',
          response_format: { type: 'json_object' },
          chat_template_kwargs: { enable_thinking: true },
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: errText.slice(0, 400), provider, model };
      }
      const data = await res.json();
      return { ok: true, data, provider, model };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { ok: false, status: 503, error: 'OPENAI_API_KEY not set' };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: errText.slice(0, 400), provider, model };
    }
    const data = await res.json();
    return { ok: true, data, provider, model };
  }

  // Holo's single-turn element localization — best for pure vision grounding when
  // the DOM catalog has no matching id. Returns { x, y } on 0–1000 scale or null.
  async function callHoloElementLocalization(imageUrl, targetDescription) {
    const apiKey = process.env.HAI_API_KEY;
    if (!apiKey || !String(imageUrl || '').startsWith('data:image/')) return null;
    const target = String(targetDescription || '').trim().slice(0, 400);
    if (!target) return null;
    const model = pickBrowserControlModel(true);
    const schema = {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0, maximum: 1000, description: 'X coordinate in [0, 1000]' },
        y: { type: 'integer', minimum: 0, maximum: 1000, description: 'Y coordinate in [0, 1000]' },
      },
      required: ['x', 'y'],
    };
    const prompt =
      'Localize an element on the GUI image according to the provided target and output a click position.\n' +
      ` * You must output a valid JSON following the format: ${JSON.stringify(schema)}\n` +
      ` Your target is:\n${target}`;
    try {
      const res = await fetch(`${HOLO_API_BASE}chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: prompt },
            ],
          }],
          temperature: 0,
          max_tokens: 64,
          structured_outputs: { json: schema },
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: Math.max(0, Math.min(1000, Math.round(x))), y: Math.max(0, Math.min(1000, Math.round(y))) };
    } catch {
      return null;
    }
  }

  function browserControlConfigured() {
    const provider = getBrowserControlProvider();
    if (provider === 'holo') return !!process.env.HAI_API_KEY;
    return !!process.env.OPENAI_API_KEY;
  }

  function formatConversationForBrowserPlan(history) {
    if (!Array.isArray(history) || !history.length) return '';
    return history
      .slice(-8)
      .map((m) => {
        const role = m?.role === 'assistant' ? 'LYKN' : 'User';
        return `${role}: ${String(m?.content || '').replace(/\s+/g, ' ').trim().slice(0, 700)}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  // Build OpenAI chat messages for browser planning (text + optional screenshot).
  function buildBrowserPlannerMessages({ systemContent, userText, imageUrl }) {
    const hasImage = String(imageUrl || "").startsWith("data:image/");
    return [
      { role: "system", content: systemContent },
      hasImage
        ? {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
            ],
          }
        : { role: "user", content: userText },
    ];
  }

  // Plan browser-control steps for the desktop overlay: given the user's intent
  // and a list of interactable elements on the active tab, return a short action
  // sequence (click / type / press / scroll). Selectors must come from the scan.
  /**
   * Pre-action intent breakdown for Agent Mode.
   * Deduce the real destination + work plan from vague asks BEFORE navigating
   * (e.g. "open my reddit ads thing" → ads.reddit.com + review campaigns).
   */
  app.post('/api/desktop/agent-intent', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY && !process.env.HAI_API_KEY) {
        return res.status(503).json({ error: 'AI not configured' });
      }
      const prompt = String(req.body?.prompt || '').trim().slice(0, 2000);
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
      const heuristicUrl = String(req.body?.heuristicUrl || '').trim().slice(0, 500);
      const browsingContext = String(req.body?.browsingContext || '').trim().slice(0, 1500);
      const conversationContext = formatConversationForBrowserPlan(req.body?.conversationHistory);

      const system =
        `You are LYKN Agent Mode's intent interpreter. The user has NOT opened a page yet.\n` +
        `Your job: deduce what they mean, pick the best concrete destination URL, and write a clear browse goal.\n` +
        `Rules:\n` +
        `- If the ask NAMES a product, app or site ("in mailchimp", "on hubspot", "using notion"), that product IS the destination. Never substitute a different tool that does a similar job — an email task named for Mailchimp goes to Mailchimp, NOT Gmail. Repeat the named product in browseGoal so it cannot be lost.\n` +
        `- Words like "email", "calendar", "doc" or "invoice" describe the ARTIFACT, not the destination. Only route to a mail client / calendar / editor when the user named no other product.\n` +
        `- Prefer official product/account dashboards over Google search.\n` +
        `- Vague filler ("thing", "stuff", "my … ads") still maps to the real product (e.g. Reddit Ads → https://ads.reddit.com).\n` +
        `- Do NOT invent credentials. Sign-in walls are fine — land on the right product.\n` +
        `- If they want to check/review something, say that in browseGoal (not just "open").\n` +
        `- browseGoal must cover the WHOLE ask through to its finished outcome, including anything after the first navigation ("… then write the body and save it as a draft"). Never shorten it to just opening a page.\n` +
        `- Only use a Google search URL when the destination is truly unknown. For an unfamiliar named product, search for that product's login/dashboard rather than routing to a generic tool.\n` +
        `- skill is usually "browse". Use "research" only for deep research reports, "build" for artifacts, "general" for chat.\n` +
        `Return JSON only:\n` +
        `{"understood":"short plain English","destinationUrl":"https://...","browseGoal":"one imperative sentence the browser agent will execute","steps":["step1","step2"],"skill":"browse","confidence":0.0}`;

      const user =
        `USER ASK:\n${prompt}\n\n` +
        (heuristicUrl ? `HEURISTIC URL GUESS (may be wrong):\n${heuristicUrl}\n\n` : '') +
        (browsingContext ? `USER BROWSING HABITS (private hint):\n${browsingContext}\n\n` : '') +
        (conversationContext ? `RECENT CHAT:\n${conversationContext}\n\n` : '') +
        `Deduce the real destination and full task.`;

      const plannerResult = await callBrowserControlPlanner({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        maxTokens: 500,
      });
      if (!plannerResult.ok) {
        console.error('❌ /api/desktop/agent-intent:', plannerResult.error?.slice?.(0, 200) || plannerResult.error);
        return res.status(502).json({ error: 'Intent parse failed' });
      }

      let parsed = {};
      try {
        parsed = JSON.parse(plannerResult.data?.choices?.[0]?.message?.content || '{}');
      } catch {
        parsed = {};
      }
      const destinationUrl = String(parsed.destinationUrl || '').trim().slice(0, 500);
      const browseGoal = String(parsed.browseGoal || parsed.understood || '').trim().slice(0, 800);
      const understood = String(parsed.understood || browseGoal || '').trim().slice(0, 400);
      const steps = Array.isArray(parsed.steps)
        ? parsed.steps.map((s) => String(s || '').trim().slice(0, 200)).filter(Boolean).slice(0, 8)
        : [];
      const skill = ['browse', 'research', 'build', 'general', 'monitor'].includes(String(parsed.skill || ''))
        ? String(parsed.skill)
        : 'browse';
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(plannerResult.data);
        logAiUsage({
          sessionId: session?.id,
          userId: req.user?.id,
          actionType: 'agent_intent',
          model: plannerResult.model || 'gpt-4.1-nano',
          provider: plannerResult.provider || 'openai',
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
        });
      }).catch(() => {});

      return res.json({
        understood,
        destinationUrl,
        browseGoal: browseGoal || understood,
        steps,
        skill,
        confidence,
      });
    } catch (err) {
      console.error('❌ /api/desktop/agent-intent:', err?.message || err);
      return res.status(500).json({ error: 'Intent parse failed' });
    }
  });

  app.post('/api/desktop/browser-plan', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      if (!browserControlConfigured()) return res.status(503).json({ error: 'AI not configured' });

      const intent = String(req.body?.intent || '').slice(0, 500).trim();
      const url = String(req.body?.url || '').slice(0, 500).trim();
      const title = String(req.body?.title || '').slice(0, 200).trim();
      const pageText = String(req.body?.pageText || '').slice(0, 15000).trim();
      const imageUrl = String(req.body?.imageUrl || '').trim();
      const hasImage = imageUrl.startsWith('data:image/');
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 130) : [];
      const useHoloAgent = getBrowserControlProvider() === 'holo';
      if (!intent) return res.status(400).json({ error: 'Missing intent' });
      if (!items.length && !useHoloAgent) return res.status(400).json({ error: 'No interactable elements' });

      const conversationContext = formatConversationForBrowserPlan(req.body?.conversationHistory);

      if (useHoloAgent) {
        const readerResult = await runScreenReader({
          intent,
          imageUrl,
          url,
          title,
          pageText,
          items,
          conversationContext,
          isPreview: true,
          cacheKey: `browser-screen-read:${(req.user?.id || 'anon').slice(0, 32)}`,
        });
        if (!readerResult.ok) {
          console.error('❌ /api/desktop/browser-plan screen-reader:', readerResult.status, readerResult.error?.slice(0, 200));
          return res.status(502).json({ error: 'Planning failed' });
        }
        getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
          const usage = extractOpenAIUsage(readerResult.data);
          logAiUsage({
            sessionId: session?.id, userId: req.user?.id, actionType: 'browser_screen_read',
            model: readerResult.model || 'gpt-4.1',
            provider: 'openai',
            inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
          });
        }).catch(() => {});
        return res.json({
          agentMode: 'holo',
          pipeline: 'reader-holo-report',
          explanation: readerResult.explanation || '',
          taskPlan: readerResult.taskPlan || readerResult.explanation || '',
          actions: [],
        });
      }

      const catalog = items.map((el, i) => ({
        id: String(el?.id || `el${i}`),
        tag: String(el?.tag || ''),
        type: String(el?.type || ''),
        role: String(el?.role || ''),
        selector: String(el?.selector || '').slice(0, 300),
        label: String(el?.label || '').slice(0, 120),
        value: String(el?.value || '').slice(0, 80),
        href: String(el?.href || '').slice(0, 200),
        checked: !!el?.checked,
      })).filter((el) => el.selector);

      const filteredCatalog = filterCatalogForIntent(catalog, intent, pageText);

      const searchHint = userWantsSearchOrType(intent)
        ? intent.replace(/^search( for| up)?\s*/i, '').replace(/^look up\s*/i, '').trim().slice(0, 120)
        : '';
      const systemContent =
        buildBrowserControlSystemContent({ intent, taskPlan: '', isFirstTurn: true, searchHint }) +
        '\n\nThis is a PREVIEW — return an empty actions array. Set taskPlan to the step-by-step plan (like chat advice). In explanation, summarize what you will do.';

      const userText =
        `USER GOAL (execute this — every action must serve it):\n${intent}\n\n` +
        (conversationContext
          ? `PRIOR CHAT (same overlay session — user may have already discussed this):\n${conversationContext}\n\n`
          : '') +
        `PAGE: ${title}\nURL: ${url}\n\n` +
        (pageText ? `PAGE TEXT (visible on screen):\n${pageText}\n\n` : '') +
        `ELEMENTS (act on one by its "id"):\n${JSON.stringify(compactCatalogForModel(filteredCatalog), null, 0)}` +
        (hasImage ? '\n\n(Screenshot attached — read it like overlay chat.)' : '');

      const plannerMessages = buildBrowserPlannerMessages({ systemContent, userText, imageUrl });
      const plannerResult = await callBrowserControlPlanner({
        messages: plannerMessages,
        temperature: 0.15,
        maxTokens: 900,
      });

      if (!plannerResult.ok) {
        console.error(
          `❌ /api/desktop/browser-plan ${plannerResult.provider || 'unknown'}:`,
          plannerResult.status,
          plannerResult.error?.slice(0, 200),
        );
        return res.status(502).json({ error: 'Planning failed' });
      }

      const data = plannerResult.data;
      let explanation = '';
      let taskPlan = '';
      let actions = [];
      try {
        const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
        explanation = String(parsed.explanation || parsed.reasoning || '').trim().slice(0, 600);
        taskPlan = String(parsed.taskPlan || '').trim().slice(0, 2000);
        actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      } catch (_) { /* keep defaults */ }

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(data);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'browser_plan',
          model: plannerResult.model || 'browser-control',
          provider: plannerResult.provider || 'openai',
          inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
        });
      }).catch(() => {});

      return res.json({ explanation, taskPlan, actions });
    } catch (err) {
      console.error('❌ /api/desktop/browser-plan:', err?.message || err);
      return res.status(500).json({ error: 'Planning failed' });
    }
  });

  // Generic structured-model endpoint for the modular browser agent
  // (electron/browser-agent). One provider-agnostic contract for its planner /
  // executor / verifier stages: { stage, system, user, imageUrl?, schema,
  // maxTokens? } -> { ok, json }. Keeps API keys server-side and lets the
  // provider/model change without touching browser control, state, or skills.
  app.post('/api/desktop/agent-model', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const stage = String(req.body?.stage || 'decide').slice(0, 24);
      const system = String(req.body?.system || '').slice(0, 60000);
      const user = String(req.body?.user || '').slice(0, 60000);
      const imageUrl = String(req.body?.imageUrl || '').trim();
      const imageUrls = Array.isArray(req.body?.imageUrls) ? req.body.imageUrls.slice(0, 10) : null;
      const schema = req.body?.schema && typeof req.body.schema === 'object' ? req.body.schema : null;
      const maxTokens = Math.min(Math.max(Number(req.body?.maxTokens) || 900, 100), 4000);
      const arm = String(req.body?.arm || '').slice(0, 40);
      if (!user || !schema) return res.status(400).json({ error: 'Missing user content or schema' });

      const { model, effort, armError } = resolveAgentStageModel({ stage, arm, userId: req.user?.id });
      if (armError) return res.status(403).json({ ok: false, error: armError });

      const out = await callStructured({
        model, system, user, imageUrl, imageUrls, schema, maxTokens, effort,
        name: `browser_agent_${stage}`.slice(0, 60),
        // Per stage, not per task: the stable prefix is the stage's system
        // prompt, so every task this user runs through a stage shares it. Scoped
        // by user because the key is only a routing hint and a shared one would
        // pull unrelated tenants onto the same backend for no gain.
        cacheKey: `browser-agent:${stage}:${(req.user?.id || 'anon').slice(0, 32)}`,
      });

      // Surface upstream time so the harness can separate provider latency from
      // our own overhead without guessing.
      res.set('X-Lykn-Upstream-Ms', String(out.upstreamMs || 0));

      if (!out.ok) {
        return res.status(out.status && out.status >= 400 ? out.status : 502)
          .json({ ok: false, error: out.error || 'model call failed', model, provider: out.provider });
      }

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: `browser_agent_${stage}`,
          model, provider: out.provider,
          inputTokens: out.usage?.inputTokens || 0, outputTokens: out.usage?.outputTokens || 0,
          metadata: { latency_ms: out.upstreamMs, arm: arm || undefined },
        });
      }).catch(() => {});

      // usage is returned to the client so the harness can account for cost
      // without reconstructing it from ai_usage_logs by time window.
      return res.json({ ok: true, json: out.json, model, provider: out.provider, usage: out.usage, upstreamMs: out.upstreamMs });
    } catch (err) {
      console.error('❌ /api/desktop/agent-model:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Agent model call failed' });
    }
  });

  /**
   * Grounding stage: turn a described element into a point on the screenshot.
   *
   * A separate route rather than another `stage` on /api/desktop/agent-model,
   * because that handler speaks the three JSON-schema dialects and this one
   * speaks Holo's structured_outputs — they would share the middleware and
   * nothing else. Keeping them apart also keeps the usage ledger honest:
   * grounding is its own actionType with its own provider.
   */
  app.post('/api/desktop/agent-ground', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const description = String(req.body?.description || '').slice(0, 300).trim();
      const imageUrl = String(req.body?.imageUrl || '').trim();
      const intent = ['click', 'type', 'drag_from', 'drag_to'].includes(req.body?.intent)
        ? req.body.intent : 'click';
      const url = String(req.body?.url || '').slice(0, 500);
      const title = String(req.body?.title || '').slice(0, 200);
      const hint = String(req.body?.hint || '').slice(0, 300);

      if (!description || !imageUrl.startsWith('data:image/')) {
        return res.status(400).json({ ok: false, error: 'Missing description or image' });
      }
      if (!process.env.HAI_API_KEY) {
        return res.status(503).json({ ok: false, error: 'Grounding not configured' });
      }

      const out = await runHoloGrounding({ description, imageUrl, intent, url, title, hint });
      res.set('X-Lykn-Upstream-Ms', String(out.upstreamMs || 0));

      if (!out.ok) {
        return res.status(out.status && out.status >= 400 ? out.status : 502)
          .json({ ok: false, error: out.error });
      }

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'browser_agent_ground',
          model: out.model, provider: 'holo',
          inputTokens: out.usage?.inputTokens || 0, outputTokens: out.usage?.outputTokens || 0,
          metadata: { latency_ms: out.upstreamMs, found: out.found },
        });
      }).catch(() => {});

      // found:false is a 200 on purpose — "I looked and it is not there" is a
      // perception result, not a transport failure, and the client routes the
      // two very differently (invalid decision vs. abort the run).
      return res.json({
        ok: true,
        found: out.found,
        ...(out.found ? { x: out.x, y: out.y } : {}),
        confidence: out.confidence,
        note: out.note,
        model: out.model,
        provider: 'holo',
        usage: out.usage,
        upstreamMs: out.upstreamMs,
      });
    } catch (err) {
      console.error('❌ /api/desktop/agent-ground:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Grounding call failed' });
    }
  });

  // Next-step planner for adaptive browser control — re-scan after each action.
  app.post('/api/desktop/browser-plan-next', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      if (!browserControlConfigured()) return res.status(503).json({ error: 'AI not configured' });

      // Keep head + tail of long multi-clause goals so "…and complete it" isn't truncated.
      const rawIntent = String(req.body?.intent || '').trim();
      const intent =
        rawIntent.length <= 1200
          ? rawIntent
          : `${rawIntent.slice(0, 900)} … ${rawIntent.slice(-280)}`;
      const url = String(req.body?.url || '').slice(0, 500).trim();
      const title = String(req.body?.title || '').slice(0, 200).trim();
      // General tasks may need more of the page in view (dense apps, long forms).
      // The planner still gets the screenshot too, so this is the upper bound of
      // what it can click by selector.
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 130) : [];
      const pageText = String(req.body?.pageText || '').slice(0, 15000).trim();
      const imageUrl = String(req.body?.imageUrl || '').trim();
      const hasImage = imageUrl.startsWith('data:image/');
      const conversationContext = formatConversationForBrowserPlan(req.body?.conversationHistory);
      const stuckHint = String(req.body?.stuckHint || '').slice(0, 500).trim();
      const forceAction = !!req.body?.forceAction;
      const completedSteps = Array.isArray(req.body?.completedSteps)
        ? req.body.completedSteps.slice(-25)
        : [];
      const useHoloAgent = getBrowserControlProvider() === 'holo';
      if (!intent) return res.status(400).json({ error: 'Missing intent' });
      if (!items.length && !useHoloAgent) return res.status(400).json({ error: 'No interactable elements' });

      const taskPlan = String(req.body?.taskPlan || '').slice(0, 2000).trim();
      const rawActionDiff = String(req.body?.lastActionDiff || '').slice(0, 1200).trim();
      // Stall escalation from the client loop must reach the Holo pipeline too.
      const lastActionDiff = [
        stuckHint ? `IMPORTANT — ${stuckHint}` : '',
        rawActionDiff,
      ].filter(Boolean).join('\n');
      const complexTaskHolo = userWantsComplexTask(intent);
      const multiQuestionHolo = wantsMultiQuestion(intent);
      // Passive actions (scroll/wait/hover) are not evidence of real task work —
      // don't let them satisfy the minimum-steps-before-done guards.
      const okCompletedSteps = completedSteps.filter(
        (s) =>
          s?.ok !== false &&
          !/^(?:scroll|wait|hover|mouseover)$/i.test(String(s?.type || '')),
      ).length;
      const pickNextTaskPlan = (readerResult, fallback = taskPlan) => {
        const fromBrief = String(readerResult?.brief?.stepByStepPlan || '').trim();
        const fromReader = String(readerResult?.taskPlan || '').trim();
        return (fromBrief || fromReader || fallback || '').slice(0, 2000);
      };

      if (useHoloAgent) {
        const domOrdinalClick = resolveOrdinalDomClick(intent, items);
        if (domOrdinalClick) {
          const ord = parseOrdinalFromIntent(intent);
          return res.json({
            agentMode: 'holo',
            pipeline: 'dom-ordinal-click',
            holoSkipped: true,
            done: false,
            explanation: `Clicking ${ord?.ordinal === -1 ? 'last' : `#${ord?.ordinal || ''}`} visible row via DOM.`,
            reasoning: domOrdinalClick.label || '',
            taskPlan,
            actions: [domOrdinalClick],
          });
        }

        const readerResult = await runScreenReader({
          intent,
          imageUrl,
          url,
          title,
          pageText,
          taskPlan,
          lastActionDiff,
          completedSteps,
          conversationContext,
          items,
          cacheKey: `browser-screen-read:${(req.user?.id || 'anon').slice(0, 32)}`,
        });
        if (!readerResult.ok) {
          console.error('❌ /api/desktop/browser-plan-next screen-reader:', readerResult.status, readerResult.error?.slice(0, 200));
          return res.status(502).json({ error: 'Planning failed' });
        }
        const nextTaskPlanHolo = pickNextTaskPlan(readerResult, taskPlan);

        // Only hard-stop on goalProgress "complete" (never "likely_complete") — the
        // reader often marks "likely_complete" after opening a quiz/form/editor.
        // Multi-question / complete-the-exercise asks also need page evidence.
        const readerWantsDone = readerResult.brief?.nextStep?.action === 'done';
        const readerFullyComplete = readerResult.brief?.goalProgress === 'complete';
        const minStepsForReaderDone = multiQuestionHolo || complexTaskHolo ? 3 : 1;
        const exerciseDoneOnPage = pageShowsExerciseComplete(pageText);
        const shareIntentReader = /\b(share|invite|give\b.{0,20}\baccess)\b/i.test(intent);
        const shareEmailsReader = String(intent).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
        const shareInviteDoneReader = (() => {
          if (!shareIntentReader) return true;
          const t = String(pageText || '').toLowerCase();
          const strong =
            /\b(access updated|invitation sent|invite sent|invite has been sent|notification sent|shared with|was shared|successfully shared|person added|people added|added as (an? )?(editor|viewer|commenter))\b/i.test(
              t,
            );
          if (!strong) return false;
          if (!shareEmailsReader.length) return true;
          return shareEmailsReader.every((e) => t.includes(String(e).toLowerCase()));
        })();
        const readerSaysDone =
          readerFullyComplete &&
          readerWantsDone &&
          okCompletedSteps >= minStepsForReaderDone &&
          !(multiQuestionHolo && !exerciseDoneOnPage) &&
          shareInviteDoneReader;
        if (readerSaysDone) {
          getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
            const usage = extractOpenAIUsage(readerResult.data);
            logAiUsage({
              sessionId: session?.id, userId: req.user?.id, actionType: 'browser_screen_read',
              model: readerResult.model || 'gpt-4.1',
              provider: 'openai',
              inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
            });
          }).catch(() => {});
          return res.json({
            agentMode: 'holo',
            pipeline: 'reader-holo-report',
            done: true,
            explanation: readerResult.brief?.nextStep?.rationale || readerResult.explanation || 'Task appears complete.',
            reasoning: readerResult.brief?.summary || '',
            taskPlan: nextTaskPlanHolo,
            actions: [],
            screenBrief: readerResult.screenBrief,
            agentResult: readerResult.brief?.nextStep?.rationale || readerResult.explanation || '',
          });
        }
        // Reader said done too early — strip that so Holo keeps acting from the brief.
        if (
          readerWantsDone &&
          readerResult.brief?.nextStep &&
          (!readerFullyComplete ||
            okCompletedSteps < minStepsForReaderDone ||
            (multiQuestionHolo && !exerciseDoneOnPage) ||
            !shareInviteDoneReader)
        ) {
          const ns = readerResult.brief.nextStep;
          const hasClick =
            ns.clickPoint &&
            Number.isFinite(Number(ns.clickPoint.x)) &&
            Number.isFinite(Number(ns.clickPoint.y));
          ns.action = hasClick ? 'click' : 'wait';
          ns.rationale =
            (ns.rationale ? `${ns.rationale} ` : '') +
            'GOAL NOT FINISHED YET — keep working through the remaining steps on this screen.';
          readerResult.brief.goalProgress =
            readerResult.brief.goalProgress === 'complete' ||
            readerResult.brief.goalProgress === 'likely_complete'
              ? 'in_progress'
              : readerResult.brief.goalProgress;
          readerResult.screenBrief =
            'IMPORTANT: Do NOT call answer yet — the USER GOAL is still unfinished. ' +
            'Verify the screen and take the next concrete click/write.\n' +
            formatScreenBriefForHolo(readerResult.brief);
        }

        // Reader provides grounded click coords — skip Holo so it can't re-pick item #1.
        if (readerResult.directClick) {
          getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
            const usage = extractOpenAIUsage(readerResult.data);
            logAiUsage({
              sessionId: session?.id, userId: req.user?.id, actionType: 'browser_screen_read',
              model: readerResult.model || 'gpt-4.1',
              provider: 'openai',
              inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
            });
          }).catch(() => {});
          return res.json({
            agentMode: 'holo',
            pipeline: 'reader-direct-click',
            holoSkipped: true,
            done: false,
            explanation: readerResult.brief?.nextStep?.rationale || readerResult.explanation || '',
            reasoning: readerResult.brief?.summary || '',
            taskPlan: nextTaskPlanHolo,
            actions: [readerResult.directClick],
            screenBrief: readerResult.screenBrief,
          });
        }

        const holoResult = await runHoloBrowserStep({
          holoMessages: req.body?.holoMessages,
          intent,
          imageUrl,
          toolOutput: req.body?.toolOutput,
          toolName: req.body?.toolName,
          pageText,
          url,
          title,
          lastActionDiff,
          conversationContext,
          screenBrief: readerResult.screenBrief,
          taskPlan: nextTaskPlanHolo,
        });
        if (!holoResult.ok) {
          console.error('❌ /api/desktop/browser-plan-next holo:', holoResult.status, holoResult.error?.slice(0, 200));
          return res.status(502).json({ error: 'Planning failed' });
        }
        getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
          const readerUsage = extractOpenAIUsage(readerResult.data);
          const holoUsage = extractOpenAIUsage(holoResult.data);
          logAiUsage({
            sessionId: session?.id, userId: req.user?.id, actionType: 'browser_screen_read',
            model: readerResult.model || 'gpt-4.1',
            provider: 'openai',
            inputTokens: readerUsage.input_tokens || 0, outputTokens: readerUsage.output_tokens || 0,
          });
          logAiUsage({
            sessionId: session?.id, userId: req.user?.id, actionType: 'browser_plan_next',
            model: holoResult.model || 'browser-control',
            provider: 'holo',
            inputTokens: holoUsage.input_tokens || 0, outputTokens: holoUsage.output_tokens || 0,
          });
        }).catch(() => {});
        let actions = Array.isArray(holoResult.actions) ? holoResult.actions : [];
        if (
          actions.length > 1 &&
          !/^(os_write|write|type|fill|click_type)$/i.test(String(actions[0]?.type || ''))
        ) {
          actions = actions.slice(0, 1);
        }
        let holoDone = !!holoResult.done;
        const shareIntent = /\b(share|invite|give\b.{0,20}\baccess)\b/i.test(intent);
        const shareEmails = String(intent).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
        const shareInviteComplete = (() => {
          const t = String(pageText || '').toLowerCase();
          const strong =
            /\b(access updated|invitation sent|invite sent|invite has been sent|notification sent|shared with|was shared|successfully shared|person added|people added|added as (an? )?(editor|viewer|commenter))\b/i.test(
              t,
            );
          if (!strong) return false;
          if (!shareEmails.length) return true;
          return shareEmails.every((e) => t.includes(String(e).toLowerCase()));
        })();
        // Mirror OpenAI path: never accept done for multi-question / complex
        // exercise goals until the page shows completion evidence.
        if (holoDone && (complexTaskHolo || shareIntent)) {
          const checks = countChecksCompleted(completedSteps);
          const screenChanges = (Array.isArray(completedSteps) ? completedSteps : []).filter(
            (s) => s?.ok && s?.screenChanged,
          ).length;
          if (shareIntent && !shareInviteComplete) {
            holoDone = false;
          } else if (multiQuestionHolo && !pageShowsExerciseComplete(pageText)) {
            holoDone = false;
          } else if (userWantsVisionClick(intent) && checks === 0 && okCompletedSteps < 2) {
            holoDone = false;
          } else if (okCompletedSteps < 2 && /complete|finish|fill|share|invite|submit|solve|work\s+through/i.test(intent)) {
            holoDone = false;
          } else if (
            complexTaskHolo &&
            !shareIntent &&
            !multiQuestionHolo &&
            okCompletedSteps < 3 &&
            screenChanges < 1
          ) {
            // General multi-step (find+do) — landing + one click is not done.
            holoDone = false;
          }
        }
        if (holoDone && !actions.length) {
          return res.json({
            agentMode: 'holo',
            pipeline: 'reader-holo-report',
            holoMessages: holoResult.holoMessages,
            holoToolName: holoResult.holoToolName,
            done: true,
            explanation: holoResult.explanation || readerResult.explanation || holoResult.reasoning || '',
            reasoning: holoResult.reasoning || readerResult.brief?.summary || '',
            taskPlan: nextTaskPlanHolo,
            actions: [],
            screenBrief: readerResult.screenBrief,
            agentResult: holoResult.explanation || '',
          });
        }
        // Premature answer with no click — force continue (client also rejects).
        if (!holoDone && !actions.length && (multiQuestionHolo || complexTaskHolo)) {
          return res.json({
            agentMode: 'holo',
            pipeline: 'reader-holo-report',
            holoMessages: holoResult.holoMessages,
            holoToolName: holoResult.holoToolName || 'answer',
            done: false,
            explanation:
              holoResult.explanation ||
              readerResult.explanation ||
              'Goal is not finished yet — continue with the next on-screen step.',
            reasoning: holoResult.reasoning || readerResult.brief?.summary || '',
            taskPlan: nextTaskPlanHolo,
            actions: [],
            screenBrief: readerResult.screenBrief,
            forceContinue: true,
            agentResult: '',
          });
        }
        return res.json({
          agentMode: 'holo',
          pipeline: 'reader-holo-report',
          holoMessages: holoResult.holoMessages,
          holoToolName: holoResult.holoToolName,
          done: holoDone,
          explanation: holoResult.explanation || readerResult.explanation || holoResult.reasoning || '',
          reasoning: holoResult.reasoning || readerResult.brief?.summary || '',
          taskPlan: nextTaskPlanHolo,
          actions,
          screenBrief: readerResult.screenBrief,
          agentResult: holoDone ? (holoResult.explanation || '') : '',
        });
      }

      const catalog = items.map((el, i) => ({
        id: String(el?.id || `el${i}`),
        tag: String(el?.tag || ''),
        type: String(el?.type || ''),
        role: String(el?.role || ''),
        selector: String(el?.selector || '').slice(0, 300),
        label: String(el?.label || '').slice(0, 120),
        value: String(el?.value || '').slice(0, 80),
        href: String(el?.href || '').slice(0, 200),
        checked: !!el?.checked,
      })).filter((el) => el.selector);

      const filteredCatalog = filterCatalogForIntent(catalog, intent, pageText);
      const lastReasoning = String(req.body?.lastReasoning || '').slice(0, 800).trim();
      const isFirstTurn = completedSteps.length === 0;
      const complexTask = userWantsComplexTask(intent);
      const visionClick = userWantsVisionClick(intent);
      const progressNote = summarizeTaskProgress(completedSteps, intent);
      const sessionSummary = String(req.body?.sessionSummary || '').slice(0, 1200).trim();

      const doneSummary = completedSteps
        .map((s, i) => {
          const changed = s.screenChanged ? 'screen updated' : 'no visible change';
          const wrong = s.wasWrong ? ' (wrong answer)' : '';
          const diff = s.pageDiff ? ` — ${s.pageDiff}` : '';
          return `${i + 1}. ${s.type || 'step'} “${String(s.label || '').slice(0, 80)}” ${s.ok ? 'ok' : 'failed'} (${changed})${wrong}${diff}`;
        })
        .join('\n');

      // Owned-browser loop sends raw {action, result} history — without it the
      // planner has no memory of its own actions and repeats failed clicks.
      const actionHistorySummary = (Array.isArray(req.body?.history) ? req.body.history : [])
        .slice(-12)
        .map((h, i) => {
          const a = h?.action || {};
          const r = h?.result || {};
          const target = String(a.label || a.value || a.key || a.url || '').slice(0, 70);
          const outcome = r.ok
            ? 'ok'
            : `FAILED (${String(r.error || 'no result').slice(0, 60)})`;
          const covered =
            r.hitTest === false ? ' — click point may have been covered by another element' : '';
          return `${i + 1}. ${a.type || 'act'} “${target}” → ${outcome}${covered}`;
        })
        .join('\n');

      const searchHint = userWantsSearchOrType(intent)
        ? String(req.body?.searchHint || intent.replace(/^search( for| up)?\s*/i, '').replace(/^look up\s*/i, '').trim()).slice(0, 200).trim()
        : '';
      const systemContent = buildBrowserControlSystemContent({
        intent,
        taskPlan,
        isFirstTurn,
        searchHint,
        complexTask,
        visionClick,
      });

      const userText =
        `USER GOAL (execute this — every action must serve it):\n${intent}\n\n` +
        (conversationContext
          ? `PRIOR CHAT (same overlay session):\n${conversationContext}\n\n`
          : '') +
        `PAGE NOW: ${title}\nURL: ${url}\n\n` +
        (pageText
          ? `PAGE TEXT:\n${pageText}\n\n`
          : 'WARNING: No page text — read the screenshot carefully.\n\n') +
        (lastActionDiff ? `WHAT CHANGED AFTER YOUR LAST ACTION (verify this matches what you intended):\n${lastActionDiff}\n\n` : '') +
        (progressNote ? `PROGRESS: ${progressNote}\n\n` : '') +
        (sessionSummary ? `SESSION MEMORY (what you already did — do NOT repeat these steps):\n${sessionSummary}\n\n` : '') +
        (taskPlan
          ? `WORKING PLAN (execute ONLY the NOW step; rewrite after WHAT CHANGED / NEW controls):\n${taskPlan}\n\n`
          : '') +
        (lastReasoning ? `YOUR LAST REASONING:\n${lastReasoning}\n\n` : '') +
        (searchHint ? `SEARCH QUERY TO TYPE: ${searchHint}\n\n` : '') +
        (forceAction || stuckHint
          ? `MANDATORY: ${stuckHint || 'Return exactly one action from ELEMENTS now.'}\n\n`
          : '') +
        (doneSummary ? `ALREADY DONE:\n${doneSummary}\n\n` : '') +
        (actionHistorySummary
          ? `ACTIONS ALREADY TRIED (never repeat a failed or no-effect action — pick a DIFFERENT element or approach):\n${actionHistorySummary}\n\n`
          : '') +
        `ELEMENTS (act on one by its "id"):\n${JSON.stringify(compactCatalogForModel(filteredCatalog), null, 0)}` +
        (hasImage ? '\n\n(Screenshot attached — read the UI like you would in overlay chat.)' : '');

      async function callPlanner(extraSystem = '') {
        const plannerResult = await callBrowserControlPlanner({
          messages: buildBrowserPlannerMessages({
            systemContent: systemContent + extraSystem,
            userText,
            imageUrl,
          }),
          temperature: 0.1,
          maxTokens: 900,
        });
        if (!plannerResult.ok) {
          console.error(
            `❌ /api/desktop/browser-plan-next ${plannerResult.provider || 'unknown'}:`,
            plannerResult.status,
            plannerResult.error?.slice(0, 200),
          );
          return null;
        }
        return { data: plannerResult.data, provider: plannerResult.provider, model: plannerResult.model };
      }

      let plannerMeta = await callPlanner();
      if (!plannerMeta) return res.status(502).json({ error: 'Planning failed' });
      let data = plannerMeta.data;

      let done = false;
      let explanation = '';
      let reasoning = '';
      let nextTaskPlan = taskPlan;
      let actions = [];
      try {
        const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
        done = !!parsed.done;
        reasoning = String(parsed.reasoning || '').trim().slice(0, 800);
        explanation = String(parsed.explanation || reasoning || '').trim().slice(0, 600);
        if (parsed.taskPlan) nextTaskPlan = String(parsed.taskPlan).trim().slice(0, 2000);
        actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      } catch (_) { /* keep defaults */ }

      // Complex tasks: don't accept done:true until exercise truly complete or progress says so.
      if (done && complexTask) {
        const checks = countChecksCompleted(completedSteps);
        const okSteps = (Array.isArray(completedSteps) ? completedSteps : []).filter((s) => s?.ok).length;
        const screenChanges = (Array.isArray(completedSteps) ? completedSteps : []).filter(
          (s) => s?.ok && s?.screenChanged,
        ).length;
        if (wantsMultiQuestion(intent) && !pageShowsExerciseComplete(pageText)) {
          done = false;
        } else if (userWantsVisionClick(intent) && checks === 0 && completedSteps.length < 2) {
          done = false;
        } else if (
          !wantsMultiQuestion(intent) &&
          !userWantsVisionClick(intent) &&
          okSteps < 3 &&
          screenChanges < 1 &&
          /then|after that|and then|find .+ and |complete|finish|fill|submit|share|invite|keep going|go through|write|draft|reply/i.test(
            String(intent || ''),
          )
        ) {
          done = false;
        } else if (
          /then|after that|and then|complete|finish|share|invite|write.{0,40}share|find.{0,40}complete/i.test(
            String(intent || ''),
          ) &&
          okSteps < 2
        ) {
          // Compound asks: opening alone is never done.
          done = false;
        }
      }

      // Retry once if model returned prose without a click action.
      if (!done && !actions.length) {
        const retryExtra = userWantsSearchOrType(intent)
          ? 'Think like chat: click the search field, type the query, press Enter. Return type + press Enter actions.'
          : visionClick
            ? 'Read the SCREENSHOT. Return click on matching img from ELEMENTS, or click_coord with x,y (0-1000) at the target center.'
            : 'Return done:false, fill reasoning, and exactly ONE action that advances the USER GOAL — an element from ELEMENTS (copy its selector verbatim), or a click_coord at the target center if it is not in ELEMENTS.';
        const retryMeta = await callPlanner(`\n\nRETRY: Your previous response had no actions. ${retryExtra}`);
        if (retryMeta) {
          plannerMeta = retryMeta;
          data = retryMeta.data;
          try {
            const parsed = JSON.parse(retryMeta.data.choices?.[0]?.message?.content || '{}');
            done = !!parsed.done;
            reasoning = String(parsed.reasoning || reasoning || '').trim().slice(0, 800);
            explanation = String(parsed.explanation || reasoning || explanation || '').trim().slice(0, 600);
            if (parsed.taskPlan) nextTaskPlan = String(parsed.taskPlan).trim().slice(0, 2000);
            actions = Array.isArray(parsed.actions) ? parsed.actions : [];
          } catch (_) { /* keep first parse */ }
        }
      }

      // Holo grounding fallback: when vision is needed and the planner still returned
      // no click, use Holo's single-turn element localization (ScreenSpot-grade).
      if (
        !done &&
        !actions.length &&
        getBrowserControlProvider() === 'holo' &&
        hasImage &&
        (visionClick || forceAction)
      ) {
        const target =
          String(req.body?.visionTarget || '').trim().slice(0, 400) ||
          intent.slice(0, 200);
        const pt = await callHoloElementLocalization(imageUrl, target);
        if (pt) {
          actions = [{
            type: 'click_coord',
            x: pt.x,
            y: pt.y,
            label: target.slice(0, 120) || 'vision click',
          }];
          explanation = explanation || `Clicking “${target.slice(0, 80)}” (Holo vision).`;
          reasoning = reasoning || `Localized target at (${pt.x}, ${pt.y}).`;
        }
      }

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(data);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'browser_plan_next',
          model: plannerMeta?.model || 'browser-control',
          provider: plannerMeta?.provider || 'openai',
          inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
        });
      }).catch(() => {});

      // Limit to one action, or an atomic pair: type+Enter, or select_all+edit
      // (formatting/copy in editors), or one click_coord.
      if (actions.length > 2) actions = actions.slice(0, 2);
      const atomicPair =
        (actions[0]?.type === 'type' && actions[1]?.type === 'press') ||
        (actions[0]?.type === 'select_all' &&
          ['shortcut', 'copy', 'cut', 'click', 'press'].includes(String(actions[1]?.type || '')));
      if (actions.length === 2 && !atomicPair) {
        actions = actions.slice(0, 1);
      }
      if (actions[0]?.type === 'click_coord') {
        actions = actions.slice(0, 1);
      }

      return res.json({ done, explanation, reasoning, taskPlan: nextTaskPlan, actions });
    } catch (err) {
      console.error('❌ /api/desktop/browser-plan-next:', err?.message || err);
      return res.status(500).json({ error: 'Planning failed' });
    }
  });


  // Turn raw browser automation results into a user-facing LYKN overlay message.
  app.post('/api/desktop/browser-report', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'AI not configured' });

      const intent = String(req.body?.intent || '').slice(0, 500).trim();
      const url = String(req.body?.url || '').slice(0, 500).trim();
      const title = String(req.body?.title || '').slice(0, 200).trim();
      const screenBrief = String(req.body?.screenBrief || '').slice(0, 4000).trim();
      const agentResult = String(req.body?.agentResult || req.body?.explanation || '').slice(0, 2000).trim();
      const ok = req.body?.ok !== false;
      const completedSteps = Array.isArray(req.body?.completedSteps) ? req.body.completedSteps.slice(-20) : [];
      const conversationContext = formatConversationForBrowserPlan(req.body?.conversationHistory);
      if (!intent) return res.status(400).json({ error: 'Missing intent' });

      const reportResult = await runBrowserTaskReport({
        intent,
        ok,
        completedSteps,
        screenBrief,
        agentResult,
        url,
        title,
        conversationContext,
      });
      if (!reportResult.ok) {
        console.error('❌ /api/desktop/browser-report:', reportResult.status, reportResult.error?.slice(0, 200));
        return res.status(502).json({ error: 'Report failed' });
      }

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        const usage = extractOpenAIUsage(reportResult.data);
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'browser_report',
          model: reportResult.model || 'gpt-4.1-nano',
          provider: 'openai',
          inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
        });
      }).catch(() => {});

      return res.json({ message: reportResult.message });
    } catch (err) {
      console.error('❌ /api/desktop/browser-report:', err?.message || err);
      return res.status(500).json({ error: 'Report failed' });
    }
  });


  app.get('/api/desktop/chats', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not signed in' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '40'), 10) || 40, 1), 80);
      const { data, error } = await supabaseAdmin
        .from('lykn_chats')
        .select('id, title, updated_at, created_at, lykn_chat_states(state)')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(limit * 2);

      if (error) {
        console.error('❌ /api/desktop/chats:', error.message);
        return res.status(500).json({ error: 'Failed to load chats' });
      }

      const rows = [];
      for (const row of data || []) {
        const state = desktopChatStateFromRow(row);
        const customTitle = String(row.title || '').trim();
        const hasCustomTitle = customTitle && !DEFAULT_CHAT_TITLES.has(customTitle);
        if (state == null) {
          if (!hasCustomTitle) continue;
        } else if (!hasCustomTitle && !desktopSnapshotHasContext(state)) {
          continue;
        }
        rows.push({
          id: row.id,
          title: desktopChatTitle(row, state),
          preview: desktopChatPreview(state),
          updatedAt: row.updated_at || row.created_at || null,
          source: 'app',
        });
        if (rows.length >= limit) break;
      }

      return res.json({ chats: rows });
    } catch (err) {
      console.error('❌ /api/desktop/chats:', err?.message || err);
      return res.status(500).json({ error: 'Failed to load chats' });
    }
  });

  // Persist a ⌘L overlay conversation into the SAME store the web/desktop app
  // reads (lykn_chats + lykn_chat_states), so overlay chats show up in the app's
  // "previous chats" sidebar — not just the overlay's own list. The overlay keeps
  // its local copy (overlay-sessions.json) for offline/instant listing; this is
  // the durable, cross-surface mirror. Idempotent upsert keyed on the overlay
  // sessionId (already a UUID), so re-saving the same conversation updates it.
  app.post('/api/desktop/chats/save', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not signed in' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database not configured' });

      const chatId = String(req.body?.chatId || '').trim();
      // lykn_chats.id is a uuid column — reject anything that isn't one so a
      // malformed id can't 500 the insert.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(chatId)) return res.status(400).json({ error: 'invalid_chat_id' });

      const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const messages = rawMessages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
        .map((m) => ({
          role: m.role,
          content: String(m.content).slice(0, 12000),
          at: typeof m.at === 'string' ? m.at : null,
        }));
      if (!messages.length) return res.json({ ok: false, reason: 'empty' });

      // Pair the flat user/assistant stream into the app's chatMessages shape
      // ({ id, content: <user>, aiResponse: <assistant> }) that the chat rail
      // renders and the desktop-chats listing reads for title/preview.
      // NOTE: the app's chat renderer (LyknChatView) keys every turn on
      // `role: "user"` and shows the assistant bubble only when
      // `msg.role === "user" && msg.aiResponse`. So each paired turn MUST carry
      // role:"user" — without it the prompt renders but the AI reply is hidden.
      const chatMessages = [];
      let pending = null;
      for (const m of messages) {
        if (m.role === 'user') {
          if (pending) chatMessages.push(pending);
          pending = { id: crypto.randomUUID(), role: 'user', content: m.content, aiResponse: '', ...(m.at ? { createdAt: m.at } : {}) };
        } else {
          if (pending) {
            pending.aiResponse = m.content;
            if (m.at) pending.aiCompletedAt = m.at;
            chatMessages.push(pending);
            pending = null;
          } else {
            chatMessages.push({ id: crypto.randomUUID(), role: 'user', content: '', aiResponse: m.content, ...(m.at ? { aiCompletedAt: m.at } : {}) });
          }
        }
      }
      if (pending) chatMessages.push(pending);

      const title =
        (String(req.body?.title || '').trim() ||
          chatMessages.find((m) => m.content)?.content ||
          'New Chat').slice(0, 120);

      const now = new Date().toISOString();
      // Mirror the web client's snapshot contract (useLyknChatPersistence
      // buildSnapshot): an empty canvas + the conversation. SNAPSHOT_VERSION = 2.
      const snapshot = {
        version: 2,
        blocks: {},
        blockOrder: [],
        camera: { x: 0, y: 0, zoom: 1 },
        gridSize: 24,
        wireConnections: [],
        chatMessages,
        aiThread: messages.map((m) => ({ role: m.role, content: m.content })).slice(-40),
        notesPages: [
          { id: crypto.randomUUID(), title: 'Page 1', content: { type: 'doc', content: [{ type: 'paragraph' }] } },
        ],
        title,
        source: 'overlay',
      };

      // Upsert the board row (don't clobber a title the user set in the app:
      // only update title if the existing one is still a default).
      const { data: existing } = await supabaseAdmin
        .from('lykn_chats')
        .select('id, title')
        .eq('id', chatId)
        .eq('user_id', userId)
        .maybeSingle();

      if (!existing?.id) {
        const { error: insErr } = await supabaseAdmin
          .from('lykn_chats')
          .insert({ id: chatId, user_id: userId, title, updated_at: now });
        if (insErr) {
          // A row may exist under a different user_id (shouldn't happen) — bail safely.
          console.error('❌ overlay chat board insert:', insErr.message);
          return res.status(500).json({ error: 'board_insert_failed' });
        }
      } else {
        const keepTitle = existing.title && !DEFAULT_CHAT_TITLES.has(String(existing.title).trim());
        await supabaseAdmin
          .from('lykn_chats')
          .update({ updated_at: now, ...(keepTitle ? {} : { title }) })
          .eq('id', chatId)
          .eq('user_id', userId);
      }

      // Deliberately NOT an upsert on chat_id: an unscoped upsert would overwrite
      // whatever row holds this chat_id regardless of owner, leaving authorization
      // to the lykn_chats PK collision above. Scope the update by user_id and let
      // a foreign row surface as a unique-violation on insert instead.
      const stateRow = { chat_id: chatId, state: snapshot, version: 2, user_id: userId, updated_at: now };
      const { data: stateUpdated, error: stateUpdErr } = await supabaseAdmin
        .from('lykn_chat_states')
        .update(stateRow)
        .eq('chat_id', chatId)
        .eq('user_id', userId)
        .select('chat_id');
      let stateErr = stateUpdErr;
      if (!stateErr && !stateUpdated?.length) {
        const { error: insErr } = await supabaseAdmin.from('lykn_chat_states').insert(stateRow);
        if (insErr && insErr.code === '23505') {
          // Lost a race with a concurrent save of the same chat — retry the
          // scoped update once. Still fails (correctly) if the row is foreign.
          const { data: retried, error: retryErr } = await supabaseAdmin
            .from('lykn_chat_states')
            .update(stateRow)
            .eq('chat_id', chatId)
            .eq('user_id', userId)
            .select('chat_id');
          stateErr = retryErr || (retried?.length ? null : insErr);
        } else {
          stateErr = insErr;
        }
      }
      if (stateErr) {
        console.error('❌ overlay chat state upsert:', stateErr.message);
        return res.status(500).json({ error: 'state_save_failed' });
      }

      return res.json({ ok: true, id: chatId });
    } catch (err) {
      console.error('❌ /api/desktop/chats/save:', err?.message || err);
      return res.status(500).json({ error: 'Failed to save chat' });
    }
  });

  // ──────────────────────────────────────────────────
  // Auto-name chat — fire-and-forget after the first user→assistant
  // exchange. Generates a 2-5 word title from the first turn, writes it
  // straight to `lykn_chats.title` (server-owned so RLS / auth all run
  // on the trusted side), and returns the title for the client to surface
  // in the sidebar / toolbar via the existing `omnia_board_renamed` and
  // `lykinsai_chats_changed` events.
  //
  // Guards (server-side, defence-in-depth — client also gates):
  //   • only renames if the board's current title is still the default
  //     ("New Chat") — never overwrite a manual rename
  //   • verifies user_id ownership before writing
  //   • silent no-op on any failure (returns 200 with applied:false) so
  //     a flake never breaks the chat surface
  // ──────────────────────────────────────────────────
  app.post('/api/ai/name-chat', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'LLM not configured' });

      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not signed in' });

      const chatId = String(req.body?.chatId || '').trim();
      const userMessage = String(req.body?.userMessage || '').trim();
      const assistantReply = String(req.body?.assistantReply || '').trim();

      if (!chatId) return res.status(400).json({ error: 'chatId required' });
      if (userMessage.length < 4 && assistantReply.length < 20) {
        return res.json({ applied: false, reason: 'too_short' });
      }

      // Verify board ownership AND that the title is still the default
      // before we spend a token generating a name.
      if (!supabaseAdmin) {
        return res.status(503).json({ error: 'Database not configured' });
      }
      const { data: board, error: boardErr } = await supabaseAdmin
        .from('lykn_chats')
        .select('id, title, user_id')
        .eq('id', chatId)
        .eq('user_id', userId)
        .maybeSingle();
      if (boardErr || !board) {
        return res.json({ applied: false, reason: 'not_found' });
      }
      const currentTitle = String(board.title || '').trim();
      if (currentTitle && currentTitle !== 'New Chat' && currentTitle !== 'Untitled board') {
        return res.json({ applied: false, reason: 'already_named', title: currentTitle });
      }

      // Compose a tight transcript snippet for the namer. The user message
      // carries the topic; the assistant reply disambiguates intent. Cap
      // each side so we stay well under the 1500-char snippet budget.
      const userSlice = userMessage.slice(0, 800);
      const replySlice = assistantReply.slice(0, 700);
      const snippet = [
        userSlice ? `User: ${userSlice}` : '',
        replySlice ? `Assistant: ${replySlice}` : '',
      ].filter(Boolean).join('\n\n');

      const nameCache = memCache('chat-name');
      const cacheKey = sha256(snippet);
      const cached = nameCache.get(cacheKey);
      let title = cached;

      let usageData = null;
      let rawOutput = '';
      if (!title) {
        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4.1-nano',
            temperature: 0.4,
            max_tokens: 20,
            // Static system prompt → pin to a per-user cache slot so the
            // OpenAI prompt-cache discount applies on every rename for the
            // same account.
            prompt_cache_key: `chat-name:${userId}`,
            messages: [
              {
                role: 'system',
                content: 'You name chat conversations. Given the first user message and assistant reply, respond with ONLY a short, specific title (2-5 words) that captures the topic. No quotes, no punctuation, no explanation, no trailing period. Just the title in title case.',
              },
              { role: 'user', content: snippet },
            ],
          }),
        });
        if (!openaiRes.ok) {
          return res.status(502).json({ error: 'naming_failed' });
        }
        const data = await openaiRes.json();
        usageData = data;
        rawOutput = data.choices?.[0]?.message?.content?.trim() || '';
        title = rawOutput.replace(/^["']+|["']+$/g, '').replace(/[.!?,;:]+$/g, '').trim().slice(0, 60);
        if (!title) return res.status(502).json({ error: 'empty_title' });
        nameCache.set(cacheKey, title);
      }

      // Write through. We re-check the current title in the WHERE clause
      // so a concurrent manual rename in another tab wins the race.
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('lykn_chats')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', chatId)
        .eq('user_id', userId)
        .in('title', ['New Chat', 'Untitled board', ''])
        .select('id, title')
        .maybeSingle();

      if (updateErr) {
        console.error('❌ name-chat update error:', updateErr.message);
        return res.status(500).json({ error: 'persist_failed' });
      }
      if (!updated) {
        return res.json({ applied: false, reason: 'race_lost', title });
      }

      console.log('[LYKN] Auto-named chat:', title);

      if (usageData) {
        getOrCreateSession(userId).then((session) => {
          const usage = extractOpenAIUsage(usageData);
          logAiUsage({
            sessionId: session?.id, userId, actionType: 'name_chat',
            model: 'gpt-4.1-nano', provider: 'openai',
            inputTokens: usage.input_tokens || estimateTokens(snippet),
            outputTokens: usage.output_tokens || estimateTokens(rawOutput),
          });
        }).catch(() => {});
      }

      return res.json({ applied: true, title });
    } catch (error) {
      console.error('❌ name-chat error:', error?.message);
      return res.status(500).json({ error: 'Naming failed' });
    }
  });
}
