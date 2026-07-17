import { API_BASE_URL } from "@/lib/api-config";
import type { TodayDocket } from "@/lib/synthesis/loadInUpdates";

// Turns the user's "on your plate today" docket into a short, warm,
// actionable briefing streamed from the chat model — concrete first steps
// for the day's tasks/events plus a helpful resource or tool suggestion for
// each. Kept intentionally small: this fires on app open, so it asks for a
// concise reply (responseLength: short) and skips web search for latency.

function fmtTime(startsAt: number, allDay: boolean): string {
  if (allDay) return "all day";
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fmtDate(dueAt: number | null): string {
  if (dueAt == null) return "";
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Build the model prompt describing today's plate. Returns null when there's
 * nothing to brief on (so the caller can skip the AI call entirely).
 */
export function buildDocketPrompt(
  docket: TodayDocket,
  greetingName?: string | null,
): string | null {
  const { events, dueToday, overdue, projectNames } = docket;
  if (events.length === 0 && dueToday.length === 0 && overdue.length === 0) {
    return null;
  }
  const proj = (id: string | null) => (id && projectNames[id] ? ` (project: ${projectNames[id]})` : "");

  const lines: string[] = [];
  if (events.length > 0) {
    lines.push("Events today:");
    for (const e of events.slice(0, 8)) {
      lines.push(`- ${e.title} — ${fmtTime(e.startsAt, e.allDay)}${e.location ? ` @ ${e.location}` : ""}${proj(e.projectId)}`);
    }
  }
  if (overdue.length > 0) {
    lines.push("Overdue tasks:");
    for (const t of overdue.slice(0, 8)) {
      lines.push(`- ${t.title}${t.dueAt ? ` (was due ${fmtDate(t.dueAt)})` : ""}${proj(t.projectId)}`);
    }
  }
  if (dueToday.length > 0) {
    lines.push("Tasks due today:");
    for (const t of dueToday.slice(0, 8)) {
      lines.push(`- ${t.title}${t.priority === "high" ? " [high priority]" : ""}${proj(t.projectId)}`);
    }
  }

  const who = greetingName ? ` My name is ${greetingName}.` : "";
  return [
    `Here is what's on my plate today.${who}`,
    "",
    lines.join("\n"),
    "",
    "Brief me on my day like my assistant would, in a natural chat reply. Open with a short, warm greeting, then walk me through my events (with their times) and my tasks so I can see the day at a glance. For the 2–4 most important items, add a concrete first step to get started and one helpful resource, tool, or template I could use. When you mention a resource or tool, prefer just naming it in bold (e.g. **Notion**, **Figma**). Only include a link if it's the tool's real main site as a full https:// URL (e.g. https://figma.com) — never link to a specific project, file, workspace, or any path you'd have to guess (no 'figma.com/yourproject'-style links), and never use bare domains, relative paths, or placeholder/made-up links. Keep it warm, concise, and skimmable — use short markdown (bold item names, small bullets), don't use a big heading, and keep the whole reply under ~200 words.",
  ].join("\n");
}

/**
 * Stream the briefing from the authenticated chat endpoint. `onChunk` is
 * called with the full accumulated text each time more arrives, so the caller
 * can render it typing out. Auth is injected globally by installAuthFetch.
 */
export async function streamDocketBriefing(
  prompt: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/ai/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      text: prompt,
      responseLength: "short",
      skipWebSearch: true,
    }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error("docket briefing: bad response");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";

  const consumeLine = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6);
    if (payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed.t === "string") {
        result += parsed.t;
        onChunk(result);
      }
    } catch {
      // Ignore partial / non-token frames (status, served_model, etc.).
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const raw of lines) consumeLine(raw);
  }
  if (buffer.trim()) {
    for (const raw of buffer.split("\n")) consumeLine(raw);
  }
  return result;
}
