"use strict";

/**
 * Deterministic natural-language → Routine spec parsing, plus conservative
 * capability derivation. No model calls: the Bot's harness may hand this
 * module either structured JSON (preferred — the create_routine tool doc
 * asks for it) or a plain sentence, and both resolve the same way every
 * time. Ambiguity fails loudly rather than guessing a trigger the user
 * didn't ask for.
 */

const path = require("node:path");
const { compileLocalCapabilities } = require("../task-runtime/executors/localCapabilities.cjs");
const { originOf } = require("./browserObservation.cjs");

const DAY_WORDS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const PART_OF_DAY_TIMES = {
  morning: "08:00",
  noon: "12:00",
  afternoon: "14:00",
  evening: "18:00",
  night: "21:00",
};

/** "8", "8am", "8:30 pm", "20:15" → "HH:MM" or null. */
function parseClockTime(raw) {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(String(raw || ""));
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = (match[3] || "").toLowerCase();
  if (minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23) return null;
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function timeFromText(text) {
  const at = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(text);
  if (at) {
    const time = parseClockTime(at[1]);
    if (time) return time;
  }
  for (const [word, time] of Object.entries(PART_OF_DAY_TIMES)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) return time;
  }
  return null;
}

/** A filesystem path mention: ~/x, /Users/..., or a well-known folder name. */
function pathFromText(text) {
  const explicit = /(~\/[^\s"'`,]+|\/(?:Users|Volumes|tmp|var|opt|home)\/[^\s"'`,]+)/.exec(text);
  if (explicit) return explicit[1].replace(/[.,;:]+$/, "");
  const wellKnown = /\b(?:my\s+)?(downloads?|documents|desktop|pictures|movies|music)\s+folder\b/i.exec(text);
  if (wellKnown) {
    const name = wellKnown[1].toLowerCase();
    const folder = name === "download" || name === "downloads" ? "Downloads" : name[0].toUpperCase() + name.slice(1);
    return `~/${folder}`;
  }
  return null;
}

function extensionPatternFromText(text) {
  const match = /\b(?:a\s+)?(?:new\s+)?(pdf|csv|png|jpe?g|zip|mp4|mp3|docx?|xlsx?|txt|json|md)s?\b/i.exec(text);
  return match ? `*.${match[1].toLowerCase()}` : "";
}

function urlFromText(text) {
  const match = /(https?:\/\/[^\s"'`,]+)/i.exec(String(text || ""));
  return match ? match[1].replace(/[.,;:]+$/, "") : "";
}

function looksLikeBrowserWatch(text) {
  return (
    /\b(this\s+(page|tab|dashboard|site|ticket|deployment|button)|the\s+(page|tab|dashboard|site))\b/i.test(text) ||
    /\b(watch|monitor|keep an eye on)\b.*\b(page|tab|dashboard|site|url|button|ticket|deployment|price|status)\b/i.test(
      text,
    ) ||
    /\b(tell me|notify me|alert me|let me know)\b.*\b(page|tab|button|price|status|dashboard|ticket|deployment)\b/i.test(
      text,
    ) ||
    /\bbutton\s+becomes?\s+(enabled|available|clickable)\b/i.test(text)
  );
}

function looksLikeScreenWatch(text) {
  return (
    /\b(this\s+(window|screen|app)|the\s+(window|screen))\b/i.test(text) ||
    /\b(watch|monitor|keep an eye on)\b.*\b(window|screen|export)\b/i.test(text) ||
    /\b(tell me|notify me|alert me|let me know)\b.*\b(window|screen|export)\b/i.test(text)
  );
}

function isNotifyOnlyInstruction(text) {
  const t = String(text || "").toLowerCase();
  const tells = /\b(tell me|notify me|alert me|let me know|ping me)\b/.test(t);
  const acts =
    /\b(inspect|diagnose|investigate|fix|repair|rerun|re-run|open it|click|download|summarize|write|delete|send|email)\b/.test(
      t,
    );
  return tells && !acts;
}

function browserConditionFromText(text) {
  const namedButton = /(?:the\s+)?"?([^"]{2,40})"?\s+button\s+becomes?\s+(enabled|available|clickable)/i.exec(text);
  if (namedButton) {
    const name = namedButton[1].trim();
    if (!/^(this|the|a|that)$/i.test(name)) {
      return {
        event: "enabled",
        target: { kind: "role", role: "button", name },
      };
    }
  }
  if (/\bbecomes?\s+(enabled|available|clickable)\b/i.test(text)) {
    return { event: "enabled", target: { kind: "role", role: "button" } };
  }
  const toValue = /(?:status|state)\s+changes?\s+to\s+["']?([a-z0-9 _-]{1,40})/i.exec(text);
  if (toValue) {
    return {
      event: "equals",
      value: toValue[1].trim(),
      target: { kind: "text", text: toValue[1].trim() },
    };
  }
  const fromWord = /changes?\s+from\s+["']?([a-z0-9 _-]{1,40})/i.exec(text);
  if (fromWord) {
    return { event: "changed", target: { kind: "text", text: fromWord[1].trim() } };
  }
  if (/\bprice\b/i.test(text)) return { event: "changed", target: { kind: "page" } };
  if (/\b(responds?|replies?|comment)\b/i.test(text)) {
    return { event: "changed", target: { kind: "page" }, semantic: true };
  }
  if (/\bfails?\b|\bfailed\b/i.test(text)) {
    return { event: "equals", value: "Failed", target: { kind: "text", text: "Failed" } };
  }
  return { event: "changed", target: { kind: "page" } };
}

function appNameFromText(text) {
  const known = /\b(final cut pro|chrome|safari|firefox|xcode|figma|slack|notion|terminal|finder|preview)\b/i.exec(
    text,
  );
  return known ? known[1] : "";
}

/**
 * Parse a natural-language routine request into { trigger } or null when no
 * trigger phrase is recognizable. Never guesses: an unparseable sentence is
 * the caller's cue to ask for structured fields.
 *
 * @param {string} rawText
 * @param {{ browserContext?: { url?: string, title?: string, appName?: string }, windowContext?: { appName?: string, title?: string } }} [context]
 */
function parseTriggerFromText(rawText, context = {}) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  // Interval: "every 15 minutes", "every hour", "every 2 hours".
  const interval = /\bevery\s+(\d+)?\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(text);
  if (interval && !/\bevery\s+(day|weekday|morning|evening|night|afternoon|week)\b/i.test(text)) {
    const count = Number(interval[1] || 1);
    const unit = /min/i.test(interval[2]) ? 60 * 1000 : 60 * 60 * 1000;
    return { type: "schedule", schedule: { kind: "interval", everyMs: Math.max(1, count) * unit } };
  }

  // Weekdays: "every weekday at 8".
  if (/\bevery\s+week\s*days?\b/i.test(text) || /\bweekdays\b/i.test(text)) {
    const time = timeFromText(text) || "09:00";
    return { type: "schedule", schedule: { kind: "weekdays", time } };
  }

  // Weekly on named days: "every monday", "every mon and fri at 9".
  const namedDays = [];
  for (const [word, day] of Object.entries(DAY_WORDS)) {
    if (new RegExp(`\\b(?:every\\s+)?${word}s?\\b`, "i").test(text) && /\bevery\b/i.test(text)) {
      namedDays.push(day);
    }
  }
  if (namedDays.length) {
    const time = timeFromText(text) || "09:00";
    return { type: "schedule", schedule: { kind: "weekly", time, days: [...new Set(namedDays)].sort() } };
  }

  // Daily: "every day at 7", "every morning", "each night", "nightly", "daily".
  if (
    /\b(every|each)\s+(day|morning|afternoon|evening|night)\b/i.test(text) ||
    /\b(daily|nightly)\b/i.test(text)
  ) {
    const time = timeFromText(text) || "09:00";
    return { type: "schedule", schedule: { kind: "daily", time } };
  }

  // One-time: "tomorrow at 3pm".
  if (/\btomorrow\b/i.test(text)) {
    const time = timeFromText(text) || "09:00";
    const [hour, minute] = time.split(":").map(Number);
    const at = new Date();
    at.setDate(at.getDate() + 1);
    at.setHours(hour, minute, 0, 0);
    return { type: "schedule", schedule: { kind: "once", at: at.getTime() } };
  }

  // Filesystem: "when a pdf appears in ~/Downloads", "whenever a new file
  // lands in my downloads folder", "watch ~/x for changes".
  const watchPath = pathFromText(text);
  if (watchPath) {
    const appears = /\b(appears?|arrives?|lands?|is\s+(added|created|saved|dropped)|shows?\s+up|new)\b/i.test(text);
    const changes = /\b(changes?|changed|is\s+(modified|updated|edited))\b/i.test(text);
    if (appears || changes || /\bwatch\b/i.test(text)) {
      const pattern = extensionPatternFromText(text);
      return {
        type: "filesystem",
        path: watchPath,
        event: changes && !appears ? "changed" : "created",
        ...(pattern ? { pattern } : {}),
      };
    }
  }

  const explicitUrl = urlFromText(text);
  const browserCtx = context.browserContext || {};
  const windowCtx = context.windowContext || {};

  if (looksLikeBrowserWatch(text) || (explicitUrl && /\b(watch|tell me|notify|alert|when)\b/i.test(text))) {
    const url = explicitUrl || String(browserCtx.url || "").trim();
    if (!url) return { _error: "browser_target_required" };
    const cond = browserConditionFromText(text);
    const notifyOnly = isNotifyOnlyInstruction(text);
    return {
      type: "browser",
      url,
      origin: originOf(url),
      ...(browserCtx.title ? { titlePattern: String(browserCtx.title).slice(0, 80) } : {}),
      ...(browserCtx.appName ? { appName: String(browserCtx.appName).slice(0, 80) } : {}),
      target: cond.target,
      condition: {
        event: cond.event,
        ...(cond.value ? { value: cond.value } : {}),
        ...(cond.semantic ? { semantic: true } : {}),
      },
      ...(cond.semantic ? { semantic: true } : {}),
      notifyOnly,
    };
  }

  if (looksLikeScreenWatch(text)) {
    const appName = appNameFromText(text) || String(windowCtx.appName || "").trim();
    const titlePattern = String(windowCtx.title || "").trim();
    if (!appName && !titlePattern) return { _error: "screen_target_required" };
    const notifyOnly = isNotifyOnlyInstruction(text);
    let semanticPrompt = "";
    if (/\bexport\b/i.test(text) && /\b(finish|finished|finishes|done|complete|completed)\b/i.test(text)) {
      semanticPrompt = "export finishes";
    } else if (/\berror/i.test(text) || /\bfail/i.test(text)) semanticPrompt = "an error appears";
    else if (/\b(finish|finished|finishes|done|complete|completed)\b/i.test(text)) semanticPrompt = "this finishes";
    return {
      type: "screen",
      ...(appName ? { appName } : {}),
      ...(titlePattern ? { titlePattern } : {}),
      condition: {
        event: "changed",
        ...(semanticPrompt ? { semantic: semanticPrompt } : {}),
      },
      ...(semanticPrompt ? { semantic: true } : {}),
      notifyOnly,
    };
  }

  return null;
}

/**
 * Conservative capability envelope for a Routine, derived from its durable
 * instructions and trigger. Explicit caller capabilities win untouched.
 * Read-shaped routines never gain write/shell; nothing here ever grants
 * external send, money, or destructive authority — those stay live-approval
 * concerns inside the run.
 */
function compileRoutineCapabilities(instructions, trigger, { explicit } = {}) {
  const listed = Array.isArray(explicit) ? explicit.map(String).filter(Boolean) : [];
  if (listed.length) return [...new Set(listed)];

  const text = String(instructions || "").toLowerCase();
  const caps = new Set(["reply"]);

  const localish =
    trigger?.type === "filesystem" ||
    /\b(file|files|folder|folders|directory|downloads|desktop|documents|~\/|\/users\/|terminal|shell|command|npm|yarn|pnpm|pip|git|test|tests|build|log|logs|process)\b/.test(
      text,
    );
  if (localish) {
    for (const cap of compileLocalCapabilities(instructions)) caps.add(cap);
    caps.add("local_computer");
  }
  if (trigger?.type === "process") {
    caps.add("local_computer");
    caps.add("files.read");
    caps.add("local.shell.read");
  }
  if (trigger?.type === "browser") {
    caps.add("browser.read");
    if (
      !trigger.notifyOnly &&
      /\b(inspect|diagnose|investigate|fix|open|click|navigate|interact)\b/.test(text)
    ) {
      caps.add("browser.navigate");
      caps.add("browser.interact");
    }
  }
  if (trigger?.type === "screen") {
    caps.add("local_computer");
    caps.add("local.apps.read");
    if (!trigger.notifyOnly && /\b(inspect|diagnose|investigate|fix)\b/.test(text)) {
      caps.add("browser.read");
      caps.add("local.shell.read");
    }
  }
  if (/\b(fix|repair|patch|resolve failures?|make (the )?tests? pass)\b/.test(text)) {
    caps.add("files.write");
    caps.add("local.shell.execute");
  }
  if (/\b(run|rerun|re-run)\b.*\btests?\b/.test(text) || /\btests?\b.*\b(run|fail)/.test(text)) {
    caps.add("local.shell.execute");
  }
  if (
    /\b(check|research|look up|monitor|track|compare|summar|price|pricing|competitor|news|weather|stock|market|website|page|dashboard)\b/.test(
      text,
    ) &&
    !/\bonly\s+local\b/.test(text)
  ) {
    caps.add("research_report");
  }
  if (/\b(image|picture|logo|illustration)\b/.test(text) && /\b(generate|create|make|draw)\b/.test(text)) {
    caps.add("generate_image");
  }
  return [...caps];
}

/**
 * Resolve a create_routine tool instruction into a validated spec:
 * structured JSON when the model provided it, deterministic NL parsing
 * otherwise. Returns { ok, spec } or { ok: false, error } — never a guess.
 */
function resolveRoutineSpec(instruction, context = {}) {
  const raw = String(instruction || "").trim();
  if (!raw) return { ok: false, error: "empty_instruction" };

  let parsed = null;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed === "object" && parsed.trigger) {
    return {
      ok: true,
      spec: {
        name: String(parsed.name || "").trim(),
        instructions: String(parsed.instructions || "").trim(),
        trigger: parsed.trigger,
        capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : undefined,
        notificationPolicy: parsed.notificationPolicy,
        concurrencyPolicy: parsed.concurrencyPolicy,
      },
    };
  }

  const trigger = parseTriggerFromText(raw, context);
  if (trigger?._error === "browser_target_required") {
    return {
      ok: false,
      error:
        "could_not_parse_trigger: say which page to watch (open it and ask again, or paste the URL). I will not pick a random tab.",
    };
  }
  if (trigger?._error === "screen_target_required") {
    return {
      ok: false,
      error:
        "could_not_parse_trigger: say which window to watch (name the app, or ask while that window is in front). I will not pick a random window.",
    };
  }
  if (!trigger) {
    return {
      ok: false,
      error:
        "could_not_parse_trigger: say when it should run (e.g. \"every weekday at 8\", \"when a PDF appears in ~/Downloads\", \"watch this page\") or pass structured JSON",
    };
  }
  return {
    ok: true,
    spec: { name: "", instructions: raw, trigger },
  };
}

module.exports = {
  parseTriggerFromText,
  parseClockTime,
  compileRoutineCapabilities,
  resolveRoutineSpec,
  isNotifyOnlyInstruction,
  PART_OF_DAY_TIMES,
};
