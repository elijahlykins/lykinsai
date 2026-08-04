/** Research-mode source focus for Studio deep research. */

export type ResearchSourcePref =
  | "all"
  | "web"
  | "academic"
  | "news"
  | "social"
  | "finance";

export const RESEARCH_SOURCE_OPTIONS: {
  value: ResearchSourcePref;
  label: string;
  shortLabel: string;
}[] = [
  { value: "all", label: "All sources", shortLabel: "All sources" },
  { value: "web", label: "Web", shortLabel: "Web" },
  { value: "academic", label: "Academic", shortLabel: "Academic" },
  { value: "news", label: "News", shortLabel: "News" },
  { value: "social", label: "Social", shortLabel: "Social" },
  { value: "finance", label: "Markets & finance", shortLabel: "Markets" },
];

const ALLOWED = new Set(RESEARCH_SOURCE_OPTIONS.map((o) => o.value));

export function normalizeResearchSourcePref(raw: unknown): ResearchSourcePref {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  return ALLOWED.has(v as ResearchSourcePref) ? (v as ResearchSourcePref) : "all";
}
