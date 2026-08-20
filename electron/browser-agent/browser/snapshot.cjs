/**
 * Structured page snapshots for the browser agent.
 *
 * A snapshot is the agent's only view of the page: URL, title, tabs,
 * interactive elements (each with a temporary reference like "e12"), and
 * visible text. References are valid ONLY for the snapshot they came from —
 * the controller rejects refs from older snapshots.
 */

let snapshotCounter = 0;

/**
 * Build a structured snapshot from raw browser data.
 * `catalog` items come from ownedBrowserAct.getDOMCatalog
 * ({id, tag, type, role, selector, label, value, checked, href, clientX, clientY, inView}).
 */
function buildSnapshot({ url = "", title = "", catalog = [], text = "", tabs = [] } = {}) {
  snapshotCounter += 1;
  const id = `snap-${snapshotCounter}`;
  const elements = [];
  const byRef = new Map();
  const byLoc = new Map();
  for (let i = 0; i < catalog.length; i += 1) {
    const item = catalog[i];
    if (!item) continue;
    // The uid is minted in page context and pinned to the element for the
    // document's lifetime. A catalog from an older collector has none, so fall
    // back to position — a stale ref is better than a crash.
    const uid = item.uid === undefined || item.uid === null || item.uid === "" ? `p${i + 1}` : item.uid;
    const ref = `e${uid}`;
    const role = normalizeRole(item);
    const label = String(item.label || "").slice(0, 120);
    const el = {
      ref,
      loc: elementLocator(item, role, label),
      role,
      label,
      value: item.value ? String(item.value).slice(0, 80) : "",
      checked: item.checked === true,
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
      raw: item,
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
    at: Date.now(),
    url: String(url || ""),
    title: String(title || ""),
    tabs: Array.isArray(tabs) ? tabs : [],
    elements,
    byRef,
    byLoc,
    visibleText: String(text || ""),
  };
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
    if (el.value) line += ` value="${el.value}"`;
    if (el.checked) line += " (checked)";
    if (el.disabled) line += " (disabled — not clickable until something enables it)";
    if (el.inDialog) line += " [dialog]";
    if (el.scrollable) line += " (scrollable — scroll this ref to reach its contents)";
    if (el.frameHost) line += ` [embedded: ${el.frameHost}]`;
    if (!el.inView) line += " (below fold)";
    // The durable handle. Refs die with the document; this survives a reload,
    // so the model can re-aim after a navigation without another observe round.
    if (el.loc) line += ` loc=${el.loc}`;
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
function diffSnapshots(before, after) {
  if (!before || !after) {
    return { urlChanged: false, titleChanged: false, newLabels: [], removedLabels: [], textChanged: false, summary: "" };
  }
  const urlChanged = before.url !== after.url;
  const titleChanged = before.title !== after.title;
  const beforeLabels = labelSet(before);
  const afterLabels = labelSet(after);
  const newLabels = [...afterLabels].filter((l) => !beforeLabels.has(l)).slice(0, 20);
  const removedLabels = [...beforeLabels].filter((l) => !afterLabels.has(l)).slice(0, 20);
  const textChanged = normText(before.visibleText) !== normText(after.visibleText);
  const parts = [];
  if (urlChanged) parts.push(`URL changed: ${before.url} -> ${after.url}`);
  if (titleChanged) parts.push(`Title changed: "${before.title}" -> "${after.title}"`);
  if (newLabels.length) parts.push(`New elements: ${newLabels.map((l) => `"${l}"`).join(", ")}`);
  if (removedLabels.length) parts.push(`Gone: ${removedLabels.map((l) => `"${l}"`).join(", ")}`);
  if (!urlChanged && !titleChanged && textChanged) parts.push("Page text changed.");
  if (!parts.length) parts.push("No observable page change.");
  return {
    urlChanged,
    titleChanged,
    newLabels,
    removedLabels,
    textChanged,
    summary: parts.join(" "),
  };
}

function labelSet(snapshot) {
  const set = new Set();
  for (const el of Array.isArray(snapshot?.elements) ? snapshot.elements : []) {
    const label = normText(el.label);
    if (label && label.length >= 2) set.add(label);
  }
  return set;
}

function normText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

module.exports = { buildSnapshot, formatSnapshotForModel, diffSnapshots, elementLocator };
