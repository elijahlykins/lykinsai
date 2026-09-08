// Overlay copy of src/lib/lyknChat/thinkingActivity.ts. Keep the kind mapping
// and collapse rules in lockstep so voice/typed overlay read like Studio chat.

const AGGREGATE_KINDS = new Set(["search", "read", "image"]);

const SEARCH_RE =
  /^(searching|searched|ran\s+\d+\s+search)/i;
const READ_RE =
  /^(reading|read\s+\d+\s+page|reading sources)/i;
const RESEARCH_RE =
  /^(planning research|researching|checking gaps|writing report)/i;
const IMAGE_RE =
  /^(creating the image|generating (the )?image|created \d+\s+image)/i;
const VIDEO_RE = /^(rendering|composing the video)/i;
const CODE_RE =
  /^(writing the (code|components)|running the (code|analysis)|patching |updating )/i;
const BUILD_RE =
  /^(building|designing the|sketching|wiring|assembling|laying out|filling in|checking the layout|figuring out)/i;
const WRITE_RE = /^(writing |drafting the|composing the)/i;
const FILES_RE =
  /^(looking through your files|searching your files|reading the file|writing the file|editing |pulling in |opening )/i;
const CONNECT_RE = /^(using [a-z]|checking what i know|saving that memory)/i;

export function stripStatusDecor(line) {
  return String(line || "")
    .trim()
    .replace(/[.…]+$/g, "")
    .trim();
}

export function trailFamilyKey(status) {
  return String(status || "")
    .trim()
    .replace(/[.…]+$/g, "")
    .replace(/\s*\(\d+\s*\/\s*\d+\)\s*$/g, "")
    .replace(/\s*\(\d+k?\)\s*$/gi, "")
    .trim()
    .toLowerCase();
}

export function activityKindFromLine(line) {
  const t = String(line || "").trim();
  if (!t) return "other";
  if (FILES_RE.test(t)) return "files";
  if (SEARCH_RE.test(t)) return "search";
  if (RESEARCH_RE.test(t)) return "research";
  if (READ_RE.test(t)) return "read";
  if (IMAGE_RE.test(t)) return "image";
  if (VIDEO_RE.test(t)) return "video";
  if (CODE_RE.test(t)) return "code";
  if (BUILD_RE.test(t)) return "build";
  if (WRITE_RE.test(t)) return "write";
  if (CONNECT_RE.test(t)) return "connect";
  return "other";
}

export function formatAggregate(kind, count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  if (kind === "search") return n === 1 ? "Ran 1 search" : `Ran ${n} searches`;
  if (kind === "read") return n === 1 ? "Read 1 page" : `Read ${n} pages`;
  if (kind === "image") return n === 1 ? "Created 1 image" : `Created ${n} images`;
  return "";
}

export function formatWorkingFor(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 1) return "Working…";
  if (s < 60) return `Working for ${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `Working for ${m}m ${r}s` : `Working for ${m}m`;
}

const MAX_STEPS = 6;

export function collapseThinkingSteps(trail, live) {
  const liveTrim = String(live || "").trim();
  const completed = [];

  for (const raw of trail || []) {
    const line = String(raw || "").trim();
    if (!line || line === liveTrim) continue;
    const kind = activityKindFromLine(line);
    const last = completed[completed.length - 1];
    if (last && last.kind === kind && AGGREGATE_KINDS.has(kind)) {
      last.count += 1;
      last.label = formatAggregate(kind, last.count);
      continue;
    }
    completed.push({
      kind,
      count: 1,
      label: AGGREGATE_KINDS.has(kind)
        ? formatAggregate(kind, 1)
        : stripStatusDecor(line),
    });
  }

  const steps = completed.map(({ kind, label }) => ({ kind, label }));

  if (liveTrim) {
    steps.push({
      kind: activityKindFromLine(liveTrim),
      label: stripStatusDecor(liveTrim),
      live: true,
    });
  }

  return steps.length > MAX_STEPS ? steps.slice(-MAX_STEPS) : steps;
}
