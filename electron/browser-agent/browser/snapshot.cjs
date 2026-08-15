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
  for (let i = 0; i < catalog.length; i += 1) {
    const item = catalog[i];
    if (!item) continue;
    const ref = `e${i + 1}`;
    const el = {
      ref,
      role: normalizeRole(item),
      label: String(item.label || "").slice(0, 120),
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
    byRef.set(ref, el);
  }
  return {
    id,
    at: Date.now(),
    url: String(url || ""),
    title: String(title || ""),
    tabs: Array.isArray(tabs) ? tabs : [],
    elements,
    byRef,
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
 * Render a snapshot as compact text for the model. Interactive elements in
 * view come first; below-fold elements fill the remaining budget.
 */
function formatSnapshotForModel(snapshot, { maxElements = 90, maxTextChars = 5000 } = {}) {
  if (!snapshot) return "(no snapshot)";
  const lines = [];
  lines.push("PAGE");
  lines.push(`Title: ${snapshot.title || "(untitled)"}`);
  lines.push(`URL: ${snapshot.url || "(blank)"}`);
  if (snapshot.tabs.length) {
    lines.push("");
    lines.push("TABS");
    for (const tab of snapshot.tabs) {
      lines.push(
        `[${tab.id}] ${String(tab.title || tab.url || "(blank)").slice(0, 80)}${tab.active ? " (active)" : ""}`,
      );
    }
  }
  lines.push("");
  lines.push("INTERACTIVE ELEMENTS");
  // A modal changes what every other element means — say so before listing.
  if (snapshot.elements.some((e) => e.inDialog)) {
    lines.push("(A dialog is open. Elements marked [dialog] belong to it; the rest are behind it.)");
  }
  const embeddedHosts = [
    ...new Set(snapshot.elements.map((e) => e.frameHost).filter(Boolean)),
  ];
  if (embeddedHosts.length) {
    lines.push(
      `(Elements marked [embedded: host] live inside an iframe on this page — ` +
        `usually the real editor. They are interacted with exactly like any other element. ` +
        `Embedded documents here: ${embeddedHosts.join(", ")}.)`,
    );
  }
  const chosen = chooseElements(snapshot.elements, maxElements);
  for (const el of chosen) {
    let line = `[${el.ref}] ${el.role} "${el.label}"`;
    if (el.value) line += ` value="${el.value}"`;
    if (el.checked) line += " (checked)";
    if (el.disabled) line += " (disabled — not clickable until something enables it)";
    if (el.inDialog) line += " [dialog]";
    if (el.scrollable) line += " (scrollable — scroll this ref to reach its contents)";
    if (el.frameHost) line += ` [embedded: ${el.frameHost}]`;
    if (!el.inView) line += " (below fold)";
    lines.push(line);
  }
  if (snapshot.elements.length > chosen.length) {
    lines.push(`(+${snapshot.elements.length - chosen.length} more elements)`);
  }
  lines.push("");
  lines.push("VISIBLE CONTENT");
  lines.push(snapshot.visibleText.slice(0, maxTextChars) || "(no visible text)");
  return lines.join("\n");
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
  const embeddedQuota = Math.min(embedded.length, Math.max(30, Math.floor(maxElements / 3)));
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
  for (const el of snapshot.elements) {
    const label = normText(el.label);
    if (label && label.length >= 2) set.add(label);
  }
  return set;
}

function normText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

module.exports = { buildSnapshot, formatSnapshotForModel, diffSnapshots };
