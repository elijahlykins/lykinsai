/**
 * Structured page snapshots for the browser agent.
 *
 * A snapshot is the agent's only view of the page: URL, title, tabs,
 * interactive elements (each with a generation-scoped reference like
 * "g42:17"), and visible text. References are valid ONLY for the observation
 * generation they came from — the controller rejects refs from older
 * generations (STALE_REF) and refs minted by other sessions.
 */

// Keep secret VALUES (passwords, OTPs, card/CVV numbers) out of the
// model-facing snapshot. Reuses the same proven classifier the eval guard uses
// to refuse typing secrets — imported from a dependency-free leaf so there is
// no require cycle between snapshot and guard/executor.
const { isSensitiveField } = require("../../sensitiveFields.cjs");

let snapshotCounter = 0;

/**
 * The process-global observation generation counter.
 *
 * ONE counter for the whole process, on purpose: generations double as the
 * session-isolation mechanism. Because no two BrowserSessions ever hold the
 * same generation number, a ref minted for one task can never collide with a
 * ref minted for another — the failure is structural, not probabilistic.
 * (Lives here rather than in session.cjs so a snapshot built without a
 * session still gets a unique generation instead of a shared default.)
 */
let generationCounter = 0;
function nextGeneration() {
  generationCounter += 1;
  return generationCounter;
}

/**
 * Build a structured snapshot from raw browser data.
 * `catalog` items come from ownedBrowserAct.getDOMCatalog
 * ({id, tag, type, role, selector, label, value, checked, href, clientX, clientY, inView}).
 *
 * `generation` scopes every ref minted here. Callers with a BrowserSession
 * pass the session's current generation; a snapshot built without one mints
 * its own, so its refs are still unique across the process.
 */
function buildSnapshot({ url = "", title = "", catalog = [], text = "", tabs = [], viewport = null, generation = 0 } = {}) {
  snapshotCounter += 1;
  const id = `snap-${snapshotCounter}`;
  const gen = Number(generation) > 0 ? Number(generation) : nextGeneration();
  const elements = [];
  const byRef = new Map();
  const byLoc = new Map();
  for (let i = 0; i < catalog.length; i += 1) {
    const item = catalog[i];
    if (!item) continue;
    // The uid is minted in page context and pinned to the element for the
    // document's lifetime. A catalog from an older collector has none, so fall
    // back to position — a stale ref is better than a crash.
    const uid = item.uid === undefined || item.uid === null || item.uid === "" ? `p${i + 1}` : String(item.uid);
    const ref = `g${gen}:${uid}`;
    const role = normalizeRole(item);
    const label = String(item.label || "").slice(0, 120);
    // Passwords, OTPs, card/CVV fields: the model must know the field EXISTS
    // (label, role, type are kept) but must never receive its value. Redact
    // here — the single point where the raw catalog becomes the model-facing
    // snapshot — and scrub the retained `raw` copy so no downstream consumer
    // (diff, logs) can recover it either.
    const sensitive = isSensitiveField(item, label);
    const safeItem = sensitive && item.value ? { ...item, value: "" } : item;
    const el = {
      ref,
      // Document-lifetime identity, generation-free. Refs change every
      // observation by design; the uid is what lets the diff say "this is the
      // SAME node as before" across two generations of the same document.
      uid,
      loc: elementLocator(item, role, label),
      role,
      label,
      sensitive,
      value: sensitive ? "" : item.value ? String(item.value).slice(0, 80) : "",
      checked: item.checked === true,
      // Tri-state on purpose: null means the widget does not claim the state at
      // all, which is different from claiming it and being false. Collapsing
      // the two would make every plain button look like a collapsed menu.
      expanded: asTriState(item.expanded),
      selected: asTriState(item.selected),
      pressed: asTriState(item.pressed),
      current: item.current ? String(item.current).slice(0, 20) : "",
      href: item.href ? String(item.href).slice(0, 200) : "",
      inView: item.inView !== false,
      // State the model has to know or it wastes rounds: clicking a disabled
      // control looks like a failed click, and not knowing a dialog is open
      // means not knowing why the page underneath ignores everything.
      disabled: item.disabled === true,
      inDialog: item.inDialog === true,
      scrollable: item.scrollable === true,
      // Elements inside an embedded editor's iframe — the model should know
      // it is working in a nested document.
      frameHost: item.frameHost ? String(item.frameHost).slice(0, 60) : "",
      raw: safeItem,
    };
    elements.push(el);
    // Two elements can collide on a ref only if the collector handed out a
    // duplicate uid. First writer wins so the earlier (usually in-view) element
    // keeps the handle the model was given.
    if (!byRef.has(ref)) byRef.set(ref, el);
    if (el.loc && !byLoc.has(el.loc)) byLoc.set(el.loc, el);
  }
  return {
    id,
    generation: gen,
    at: Date.now(),
    url: String(url || ""),
    title: String(title || ""),
    tabs: Array.isArray(tabs) ? tabs : [],
    elements,
    byRef,
    byLoc,
    visibleText: String(text || ""),
    // The viewport every position in this snapshot was measured against.
    // Null when the collector predates viewport reporting — the layout guard
    // simply stays quiet then.
    viewport:
      viewport && Number(viewport.w) > 0 && Number(viewport.h) > 0
        ? { w: Number(viewport.w), h: Number(viewport.h) }
        : null,
  };
}

function asTriState(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function normalizeRole(item) {
  const role = String(item.role || "").toLowerCase();
  if (role) return role;
  const tag = String(item.tag || "").toLowerCase();
  const type = String(item.type || "").toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    if (["checkbox", "radio"].includes(type)) return type;
    if (["button", "submit"].includes(type)) return "button";
    return "textbox";
  }
  if (tag === "img" || tag === "picture" || tag === "canvas") return "img";
  return tag || "element";
}

/**
 * A locator that outlives the snapshot that produced it.
 *
 * A uid dies with its document, so after a navigation or a framework remount
 * the model has nothing durable to aim at and has to re-read the page. These
 * are ordered by how well each survives a re-render: an author-written DOM id
 * essentially always does, a link's path nearly always does, and role+label
 * survives anything short of a copy change. The generated `nth-of-type` chain
 * is last because it is the one that breaks the moment the DOM shifts —
 * exactly the failure the uid already fixed.
 */
function elementLocator(item, role, label) {
  const selector = String(item?.selector || "").trim();
  if (/^#[^ >]+$/.test(selector)) return `css:${selector}`;
  const href = String(item?.href || "").trim();
  if (href && !/^(?:javascript:|#)/i.test(href)) {
    try {
      const u = new URL(href);
      if (/^https?:$/i.test(u.protocol)) return `href:${u.pathname}${u.search}`.slice(0, 120);
    } catch {
      /* relative or malformed — fall through */
    }
  }
  const text = String(label || "").trim().slice(0, 60);
  if (role && text) return `role:${role}|${text}`;
  return selector ? `css:${selector}`.slice(0, 120) : "";
}

/**
 * Render a snapshot as compact text for the model. Interactive elements in
 * view come first; below-fold elements fill the remaining budget.
 */
function formatSnapshotForModel(snapshot, { maxElements = 90, maxTextChars = 5000 } = {}) {
  if (!snapshot) return "(no snapshot)";
  // A snapshot reaches here from several paths, including `after = before` on a
  // failed re-observe, so nothing is assumed to be populated.
  const tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const lines = [];
  lines.push("PAGE");
  lines.push(`Title: ${snapshot.title || "(untitled)"}`);
  lines.push(`URL: ${snapshot.url || "(blank)"}`);
  if (tabs.length) {
    lines.push("");
    lines.push("TABS");
    for (const tab of tabs) {
      lines.push(
        `[${tab.id}] ${String(tab.title || tab.url || "(blank)").slice(0, 80)}${tab.active ? " (active)" : ""}`,
      );
    }
  }
  lines.push("");
  if (snapshot.collectorFailed) {
    lines.push(
      "(WARNING: the page could not be read this round — the list below is incomplete or empty " +
        "because the collector failed, NOT because the page is empty. Wait and observe again, " +
        "or take a screenshot.)",
    );
    lines.push("");
  }
  // The page changed before it was read, and not because the agent acted.
  // Unexplained, that reads as a site behaving erratically.
  const cleared = Array.isArray(snapshot.overlaysDismissed) ? snapshot.overlaysDismissed : [];
  if (cleared.length) {
    lines.push(
      `(Cleared out of the way before this snapshot: ${cleared
        .map((o) => o.what || o.kind)
        .join("; ")}. That was done for you — do not go looking for it.)`,
    );
    lines.push("");
  }
  // Still up, and already clicked once without shifting. The model needs this:
  // a covered page swallows clicks silently, and nothing else in the snapshot
  // would ever tell it why.
  const stillUp = Array.isArray(snapshot.overlaysBlocking) ? snapshot.overlaysBlocking : [];
  if (stillUp.length) {
    lines.push(
      `(STILL COVERING THE PAGE: ${stillUp
        .map((o) => o.what || o.kind)
        .join("; ")}. An attempt to close it did not work, so clicks on the page behind it may not land. ` +
        "Deal with it first — its own controls are in the list below, or press Escape.)",
    );
    lines.push("");
  }
  lines.push("INTERACTIVE ELEMENTS");
  // A modal changes what every other element means — say so before listing.
  if (elements.some((e) => e.inDialog)) {
    lines.push("(A dialog is open. Elements marked [dialog] belong to it; the rest are behind it.)");
  }
  const embeddedHosts = [
    ...new Set(elements.map((e) => e.frameHost).filter(Boolean)),
  ];
  if (embeddedHosts.length) {
    lines.push(
      `(Elements marked [embedded: host] live inside an iframe on this page — ` +
        `usually the real editor. They are interacted with exactly like any other element. ` +
        `Embedded documents here: ${embeddedHosts.join(", ")}.)`,
    );
  }
  const chosen = chooseElements(elements, maxElements);
  for (const el of chosen) {
    let line = `[${el.ref}] ${el.role} "${el.label}"`;
    // Where a link goes is the single most useful thing about it, and it was
    // collected, stored, and then dropped on the floor here. Without it the
    // agent cannot tell an outbound link from an internal one, cannot choose
    // between two links with the same text, and cannot skip the click and
    // navigate straight to the URL it is already holding.
    const href = linkDestination(el);
    if (href) line += ` -> ${href}`;
    // Sensitive fields advertise their existence but never their contents.
    if (el.sensitive) line += " (sensitive — value hidden)";
    else if (el.value) line += ` value="${el.value}"`;
    if (el.checked) line += " (checked)";
    // A menu the agent already opened looks identical to one it has not, and
    // that is how a round gets spent opening something twice — the second
    // click closing what the first opened.
    if (el.expanded === true) line += " (open)";
    else if (el.expanded === false) line += " (closed — click to open)";
    if (el.selected === true) line += " (selected)";
    if (el.pressed === true) line += " (on)";
    else if (el.pressed === false) line += " (off)";
    if (el.current) line += " (current)";
    if (el.disabled) line += " (disabled — not clickable until something enables it)";
    if (el.inDialog) line += " [dialog]";
    if (el.scrollable) line += " (scrollable — scroll this ref to reach its contents)";
    // Which of these will accept writing. A rich editor is an anonymous div in
    // the list otherwise, so the agent hunts for the writing surface by pixel.
    if (el.raw?.editable === true && !["textbox", "searchbox", "combobox"].includes(String(el.role || ""))) {
      line += " (editable — you can write here)";
    }
    if (el.frameHost) line += ` [embedded: ${el.frameHost}]`;
    if (!el.inView) line += " (below fold)";
    // Generation-stamped locator. After navigation the previous generation is
    // stale even if the same CSS still matches a different control.
    if (el.loc) line += ` loc=g${snapshot.generation}:${el.loc}`;
    lines.push(line);
  }
  if (elements.length > chosen.length) {
    lines.push(`(+${elements.length - chosen.length} more elements)`);
  }
  lines.push("");
  lines.push("VISIBLE CONTENT");
  const fullText = String(snapshot.visibleText || "");
  lines.push(fullText.slice(0, maxTextChars) || "(no visible text)");
  if (fullText.length > maxTextChars) {
    lines.push(`… (${fullText.length - maxTextChars} more characters — scroll or extract to read the rest)`);
  }
  return lines.join("\n");
}

/**
 * A link's destination, trimmed to what is worth spending prompt on.
 *
 * Tracking parameters and long opaque ids are noise — the host and path are
 * what tell the agent whether this leaves the site and where it lands.
 */
function linkDestination(el) {
  const href = String(el?.href || "").trim();
  if (!href) return "";
  if (/^(?:javascript:|#|about:blank$)/i.test(href)) return "";
  try {
    const u = new URL(href);
    if (!/^https?:$/i.test(u.protocol)) return href.slice(0, 60);
    const path = u.pathname === "/" ? "" : u.pathname;
    const base = `${u.host}${path}`;
    const q = u.search ? "?…" : "";
    return `${base.length > 78 ? `${base.slice(0, 77)}…` : base}${q}`;
  } catch {
    // Relative or malformed — still more useful to the agent than nothing.
    return href.slice(0, 60);
  }
}

/**
 * Fit the most useful elements into the budget.
 *
 * In-view before below-fold, as ever. The addition is a reserved share for
 * elements inside embedded frames: the outer page of an app like a campaign
 * editor can easily present 90 controls of its own chrome, which would push the
 * actual editor — the only part the task is about — off the end of the list.
 */
function chooseElements(elements, maxElements) {
  const rank = (e) => (e.inView ? 0 : 1);
  // A dialog makes everything behind it inert, so when one is open its own
  // controls are the only ones worth spending the budget on. They used to
  // compete with the whole page for room and routinely lost — a share
  // dialog's recipient field and Send button were both in the snapshot and
  // both absent from the list the model was shown, so it fell back to aiming
  // by pixel at controls it could have clicked by reference.
  const dialog = elements.filter((e) => e.inDialog);
  if (dialog.length) {
    const rest = elements.filter((e) => !e.inDialog).sort((a, b) => rank(a) - rank(b));
    const kept = [
      ...dialog.sort((a, b) => rank(a) - rank(b)).slice(0, maxElements),
      // Whatever room is left goes to the page behind it, which still explains
      // where the dialog came from.
      ...rest.slice(0, Math.max(0, maxElements - Math.min(dialog.length, maxElements))),
    ];
    return kept.slice(0, maxElements);
  }
  const embedded = elements.filter((e) => e.frameHost).sort((a, b) => rank(a) - rank(b));
  const main = elements.filter((e) => !e.frameHost).sort((a, b) => rank(a) - rank(b));
  if (!embedded.length) return main.slice(0, maxElements);
  // A third of the budget, floored at 30 only when the budget is big enough to
  // spare it. The absolute floor starved the main page at the verifier's
  // 40-element budget, leaving it ten slots for the whole outer application.
  const embeddedQuota = Math.min(
    embedded.length,
    Math.max(Math.floor(maxElements / 3), Math.min(30, Math.floor(maxElements / 2))),
  );
  const kept = [
    ...main.slice(0, Math.max(0, maxElements - embeddedQuota)),
    ...embedded.slice(0, embeddedQuota),
  ];
  // Any budget the smaller group left unused goes back to the other.
  if (kept.length < maxElements) {
    const seen = new Set(kept);
    for (const el of [...main, ...embedded]) {
      if (kept.length >= maxElements) break;
      if (!seen.has(el)) kept.push(el);
    }
  }
  return kept.sort((a, b) => rank(a) - rank(b));
}

/**
 * Deterministic diff between two snapshots — cheap evidence for the verifier.
 */
function emptyDiff() {
  return {
    urlChanged: false,
    titleChanged: false,
    newLabels: [],
    removedLabels: [],
    textChanged: false,
    countChanges: [],
    stateChanges: [],
    summary: "",
  };
}

function diffSnapshots(before, after) {
  if (!before || !after) return emptyDiff();
  const urlChanged = before.url !== after.url;
  const titleChanged = before.title !== after.title;
  const beforeLabels = labelCounts(before);
  const afterLabels = labelCounts(after);
  const newLabels = [...afterLabels.keys()].filter((l) => !beforeLabels.has(l)).slice(0, 20);
  const removedLabels = [...beforeLabels.keys()].filter((l) => !afterLabels.has(l)).slice(0, 20);
  // How MANY of a repeated label there are, which the label set could never
  // see. Deleting one of five identical "Remove" rows, or adding a second copy
  // of a line item, leaves the set of labels untouched and the page changed.
  const countChanges = [];
  for (const [label, now] of afterLabels) {
    const was = beforeLabels.get(label);
    if (was !== undefined && was !== now) countChanges.push({ label, was, now });
  }
  const textChanged = normText(before.visibleText) !== normText(after.visibleText);
  const stateChanges = diffElementStates(before, after);
  const parts = [];
  if (urlChanged) parts.push(`URL changed: ${before.url} -> ${after.url}`);
  if (titleChanged) parts.push(`Title changed: "${before.title}" -> "${after.title}"`);
  if (newLabels.length) parts.push(`New elements: ${newLabels.map((l) => `"${l}"`).join(", ")}`);
  if (removedLabels.length) parts.push(`Gone: ${removedLabels.map((l) => `"${l}"`).join(", ")}`);
  if (countChanges.length) {
    parts.push(
      `Counts changed: ${countChanges
        .slice(0, 8)
        .map((c) => `"${c.label}" ${c.was}→${c.now}`)
        .join(", ")}`,
    );
  }
  if (stateChanges.length) {
    parts.push(`State changed: ${stateChanges.slice(0, 8).map((c) => c.text).join("; ")}`);
  }
  if (!urlChanged && !titleChanged && textChanged) parts.push("Page text changed.");
  if (!parts.length) parts.push("No observable page change.");
  return {
    urlChanged,
    titleChanged,
    newLabels,
    removedLabels,
    textChanged,
    countChanges,
    stateChanges,
    summary: parts.join(" "),
  };
}

/**
 * The states a control can change without changing a word of the page.
 *
 * Every one of these is a normal, successful outcome of a click, and none of
 * them alters a label or the visible text — so an action that produced one used
 * to be scored as "nothing happened" and sent back through the recovery ladder,
 * where the retry clicked the same control again and undid it.
 */
const TRACKED_STATES = [
  ["checked", "ticked", "unticked"],
  ["expanded", "opened", "closed"],
  ["selected", "selected", "deselected"],
  ["pressed", "turned on", "turned off"],
];

function diffElementStates(before, after) {
  const changes = [];
  const seen = new Map();
  for (const el of Array.isArray(before?.elements) ? before.elements : []) {
    if (el?.uid && !seen.has(el.uid)) seen.set(el.uid, el);
  }
  for (const now of Array.isArray(after?.elements) ? after.elements : []) {
    // uids are minted per element and pinned for the document's lifetime, so
    // the same uid in both snapshots is the same node — not merely one that
    // looks like it. (Refs cannot do this job any more: they embed the
    // observation generation, so the same node carries a different ref in
    // each snapshot on purpose.)
    const was = now?.uid ? seen.get(now.uid) : null;
    if (!was) continue;
    const name = `"${now.label || was.label || now.role}"`;
    for (const [key, onWord, offWord] of TRACKED_STATES) {
      if (was[key] === now[key]) continue;
      // Appearing or losing the attribute entirely is a re-render, not a state
      // change the agent caused; only a real flip counts.
      if (typeof was[key] !== "boolean" || typeof now[key] !== "boolean") continue;
      changes.push({ ref: now.ref, uid: now.uid, key, from: was[key], to: now[key], text: `${name} ${now[key] ? onWord : offWord}` });
    }
    if (was.disabled !== now.disabled) {
      changes.push({
        ref: now.ref,
        uid: now.uid,
        key: "disabled",
        from: was.disabled,
        to: now.disabled,
        text: `${name} became ${now.disabled ? "disabled" : "enabled"}`,
      });
    }
    if (normText(was.value) !== normText(now.value)) {
      changes.push({
        ref: now.ref,
        uid: now.uid,
        key: "value",
        from: was.value,
        to: now.value,
        text: `${name} now holds "${String(now.value || "").slice(0, 40)}"`,
      });
    }
    if ((was.current || "") !== (now.current || "")) {
      changes.push({
        ref: now.ref,
        uid: now.uid,
        key: "current",
        from: was.current,
        to: now.current,
        text: `${name} ${now.current ? "became the current item" : "is no longer the current item"}`,
      });
    }
    if (changes.length >= 24) break;
  }
  return changes;
}

/**
 * Anything at all that the page did. The loop and the verifier have to agree on
 * this, or one of them will retry an action the other considers done.
 */
function hasObservableChange(diff) {
  if (!diff) return false;
  return !!(
    diff.urlChanged ||
    diff.titleChanged ||
    diff.textChanged ||
    diff.newLabels?.length ||
    diff.removedLabels?.length ||
    diff.countChanges?.length ||
    diff.stateChanges?.length
  );
}

function labelCounts(snapshot) {
  const counts = new Map();
  for (const el of Array.isArray(snapshot?.elements) ? snapshot.elements : []) {
    const label = normText(el.label);
    if (label && label.length >= 2) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return counts;
}

function normText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

module.exports = {
  buildSnapshot,
  formatSnapshotForModel,
  diffSnapshots,
  hasObservableChange,
  elementLocator,
  nextGeneration,
};
